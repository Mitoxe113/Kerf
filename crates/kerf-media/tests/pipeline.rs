//! End-to-end media pipeline test against a real FFmpeg:
//! generate media -> probe -> analyse -> edit -> render -> verify the output.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use kerf_core::history::History;
use kerf_core::model::*;
use kerf_core::ops::{ClipPatch, EditCommand, PlaceMode, TransitionEdit};
use kerf_core::time::Rational;
use kerf_media::render::{self, AudioCodec, ExportSettings, LoudnessTarget, RateControl, VideoCodec};
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
        marks: Default::default(),
        title: None,
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
        subtitles: Default::default(),
        title_files: Default::default(),
        loudness: None,
        segmented: false,
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
        subtitles: Default::default(),
        title_files: Default::default(),
        loudness: None,
        segmented: false,
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
        subtitles: Default::default(),
        title_files: Default::default(),
        loudness: None,
        segmented: false,
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
fn animated_colour_renders() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("grey.mp4");
    ffmpeg(&tools, &["-f", "lavfi", "-i", "color=c=0x808080:s=320x180:r=25:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-y", &src.to_string_lossy()]);
    let asset = import(&tools, &src, &dir.path().join("cache"));
    let mut p = Project::new("c", 0);
    let id = asset.id;
    p.media.push(asset);
    let seq = p.active_sequence;
    let settings = SequenceSettings { width: 320, height: 180, fps: Rational::new(25, 1), sample_rate: 48_000 };
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateSequenceSettings { sequence: seq, settings }).unwrap();
    let out = kerf_core::ops::apply(&mut p, &EditCommand::PlaceMedia {
        sequence: seq, media: id, video_track: None, audio_track: None, at: 0,
        mode: PlaceMode::Overwrite, source_in: None, source_out: None, match_sequence: false,
    })
    .unwrap();
    let v = out.created[0];
    // -2 EV brightening to 0 EV on a custom curve; contrast held (mid-grey stays put).
    let curve = Ease::Bezier { x1: 0.42, y1: 0.0, x2: 0.58, y2: 1.0 };
    for (param, keys) in [
        (Param::Exposure, vec![Keyframe { at: 0, value: -2.0, ease: curve }, Keyframe { at: 40, value: 0.0, ease: Ease::Linear }]),
        (Param::Contrast, vec![Keyframe { at: 0, value: 0.6, ease: Ease::Hold }]),
    ] {
        kerf_core::ops::apply(&mut p, &EditCommand::SetKeyframes { sequence: seq, clip: v, param, keys }).unwrap();
    }
    let file = dir.path().join("colour.mp4");
    let export = ExportSettings {
        output: file.clone(),
        video_codec: VideoCodec::H264,
        hardware: false,
        width: 320,
        height: 180,
        fps: Rational::new(25, 1),
        rate: RateControl::Quality { crf: 12 },
        audio_codec: AudioCodec::Aac,
        audio_bitrate_kbps: 128,
        sample_rate: 48_000,
        audio_channels: 2,
        use_in_out: false,
        subtitles: Default::default(),
        title_files: Default::default(),
        loudness: None,
        segmented: false,
    };
    let plan = render::plan(&p, p.sequence(seq).unwrap(), &export, dir.path(), &[]).unwrap();
    render::render(&tools, &plan, &AtomicBool::new(false), |_| {}).expect("render with colour keys");
    let (dark, mid, end) = (mean_luma(&tools, &file, 0.0), mean_luma(&tools, &file, 0.8), mean_luma(&tools, &file, 1.8));
    eprintln!("luma {dark:.1} {mid:.1} {end:.1}");
    // 128 at 0 EV; -2 EV is a quarter, pushed further down by the contrast about 50 %.
    assert!(dark < 30.0, "starts dark");
    assert!(mid > dark + 15.0 && mid < end - 5.0, "brightens along the curve");
    assert!((end - 128.0).abs() < 6.0, "ends unchanged: {end}");
}

#[test]
fn effect_stack_renders() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("bars.mp4");
    ffmpeg(&tools, &["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-y", &src.to_string_lossy()]);
    let cube = dir.path().join("look.cube");
    std::fs::write(&cube, "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n").unwrap();
    let asset = import(&tools, &src, &dir.path().join("cache"));
    let mut p = Project::new("fx", 0);
    let id = asset.id;
    p.media.push(asset);
    let seq = p.active_sequence;
    let settings = SequenceSettings { width: 320, height: 180, fps: Rational::new(25, 1), sample_rate: 48_000 };
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateSequenceSettings { sequence: seq, settings }).unwrap();
    let out = kerf_core::ops::apply(&mut p, &EditCommand::PlaceMedia {
        sequence: seq, media: id, video_track: None, audio_track: None, at: 0,
        mode: PlaceMode::Overwrite, source_in: None, source_out: None, match_sequence: false,
    })
    .unwrap();
    let v = out.created[0];
    let fx = |kind| Effect { id: Uuid::new_v4(), enabled: true, kind };
    let effects = vec![
        fx(EffectKind::ChromaKey { color: [0.0, 1.0, 0.0], similarity: 0.12, blend: 0.05, spill: 0.5 }),
        fx(EffectKind::Lut { path: cube, intensity: 0.5 }),
        fx(EffectKind::ColorWheels { lift: [0.02, 0.0, -0.02], gamma: [1.1, 1.0, 0.9], gain: [1.05, 1.0, 0.95] }),
        fx(EffectKind::Curves { master: vec![[0.0, 0.0], [0.5, 0.6], [1.0, 1.0]], red: vec![], green: vec![], blue: vec![[0.0, 0.1], [1.0, 0.9]] }),
        fx(EffectKind::Blur { radius: 2.0 }),
        fx(EffectKind::Sharpen { amount: 0.8, radius: 1.5 }),
        fx(EffectKind::Vignette { amount: 0.5 }),
    ];
    kerf_core::ops::apply(&mut p, &EditCommand::SetEffects { sequence: seq, clips: vec![v], effects }).unwrap();
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateClips { sequence: seq, clips: vec![v], patch: ClipPatch { opacity: Some(0.8), ..Default::default() } }).unwrap();
    let file = dir.path().join("fx.mp4");
    let export = ExportSettings {
        output: file.clone(),
        video_codec: VideoCodec::H264,
        hardware: false,
        width: 320,
        height: 180,
        fps: Rational::new(25, 1),
        rate: RateControl::Quality { crf: 18 },
        audio_codec: AudioCodec::Aac,
        audio_bitrate_kbps: 128,
        sample_rate: 48_000,
        audio_channels: 2,
        use_in_out: false,
        subtitles: Default::default(),
        title_files: Default::default(),
        loudness: None,
        segmented: false,
    };
    let plan = render::plan(&p, p.sequence(seq).unwrap(), &export, dir.path(), &[]).unwrap();
    let mut log = String::new();
    let res = render::render_logged(&tools, &plan, &AtomicBool::new(false), |_| {}, &mut log);
    assert!(res.is_ok(), "{res:?}\n{log}");
    let luma = mean_luma(&tools, &file, 0.5);
    assert!(luma > 10.0 && luma < 240.0, "a picture came out: {luma}");
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

#[test]
fn subtitles_burn_embed_and_sidecar() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("black.mp4");
    ffmpeg(&tools, &["-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-y", &src.to_string_lossy()]);
    // Cue images as the UI draws them: full-size RGBA, here a white frame and a transparent one.
    let cue = dir.path().join("cue's.png");
    let blank = dir.path().join("blank.png");
    ffmpeg(&tools, &["-f", "lavfi", "-i", "color=c=white:s=320x180", "-frames:v", "1", "-pix_fmt", "rgba", "-y", &cue.to_string_lossy()]);
    ffmpeg(&tools, &["-f", "lavfi", "-i", "color=c=black@0.0:s=320x180,format=rgba", "-frames:v", "1", "-y", &blank.to_string_lossy()]);
    let asset = import(&tools, &src, &dir.path().join("cache"));
    let mut p = Project::new("subs", 0);
    let id = asset.id;
    p.media.push(asset);
    let seq = p.active_sequence;
    let settings = SequenceSettings { width: 320, height: 180, fps: Rational::new(25, 1), sample_rate: 48_000 };
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateSequenceSettings { sequence: seq, settings }).unwrap();
    kerf_core::ops::apply(&mut p, &EditCommand::PlaceMedia {
        sequence: seq, media: id, video_track: None, audio_track: None, at: 0,
        mode: PlaceMode::Overwrite, source_in: None, source_out: None, match_sequence: false,
    })
    .unwrap();
    let cues = vec![
        Cue { id: Uuid::new_v4(), start: 10, end: 20, text: "Eins".into() },
        Cue { id: Uuid::new_v4(), start: 30, end: 40, text: "Zwei".into() },
    ];
    kerf_core::ops::apply(&mut p, &EditCommand::SetSubtitles { sequence: seq, cues: cues.clone() }).unwrap();
    let file = dir.path().join("subs.mp4");
    let export = ExportSettings {
        output: file.clone(),
        video_codec: VideoCodec::H264,
        hardware: false,
        width: 320,
        height: 180,
        fps: Rational::new(25, 1),
        rate: RateControl::Quality { crf: 18 },
        audio_codec: AudioCodec::Aac,
        audio_bitrate_kbps: 128,
        sample_rate: 48_000,
        audio_channels: 2,
        use_in_out: false,
        subtitles: render::SubtitleOutput {
            burn: cues.iter().map(|c| render::BurnCue { start: c.start, end: c.end, path: cue.clone() }).collect(),
            blank: Some(blank.clone()),
            sidecar: Some(kerf_core::text::SubtitleFormat::Srt),
            embed: true,
        },
        title_files: Default::default(),
        loudness: None,
        segmented: false,
    };
    let plan = render::plan(&p, p.sequence(seq).unwrap(), &export, dir.path(), &[]).unwrap();
    let mut log = String::new();
    let res = render::render_logged(&tools, &plan, &AtomicBool::new(false), |_| {}, &mut log);
    assert!(res.is_ok(), "{res:?}\n{log}");
    // Burned in exactly while a cue is on (frames 10..20 and 30..40).
    // (`-ss t` returns the first frame at or after t.)
    for (t, white) in [(0.2, false), (0.4, true), (0.74, true), (0.8, false), (1.0, false), (1.3, true), (1.6, false), (1.9, false)] {
        let luma = mean_luma(&tools, &file, t);
        assert_eq!(luma > 128.0, white, "t={t}: {luma}\n{log}");
    }
    // Soft subtitle stream and the SRT next to the file.
    let probe = std::process::Command::new(&tools.ffprobe)
        .args(["-v", "error", "-select_streams", "s", "-show_entries", "stream=codec_name", "-of", "csv=p=0"])
        .arg(&file)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), "mov_text");
    let srt = std::fs::read_to_string(file.with_extension("srt")).unwrap();
    assert!(srt.starts_with("1\n00:00:00,400 --> 00:00:00,800\nEins\n\n2\n00:00:01,200 --> 00:00:01,600\nZwei"), "{srt}");
    // Helper files are gone.
    assert!(plan.files.iter().all(|(p, _)| !p.exists()));
}

#[test]
fn transitions_render() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let make = |name: &str, colour: &str, hz: u32| {
        let src = dir.path().join(name);
        ffmpeg(&tools, &[
            "-f", "lavfi", "-i", &format!("color=c={colour}:s=320x180:r=25:d=4"),
            "-f", "lavfi", "-i", &format!("sine=frequency={hz}:duration=4"),
            "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-y", &src.to_string_lossy(),
        ]);
        import(&tools, &src, &dir.path().join("cache"))
    };
    let (white, grey) = (make("white.mp4", "white", 440), make("grey.mp4", "0x404040", 1000));
    let mut p = Project::new("t", 0);
    let (wid, gid) = (white.id, grey.id);
    p.media.extend([white, grey]);
    let seq = p.active_sequence;
    let settings = SequenceSettings { width: 320, height: 180, fps: Rational::new(25, 1), sample_rate: 48_000 };
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateSequenceSettings { sequence: seq, settings }).unwrap();
    // A: 0..50 from 1 s into the white media, B: 50..100 from 1 s into the grey one;
    // both have media to spare around the cut.
    let mut place = |media, at| {
        kerf_core::ops::apply(&mut p, &EditCommand::PlaceMedia {
            sequence: seq, media, video_track: None, audio_track: None, at,
            mode: PlaceMode::Overwrite, source_in: Some(25), source_out: Some(75), match_sequence: false,
        })
        .unwrap()
        .created
    };
    let first = place(wid, 0);
    let b = place(gid, 50);
    let render = |p: &mut Project, kind, range: Option<i64>| {
        let t = |kind| Some(Transition { kind, duration: 20, align: TransitionAlign::Center });
        let items = vec![TransitionEdit { clip: b[0], transition: t(kind) }, TransitionEdit { clip: b[1], transition: t(TransitionKind::Crossfade) }];
        kerf_core::ops::apply(p, &EditCommand::SetTransitions { sequence: seq, items }).unwrap();
        kerf_core::ops::apply(p, &EditCommand::SetInOut { sequence: seq, in_point: range, out_point: None }).unwrap();
        let file = dir.path().join(format!("{kind:?}-{}.mp4", range.is_some()));
        let export = ExportSettings {
            output: file.clone(),
            video_codec: VideoCodec::H264,
            hardware: false,
            width: 320,
            height: 180,
            fps: Rational::new(25, 1),
            rate: RateControl::Quality { crf: 12 },
            audio_codec: AudioCodec::Aac,
            audio_bitrate_kbps: 192,
            sample_rate: 48_000,
            audio_channels: 2,
            use_in_out: range.is_some(),
            subtitles: Default::default(),
            title_files: Default::default(),
            loudness: None,
            segmented: false,
        };
        let plan = render::plan(p, p.sequence(seq).unwrap(), &export, dir.path(), &[]).unwrap();
        let mut log = String::new();
        let res = render::render_logged(&tools, &plan, &AtomicBool::new(false), |_| {}, &mut log);
        assert!(res.is_ok(), "{kind:?}: {res:?}\n{log}");
        file
    };
    let (w, g) = (255.0, 64.0);
    let near = |v: f64, want: f64, what: &str| assert!((v - want).abs() < 8.0, "{what}: {v:.1}, want {want:.1}");

    // Dissolve over frames 40..60: p = (frame - 40) / 20.
    let f = render(&mut p, TransitionKind::Dissolve, None);
    near(mean_luma(&tools, &f, 1.5), w, "before");
    near(mean_luma(&tools, &f, 40.0 / 25.0), w, "first frame is the outgoing clip");
    near(mean_luma(&tools, &f, 2.0), (w + g) / 2.0, "half way");
    near(mean_luma(&tools, &f, 55.0 / 25.0), w * 0.25 + g * 0.75, "three quarters");
    near(mean_luma(&tools, &f, 2.5), g, "after");
    // Audio: both clips at half gain at the cut, each alone outside.
    let (a, mid, bb) = (audio_rms(&tools, &f, 1.2), audio_rms(&tools, &f, 1.9), audio_rms(&tools, &f, 2.8));
    eprintln!("rms {a:.4} {mid:.4} {bb:.4}");
    assert!(mid > a.min(bb) * 0.5 && mid < a.max(bb) * 0.95, "crossfade keeps both, quieter: {mid}");

    // Rendering from inside the transition: frame 45 is the first, p = 0.25.
    let f = render(&mut p, TransitionKind::Dissolve, Some(45));
    near(mean_luma(&tools, &f, 0.0), w * 0.75 + g * 0.25, "range starts in the dissolve");

    // Dip to black: colour 2p up to the middle, then the incoming clip from under it.
    let f = render(&mut p, TransitionKind::DipBlack, None);
    near(mean_luma(&tools, &f, 45.0 / 25.0), w * 0.5, "quarter way");
    near(mean_luma(&tools, &f, 2.0), 0.0, "black in the middle");
    near(mean_luma(&tools, &f, 55.0 / 25.0), g * 0.5, "three quarters");

    // Wipe right: the incoming clip fills the left part up to floor(W * p).
    let f = render(&mut p, TransitionKind::WipeRight, None);
    let (l, r) = (half_luma(&tools, &f, 2.0, true), half_luma(&tools, &f, 2.0, false));
    near(l, g, "left half is new");
    near(r, w, "right half is old");
    let (l, r) = (half_luma(&tools, &f, 1.7, true), half_luma(&tools, &f, 1.7, false));
    assert!(l < w - 30.0 && (r - w).abs() < 8.0, "a quarter in: {l:.1} {r:.1}");

    // The outgoing clip ends with its media (slipped to the last frames): its last
    // frame holds, also when the range starts after the cut. A fade-out on it that
    // began before the range is continued, not restarted.
    kerf_core::ops::apply(&mut p, &EditCommand::SlipClip { sequence: seq, clip: first[0], delta: 25, linked: true }).unwrap();
    let f = render(&mut p, TransitionKind::Dissolve, Some(55));
    near(mean_luma(&tools, &f, 0.0), w * 0.25 + g * 0.75, "held last frame three quarters through");
    let patch = ClipPatch { fade_out: Some(20), ..Default::default() };
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateClips { sequence: seq, clips: vec![first[0]], patch }).unwrap();
    let f = render(&mut p, TransitionKind::DipBlack, Some(42));
    // Frame 42: the fade-out (30..50) is at 0.4, under the dip colour at 2 * 0.1.
    near(mean_luma(&tools, &f, 0.0), w * 0.4 * 0.8, "fade continues from before the range");
}

/// RMS (0..1) of the left and right channel in `t..t+0.5` seconds, and the peak of both.
fn channel_levels(tools: &Tools, file: &Path, t: f64) -> (f64, f64, f64) {
    let out = tools
        .ffmpeg_cmd()
        .args(["-ss", &format!("{t}"), "-t", "0.5", "-i"])
        .arg(file)
        .args(["-vn", "-ac", "2", "-f", "f32le", "pipe:1"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let s: Vec<f64> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64).collect();
    let rms = |c: usize| (s.iter().skip(c).step_by(2).map(|v| v * v).sum::<f64>() / (s.len() / 2).max(1) as f64).sqrt();
    (rms(0), rms(1), s.iter().fold(0.0f64, |m, v| m.max(v.abs())))
}

#[test]
fn audio_effects_and_loudness_render() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    // Mono 1 kHz at 0.25 (-12 dBFS), 4 s.
    let src = dir.path().join("mono.wav");
    ffmpeg(&tools, &[
        "-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*1000*t):s=48000:d=4",
        "-ac", "1", "-c:a", "pcm_s16le", "-y", &src.to_string_lossy(),
    ]);
    let asset = import(&tools, &src, &dir.path().join("cache"));
    assert_eq!(asset.info.as_ref().unwrap().audio.as_ref().unwrap().channels, 1);
    let mut p = Project::new("t", 0);
    let id = asset.id;
    p.media.push(asset);
    let seq = p.active_sequence;
    let settings = SequenceSettings { width: 320, height: 180, fps: Rational::new(25, 1), sample_rate: 48_000 };
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateSequenceSettings { sequence: seq, settings }).unwrap();
    kerf_core::ops::apply(&mut p, &EditCommand::PlaceMedia {
        sequence: seq, media: id, video_track: None, audio_track: None, at: 0,
        mode: PlaceMode::Overwrite, source_in: Some(0), source_out: Some(100), match_sequence: false,
    })
    .unwrap();
    let render = |p: &Project, name: &str, loudness: Option<LoudnessTarget>| {
        let file = dir.path().join(name);
        let export = ExportSettings {
            output: file.clone(),
            video_codec: VideoCodec::H264,
            hardware: false,
            width: 320,
            height: 180,
            fps: Rational::new(25, 1),
            rate: RateControl::Quality { crf: 30 },
            audio_codec: AudioCodec::Pcm,
            audio_bitrate_kbps: 192,
            sample_rate: 48_000,
            audio_channels: 2,
            use_in_out: false,
            subtitles: Default::default(),
            title_files: Default::default(),
            loudness,
            segmented: false,
        };
        let plan = render::plan(p, p.sequence(seq).unwrap(), &export, dir.path(), &[]).unwrap();
        let mut log = String::new();
        let mut measured = false;
        let res = render::render_logged(&tools, &plan, &AtomicBool::new(false), |s| measured |= s.measuring, &mut log);
        assert!(res.is_ok(), "{name}: {res:?}\n{log}");
        assert_eq!(measured, loudness.is_some(), "{log}");
        (file, log)
    };
    let edit = |p: &mut Project, f: &dyn Fn(&mut Track)| {
        let s = p.sequence_mut(seq).unwrap();
        f(s.tracks.iter_mut().find(|t| t.kind == TrackKind::Audio && !t.clips.is_empty()).unwrap());
    };
    let sine_rms = 0.25 / 2f64.sqrt();
    let near = |v: f64, want: f64, what: &str| assert!((v - want).abs() < want.max(0.01) * 0.05, "{what}: {v:.4}, want {want:.4}");

    // A mono source plays on both sides at full level, as in the preview.
    let (f, _) = render(&p, "mono.mov", None);
    let (l, r, _) = channel_levels(&tools, &f, 1.0);
    near(l, sine_rms, "left");
    near(r, sine_rms, "right");

    // Panned fully right with WebAudio's law: the left side moves over.
    edit(&mut p, &|t| t.clips[0].pan = 1.0);
    let (f, _) = render(&p, "pan.mov", None);
    let (l, r, _) = channel_levels(&tools, &f, 1.0);
    assert!(l < 1e-4, "left is silent: {l}");
    near(r, 2.0 * sine_rms, "right takes both");

    // Clip limiter at -18 dBFS; the track folded to mono and 6 dB down.
    edit(&mut p, &|t| {
        t.clips[0].pan = 0.0;
        t.clips[0].channels = ChannelMap::Left;
        t.clips[0].audio_effects = vec![AudioEffect { id: Uuid::nil(), enabled: true, kind: AudioEffectKind::Limiter { ceiling_db: -18.0, release_ms: 50.0 } }];
        t.mono = true;
        t.volume_db = -6.0;
        t.effects = vec![AudioEffect {
            id: Uuid::nil(),
            enabled: true,
            kind: AudioEffectKind::Eq { bands: vec![EqBand { shape: EqShape::HighPass, freq: 80.0, gain_db: 0.0, q: 0.707, enabled: true }] },
        }];
    });
    let (f, log) = render(&p, "fx.mov", None);
    assert!(log.contains("alimiter=") && log.contains("highpass=f=80"), "{log}");
    let (l, r, peak) = channel_levels(&tools, &f, 1.0);
    let ceiling = 10f64.powf(-18.0 / 20.0) * 10f64.powf(-6.0 / 20.0);
    assert!(peak <= ceiling * 1.02 && peak > ceiling * 0.9, "limited, then -6 dB: {peak:.4} vs {ceiling:.4}");
    near(l, r, "mono");

    // Loudness: two passes to -20 LUFS.
    edit(&mut p, &|t| {
        t.clips[0].audio_effects.clear();
        t.clips[0].channels = ChannelMap::Stereo;
        t.effects.clear();
        t.mono = false;
        t.volume_db = 0.0;
    });
    let (f, log) = render(&p, "loud.mov", Some(LoudnessTarget { integrated: -20.0, true_peak: -1.0 }));
    assert!(log.contains("gemessen:") && log.contains("linear=true"), "{log}");
    let m = analysis::loudness(&tools, &f, 0.0, None).unwrap();
    assert!((m.integrated.unwrap() + 20.0).abs() < 0.5, "{m:?}\n{log}");
    // The length is unchanged by loudnorm's resampling.
    let (_, info) = probe::probe(&tools, &f).unwrap();
    assert!((info.duration - 4.0).abs() < 0.05, "{}", info.duration);
}

/// Source frame number shown on output frame `l` (25 fps) of a render of the
/// counter video in `reverse_and_speed_ramps_render`.
fn frame_number(tools: &Tools, file: &Path, l: f64) -> f64 {
    // An accurate seek drops frames before the time: aim just before frame l.
    let t = (l / 25.0 - 0.001).max(0.0);
    // Gray output is full range; the video luma is limited range.
    let y = |left| half_luma(tools, file, t, left) * 219.0 / 255.0 + 16.0;
    // The colour round trip of the export lowers the luma by 1..3 codes: 18 is the middle.
    50.0 * ((y(false) - 18.0) / 60.0).round() + (y(true) - 18.0) / 4.0
}

#[test]
fn reverse_and_speed_ramps_render() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    // 150 frames at 25 fps: frame N = 50 * (right half) + (left half), see frame_number;
    // the sound is a 1 kHz tone whose amplitude rises linearly from 0.1 to 0.9.
    let src = dir.path().join("counter.mp4");
    ffmpeg(&tools, &[
        "-f", "lavfi", "-i", "nullsrc=s=160x90:r=25:d=6,format=yuv420p,geq=lum='if(lt(X,W/2),20+4*mod(N,50),20+60*floor(N/50))':cb=128:cr=128",
        "-f", "lavfi", "-i", "aevalsrc='(0.1+0.8*t/6)*sin(2*PI*1000*t)':s=48000:d=6",
        "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-g", "25", "-c:a", "pcm_s16le", "-shortest", "-y", &src.with_extension("mov").to_string_lossy(),
    ]);
    let src = src.with_extension("mov");
    let asset = import(&tools, &src, &dir.path().join("cache"));
    let mut p = Project::new("t", 0);
    let id = asset.id;
    p.media.push(asset);
    let seq = p.active_sequence;
    let settings = SequenceSettings { width: 160, height: 90, fps: Rational::new(25, 1), sample_rate: 48_000 };
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateSequenceSettings { sequence: seq, settings }).unwrap();
    let ids = kerf_core::ops::apply(&mut p, &EditCommand::PlaceMedia {
        sequence: seq, media: id, video_track: None, audio_track: None, at: 0,
        mode: PlaceMode::Overwrite, source_in: Some(0), source_out: Some(150), match_sequence: false,
    })
    .unwrap()
    .created;
    let render = |p: &Project, name: &str| {
        let file = dir.path().join(name);
        let export = ExportSettings {
            output: file.clone(),
            video_codec: VideoCodec::H264,
            hardware: false,
            width: 160,
            height: 90,
            fps: Rational::new(25, 1),
            rate: RateControl::Quality { crf: 4 },
            audio_codec: AudioCodec::Pcm,
            audio_bitrate_kbps: 192,
            sample_rate: 48_000,
            audio_channels: 2,
            use_in_out: false,
            subtitles: Default::default(),
            title_files: Default::default(),
            loudness: None,
            segmented: false,
        };
        let plan = render::plan(p, p.sequence(seq).unwrap(), &export, dir.path(), &[]).unwrap();
        let mut log = String::new();
        let res = render::render_logged(&tools, &plan, &AtomicBool::new(false), |_| {}, &mut log);
        assert!(res.is_ok(), "{name}: {res:?}\n{log}");
        (file, log)
    };
    // RMS of a 1 kHz tone at source time s.
    let tone = |s: f64| (0.1 + 0.8 * s / 6.0) / 2f64.sqrt();
    let near = |v: f64, want: f64, what: &str| assert!((v - want).abs() < want * 0.06, "{what}: {v:.4}, want {want:.4}");

    // Plain: frame l shows source frame l.
    let (f, _) = render(&p, "plain.mov");
    for l in [0.0, 12.0, 25.0, 37.0, 49.0, 50.0, 120.0, 149.0] {
        assert_eq!(frame_number(&tools, &f, l).round(), l, "plain frame {l}");
    }

    // Reversed (three pieces of 50 frames): frame l shows 149 - l, the sound runs backwards.
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateClips { sequence: seq, clips: vec![ids[0]], patch: ClipPatch { reverse: Some(true), ..Default::default() } }).unwrap();
    let (f, log) = render(&p, "reverse.mov");
    assert!(log.contains("reverse") && log.contains("concat=n=3"), "{log}");
    for l in [0.0, 1.0, 49.0, 50.0, 99.0, 100.0, 149.0] {
        assert_eq!(frame_number(&tools, &f, l).round(), 149.0 - l, "reversed frame {l}");
    }
    near(audio_rms(&tools, &f, 0.5), tone(5.4), "reversed sound early");
    near(audio_rms(&tools, &f, 4.8), tone(1.1), "reversed sound late");

    // Ramp: 1x up to source 50, then speeding up to 3x at source 100, 3x after.
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateClips { sequence: seq, clips: vec![ids[0]], patch: ClipPatch { reverse: Some(false), ..Default::default() } }).unwrap();
    let k = |at, value| Keyframe { at, value, ease: Ease::Linear };
    kerf_core::ops::apply(&mut p, &EditCommand::SetKeyframes { sequence: seq, clip: ids[0], param: Param::Speed, keys: vec![k(50, 1.0), k(100, 3.0)] }).unwrap();
    let clip = p.sequence(seq).unwrap().tracks[0].clips[0].clone();
    // 50 + 2 * 50 / 4 + 50 / 3 = 91.67 -> 92 frames.
    assert_eq!(clip.duration, 92);
    let (f, log) = render(&p, "ramp.mov");
    assert!(log.contains("asendcmd") && log.contains("atempo@tp"), "{log}");
    for l in [10.0, 55.0, 62.0, 70.0, 80.0, 90.0] {
        let want = clip.source_at(l).floor();
        assert_eq!(frame_number(&tools, &f, l).round(), want, "ramp frame {l}");
    }
    for l in [20.0, 60.0, 85.0] {
        let t = l / 25.0;
        // The tone's level follows the source position (the RMS window is 0.2 s long).
        let s = (clip.source_at(l) + clip.source_at(l + 5.0)) / 2.0 / 25.0;
        near(audio_rms(&tools, &f, t), tone(s), &format!("ramp sound at {l}"));
    }
    // The sound lasts as long as the picture.
    let (_, info) = probe::probe(&tools, &f).unwrap();
    assert!((info.duration - 92.0 / 25.0).abs() < 0.05, "{}", info.duration);

    // Reversed ramp: the same timing mirrored around the clip.
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateClips { sequence: seq, clips: vec![ids[0]], patch: ClipPatch { reverse: Some(true), ..Default::default() } }).unwrap();
    let clip = p.sequence(seq).unwrap().tracks[0].clips[0].clone();
    let (f, _) = render(&p, "ramp-reverse.mov");
    for l in [0.0, 5.0, 20.0, 40.0, 91.0] {
        // Past the media (149 is its last frame) the last frame holds.
        let want = (clip.source_at(l) - 1e-6).floor().min(149.0);
        assert_eq!(frame_number(&tools, &f, l).round(), want, "reversed ramp frame {l}");
    }
}

/// Mean luma (0..255) of the `w`x`h` region at `x`, `y` of the frame at `t` seconds.
fn region_luma(tools: &Tools, file: &Path, t: f64, (x, y, w, h): (u32, u32, u32, u32)) -> f64 {
    let out = tools
        .ffmpeg_cmd()
        .args(["-ss", &format!("{t}"), "-i"])
        .arg(file)
        .args(["-frames:v", "1", "-vf", &format!("crop={w}:{h}:{x}:{y}"), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"])
        .output()
        .unwrap();
    assert!(out.status.success());
    out.stdout.iter().map(|b| *b as f64).sum::<f64>() / out.stdout.len().max(1) as f64
}

#[test]
fn nested_sequences_render() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let (bg, fg) = (d.join("grey.mp4"), d.join("white.mp4"));
    ffmpeg(&tools, &["-f", "lavfi", "-i", "color=c=0x808080:s=320x180:r=25:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-y", &bg.to_string_lossy()]);
    ffmpeg(&tools, &[
        "-f", "lavfi", "-i", "color=c=white:s=320x180:r=25:d=2",
        "-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*1000*t):s=48000:d=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-y", &fg.to_string_lossy(),
    ]);
    let (bg, fg) = (import(&tools, &bg, &d.join("cache")), import(&tools, &fg, &d.join("cache")));
    let (bg_id, fg_id) = (bg.id, fg.id);
    let mut p = Project::new("n", 0);
    p.media.extend([bg, fg]);
    let settings = SequenceSettings { width: 640, height: 360, fps: Rational::new(25, 1), sample_rate: 48_000 };
    let run = |p: &mut Project, cmd: EditCommand| kerf_core::ops::apply(p, &cmd).unwrap();
    let place = |sequence, media, video_track| EditCommand::PlaceMedia {
        sequence, media, video_track, audio_track: None, at: 0,
        mode: PlaceMode::Overwrite, source_in: None, source_out: None, match_sequence: false,
    };
    let outer = p.active_sequence;
    run(&mut p, EditCommand::UpdateSequenceSettings { sequence: outer, settings });

    // Innermost: a half-transparent white box in the left half, with a tone.
    let inner = run(&mut p, EditCommand::AddSequence { name: "Innen".into(), settings }).created[0];
    let box_clip = run(&mut p, place(inner, fg_id, None)).created[0];
    run(&mut p, EditCommand::UpdateClips {
        sequence: inner, clips: vec![box_clip],
        patch: ClipPatch { transform: Some(Transform { x: -200.0, scale: 0.25, ..Default::default() }), opacity: Some(0.5), ..Default::default() },
    });

    // Outer: grey on V1, the inner sequence over it on V2; then both nested once more.
    let v2 = p.sequence(outer).unwrap().tracks[1].id;
    let grey = run(&mut p, place(outer, bg_id, None)).created[0];
    let nested = run(&mut p, place(outer, inner, Some(v2))).created;
    assert_eq!(nested.len(), 2, "picture and sound of the nested sequence");
    let wrap = run(&mut p, EditCommand::NestClips { sequence: outer, clips: vec![grey, nested[0]], name: "Ebene 2".into() }).created[0];
    assert!(p.nests(outer, inner) && p.nests(wrap, inner));

    let file = d.join("nested.mp4");
    let export = ExportSettings {
        output: file.clone(),
        video_codec: VideoCodec::H264,
        hardware: false,
        width: 640,
        height: 360,
        fps: Rational::new(25, 1),
        rate: RateControl::Quality { crf: 12 },
        audio_codec: AudioCodec::Aac,
        audio_bitrate_kbps: 192,
        sample_rate: 48_000,
        audio_channels: 2,
        use_in_out: false,
        subtitles: Default::default(),
        title_files: Default::default(),
        loudness: None,
        segmented: false,
    };
    let plan = render::plan(&p, p.sequence(outer).unwrap(), &export, d, &[]).unwrap();
    assert_eq!(plan.nested.len(), 2, "both levels render first");
    let mut saw_nested = false;
    render::render(&tools, &plan, &AtomicBool::new(false), |pr| saw_nested |= pr.nested).expect("render nested");
    assert!(saw_nested);
    assert!(plan.nested.iter().all(|n| !n.output.exists()), "intermediate files are removed");

    // Box centre: half white over grey (straight alpha, not darkened twice); right: grey.
    // (Read back as full-range grey, so half white over grey is their mean.)
    let boxed = region_luma(&tools, &file, 1.0, (100, 160, 40, 40));
    let right = region_luma(&tools, &file, 1.0, (420, 20, 200, 300));
    eprintln!("box {boxed:.1} right {right:.1}");
    assert!((right - 126.0).abs() < 6.0, "grey from the nested V1");
    assert!((boxed - (255.0 + right) / 2.0).abs() < 5.0, "half-transparent box");
    let rms = audio_rms(&tools, &file, 1.0);
    eprintln!("rms {rms:.3}");
    assert!(rms > 0.25, "tone through two levels");
}

#[test]
fn angles_sync_by_their_sound() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let (a, b, c) = (d.join("a.wav"), d.join("b.wav"), d.join("c.mp4"));
    // Noise in irregular bursts, like speech.
    ffmpeg(&tools, &[
        "-f", "lavfi", "-i", "anoisesrc=d=40:c=pink:a=0.4:seed=7",
        "-af", "volume='0.05+0.95*gt(sin(2*PI*t*1.3)*sin(2*PI*t*0.37+1)+0.2*sin(2*PI*t*3.1),0.3)':eval=frame",
        "-ar", "48000", "-y", &a.to_string_lossy(),
    ]);
    // B started 3.37 s after A (and records quieter, through another microphone).
    ffmpeg(&tools, &["-ss", "3.37", "-i", &a.to_string_lossy(), "-af", "volume=0.3,highpass=f=200", "-y", &b.to_string_lossy()]);
    // C (a camera file) started 1.5 s before A.
    ffmpeg(&tools, &[
        "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=25:d=30",
        "-i", &a.to_string_lossy(),
        "-af", "adelay=1500:all=1,volume=0.6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-y", &c.to_string_lossy(),
    ]);
    let offsets = analysis::sync_offsets(&tools, &[a, b, c]).unwrap();
    eprintln!("{offsets:?}");
    assert_eq!(offsets[0], Some(0.0));
    assert!((offsets[1].unwrap() - 3.37).abs() < 0.002, "B");
    // AAC adds a little delay of its own; within a frame is what counts.
    assert!((offsets[2].unwrap() + 1.5).abs() < 0.03, "C");
}

fn probe_entries(tools: &Tools, file: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new(&tools.ffprobe).args(["-v", "error"]).args(args).args(["-of", "csv=p=0"]).arg(file).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn segmented_export_matches_one_piece() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let make = |name: &str, video: &str, hz: u32, d: u32| {
        let src = dir.path().join(name);
        ffmpeg(&tools, &[
            "-f", "lavfi", "-i", &format!("{video}=s=160x90:r=25:d={d}"),
            "-f", "lavfi", "-i", &format!("sine=frequency={hz}:duration={d}"),
            "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-c:a", "aac", "-shortest", "-y", &src.to_string_lossy(),
        ]);
        import(&tools, &src, &dir.path().join("cache"))
    };
    let (a, b) = (make("a.mp4", "testsrc2", 440, 30), make("b.mp4", "testsrc", 1000, 25));
    let mut p = Project::new("t", 0);
    let (aid, bid) = (a.id, b.id);
    p.media.extend([a, b]);
    let seq = p.active_sequence;
    let settings = SequenceSettings { width: 160, height: 90, fps: Rational::new(25, 1), sample_rate: 48_000 };
    kerf_core::ops::apply(&mut p, &EditCommand::UpdateSequenceSettings { sequence: seq, settings }).unwrap();
    let mut place = |media, at, source_in, source_out| {
        kerf_core::ops::apply(&mut p, &EditCommand::PlaceMedia {
            sequence: seq, media, video_track: None, audio_track: None, at,
            mode: PlaceMode::Overwrite, source_in: Some(source_in), source_out: Some(source_out), match_sequence: false,
        })
        .unwrap()
        .created
    };
    place(aid, 0, 0, 250);
    let b = place(bid, 250, 50, 550);
    // 8.44 s into the second part: 210.99… frames of 1/25 s in floating point.
    place(aid, 461, 100, 160);
    // The parts are 0..250, 250..500 and 500..750: the dissolve, the crossfade
    // and the subtitle run over the first boundary.
    let t = |kind| Some(Transition { kind, duration: 20, align: TransitionAlign::Center });
    let items = vec![TransitionEdit { clip: b[0], transition: t(TransitionKind::Dissolve) }, TransitionEdit { clip: b[1], transition: t(TransitionKind::Crossfade) }];
    kerf_core::ops::apply(&mut p, &EditCommand::SetTransitions { sequence: seq, items }).unwrap();
    let cues = vec![Cue { id: Uuid::new_v4(), start: 200, end: 300, text: "Über die Grenze".into() }];
    kerf_core::ops::apply(&mut p, &EditCommand::SetSubtitles { sequence: seq, cues }).unwrap();

    let render = |segmented: bool| {
        let file = dir.path().join(if segmented { "parts.mp4" } else { "whole.mp4" });
        let export = ExportSettings {
            output: file.clone(),
            video_codec: VideoCodec::H264,
            hardware: false,
            width: 160,
            height: 90,
            fps: Rational::new(25, 1),
            rate: RateControl::Quality { crf: 10 },
            audio_codec: AudioCodec::Aac,
            audio_bitrate_kbps: 192,
            sample_rate: 48_000,
            audio_channels: 2,
            use_in_out: false,
            subtitles: render::SubtitleOutput { embed: true, ..Default::default() },
            title_files: Default::default(),
            loudness: Some(LoudnessTarget { integrated: -20.0, true_peak: -1.0 }),
            segmented,
        };
        let plan = render::plan_with(&p, p.sequence(seq).unwrap(), &export, dir.path(), &[], Some(2)).unwrap();
        assert_eq!(plan.parts.len(), if segmented { 3 } else { 0 });
        let (mut parallel, mut joining) = (0, false);
        let mut log = String::new();
        let res = render::render_logged(&tools, &plan, &AtomicBool::new(false), |s| {
            parallel = parallel.max(s.parallel);
            joining |= s.joining;
        }, &mut log);
        assert!(res.is_ok(), "{res:?}\n{log}");
        assert_eq!((parallel, joining), if segmented { (2, true) } else { (0, false) }, "{log}");
        // Parts, sound and helper files are gone.
        assert!(plan.parts.iter().chain(plan.sound.as_deref()).all(|j| !j.output.exists() && !j.partial_path.exists()));
        assert!(plan.files.iter().all(|(p, _)| !p.exists()));
        (file, log)
    };
    let (parts, log) = render(true);
    let (whole, _) = render(false);

    for f in [&parts, &whole] {
        assert_eq!(probe_entries(&tools, f, &["-count_packets", "-select_streams", "v", "-show_entries", "stream=nb_read_packets"]), "750", "{log}");
    }
    assert_eq!(probe_entries(&tools, &parts, &["-select_streams", "v", "-show_entries", "stream=r_frame_rate,color_space"]), "bt709,25/1");
    assert_eq!(probe_entries(&tools, &parts, &["-select_streams", "s", "-show_entries", "stream=codec_name"]), "mov_text");
    // The parts follow each other without a jump in the timestamps.
    assert!(!log.to_lowercase().contains("monoton"), "{log}");
    // Every frame matches its counterpart (a frame off would show in the moving pattern).
    let stats = dir.path().join("psnr.log");
    let filter = format!("[0:v][1:v]psnr=stats_file='{}'", stats.to_string_lossy().replace('\\', "/").replace(':', "\\:"));
    ffmpeg(&tools, &["-i", &parts.to_string_lossy(), "-i", &whole.to_string_lossy(), "-lavfi", &filter, "-f", "null", "-"]);
    let psnr: Vec<f64> = std::fs::read_to_string(&stats)
        .unwrap()
        .lines()
        .map(|l| l.split_whitespace().find_map(|kv| kv.strip_prefix("psnr_avg:")).unwrap().parse::<f64>().unwrap_or(f64::INFINITY))
        .collect();
    let worst = psnr.iter().cloned().enumerate().min_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
    eprintln!("frames {}, worst psnr {worst:?}", psnr.len());
    assert_eq!(psnr.len(), 750);
    assert!(worst.1 > 30.0, "frame {} differs: {} dB\n{log}", worst.0, worst.1);
    // The sound is mixed, normalised and encoded as in one piece.
    let md5 = |f: &Path| {
        let out = tools.ffmpeg_cmd().arg("-i").arg(f).args(["-map", "0:a", "-f", "md5", "-"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    assert_eq!(md5(&parts), md5(&whole), "{log}");
}
