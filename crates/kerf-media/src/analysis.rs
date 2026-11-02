//! Derived media: posters, filmstrips, waveform peaks and proxies.
//!
//! Everything is cached per source file under `<cache>/<fingerprint>/`, where
//! the fingerprint covers path, size and modification time. Re-opening a
//! project therefore never regenerates anything that is still valid.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use kerf_core::model::{Filmstrip, MediaInfo, MediaKind, Peaks};

use crate::probe::extension;
use crate::tools::{path_arg, run};
use crate::{MediaError, Tools};

/// Waveform resolution stored on disk.
pub const PEAKS_PER_SECOND: u32 = 100;
const PEAK_SAMPLE_RATE: u32 = 8_000;
const FILMSTRIP_TILE_HEIGHT: u32 = 90;
const FILMSTRIP_MAX_TILES: u32 = 60;
pub const PROXY_HEIGHT: u32 = 720;

/// Stable cache directory for a source file.
pub fn cache_dir(cache_root: &Path, source: &Path) -> PathBuf {
    let meta = fs::metadata(source).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = format!("{}|{size}|{mtime}", source.to_string_lossy().to_lowercase());
    cache_root.join(format!("{:016x}", fnv1a(key.as_bytes())))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Displayed frame size (container rotation applied).
pub fn display_size(info: &MediaInfo) -> Option<(u32, u32)> {
    info.video.as_ref().map(|v| if v.rotation.rem_euclid(180) == 90 { (v.height, v.width) } else { (v.width, v.height) })
}

/// Whether the system webview (Chromium) can decode the original for preview.
/// Anything else is previewed through a generated proxy.
pub fn preview_native(kind: MediaKind, info: &MediaInfo, path: &Path) -> bool {
    let ext = extension(path);
    let container = info.container.as_str();
    let audio_ok = |codec: &str, in_mp4: bool| match codec {
        "aac" | "mp3" | "opus" | "flac" => true,
        "vorbis" => !in_mp4,
        c if c.starts_with("pcm_") => !in_mp4,
        _ => false,
    };
    match kind {
        MediaKind::Image => matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"),
        MediaKind::Audio => {
            let codec = info.audio.as_ref().map(|a| a.codec.as_str()).unwrap_or("");
            let mp4 = container.contains("mp4");
            matches!(ext.as_str(), "wav" | "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus" | "webm") && audio_ok(codec, mp4)
        }
        MediaKind::Video => {
            let Some(v) = &info.video else { return false };
            let mp4 = container.contains("mp4") || container.contains("mov");
            let webm = container.contains("webm") && matches!(ext.as_str(), "webm");
            let pix = v.pix_fmt.as_deref().unwrap_or("");
            let codec_ok = match v.codec.as_str() {
                "h264" => mp4 && matches!(pix, "yuv420p" | "yuvj420p"),
                "vp8" => webm,
                "vp9" | "av1" => (mp4 || webm) && pix.starts_with("yuv420p"),
                _ => false,
            };
            let audio = info.audio.as_ref().is_none_or(|a| audio_ok(&a.codec, mp4));
            codec_ok && audio
        }
    }
}

/// Representative still for the media browser.
pub fn poster(tools: &Tools, src: &Path, kind: MediaKind, info: &MediaInfo, dir: &Path) -> Result<PathBuf, MediaError> {
    let out = dir.join("poster.jpg");
    if out.is_file() {
        return Ok(out);
    }
    fs::create_dir_all(dir)?;
    let mut cmd = tools.ffmpeg_cmd();
    if kind == MediaKind::Video {
        let at = (info.duration * 0.1).min(2.0);
        cmd.args(["-ss", &format!("{at:.3}")]);
    }
    cmd.arg("-i").arg(path_arg(src));
    cmd.args(["-frames:v", "1", "-vf", "scale=-2:'min(270,ih)':flags=bicubic", "-q:v", "3", "-an", "-y"]);
    cmd.arg(path_arg(&out));
    run(cmd, "poster")?;
    Ok(out)
}

/// Longest media whose sound is reversed for the preview (`areverse` holds it all).
const MAX_REVERSED_S: f64 = 30.0 * 60.0;

/// The sound of `src` backwards (AAC), so the preview can play reversed clips
/// forwards: source time s is at `duration - s`. Cached in `dir`.
pub fn reversed_audio(tools: &Tools, src: &Path, info: &MediaInfo, dir: &Path) -> Result<PathBuf, MediaError> {
    let out = dir.join("reversed.m4a");
    if out.is_file() {
        return Ok(out);
    }
    if info.audio.is_none() {
        return Err(MediaError::Unsupported("no audio".into()));
    }
    if info.duration > MAX_REVERSED_S {
        return Err(MediaError::Unsupported("too long to reverse for the preview".into()));
    }
    fs::create_dir_all(dir)?;
    let partial = dir.join("partial_reversed.m4a");
    let mut cmd = tools.ffmpeg_cmd();
    cmd.arg("-i").arg(path_arg(src));
    cmd.args(["-map", "0:a:0", "-af", "areverse", "-c:a", "aac", "-b:a", "192k", "-f", "ipod", "-y"]);
    cmd.arg(path_arg(&partial));
    run(cmd, "reversed audio")?;
    fs::rename(&partial, &out)?;
    Ok(out)
}

/// Writes the frame at `seconds` (source time) of `src` as a PNG (freeze frames).
pub fn extract_frame(tools: &Tools, src: &Path, seconds: f64, out: &Path) -> Result<(), MediaError> {
    if let Some(dir) = out.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut cmd = tools.ffmpeg_cmd();
    // Input seeking is frame-accurate when re-encoding; PNG keeps the frame lossless.
    cmd.args(["-ss", &format!("{:.6}", seconds.max(0.0))]).arg("-i").arg(path_arg(src));
    cmd.args(["-frames:v", "1", "-an", "-y"]).arg(path_arg(out));
    run(cmd, "freeze frame")?;
    if !out.is_file() {
        return Err(MediaError::Unsupported("no frame at this position".into()));
    }
    Ok(())
}

/// Horizontal sprite of evenly spaced frames used for timeline thumbnails.
pub fn filmstrip(tools: &Tools, src: &Path, info: &MediaInfo, dir: &Path) -> Result<Filmstrip, MediaError> {
    let (dw, dh) = display_size(info).ok_or_else(|| MediaError::Unsupported("no video".into()))?;
    let tile_height = FILMSTRIP_TILE_HEIGHT;
    let tile_width = (((tile_height as f64 * dw as f64 / dh as f64) / 2.0).round() as u32 * 2).clamp(16, 640);
    let duration = info.duration.max(0.04);
    let tiles = ((duration / 1.0).ceil() as u32).clamp(1, FILMSTRIP_MAX_TILES);
    let interval = duration / tiles as f64;
    let strip = Filmstrip { path: dir.join(format!("strip_{tiles}.jpg")), tiles, tile_width, tile_height, interval };
    if strip.path.is_file() {
        return Ok(strip);
    }
    fs::create_dir_all(dir)?;
    let mut cmd = tools.ffmpeg_cmd();
    // Long media: decode keyframes only, which is an order of magnitude faster.
    if duration > 120.0 {
        cmd.args(["-skip_frame", "nokey"]);
    }
    cmd.arg("-i").arg(path_arg(src));
    let vf = format!(
        "fps=1/{interval:.6}:start_time=0:round=down,scale={tile_width}:{tile_height}:flags=fast_bilinear,tile={tiles}x1"
    );
    cmd.args(["-an", "-vf", &vf, "-frames:v", "1", "-q:v", "4", "-y"]).arg(path_arg(&strip.path));
    run(cmd, "filmstrip")?;
    Ok(strip)
}

/// Mono peak envelope, one byte (0..=255) per 1/[`PEAKS_PER_SECOND`] s.
pub fn peaks(tools: &Tools, src: &Path, dir: &Path) -> Result<Peaks, MediaError> {
    let out = dir.join("peaks.u8");
    let result = Peaks { path: out.clone(), rate: PEAKS_PER_SECOND };
    if out.is_file() {
        return Ok(result);
    }
    fs::create_dir_all(dir)?;
    let mut child = tools
        .ffmpeg_cmd()
        .arg("-i")
        .arg(path_arg(src))
        .args(["-vn", "-ac", "1", "-ar", &PEAK_SAMPLE_RATE.to_string(), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let bucket = (PEAK_SAMPLE_RATE / PEAKS_PER_SECOND) as usize;
    let mut stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    let err_thread = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut s);
        s
    });
    let mut buf = vec![0u8; 64 * 1024];
    let mut pending: Vec<u8> = Vec::with_capacity(buf.len() + 1);
    let mut peaks = Vec::new();
    let (mut peak, mut count) = (0u16, 0usize);
    loop {
        let n = stdout.read(&mut buf)?;
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..n]);
        let usable = pending.len() & !1;
        for c in pending[..usable].chunks_exact(2) {
            peak = peak.max(i16::from_le_bytes([c[0], c[1]]).unsigned_abs());
            count += 1;
            if count == bucket {
                peaks.push((u32::from(peak) * 255 / 32768) as u8);
                peak = 0;
                count = 0;
            }
        }
        pending.drain(..usable);
    }
    if count > 0 {
        peaks.push((u32::from(peak) * 255 / 32768) as u8);
    }
    let status = child.wait()?;
    let err = err_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(MediaError::failed("waveform", &err));
    }
    kerf_core::io::write_atomic(&out, &peaks, false).map_err(|e| MediaError::Failed { what: "waveform", detail: e.to_string() })?;
    Ok(result)
}

/// EBU R128 measurement of an audio range. `None` fields mean silence (below
/// the gate, or a peak of -inf).
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    /// Integrated loudness, LUFS.
    pub integrated: Option<f64>,
    /// Loudness range, LU.
    pub range: Option<f64>,
    /// Highest sample, dBFS.
    pub sample_peak: Option<f64>,
    /// Highest inter-sample (true) peak, dBTP.
    pub true_peak: Option<f64>,
}

/// Measures the first audio stream of `src`, optionally limited to
/// `start..start+duration` seconds.
pub fn loudness(tools: &Tools, src: &Path, start: f64, duration: Option<f64>) -> Result<Loudness, MediaError> {
    let mut cmd = tools.ffmpeg_cmd();
    // The summary is logged at info level; per-frame lines go to verbose.
    cmd.args(["-nostats", "-loglevel", "info"]);
    if start > 0.0 {
        cmd.args(["-ss", &format!("{start:.6}")]);
    }
    if let Some(d) = duration {
        cmd.args(["-t", &format!("{:.6}", d.max(0.001))]);
    }
    cmd.arg("-i").arg(path_arg(src));
    cmd.args(["-map", "0:a:0", "-af", "ebur128=peak=sample+true:framelog=verbose", "-f", "null", "-"]);
    let out = run(cmd, "loudness")?;
    Ok(parse_loudness(&String::from_utf8_lossy(&out.stderr)))
}

fn parse_loudness(log: &str) -> Loudness {
    let summary = log.rsplit_once("Summary:").map_or("", |(_, s)| s);
    let mut l = Loudness::default();
    let mut section = "";
    for line in summary.lines().map(str::trim) {
        if line.ends_with(':') {
            section = line;
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else { continue };
        let value = rest.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite());
        match (section, key) {
            ("Integrated loudness:", "I") => l.integrated = value.filter(|v| *v > -70.0),
            ("Loudness range:", "LRA") => l.range = value,
            ("Sample peak:", "Peak") => l.sample_peak = value,
            ("True peak:", "Peak") => l.true_peak = value,
            _ => {}
        }
    }
    l
}

/// Generates an edit-friendly proxy (H.264 720p, short GOP; PNG for stills;
/// AAC for audio) and reports progress 0..1. Cancellable via `cancel`.
pub fn proxy(
    tools: &Tools,
    src: &Path,
    kind: MediaKind,
    info: &MediaInfo,
    dir: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<PathBuf, MediaError> {
    let out = dir.join(match kind {
        MediaKind::Video => "proxy.mp4",
        MediaKind::Audio => "proxy.m4a",
        MediaKind::Image => "proxy.png",
    });
    if out.is_file() {
        return Ok(out);
    }
    fs::create_dir_all(dir)?;
    let partial = dir.join(format!("partial_{}", out.file_name().unwrap().to_string_lossy()));
    let mut cmd = tools.ffmpeg_cmd();
    cmd.arg("-i").arg(path_arg(src));
    match kind {
        MediaKind::Video => {
            let vf = format!("scale=-2:'min({PROXY_HEIGHT},ih)':flags=bicubic,format=yuv420p");
            cmd.args(["-map", "0:v:0", "-map", "0:a:0?", "-vf", &vf]);
            cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-g", "12", "-bf", "0"]);
            cmd.args(["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-movflags", "+faststart"]);
        }
        MediaKind::Audio => {
            cmd.args(["-vn", "-c:a", "aac", "-b:a", "256k"]);
        }
        MediaKind::Image => {
            cmd.args(["-frames:v", "1"]);
        }
    }
    // Explicit muxer: the partial file name hides the extension from ffmpeg.
    let muxer = match kind {
        MediaKind::Video => "mp4",
        MediaKind::Audio => "ipod",
        MediaKind::Image => "image2",
    };
    cmd.args(["-progress", "pipe:1", "-nostats", "-f", muxer, "-y"]).arg(path_arg(&partial));
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stderr = child.stderr.take().expect("piped");
    let err_thread = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut s);
        s
    });
    let stdout = child.stdout.take().expect("piped");
    let duration = info.duration.max(0.001);
    for line in BufReader::new(stdout).lines() {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&partial);
            return Err(MediaError::Cancelled);
        }
        let Ok(line) = line else { break };
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
            progress((us / 1e6 / duration).clamp(0.0, 1.0));
        }
    }
    let status = child.wait()?;
    let err = err_thread.join().unwrap_or_default();
    if !status.success() {
        let _ = fs::remove_file(&partial);
        return Err(MediaError::failed("proxy", &err));
    }
    fs::rename(&partial, &out)?;
    progress(1.0);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_ebur128_summary() {
        let log = "[Parsed_ebur128_0 @ 0x1] t: 1.0 M: -20.0\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -21.8 LUFS\n    Threshold: -31.8 LUFS\n\n  Loudness range:\n    LRA:         2.5 LU\n    Threshold: -41.8 LUFS\n\n  Sample peak:\n    Peak:      -13.9 dBFS\n\n  True peak:\n    Peak:      -13.4 dBFS\n";
        let l = parse_loudness(log);
        assert_eq!(l, Loudness { integrated: Some(-21.8), range: Some(2.5), sample_peak: Some(-13.9), true_peak: Some(-13.4) });
        let silent = parse_loudness("Summary:\n  Integrated loudness:\n    I: -70.0 LUFS\n  Sample peak:\n    Peak: -inf dBFS\n");
        assert_eq!(silent, Loudness::default());
    }
}
