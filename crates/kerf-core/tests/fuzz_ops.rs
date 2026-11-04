//! Random edit sequences against the model invariants.
//!
//! Every step applies a random command through the history and checks:
//! clips sorted and not overlapping, source ranges inside the media, speed,
//! fades and keys valid, transitions only between touching clips, clips on a
//! track of their kind, a failed command leaves the project untouched, undo
//! and redo restore exactly, and the project survives a save/load round trip.
//! Failures print the seed and the step so they can be replayed.

use kerf_core::history::History;
use kerf_core::model::*;
use kerf_core::ops::{ClipPatch, Edge, EditCommand, MediaPatch, PasteItem, PlaceMode, TrackPatch, TransitionEdit};
use kerf_core::time::{Frame, Rational};
use uuid::Uuid;

const FPS: Rational = Rational::new(25, 1);

/// xorshift64*: deterministic, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % (hi - lo + 1) as u64) as i64
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
    fn pick<T: Copy>(&mut self, v: &[T]) -> Option<T> {
        (!v.is_empty()).then(|| v[self.below(v.len())])
    }
}

fn asset(name: &str, kind: MediaKind, seconds: f64, video: bool, audio: bool) -> MediaAsset {
    MediaAsset {
        id: Uuid::new_v4(),
        path: format!("{name}.bin").into(),
        name: name.into(),
        kind,
        status: MediaStatus::Ready,
        info: Some(MediaInfo {
            duration: seconds,
            size_bytes: 1,
            container: "mov".into(),
            bit_rate: None,
            video: video.then(|| VideoInfo {
                codec: "h264".into(),
                profile: None,
                width: 1280,
                height: 720,
                fps: FPS,
                pix_fmt: None,
                bit_rate: None,
                rotation: 0,
                color: Default::default(),
            }),
            audio: audio.then(|| AudioInfo { codec: "aac".into(), channels: 2, sample_rate: 48_000, channel_layout: None, bit_rate: None }),
        }),
        bin: None,
        favorite: false,
        label: Default::default(),
        tags: Vec::new(),
        note: String::new(),
        imported_at: 0,
        derived: Derived::default(),
        marks: Default::default(),
        matrix: Default::default(),
        title: None,
    }
}

fn project() -> Project {
    let mut p = Project::new("fuzz", 0);
    p.media = vec![
        asset("av10", MediaKind::Video, 10.0, true, true),
        asset("av3", MediaKind::Video, 3.04, true, true),
        asset("v4", MediaKind::Video, 4.0, true, false),
        asset("a8", MediaKind::Audio, 8.0, false, true),
        asset("still", MediaKind::Image, 0.04, true, false),
    ];
    p
}

fn all_clips(seq: &Sequence) -> Vec<Uuid> {
    seq.tracks.iter().flat_map(|t| &t.clips).map(|c| c.id).collect()
}

fn invariants(p: &Project) -> Result<(), String> {
    for seq in &p.sequences {
        let rate = seq.settings.fps;
        for (ti, t) in seq.tracks.iter().enumerate() {
            let mut last_end = 0;
            for (ci, c) in t.clips.iter().enumerate() {
                let at = format!("{} track {ti} clip {ci} ({}, id {})", seq.name, c.name, c.id);
                if c.duration < 1 {
                    return Err(format!("{at}: duration {}", c.duration));
                }
                if c.start < last_end {
                    return Err(format!("{at}: starts at {} before the previous end {last_end}", c.start));
                }
                last_end = c.end();
                if !(c.speed.is_finite() && (kerf_core::timemap::MIN_SPEED..=kerf_core::timemap::MAX_SPEED).contains(&c.speed)) {
                    return Err(format!("{at}: speed {}", c.speed));
                }
                if c.fade_in < 0 || c.fade_out < 0 || c.fade_in + c.fade_out > c.duration {
                    return Err(format!("{at}: fades {} + {} over {}", c.fade_in, c.fade_out, c.duration));
                }
                for (param, keys) in &c.keys {
                    if keys.windows(2).any(|w| w[0].at >= w[1].at) {
                        return Err(format!("{at}: keys of {param:?} not strictly sorted"));
                    }
                }
                if c.source_in < 0 {
                    return Err(format!("{at}: source_in {}", c.source_in));
                }
                if let Some(m) = p.media(c.media_id) {
                    let fits = match t.kind {
                        TrackKind::Video => m.has_video(),
                        TrackKind::Audio => m.has_audio(),
                    };
                    if !fits {
                        return Err(format!("{at}: media {} on a {:?} track", m.name, t.kind));
                    }
                    if let Some(len) = m.length_frames(rate) {
                        if !c.shows_only_media(len) {
                            let (a, b) = (c.shown_frame(0), c.shown_frame(c.duration - 1));
                            return Err(format!("{at}: shows source frames {a}..={b} of a media with {len} (speed {}, reverse {})", c.speed, c.reverse));
                        }
                    }
                } else if p.sequence(c.media_id).is_none() {
                    return Err(format!("{at}: unknown media"));
                }
            }
            let mut tidy = t.clone();
            if tidy.tidy_transitions() {
                return Err(format!("{} track {ti}: transition between clips that do not touch", seq.name));
            }
        }
        if let (Some(i), Some(o)) = (seq.in_point, seq.out_point) {
            if o <= i {
                return Err(format!("{}: in {i} not before out {o}", seq.name));
            }
        }
        if seq.subtitles.cues.iter().any(|c| c.end <= c.start || c.start < 0) || seq.subtitles.cues.windows(2).any(|w| w[0].end > w[1].start) {
            return Err(format!("{}: subtitle cues empty, negative or overlapping", seq.name));
        }
        if seq.markers.windows(2).any(|w| w[0].frame > w[1].frame) {
            return Err(format!("{}: markers not sorted", seq.name));
        }
    }
    if p.sequence(p.active_sequence).is_none() {
        return Err("active sequence missing".into());
    }
    // Media and bins sit in existing bins that hold things (not smart ones), without loops.
    let holds = |id: Uuid| p.bins.iter().any(|b| b.id == id && b.smart.is_none());
    if let Some(m) = p.media.iter().find(|m| m.bin.is_some_and(|b| !holds(b))) {
        return Err(format!("media {} in a missing or smart bin", m.name));
    }
    for b in &p.bins {
        let mut at = b.parent;
        for _ in 0..=p.bins.len() {
            match at {
                Some(id) if !holds(id) || id == b.id => return Err(format!("bin {} under a missing or smart bin, or in a loop", b.name)),
                Some(id) => at = p.bins.iter().find(|x| x.id == id).and_then(|x| x.parent),
                None => break,
            }
        }
        if at.is_some() {
            return Err(format!("bin {} in a loop", b.name));
        }
    }
    Ok(())
}

fn random_command(r: &mut Rng, p: &Project, clipboard: &[PasteItem]) -> EditCommand {
    let seq = p.sequence(p.active_sequence).expect("active");
    let sequence = seq.id;
    let clips = all_clips(seq);
    let tracks: Vec<Uuid> = seq.tracks.iter().map(|t| t.id).collect();
    let clip = r.pick(&clips);
    let frame = r.range(0, seq.duration().max(50) + 30);
    let delta = r.range(-80, 80);
    let linked = r.chance(70);
    let some_clips = |r: &mut Rng| -> Vec<Uuid> { clips.iter().copied().filter(|_| r.chance(35)).collect() };
    let media_ids: Vec<Uuid> = p.media.iter().map(|m| m.id).chain(p.sequences.iter().filter(|s| s.id != sequence).map(|s| s.id)).collect();
    let mode = if r.chance(50) { PlaceMode::Insert } else { PlaceMode::Overwrite };
    let multicams: Vec<Uuid> = p.multicams.iter().map(|m| m.id).collect();
    match r.below(33) {
        32 => {
            // Media and bins, sometimes with an id that does not exist.
            let bins: Vec<Uuid> = p.bins.iter().map(|b| b.id).chain([Uuid::new_v4()]).collect();
            let mut media: Vec<Uuid> = p.media.iter().map(|m| m.id).filter(|_| r.chance(50)).collect();
            if r.chance(20) {
                media.push(Uuid::new_v4());
            }
            match r.below(6) {
                0 => EditCommand::UpdateMedia { media, patch: MediaPatch { favorite: Some(r.chance(50)), tags: Some(vec![" a ".into(), "b".into(), "a".into()]), note: Some("Notiz".into()), ..Default::default() } },
                1 => EditCommand::SetMediaFavorite { media, favorite: r.chance(50) },
                2 => EditCommand::MoveMediaToBin { media, bin: r.chance(80).then(|| r.pick(&bins)).flatten() },
                3 => {
                    let smart = r.chance(50).then(|| SmartRules { kinds: vec![SmartKind::Video], tags: vec!["a".into()], usage: SmartUsage::Unused, ..Default::default() });
                    EditCommand::CreateBin { name: "Ablage".into(), parent: r.chance(60).then(|| r.pick(&bins)).flatten(), smart }
                }
                4 => EditCommand::SetSmartRules { bin: r.pick(&bins).unwrap_or_default(), rules: SmartRules { favorites: r.chance(50), ..Default::default() } },
                _ => EditCommand::RemoveBin { bin: r.pick(&bins).unwrap_or_default() },
            }
        }
        24 => {
            let fps = [Rational::new(25, 1), Rational::new(50, 1), Rational::new(24, 1), Rational::new(30000, 1001), Rational::new(60, 1)][r.below(5)];
            EditCommand::UpdateSequenceSettings { sequence, settings: SequenceSettings { fps, ..seq.settings } }
        }
        25 => EditCommand::ReplaceMedia { sequence, clip: clip.unwrap_or_default(), media: r.pick(&media_ids).unwrap_or_default() },
        26 => {
            if r.chance(50) {
                EditCommand::RemoveMedia { media: vec![r.pick(&media_ids).unwrap_or_default()] }
            } else {
                EditCommand::RemoveSequence { sequence: r.pick(&p.sequences.iter().map(|s| s.id).collect::<Vec<_>>()).unwrap_or_default() }
            }
        }
        27 => {
            let mut a = asset("frozen", MediaKind::Image, 0.04, true, false);
            a.id = Uuid::new_v4();
            EditCommand::InsertStill { sequence, asset: Box::new(a), track: r.pick(&tracks).unwrap_or_default(), at: frame, duration: r.range(-2, 60) }
        }
        28 => {
            let mut angles = Vec::new();
            for m in &p.media {
                if r.chance(60) {
                    angles.push(Angle { media: m.id, name: String::new(), offset: r.range(-20, 20) as f64 / 10.0 });
                }
            }
            EditCommand::CreateMulticam { multicam: Multicam { id: Uuid::new_v4(), name: "MC".into(), angles } }
        }
        29 => match r.pick(&multicams) {
            Some(m) => EditCommand::PlaceMulticam { sequence, multicam: m, at: frame, mode, video_angle: r.below(4), audio_angle: r.chance(60).then(|| r.below(4)), video_track: None, audio_track: None },
            None => EditCommand::AddTrack { sequence, kind: TrackKind::Video },
        },
        30 => EditCommand::SwitchAngle { sequence, clip: clip.unwrap_or_default(), angle: r.below(4), at: r.chance(50).then_some(frame) },
        31 => {
            let mut cues = Vec::new();
            for _ in 0..r.below(5) {
                let a = r.range(-5, 300);
                cues.push(Cue { id: Uuid::new_v4(), start: a, end: a + r.range(-5, 80), text: "Text".into() });
            }
            if r.chance(50) {
                EditCommand::SetSubtitles { sequence, cues }
            } else {
                let mut gains = Vec::new();
                for &c in &clips {
                    if r.chance(30) {
                        gains.push(kerf_core::ops::ClipGain { clip: c, volume_db: r.range(-30, 30) as f32, limit_db: r.chance(50).then_some(-1.0) });
                    }
                }
                EditCommand::SetClipGain { sequence, gains }
            }
        }
        0..=3 => {
            let media = r.pick(&media_ids).expect("media");
            let (sin, sout) = if r.chance(50) {
                let a = r.range(0, 200);
                (Some(a), Some(a + r.range(-5, 120)))
            } else {
                (None, None)
            };
            let video_track = r.pick(&tracks).filter(|_| r.chance(40));
            let audio_track = r.pick(&tracks).filter(|_| r.chance(40));
            EditCommand::PlaceMedia { sequence, media, video_track, audio_track, at: frame, mode, source_in: sin, source_out: sout, match_sequence: false }
        }
        4 => EditCommand::MoveClips { sequence, clips: some_clips(r), delta, track_delta: r.range(-2, 2) as i32, track_kind: if r.chance(50) { Some(TrackKind::Video) } else { None } },
        5 | 6 => EditCommand::TrimClip { sequence, clip: clip.unwrap_or_default(), edge: if r.chance(50) { Edge::Start } else { Edge::End }, delta, ripple: r.chance(40), linked },
        7 => EditCommand::RollEdit { sequence, clip: clip.unwrap_or_default(), delta, linked },
        8 => EditCommand::SlipClip { sequence, clip: clip.unwrap_or_default(), delta, linked },
        9 => EditCommand::SlideClip { sequence, clip: clip.unwrap_or_default(), delta, linked },
        10 => EditCommand::SplitAt { sequence, frame, clips: if r.chance(50) { None } else { Some(some_clips(r)) } },
        11 => EditCommand::DeleteClips { sequence, clips: some_clips(r), ripple: r.chance(50) },
        12 => {
            let a = r.range(0, frame);
            EditCommand::RemoveRange { sequence, start: a, end: a + r.range(-3, 60), ripple: r.chance(50), tracks: if r.chance(50) { None } else { Some(tracks.iter().copied().filter(|_| r.chance(50)).collect()) } }
        }
        13 => EditCommand::CloseGap { sequence, track: r.pick(&tracks).unwrap_or_default(), frame },
        14 => EditCommand::PasteClips { sequence, items: clipboard.to_vec(), at: frame },
        15 => EditCommand::DuplicateClips { sequence, clips: some_clips(r) },
        16 => {
            let patch = match r.below(5) {
                0 => ClipPatch { speed: Some([0.25, 0.5, 1.0, 1.5, 2.0, 3.7, 0.0, -1.0, 1e9][r.below(9)]), ..Default::default() },
                1 => ClipPatch { reverse: Some(r.chance(50)), ..Default::default() },
                2 => ClipPatch { fade_in: Some(r.range(-5, 80)), fade_out: Some(r.range(-5, 80)), ..Default::default() },
                3 => ClipPatch { enabled: Some(r.chance(50)), opacity: Some(r.range(-1, 2) as f32), ..Default::default() },
                _ => ClipPatch { volume_db: Some(r.range(-100, 30) as f32), pan: Some(r.range(-2, 2) as f32), ..Default::default() },
            };
            EditCommand::UpdateClips { sequence, clips: some_clips(r), patch }
        }
        17 => {
            let c = clip.and_then(|id| seq.clip(id));
            let param = [Param::Opacity, Param::Speed, Param::Volume, Param::X][r.below(4)];
            let base = c.map_or(0, |c| c.source_in);
            let mut keys: Vec<Keyframe> = (0..r.below(4))
                .map(|_| Keyframe { at: base + r.range(-10, 150), value: [0.3, 1.0, 2.5, 0.0, -3.0, 50.0][r.below(6)], ease: Ease::Linear })
                .collect();
            if r.chance(70) {
                keys.sort_by_key(|k| k.at);
            }
            EditCommand::SetKeyframes { sequence, clip: clip.unwrap_or_default(), param, keys }
        }
        18 => {
            let kind = [TransitionKind::Dissolve, TransitionKind::Crossfade, TransitionKind::WipeLeft, TransitionKind::IrisRound, TransitionKind::PushUp][r.below(5)];
            let align = [TransitionAlign::Center, TransitionAlign::Start, TransitionAlign::End][r.below(3)];
            let items = some_clips(r).into_iter().map(|clip| TransitionEdit { clip, transition: r.chance(80).then(|| Transition { kind, duration: r.range(-2, 60), align }) }).collect();
            EditCommand::SetTransitions { sequence, items }
        }
        19 => {
            if r.chance(50) {
                EditCommand::LinkClips { sequence, clips: some_clips(r) }
            } else {
                EditCommand::UnlinkClips { sequence, clips: some_clips(r) }
            }
        }
        20 => match r.below(3) {
            0 => EditCommand::AddTrack { sequence, kind: if r.chance(50) { TrackKind::Video } else { TrackKind::Audio } },
            1 => EditCommand::RemoveTrack { sequence, track: r.pick(&tracks).unwrap_or_default() },
            _ => EditCommand::UpdateTrack { sequence, track: r.pick(&tracks).unwrap_or_default(), patch: TrackPatch { locked: Some(r.chance(25)), ..Default::default() } },
        },
        21 => {
            let a = r.range(-5, 200);
            EditCommand::SetInOut { sequence, in_point: r.chance(70).then_some(a), out_point: r.chance(70).then(|| a + r.range(-10, 100)) }
        }
        22 => {
            if r.chance(60) {
                EditCommand::AddMarker { sequence, frame: r.range(-5, 300), name: "m".into(), color: MarkerColor::Blue }
            } else {
                EditCommand::NestClips { sequence, clips: some_clips(r), name: "Nest".into() }
            }
        }
        _ => {
            // Switch the edited sequence now and then (nested sequences live there).
            if p.sequences.len() < 3 && r.chance(30) {
                EditCommand::AddSequence { name: "S".into(), settings: SequenceSettings::default() }
            } else {
                let mut cuts = Vec::new();
                for _ in 0..r.below(4) {
                    cuts.push(EditCommand::SplitAt { sequence, frame: r.range(0, 400), clips: None });
                }
                EditCommand::Batch { label: kerf_core::ops::BatchLabel::SceneCuts, commands: cuts }
            }
        }
    }
}

fn run(seed: u64, steps: usize) {
    let mut r = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut p = project();
    let mut h = History::new(200);
    let mut clipboard: Vec<PasteItem> = Vec::new();
    let mut log: Vec<String> = Vec::new();
    for step in 0..steps {
        if r.chance(8) && p.sequences.len() > 1 {
            p.active_sequence = p.sequences[r.below(p.sequences.len())].id;
        }
        if r.chance(10) {
            let seq = p.sequence(p.active_sequence).unwrap();
            clipboard = seq.tracks.iter().flat_map(|t| t.clips.iter().map(move |c| (t, c))).filter(|_| r.chance(30)).map(|(t, c)| PasteItem { clip: c.clone(), track: t.id, kind: t.kind, rate: Some(seq.settings.fps) }).collect();
        }
        let cmd = random_command(&mut r, &p, &clipboard);
        let before = p.clone();
        log.push(format!("{step}: {cmd:?}"));
        let fail = |what: String, p: &Project, log: &[String]| -> ! {
            let tail = &log[log.len().saturating_sub(6)..];
            // The clip named in the message, before this step (for replays).
            let id = what.split("id ").nth(1).and_then(|s| s.get(..36)).and_then(|s| Uuid::parse_str(s).ok());
            let was = id.and_then(|id| before.sequences.iter().find_map(|s| s.clip(id))).map(|c| format!("{c:?}")).unwrap_or_default();
            let now = id.and_then(|id| p.sequences.iter().find_map(|s| s.clip(id))).map(|c| format!("{c:?}")).unwrap_or_default();
            let target = log.last().and_then(|l| l.split("clip: ").nth(1)).and_then(|s| s.get(..36)).and_then(|s| Uuid::parse_str(s).ok());
            let target = target.and_then(|id| before.sequences.iter().find_map(|s| s.clip(id).map(|c| (s.locate(id), c.clone())))).map(|c| format!("{c:?}")).unwrap_or_default();
            panic!("seed {seed}, step {step}: {what}\nclip before this step: {was}\nafter: {now}\ncommand target before: {target}\nlast commands:\n{}", tail.join("\n"));
        };
        match h.apply(&mut p, &cmd) {
            Ok(out) => {
                if let Err(e) = invariants(&p) {
                    fail(e, &p, &log);
                }
                if out.changed {
                    let after = p.clone();
                    h.undo(&mut p);
                    if p != before {
                        fail("undo does not restore the project".into(), &p, &log);
                    }
                    h.redo(&mut p);
                    if p != after {
                        fail("redo does not restore the edit".into(), &p, &log);
                    }
                } else if p != before {
                    fail("unchanged outcome but the project changed".into(), &p, &log);
                }
            }
            Err(_) => {
                if p != before {
                    fail("a failed command changed the project".into(), &p, &log);
                }
            }
        }
        if step % 10 == 9 {
            let bytes = serde_json::to_vec(&p).unwrap();
            let back = kerf_core::io::from_json(&bytes).unwrap_or_else(|e| fail(format!("reload failed: {e}"), &p, &log));
            if back != p {
                let (a, b) = (serde_json::to_value(&p).unwrap(), serde_json::to_value(&back).unwrap());
                fail(format!("save/load round trip changes the project: {}", first_diff(&a, &b, String::new())), &p, &log);
            }
        }
        if r.chance(5) {
            h.undo(&mut p);
            if let Err(e) = invariants(&p) {
                fail(format!("after a random undo: {e}"), &p, &log);
            }
        }
    }
}

fn first_diff(a: &serde_json::Value, b: &serde_json::Value, at: String) -> String {
    use serde_json::Value as V;
    match (a, b) {
        (V::Object(x), V::Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                if x.get(k) != y.get(k) {
                    return match (x.get(k), y.get(k)) {
                        (Some(u), Some(v)) => first_diff(u, v, format!("{at}.{k}")),
                        (u, v) => format!("{at}.{k}: {u:?} vs {v:?}"),
                    };
                }
            }
            format!("{at}: equal")
        }
        (V::Array(x), V::Array(y)) if x.len() == y.len() => {
            for (i, (u, v)) in x.iter().zip(y).enumerate() {
                if u != v {
                    return first_diff(u, v, format!("{at}[{i}]"));
                }
            }
            format!("{at}: equal")
        }
        _ => format!("{at}: {a} vs {b}"),
    }
}

#[test]
fn random_edits_keep_the_model_valid() {
    let seeds: u64 = std::env::var("KERF_FUZZ_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(300);
    for seed in 0..seeds {
        run(seed, 80);
    }
}

#[allow(dead_code)]
fn _frame(_: Frame) {}
