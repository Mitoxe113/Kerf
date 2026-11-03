//! The analysis decoders against a real FFmpeg on generated media.

use std::sync::atomic::AtomicBool;

use kerf_media::detect::{self, CutKind, SceneOptions, SilenceOptions};
use kerf_media::Tools;

fn tools() -> Option<Tools> {
    match Tools::discover() {
        Ok(t) => Some(t),
        Err(e) if std::env::var_os("KERF_REQUIRE_FFMPEG").is_some() => panic!("ffmpeg required: {e}"),
        Err(_) => {
            eprintln!("ffmpeg not found - skipping analysis test");
            None
        }
    }
}

#[test]
fn scenes_and_pauses_in_generated_media() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("scenes.mkv");
    // Test pattern 2 s, red 2 s, test pattern 2 s; tone 0-1.5 s, quiet until 3 s, tone after.
    let status = tools
        .ffmpeg_cmd()
        .args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=2", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=25:d=2"])
        .args(["-f", "lavfi", "-i", "testsrc=s=320x180:r=25:d=2"])
        .args(["-f", "lavfi", "-i", "sine=f=440:r=48000:d=6,volume='if(between(t,1.5,3),0,1)':eval=frame"])
        .args(["-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a", "-c:v", "ffv1", "-c:a", "pcm_s16le"])
        .arg(&file)
        .status()
        .unwrap();
    assert!(status.success());
    let cancel = AtomicBool::new(false);

    let stats = detect::video_stats(&tools, &file, 0.0, None, 25.0, &cancel, |_| {}).unwrap();
    assert_eq!(stats.len(), 150);
    let cuts = detect::detect_scenes(&stats, 25.0, &SceneOptions::default());
    let times: Vec<f64> = cuts.iter().map(|c| c.time).collect();
    assert_eq!(times, vec![2.0, 4.0], "{cuts:?}");
    assert!(cuts.iter().all(|c| c.kind == CutKind::Hard));

    // A range: from 1 s for 2 s holds the first cut at 1 s into the range.
    let part = detect::video_stats(&tools, &file, 1.0, Some(2.0), 25.0, &cancel, |_| {}).unwrap();
    let cuts = detect::detect_scenes(&part, 25.0, &SceneOptions::default());
    assert_eq!(cuts.iter().map(|c| c.time).collect::<Vec<_>>(), vec![1.0]);

    let samples = detect::audio_samples(&tools, &file, 0.0, None, 16_000, &cancel).unwrap();
    assert!((samples.len() as f64 / 16_000.0 - 6.0).abs() < 0.01, "{} samples", samples.len());
    let r = detect::detect_silence(&detect::block_levels(&samples, 16_000), &SilenceOptions { relative: false, threshold_db: -50.0, ..Default::default() });
    assert_eq!(r.silences.len(), 1, "{r:?}");
    let s = &r.silences[0];
    assert!((s.start - 1.5).abs() < 0.03 && (s.end - 3.0).abs() < 0.03, "{s:?}");

    // Cancelling stops the decoder.
    let stop = AtomicBool::new(true);
    assert!(matches!(detect::video_stats(&tools, &file, 0.0, None, 25.0, &stop, |_| {}), Err(kerf_media::MediaError::Cancelled)));
}
