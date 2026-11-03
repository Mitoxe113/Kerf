//! Editing assistants: scene, silence, beat and highlight analysis of media or
//! timeline clips, and ducking plans. Analyses only read the media; what to do
//! with the results is decided in the UI and applied as ordinary (undoable) edits.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use kerf_core::assist::{self, DuckOptions};
use kerf_core::error::EditError;
use kerf_core::model::{Clip, Keyframe, MediaAsset, Param, TrackKind};
use kerf_core::time::Frame;
use kerf_media::detect::{self, BeatOptions, BeatReport, Highlight, HighlightOptions, SceneCut, SceneOptions, SilenceOptions, SilenceReport};
use kerf_media::MediaError;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::commands::{CmdResult, CommandError};
use crate::state::{lock, AppState};

/// Longest stretch the beat analysis decodes at once (it keeps the samples).
const MAX_BEAT_SECONDS: f64 = 30.0 * 60.0;
/// Highest frame rate the scene analysis samples at.
const MAX_SCENE_FPS: f64 = 60.0;

fn cancels() -> &'static Mutex<HashMap<Uuid, Arc<AtomicBool>>> {
    static C: OnceLock<Mutex<HashMap<Uuid, Arc<AtomicBool>>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Registers a cancel flag for `job` for as long as the guard lives.
struct Job(Uuid, Arc<AtomicBool>);

impl Job {
    fn new(id: Uuid) -> Self {
        let flag = Arc::new(AtomicBool::new(false));
        lock(cancels()).insert(id, flag.clone());
        Self(id, flag)
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        lock(cancels()).remove(&self.0);
    }
}

#[tauri::command]
pub fn analyze_cancel(job: Uuid) {
    if let Some(f) = lock(cancels()).get(&job) {
        f.store(true, Ordering::Relaxed);
    }
}

fn media_err(e: MediaError) -> CommandError {
    match e {
        MediaError::Cancelled => CommandError::new("cancelled", "analysis cancelled"),
        e => CommandError::new("analysisFailed", e),
    }
}

#[derive(Deserialize, Clone, Copy)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AnalysisTarget {
    /// The whole media file.
    Media { media: Uuid },
    /// The source range a timeline clip plays; results are also placed on the timeline.
    Clip { sequence: Uuid, clip: Uuid },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AnalysisRequest {
    Scenes { options: SceneOptions },
    Silence { options: SilenceOptions },
    Beats { options: BeatOptions },
    Highlights { options: HighlightOptions, scenes: SceneOptions },
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    /// Analysed source range, seconds.
    source_start: f64,
    source_end: f64,
    scenes: Option<Vec<SceneCut>>,
    silence: Option<SilenceReport>,
    beats: Option<BeatReport>,
    highlights: Option<Vec<Highlight>>,
    /// For clip targets: timeline frame of each scene cut / beat / peak, and the
    /// timeline range of each silence (its removable part) / highlight; `None`
    /// where the clip does not show it. Empty for media targets.
    scene_frames: Vec<Option<Frame>>,
    beat_frames: Vec<Option<Frame>>,
    peak_frames: Vec<Option<Frame>>,
    silence_ranges: Vec<Option<(Frame, Frame)>>,
    highlight_ranges: Vec<Option<(Frame, Frame)>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job: Uuid,
    /// Seconds decoded so far, and in all.
    done: f64,
    total: f64,
}

struct Resolved {
    asset: MediaAsset,
    start: f64,
    duration: f64,
    /// Clip and sequence frame rate for clip targets.
    clip: Option<(Clip, f64)>,
}

fn resolve(state: &AppState, target: AnalysisTarget) -> CmdResult<Resolved> {
    let s = lock(&state.session);
    let p = &s.project;
    let (asset, start, duration, clip) = match target {
        AnalysisTarget::Media { media } => {
            let a = p.media(media).ok_or(EditError::MediaNotFound)?.clone();
            let d = a.info.as_ref().ok_or(EditError::MediaNotReady)?.duration;
            (a, 0.0, d, None)
        }
        AnalysisTarget::Clip { sequence, clip } => {
            let seq = p.sequence(sequence).ok_or(EditError::SequenceNotFound)?;
            let c = seq.clip(clip).ok_or(EditError::ClipNotFound)?.clone();
            let a = p.media(c.media_id).ok_or(EditError::MediaNotFound)?.clone();
            if p.sequence(a.id).is_some() {
                return Err(CommandError::new("nestedClip", "nested sequences cannot be analysed; open the sequence and analyse its clips"));
            }
            let rate = seq.settings.fps;
            let (from, to) = (rate.frames_to_seconds(c.source_in), rate.frames_to_seconds(c.source_out()));
            (a, from, to - from, Some((c, rate.as_f64())))
        }
    };
    if asset.title.is_some() {
        return Err(CommandError::new("notMedia", "titles have nothing to analyse"));
    }
    if !asset.path.is_file() {
        return Err(CommandError::new("mediaOffline", format!("{} is offline", asset.path.display())));
    }
    Ok(Resolved { asset, start, duration, clip })
}

/// Runs one analysis of a media file or clip. Progress arrives as
/// `analysis-progress` events; [`analyze_cancel`] stops it.
#[tauri::command(async)]
pub fn analyze(app: AppHandle, state: State<'_, AppState>, job: Uuid, target: AnalysisTarget, request: AnalysisRequest) -> CmdResult<AnalysisResult> {
    let tools = state.media.tools.clone().ok_or_else(|| CommandError::new("ffmpegMissing", "FFmpeg not found"))?;
    let r = resolve(&state, target)?;
    let guard = Job::new(job);
    let cancel = &*guard.1;
    let info = r.asset.info.clone().ok_or(EditError::MediaNotReady)?;
    let path: PathBuf = r.asset.path.clone();
    let (start, duration) = (r.start, r.duration);
    let progress = |done: f64| {
        let _ = app.emit("analysis-progress", Progress { job, done, total: duration });
    };
    let need_video = || -> CmdResult<f64> {
        let v = info.video.as_ref().filter(|_| r.asset.has_video()).ok_or_else(|| CommandError::new("noVideo", "the media has no picture"))?;
        Ok(v.fps.as_f64().clamp(1.0, MAX_SCENE_FPS))
    };
    let need_audio = || -> CmdResult<()> {
        if r.asset.has_audio() {
            Ok(())
        } else {
            Err(CommandError::new("noAudio", "the media has no sound"))
        }
    };

    let mut out = AnalysisResult { source_start: start, source_end: start + duration, ..Default::default() };
    match request {
        AnalysisRequest::Scenes { options } => {
            let fps = need_video()?;
            let stats = detect::video_stats(&tools, &path, start, Some(duration), fps, cancel, progress).map_err(media_err)?;
            let mut cuts = detect::detect_scenes(&stats, fps, &options);
            for c in &mut cuts {
                c.time += start;
                c.from += start;
                c.to += start;
            }
            out.scenes = Some(cuts);
        }
        AnalysisRequest::Silence { options } => {
            need_audio()?;
            progress(0.0);
            let levels = detect::audio_levels(&tools, &path, start, Some(duration), cancel).map_err(media_err)?;
            let mut report = detect::detect_silence(&levels, &options);
            for s in &mut report.silences {
                s.start += start;
                s.end += start;
                s.cut_start += start;
                s.cut_end += start;
            }
            out.silence = Some(report);
        }
        AnalysisRequest::Beats { options } => {
            need_audio()?;
            if duration > MAX_BEAT_SECONDS {
                return Err(CommandError::new("tooLong", "beat analysis handles up to 30 minutes at a time; analyse a clip of the music instead"));
            }
            progress(0.0);
            let samples = detect::audio_samples(&tools, &path, start, Some(duration), detect::BEAT_RATE, cancel).map_err(media_err)?;
            let (env, hop) = detect::onset_envelope(&samples, detect::BEAT_RATE);
            let mut report = detect::detect_beats(&env, hop, &options);
            report.beats.iter_mut().for_each(|b| b.time += start);
            report.peaks.iter_mut().for_each(|p| p.0 += start);
            out.beats = Some(report);
        }
        AnalysisRequest::Highlights { options, scenes } => {
            let fps = need_video()?;
            let stats = detect::video_stats(&tools, &path, start, Some(duration), fps, cancel, progress).map_err(media_err)?;
            let levels = if r.asset.has_audio() { detect::audio_levels(&tools, &path, start, Some(duration), cancel).map_err(media_err)? } else { Vec::new() };
            let cuts: Vec<f64> = detect::detect_scenes(&stats, fps, &scenes).iter().map(|c| c.time).collect();
            let motion: Vec<f64> = stats.iter().map(|s| s.motion as f64).collect();
            let mut h = detect::detect_highlights(&motion, fps, &levels, &cuts, duration, &options);
            for x in &mut h {
                x.start += start;
                x.end += start;
            }
            out.highlights = Some(h);
        }
    }

    if let Some((clip, fps)) = &r.clip {
        let at = |t: f64| assist::timeline_frame(clip, *fps, t);
        let range = |a: f64, b: f64| assist::timeline_range(clip, *fps, a, b);
        out.scene_frames = out.scenes.iter().flatten().map(|c| at(c.time)).collect();
        if let Some(b) = &out.beats {
            out.beat_frames = b.beats.iter().map(|x| at(x.time)).collect();
            out.peak_frames = b.peaks.iter().map(|x| at(x.0)).collect();
        }
        out.silence_ranges = out.silence.iter().flat_map(|s| &s.silences).map(|s| range(s.cut_start, s.cut_end)).collect();
        out.highlight_ranges = out.highlights.iter().flatten().map(|h| range(h.start, h.end)).collect();
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckClip {
    clip: Uuid,
    name: String,
    /// New volume keys; empty when no speech overlaps the clip.
    keys: Vec<Keyframe>,
    /// The clip already had volume keys, which the plan replaces.
    replaces_keys: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckPlan {
    /// Speech found on the trigger tracks, sequence seconds.
    speech: Vec<(f64, f64)>,
    /// The gain curve below the clips' own volume, sequence seconds and dB.
    curve: Vec<(f64, f32)>,
    clips: Vec<DuckClip>,
    /// Target clips left alone (reversed or speed-ramped).
    skipped: Vec<String>,
    /// Trigger clips that could not be analysed (offline, no sound), by name.
    unreadable: Vec<String>,
}

/// Finds speech on the `triggers` tracks and computes ducking keys for the
/// audio clips on the `targets` tracks. Nothing is changed: the UI applies the
/// plan as one undoable edit.
#[tauri::command(async)]
pub fn duck_plan(
    state: State<'_, AppState>,
    job: Uuid,
    sequence: Uuid,
    triggers: Vec<Uuid>,
    targets: Vec<Uuid>,
    speech: SilenceOptions,
    duck: DuckOptions,
) -> CmdResult<DuckPlan> {
    let tools = state.media.tools.clone().ok_or_else(|| CommandError::new("ffmpegMissing", "FFmpeg not found"))?;
    if triggers.iter().any(|t| targets.contains(t)) {
        return Err(CommandError::new("invalid", "a track cannot trigger and be ducked at once"));
    }
    struct Trigger {
        name: String,
        path: PathBuf,
        clip: Clip,
        has_audio: bool,
    }
    let (fps, trig, target_clips) = {
        let s = lock(&state.session);
        let seq = s.project.sequence(sequence).ok_or(EditError::SequenceNotFound)?;
        let fps = seq.settings.fps.as_f64();
        let audio = |id: &Uuid| seq.track(*id).filter(|t| t.kind == TrackKind::Audio);
        let mut trig = Vec::new();
        for t in triggers.iter().filter_map(audio) {
            for c in t.clips.iter().filter(|c| c.enabled) {
                let a = s.project.media(c.media_id).ok_or(EditError::MediaNotFound)?;
                trig.push(Trigger { name: c.name.clone(), path: a.path.clone(), clip: c.clone(), has_audio: a.has_audio() && s.project.sequence(a.id).is_none() });
            }
        }
        let target_clips: Vec<Clip> = targets.iter().filter_map(audio).flat_map(|t| t.clips.iter().cloned()).collect();
        (fps, trig, target_clips)
    };
    if trig.is_empty() {
        return Err(CommandError::new("noTriggers", "the trigger tracks hold no audio clips"));
    }
    let guard = Job::new(job);
    let cancel = &*guard.1;
    let mut ranges = Vec::new();
    let mut unreadable = Vec::new();
    for t in &trig {
        if !t.has_audio || !t.path.is_file() || t.clip.reverse || t.clip.is_warped() {
            unreadable.push(t.name.clone());
            continue;
        }
        let from = t.clip.source_in as f64 / fps;
        let len = (t.clip.source_out() - t.clip.source_in) as f64 / fps;
        let levels = detect::audio_levels(&tools, &t.path, from, Some(len), cancel).map_err(media_err)?;
        let report = detect::detect_silence(&levels, &speech);
        // Speech is what lies between the pauses (the padding counts as speech).
        let mut at = 0.0;
        for p in report.silences.iter().map(|p| (p.cut_start - from, p.cut_end - from)).chain([(len, len)]) {
            if p.0 > at {
                if let Some((a, b)) = assist::timeline_range(&t.clip, fps, from + at, from + p.0) {
                    ranges.push((a as f64 / fps, b as f64 / fps));
                }
            }
            at = p.1.max(at);
        }
    }
    let speech_ranges = assist::merge_ranges(ranges, 0.0);
    let curve = assist::duck_curve(&speech_ranges, &duck);
    let mut clips = Vec::new();
    let mut skipped = Vec::new();
    for c in &target_clips {
        match assist::duck_keys(c, fps, &speech_ranges, &duck) {
            Some(keys) => clips.push(DuckClip { clip: c.id, name: c.name.clone(), keys, replaces_keys: !c.keys_of(Param::Volume).is_empty() }),
            None => skipped.push(c.name.clone()),
        }
    }
    Ok(DuckPlan { speech: speech_ranges, curve, clips, skipped, unreadable })
}
