//! End-to-end media pipeline test against a real FFmpeg:
//! generate media -> probe -> analyse -> edit -> render -> verify the output.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use kerf_core::history::History;
use kerf_core::model::*;
use kerf_core::ops::{ClipPatch, EditCommand, PlaceMode};
use kerf_core::time::Rational;
use kerf_media::render::{self, AudioCodec, ExportSettings, RateControl, VideoCodec};
use kerf_media::{analysis, probe, Tools};
use uuid::Uuid;

fn tools() -> Option<Tools> {
    match Tools::discover() {
        Ok(t) => Some(t),
        Err(_) => {
            eprintln!("ffmpeg not found - skipping media pipeline test");
            None
        }
    }
}

fn ffmpeg(tools: &Tools, args: &[&str]) {
    let status = tools.ffmpeg_cmd().args(args).status().expect("spawn ffmpeg");
    assert!(status.success(), "ffmpeg {args:?}");
}

/// Mean luma (0..255) of the frame at `t` seconds.
fn mean_luma(tools: &Tools, file: &Path, t: f64) -> f64 {
    let out = tools
        .ffmpeg_cmd()
        .args(["-ss", &format!("{t}"), "-i"])
        .arg(file)
        .args(["-frames:v", "1", "-vf", "scale=64:36", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"])
        .output()
        .unwrap();
    assert!(out.status.success());
    out.stdout.iter().map(|b| *b as f64).sum::<f64>() / out.stdout.len().max(1) as f64
}

fn import(tools: &Tools, path: &Path, cache: &Path) -> MediaAsset {
    let (kind, info) = probe::probe(tools, path).expect("probe");
    let dir = analysis::cache_dir(cache, path);
    let mut derived = Derived { preview_native: analysis::preview_native(kind, &info, path), ..Default::default() };
    if kind != MediaKind::Audio {
        derived.poster = Some(analysis::poster(tools, path, kind, &info, &dir).expect("poster"));
    }
    if kind == MediaKind::Video {
        derived.filmstrip = Some(analysis::filmstrip(tools, path, &info, &dir).expect("filmstrip"));
    }
    if info.audio.is_some() {
        derived.peaks = Some(analysis::peaks(tools, path, &dir).expect("peaks"));
    }
    MediaAsset {
        id: Uuid::new_v4(),
        path: path.to_path_buf(),
        name: path.file_stem().unwrap().to_string_lossy().into(),
        kind,
        status: MediaStatus::Ready,
        info: Some(info),
        bin: None,
        favorite: false,
        label: Default::default(),
        tags: Vec::new(),
        note: String::new(),
        imported_at: 0,
        derived,
    }
}

#[test]
fn edit_and_render_real_media() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let cache = d.join("cache");
    let src = d.join("src.mp4");
    let tone = d.join("tone.wav");
    let still = d.join("still.png");
    let s = |p: &Path| p.to_string_lossy().into_owned();

    ffmpeg(&tools, &[
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", &s(&src),
    ]);
    ffmpeg(&tools, &["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2", "-y", &s(&tone)]);
    ffmpeg(&tools, &["-f", "lavfi", "-i", "color=c=white:s=320x180", "-frames:v", "1", "-y", &s(&still)]);

    // --- analysis -----------------------------------------------------------
    let video = import(&tools, &src, &cache);
    let audio = import(&tools, &tone, &cache);
    let image = import(&tools, &still, &cache);
    assert_eq!(video.kind, MediaKind::Video);
    assert_eq!(audio.kind, MediaKind::Audio);
    assert_eq!(image.kind, MediaKind::Image);
    assert!(video.derived.preview_native, "h264/aac mp4 plays natively");
    let vinfo = video.info.as_ref().unwrap();
    assert_eq!(vinfo.video.as_ref().unwrap().fps, Rational::new(25, 1));
    assert!((vinfo.duration - 4.0).abs() < 0.1);
    let strip = video.derived.filmstrip.as_ref().unwrap();
    assert!(strip.path.is_file() && strip.tiles == 4);
    let peaks = std::fs::read(&video.derived.peaks.as_ref().unwrap().path).unwrap();
    assert!((395..=405).contains(&peaks.len()), "peaks: {}", peaks.len());
    // lavfi's sine source plays at 1/8 full scale (255 / 8 ≈ 31); AAC adds some overshoot.
    let max = peaks.iter().copied().max().unwrap();
    assert!((25..=50).contains(&max), "sine peak {max}");

    // Proxy generation (cancellable, with progress).
    let cancel = AtomicBool::new(false);
    let mut last = 0.0;
    let proxy = analysis::proxy(&tools, &src, MediaKind::Video, vinfo, &analysis::cache_dir(&cache, &src), &cancel, |p| last = p)
        .expect("proxy");
    assert!(proxy.is_file());
    assert_eq!(last, 1.0);
    let (_, pinfo) = probe::probe(&tools, &proxy).unwrap();
    assert!((pinfo.duration - 4.0).abs() < 0.15);

    // --- editing ------------------------------------------------------------
    let mut p = Project::new("pipeline", 0);
    let mut h = History::default();
    let (vid, aid, iid) = (video.id, audio.id, image.id);
    h.apply(&mut p, &EditCommand::ImportMedia { assets: vec![video, audio, image] }).unwrap();
    let seq = p.active_sequence;
    let place = |media, at, sin: Option<i64>, sout: Option<i64>| EditCommand::PlaceMedia {
        sequence: seq,
        media,
        video_track: None,
        audio_track: None,
        at,
        mode: PlaceMode::Overwrite,
        source_in: sin,
        source_out: sout,
        match_sequence: true,
    };
    let created = h.apply(&mut p, &place(vid, 0, None, None)).unwrap().created;
    assert_eq!(p.sequence(seq).unwrap().settings.width, 640, "sequence matched to first clip");
    let v_clip = created[0];
    // Fade in over 10 frames: the very first frame must be black.
    h.apply(&mut p, &EditCommand::UpdateClips {
        sequence: seq,
        clips: vec![v_clip],
        patch: ClipPatch { fade_in: Some(10), ..Default::default() },
    })
    .unwrap();
    // Cut at 2 s and remove the second half's audio from the mix.
    h.apply(&mut p, &EditCommand::SplitAt { sequence: seq, frame: 50, clips: None }).unwrap();
    // A white still on V2, scaled down, from 1 s to 3 s.
    let v2 = p.sequence(seq).unwrap().tracks[1].id;
    let still_ids = h
        .apply(&mut p, &EditCommand::PlaceMedia {
            sequence: seq,
            media: iid,
            video_track: Some(v2),
            audio_track: None,
            at: 25,
            mode: PlaceMode::Overwrite,
            source_in: None,
            source_out: Some(50),
            match_sequence: false,
        })
        .unwrap()
        .created;
    h.apply(&mut p, &EditCommand::UpdateClips {
        sequence: seq,
        clips: still_ids,
        patch: ClipPatch {
            transform: Some(Transform { scale: 0.5, x: 100.0, ..Default::default() }),
            ..Default::default()
        },
    })
    .unwrap();
    // A tone on A2 at 1 s.
    let a2 = p.sequence(seq).unwrap().tracks.iter().filter(|t| t.kind == TrackKind::Audio).nth(1).unwrap().id;
    h.apply(&mut p, &EditCommand::PlaceMedia {
        sequence: seq,
        media: aid,
        video_track: None,
        audio_track: Some(a2),
        at: 25,
        mode: PlaceMode::Overwrite,
        source_in: None,
        source_out: None,
        match_sequence: false,
    })
    .unwrap();

    // Save, reload and render the reloaded project.
    let proj_path = d.join("pipeline.kerf");
    kerf_core::io::save(&p, &proj_path).unwrap();
    let p = kerf_core::io::load(&proj_path).unwrap();
    let sequence = p.sequence(seq).unwrap();
    assert_eq!(sequence.duration(), 100);

    // --- render -------------------------------------------------------------
    let out = d.join("export.mp4");
    let settings = ExportSettings {
        output: out.clone(),
        video_codec: VideoCodec::H264,
        hardware: false,
        width: 640,
        height: 360,
        fps: Rational::new(25, 1),
        rate: RateControl::Quality { crf: 20 },
        audio_codec: AudioCodec::Aac,
        audio_bitrate_kbps: 192,
        sample_rate: 48_000,
        audio_channels: 2,
        use_in_out: false,
    };
    let plan = render::plan(&p, sequence, &settings, d, &[]).unwrap();
    assert_eq!(plan.inputs, 6, "2 video halves + still + 2 audio halves + tone\n{}", plan.graph);
    let mut updates = 0;
    render::render(&tools, &plan, &AtomicBool::new(false), |_| updates += 1).unwrap_or_else(|e| panic!("{e}\n{}", plan.graph));
    assert!(updates > 0);
    assert!(out.is_file() && !plan.partial_path.exists());

    let (kind, info) = probe::probe(&tools, &out).unwrap();
    assert_eq!(kind, MediaKind::Video);
    let v = info.video.as_ref().unwrap();
    assert_eq!((v.width, v.height), (640, 360));
    assert!((info.duration - 4.0).abs() < 0.1, "duration {}", info.duration);
    assert!(info.audio.is_some());

    // Pixel checks: black at frame 0 (fade-in), picture at 0.6 s, white still at 2 s centre-right.
    assert!(mean_luma(&tools, &out, 0.0) < 8.0);
    assert!(mean_luma(&tools, &out, 0.6) > 40.0);
    let probe_still = tools
        .ffmpeg_cmd()
        .args(["-ss", "2", "-i"])
        .arg(&out)
        .args(["-frames:v", "1", "-vf", "crop=20:20:410:170", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"])
        .output()
        .unwrap();
    let mean = probe_still.stdout.iter().map(|b| *b as f64).sum::<f64>() / probe_still.stdout.len() as f64;
    assert!(mean > 230.0, "still overlay at its transformed position, got {mean}");

    // Hardware encoding, when this machine has a working encoder.
    let hw = tools.working_hw_encoders();
    if hw.iter().any(|e| e == "h264_nvenc") {
        let out_hw = d.join("export_hw.mp4");
        let plan = render::plan(&p, sequence, &ExportSettings { output: out_hw.clone(), hardware: true, ..settings }, d, &hw).unwrap();
        assert_eq!(plan.encoder, "h264_nvenc");
        render::render(&tools, &plan, &AtomicBool::new(false), |_| {}).unwrap();
        let (_, info) = probe::probe(&tools, &out_hw).unwrap();
        assert!((info.duration - 4.0).abs() < 0.1);
    }
}

#[test]
fn cancelled_render_leaves_no_file() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("long.mp4");
    ffmpeg(&tools, &[
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=20",
        "-c:v", "libx264", "-preset", "ultrafast", "-y", &src.to_string_lossy(),
    ]);
    let asset = import(&tools, &src, &dir.path().join("cache"));
    let mut p = Project::new("c", 0);
    let id = asset.id;
    p.media.push(asset);
    let seq = p.active_sequence;
    kerf_core::ops::apply(&mut p, &EditCommand::PlaceMedia {
        sequence: seq, media: id, video_track: None, audio_track: None, at: 0,
        mode: PlaceMode::Overwrite, source_in: None, source_out: None, match_sequence: true,
    })
    .unwrap();
    let out = dir.path().join("never.mp4");
    let settings = ExportSettings {
        output: out.clone(),
        video_codec: VideoCodec::Hevc,
        hardware: false,
        width: 1280,
        height: 720,
        fps: Rational::new(30, 1),
        rate: RateControl::Quality { crf: 20 },
        audio_codec: AudioCodec::Aac,
        audio_bitrate_kbps: 192,
        sample_rate: 48_000,
        audio_channels: 2,
        use_in_out: false,
    };
    let plan = render::plan(&p, p.sequence(seq).unwrap(), &settings, dir.path(), &[]).unwrap();
    let cancel = AtomicBool::new(false);
    let res = render::render(&tools, &plan, &cancel, |pr| {
        if pr.frame > 0 {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    });
    assert!(matches!(res, Err(kerf_media::MediaError::Cancelled)));
    assert!(!out.exists() && !plan.partial_path.exists() && !plan.graph_path.exists());
}

/// Mean luma (0..255) of the left or right half of the frame at `t` seconds.
fn half_luma(tools: &Tools, file: &Path, t: f64, left: bool) -> f64 {
    let crop = if left { "crop=iw/2:ih:0:0" } else { "crop=iw/2:ih:iw/2:0" };
    let out = tools
        .ffmpeg_cmd()
        .args(["-ss", &format!("{t}"), "-i"])
        .arg(file)
        .args(["-frames:v", "1", "-vf", &format!("{crop},scale=32:36"), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"])
        .output()
        .unwrap();
    assert!(out.status.success());
    out.stdout.iter().map(|b| *b as f64).sum::<f64>() / out.stdout.len().max(1) as f64
}

/// RMS (0..1) of the rendered audio in `t..t+0.2` seconds.
fn audio_rms(tools: &Tools, file: &Path, t: f64) -> f64 {
    let out = tools
        .ffmpeg_cmd()
        .args(["-ss", &format!("{t}"), "-t", "0.2", "-i"])
        .arg(file)
        .args(["-vn", "-ac", "1", "-f", "s16le", "pipe:1"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let s: Vec<f64> = out.stdout.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f64 / 32768.0).collect();
    (s.iter().map(|v| v * v).sum::<f64>() / s.len().max(1) as f64).sqrt()
}

#[test]
fn keyframed_position_opacity_and_volume_render() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("white.mp4");
    ffmpeg(&tools, &[
        "-f", "lavfi", "-i", "color=c=white:s=320x180:r=25:d=2",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-y", &src.to_string_lossy(),
    ]);
    let asset = import(&tools, &src, &dir.path().join("cache"));
    let mut p = Project::new("k", 0);
    let id = asset.id;
    p.media.push(asset);
    let seq = p.active_sequence;
    let settings = SequenceSettings { width: 640, height: 360, fps: Rational::new(25, 1), sample_rate: 48_000 };
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateSequenceSettings { sequence: seq, settings }).unwrap();
    let out = kerf_core::ops::apply(&mut p, &EditCommand::PlaceMedia {
        sequence: seq, media: id, video_track: None, audio_track: None, at: 0,
        mode: PlaceMode::Overwrite, source_in: None, source_out: None, match_sequence: false,
    })
    .unwrap();
    let (v, a) = (out.created[0], out.created[1]);
    let key = |at, value| Keyframe { at, value, ease: Ease::Linear };
    let mut set = |clip, param, keys| {
        kerf_core::ops::apply(&mut p, &EditCommand::SetKeyframes { sequence: seq, clip, param, keys }).unwrap();
    };
    // A quarter-size white box travels from the left to the right half and fades to 20 %.
    set(v, Param::Scale, vec![key(0, 0.25)]);
    set(v, Param::X, vec![key(0, -200.0), key(49, 200.0)]);
    set(v, Param::Opacity, vec![key(0, 1.0), key(49, 0.2)]);
    set(a, Param::Volume, vec![key(0, -40.0), key(49, 0.0)]);

    let file = dir.path().join("keys.mp4");
    let export = ExportSettings {
        output: file.clone(),
        video_codec: VideoCodec::H264,
        hardware: false,
        width: 640,
        height: 360,
        fps: Rational::new(25, 1),
        rate: RateControl::Quality { crf: 18 },
        audio_codec: AudioCodec::Aac,
        audio_bitrate_kbps: 192,
        sample_rate: 48_000,
        audio_channels: 2,
        use_in_out: false,
    };
    let plan = render::plan(&p, p.sequence(seq).unwrap(), &export, dir.path(), &[]).unwrap();
    render::render(&tools, &plan, &AtomicBool::new(false), |_| {}).expect("render with keyframes");

    let (l0, r0) = (half_luma(&tools, &file, 0.0, true), half_luma(&tools, &file, 0.0, false));
    let (l1, r1) = (half_luma(&tools, &file, 1.92, true), half_luma(&tools, &file, 1.92, false));
    eprintln!("start L{l0:.1} R{r0:.1}  end L{l1:.1} R{r1:.1}");
    assert!(l0 > 20.0 && r0 < 5.0, "box starts on the left");
    assert!(r1 > 3.0 && l1 < 2.0, "box ends on the right");
    assert!(r1 < l0 * 0.5, "box faded towards 20 %");
    let (q, loud) = (audio_rms(&tools, &file, 0.05), audio_rms(&tools, &file, 1.7));
    eprintln!("rms start {q:.4} end {loud:.4}");
    assert!(loud > q * 10.0, "volume ramps up");
}

#[test]
fn loudness_measures_peaks_over_a_range() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("tone.wav");
    // 0.5 (-6 dBFS) for the first second, 0.05 (-26 dBFS) after.
    ffmpeg(&tools, &[
        "-f", "lavfi", "-i", "aevalsrc='if(lt(t,1),0.5,0.05)*sin(2*PI*1000*t)':s=48000:d=3",
        "-c:a", "pcm_s16le", "-y", &src.to_string_lossy(),
    ]);
    let all = analysis::loudness(&tools, &src, 0.0, None).unwrap();
    let tail = analysis::loudness(&tools, &src, 1.5, Some(1.0)).unwrap();
    let near = |v: Option<f64>, want: f64| v.is_some_and(|v| (v - want).abs() < 0.3);
    assert!(near(all.sample_peak, -6.0), "{all:?}");
    assert!(near(tail.sample_peak, -26.0), "{tail:?}");
    assert!(all.integrated.unwrap() > tail.integrated.unwrap() + 10.0, "{all:?} {tail:?}");
    assert!(all.true_peak.unwrap() >= all.sample_peak.unwrap() - 0.01);
}
