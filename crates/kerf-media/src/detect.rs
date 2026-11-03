//! Media analysis for the editing assistants: scene changes, silence, beats
//! and highlight suggestions.
//!
//! FFmpeg only decodes (small frames, mono PCM); every decision is made by the
//! pure functions here, so they are unit-tested on synthetic signals and the
//! same numbers come out on every platform. Nothing writes to the source.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::analysis::fft;
use crate::tools::path_arg;
use crate::{MediaError, Tools};

// --- decoding ------------------------------------------------------------------------

/// Frame size the scene analysis looks at.
pub const STAT_W: usize = 64;
pub const STAT_H: usize = 36;
const BINS: usize = 16;

/// What the scene analysis keeps of one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameStats {
    /// Normalised histograms of R, G and B (16 bins each, each sums to 1).
    pub hist: [f32; BINS * 3],
    /// Mean luma 0..1 (BT.709 weights).
    pub luma: f32,
    /// Mean absolute luma change against the previous frame, 0..1.
    pub motion: f32,
}

impl FrameStats {
    /// Statistics of one RGB24 frame; `prev` is the previous frame's luma plane.
    pub fn of(rgb: &[u8], prev: Option<&[f32]>, luma_out: &mut Vec<f32>) -> Self {
        let mut hist = [0f32; BINS * 3];
        luma_out.clear();
        let px = rgb.len() / 3;
        for p in rgb.chunks_exact(3) {
            for c in 0..3 {
                hist[c * BINS + (p[c] as usize * BINS / 256)] += 1.0;
            }
            luma_out.push((0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32) / 255.0);
        }
        for h in &mut hist {
            *h /= px.max(1) as f32;
        }
        let luma = luma_out.iter().sum::<f32>() / px.max(1) as f32;
        let motion = prev.map(|q| q.iter().zip(luma_out.iter()).map(|(a, b)| (a - b).abs()).sum::<f32>() / px.max(1) as f32).unwrap_or(0.0);
        Self { hist, luma, motion }
    }
}

/// Histogram distance 0..1 (half the L1 distance, averaged over the channels).
pub fn hist_distance(a: &FrameStats, b: &FrameStats) -> f64 {
    a.hist.iter().zip(b.hist.iter()).map(|(x, y)| (x - y).abs() as f64).sum::<f64>() / 6.0
}

/// Earth mover's distance between the histograms, 0..1 (mean over the channels).
/// Unlike the L1 distance it adds up along a steady change: when every pixel moves
/// monotonically (fades, dissolves), the steps sum to the distance of the ends.
pub fn hist_emd(a: &FrameStats, b: &FrameStats) -> f64 {
    let mut total = 0.0;
    for c in 0..3 {
        let (mut ca, mut cb) = (0.0f64, 0.0f64);
        for k in 0..BINS {
            ca += a.hist[c * BINS + k] as f64;
            cb += b.hist[c * BINS + k] as f64;
            total += (ca - cb).abs();
        }
    }
    total / (3.0 * (BINS - 1) as f64)
}

/// Reads `cmd`'s stdout in `chunk`-sized records, stopping on `cancel`.
fn stream(mut cmd: std::process::Command, chunk: usize, partial: bool, cancel: &AtomicBool, mut each: impl FnMut(&[u8])) -> Result<(), MediaError> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut err = child.stderr.take();
    let errs = std::thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_end(&mut s);
        }
        s
    });
    let mut out = child.stdout.take().ok_or_else(|| MediaError::Unsupported("no output".into()))?;
    let mut buf = vec![0u8; chunk];
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(MediaError::Cancelled);
        }
        let mut filled = 0;
        while filled < chunk {
            match out.read(&mut buf[filled..])? {
                0 => break,
                n => filled += n,
            }
        }
        if filled < chunk {
            if partial && filled > 0 {
                each(&buf[..filled]);
            }
            break;
        }
        each(&buf);
    }
    let status = child.wait()?;
    let stderr = errs.join().unwrap_or_default();
    if !status.success() {
        return Err(MediaError::failed("analysis", &stderr));
    }
    Ok(())
}

fn range_args(cmd: &mut std::process::Command, start: f64, duration: Option<f64>, src: &Path) {
    cmd.args(["-v", "error", "-nostdin"]);
    if start > 0.0 {
        cmd.arg("-ss").arg(format!("{start:.6}"));
    }
    cmd.arg("-i").arg(path_arg(src));
    if let Some(d) = duration {
        cmd.arg("-t").arg(format!("{:.6}", d.max(0.0)));
    }
}

/// Per-frame statistics of `src` from `start` for `duration` seconds, resampled
/// to a constant `fps` (so frame `i` lies at `start + i / fps`).
pub fn video_stats(
    tools: &Tools,
    src: &Path,
    start: f64,
    duration: Option<f64>,
    fps: f64,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<Vec<FrameStats>, MediaError> {
    if !(fps > 0.0 && fps <= 240.0) {
        return Err(MediaError::Unsupported("frame rate".into()));
    }
    let mut cmd = tools.ffmpeg_cmd();
    range_args(&mut cmd, start, duration, src);
    cmd.args(["-map", "0:v:0", "-an", "-sn", "-dn", "-vf"])
        .arg(format!("fps={fps:.6},scale={STAT_W}:{STAT_H}:flags=area,format=rgb24"))
        .args(["-f", "rawvideo", "pipe:1"]);
    let mut stats = Vec::new();
    let (mut prev, mut cur) = (Vec::new(), Vec::new());
    stream(cmd, STAT_W * STAT_H * 3, false, cancel, |frame| {
        let s = FrameStats::of(frame, (!prev.is_empty()).then_some(&prev[..]), &mut cur);
        std::mem::swap(&mut prev, &mut cur);
        stats.push(s);
        if stats.len() % 50 == 0 {
            progress(stats.len() as f64 / fps);
        }
    })?;
    Ok(stats)
}

/// Mono samples of the first audio stream at `rate` Hz.
pub fn audio_samples(tools: &Tools, src: &Path, start: f64, duration: Option<f64>, rate: u32, cancel: &AtomicBool) -> Result<Vec<f32>, MediaError> {
    let mut cmd = tools.ffmpeg_cmd();
    range_args(&mut cmd, start, duration, src);
    cmd.args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", &rate.to_string(), "-f", "f32le", "pipe:1"]);
    let mut out = Vec::new();
    // 0.1 s per read.
    let chunk = (rate as usize / 10).max(1) * 4;
    stream(cmd, chunk, true, cancel, |b| out.extend(b.chunks_exact(4).map(|v| f32::from_le_bytes([v[0], v[1], v[2], v[3]]))))?;
    Ok(out)
}

/// Sample rate of [`audio_levels`].
pub const LEVEL_RATE: u32 = 16_000;

/// [`block_levels`] of the first audio stream, computed while decoding (long
/// recordings never sit in memory as samples).
pub fn audio_levels(tools: &Tools, src: &Path, start: f64, duration: Option<f64>, cancel: &AtomicBool) -> Result<Vec<f64>, MediaError> {
    let mut cmd = tools.ffmpeg_cmd();
    range_args(&mut cmd, start, duration, src);
    cmd.args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", &LEVEL_RATE.to_string(), "-f", "f32le", "pipe:1"]);
    let block = (LEVEL_RATE as f64 * BLOCK_S).round() as usize;
    let mut out = Vec::new();
    stream(cmd, block * 4, true, cancel, |b| {
        let v: Vec<f32> = b.chunks_exact(4).map(|v| f32::from_le_bytes([v[0], v[1], v[2], v[3]])).collect();
        out.extend(block_levels(&v, LEVEL_RATE));
    })?;
    Ok(out)
}

// --- scene changes -------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SceneOptions {
    /// Histogram distance a change must reach, 0..1 (lower finds more).
    pub threshold: f64,
    /// Also look for dissolves and fades.
    pub gradual: bool,
    /// Shortest scene in seconds; closer cuts keep the stronger one.
    pub min_scene: f64,
    /// Ignore flashes: a change that returns to the previous picture within 0.15 s.
    pub ignore_flashes: bool,
}

impl Default for SceneOptions {
    fn default() -> Self {
        Self { threshold: 0.35, gradual: true, min_scene: 0.6, ignore_flashes: true }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CutKind {
    /// From one frame to the next.
    Hard,
    /// A dissolve, fade or other change spread over several frames.
    Gradual,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCut {
    /// Where the new scene starts (gradual: the middle of the change), seconds from the analysed start.
    pub time: f64,
    pub kind: CutKind,
    /// Start and end of the change in seconds (equal to `time` for hard cuts).
    pub from: f64,
    pub to: f64,
    /// Histogram distance across the change, 0..1.
    pub score: f64,
    /// Mean luma after minus before (-1..1): fades to or from black show here.
    pub luma_change: f64,
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

/// Scene changes in `stats` sampled at `fps`.
pub fn detect_scenes(stats: &[FrameStats], fps: f64, o: &SceneOptions) -> Vec<SceneCut> {
    let n = stats.len();
    if n < 2 || fps <= 0.0 {
        return Vec::new();
    }
    let threshold = o.threshold.clamp(0.02, 1.0);
    let d: Vec<f64> = (0..n).map(|i| if i == 0 { 0.0 } else { hist_distance(&stats[i - 1], &stats[i]) }).collect();
    let w = (fps * 0.5).round().max(2.0) as usize;
    let flash = (fps * 0.15).round().max(1.0) as usize;
    let t = |i: usize| i as f64 / fps;
    let mut cuts: Vec<SceneCut> = Vec::new();

    // Hard cuts: a jump well above the usual change around it (handheld or busy
    // footage has a high baseline that must not count as cuts).
    for i in 1..n {
        if d[i] < threshold {
            continue;
        }
        let mut around: Vec<f64> = (i.saturating_sub(w)..(i + w + 1).min(n)).filter(|j| *j != i && *j > 0).map(|j| d[j]).collect();
        if d[i] < 2.5 * median(&mut around) + 0.02 {
            continue;
        }
        // A flash: the picture returns within a few frames (checked from both of its edges).
        let returns = (1..=flash).any(|k| i + k < n && hist_distance(&stats[i - 1], &stats[i + k]) < threshold * 0.5);
        let returned = (1..=flash).any(|k| i > k && hist_distance(&stats[i - 1 - k], &stats[i]) < threshold * 0.5);
        if o.ignore_flashes && (returns || returned) {
            continue;
        }
        cuts.push(SceneCut { time: t(i), kind: CutKind::Hard, from: t(i), to: t(i), score: d[i], luma_change: (stats[i].luma - stats[i - 1].luma) as f64 });
    }

    // Gradual changes: over a window of one second the picture moves steadily
    // from one state to another. Motion also adds up frame differences, but it
    // goes back and forth, so the distance between the window's ends stays far
    // below their sum; a dissolve's ends are as far apart as its steps add up to.
    if o.gradual {
        let l = fps.round().max(3.0) as usize;
        let e: Vec<f64> = (0..n).map(|i| if i == 0 { 0.0 } else { hist_emd(&stats[i - 1], &stats[i]) }).collect();
        let mut flagged = vec![false; n];
        for i in l..n {
            let window = &d[i - l + 1..=i];
            let biggest = window.iter().cloned().fold(0.0, f64::max);
            let ends = hist_distance(&stats[i - l], &stats[i]);
            let steps: f64 = e[i - l + 1..=i].iter().sum();
            let travel = hist_emd(&stats[i - l], &stats[i]);
            let steady = travel >= 0.7 * steps && steps > 1e-4;
            if ends >= threshold && steady && biggest < 0.5 * ends {
                flagged[i] = true;
            }
        }
        let mut i = 0;
        while i < n {
            if !flagged[i] {
                i += 1;
                continue;
            }
            let first = i;
            while i < n && flagged[i] {
                i += 1;
            }
            let last = i - 1;
            // The change runs from the first window's start to the last window's end;
            // trim the steady frames at both ends (less than a tenth of the change).
            let (ra, rb) = (first - l, last);
            let total = hist_distance(&stats[ra], &stats[rb]);
            let mut a = ra;
            while a < rb && hist_distance(&stats[ra], &stats[a + 1]) < 0.1 * total {
                a += 1;
            }
            let mut b = rb;
            while b > a && hist_distance(&stats[b - 1], &stats[rb]) < 0.1 * total {
                b -= 1;
            }
            if cuts.iter().any(|c| c.kind == CutKind::Hard && c.time >= t(a) && c.time <= t(b)) {
                continue;
            }
            let mid = (a + b).div_ceil(2);
            cuts.push(SceneCut {
                time: t(mid),
                kind: CutKind::Gradual,
                from: t(a),
                to: t(b),
                score: total,
                luma_change: (stats[rb].luma - stats[ra].luma) as f64,
            });
        }
    }

    cuts.sort_by(|a, b| a.time.total_cmp(&b.time));
    // Scenes shorter than `min_scene`: keep the stronger change.
    let mut kept: Vec<SceneCut> = Vec::new();
    for c in cuts {
        match kept.last_mut() {
            Some(last) if c.time - last.time < o.min_scene.max(0.0) => {
                if c.score > last.score {
                    *last = c;
                }
            }
            _ => kept.push(c),
        }
    }
    kept
}

// --- silence ------------------------------------------------------------------------

/// Level blocks of 10 ms.
pub const BLOCK_S: f64 = 0.01;
const FLOOR_DB: f64 = -100.0;

/// RMS level in dBFS of each [`BLOCK_S`] block of `samples` at `rate`.
pub fn block_levels(samples: &[f32], rate: u32) -> Vec<f64> {
    let len = ((rate as f64 * BLOCK_S).round() as usize).max(1);
    samples
        .chunks(len)
        .map(|c| {
            let ms = c.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / c.len() as f64;
            if ms > 0.0 {
                (10.0 * ms.log10()).max(FLOOR_DB)
            } else {
                FLOOR_DB
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SilenceOptions {
    /// dBFS below which a block is quiet; with `relative`, dB above the measured noise floor.
    pub threshold_db: f64,
    pub relative: bool,
    /// Shortest pause that counts, seconds.
    pub min_silence: f64,
    /// Sound kept after speech ends and before it starts again, seconds.
    pub pad_after: f64,
    pub pad_before: f64,
    /// Loud bursts shorter than this inside a pause (clicks, breaths) do not end it, seconds.
    pub ignore_bursts: f64,
}

impl Default for SilenceOptions {
    fn default() -> Self {
        Self { threshold_db: 10.0, relative: true, min_silence: 0.5, pad_after: 0.15, pad_before: 0.1, ignore_bursts: 0.04 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Silence {
    /// The quiet stretch, seconds from the analysed start.
    pub start: f64,
    pub end: f64,
    /// The part that can go once the padding is kept (empty when the pause is shorter than the padding).
    pub cut_start: f64,
    pub cut_end: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceReport {
    /// 10th percentile of the block levels: the background noise, roughly.
    pub noise_floor_db: f64,
    /// The threshold that was applied, dBFS.
    pub threshold_db: f64,
    pub silences: Vec<Silence>,
}

/// Pauses in `levels` (from [`block_levels`]).
pub fn detect_silence(levels: &[f64], o: &SilenceOptions) -> SilenceReport {
    let mut sorted = levels.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let floor = if sorted.is_empty() { FLOOR_DB } else { sorted[sorted.len() / 10] };
    let threshold = if o.relative { floor + o.threshold_db.max(0.0) } else { o.threshold_db };
    let mut quiet: Vec<bool> = levels.iter().map(|l| *l < threshold).collect();
    // Short bursts between quiet blocks stay quiet.
    let burst = (o.ignore_bursts / BLOCK_S).round() as usize;
    let mut i = 0;
    while i < quiet.len() {
        if quiet[i] {
            i += 1;
            continue;
        }
        let s = i;
        while i < quiet.len() && !quiet[i] {
            i += 1;
        }
        if i - s <= burst && s > 0 && i < quiet.len() {
            quiet[s..i].iter_mut().for_each(|q| *q = true);
        }
    }
    let mut silences = Vec::new();
    let mut i = 0;
    while i < quiet.len() {
        if !quiet[i] {
            i += 1;
            continue;
        }
        let s = i;
        while i < quiet.len() && quiet[i] {
            i += 1;
        }
        let (start, end) = (s as f64 * BLOCK_S, i as f64 * BLOCK_S);
        if end - start + 1e-9 < o.min_silence.max(BLOCK_S) {
            continue;
        }
        // No padding against the ends of the analysed range: nothing to keep there.
        let cut_start = if s == 0 { start } else { start + o.pad_after.max(0.0) };
        let cut_end = if i == quiet.len() { end } else { end - o.pad_before.max(0.0) };
        let (cut_start, cut_end) = if cut_end > cut_start { (cut_start, cut_end) } else { (start, start) };
        silences.push(Silence { start, end, cut_start, cut_end });
    }
    SilenceReport { noise_floor_db: floor, threshold_db: threshold, silences }
}

// --- beats ----------------------------------------------------------------------------

/// Sample rate the beat analysis runs at.
pub const BEAT_RATE: u32 = 11_025;
const BEAT_WIN: usize = 512;
const BEAT_HOP: usize = 128;

/// Onset strength (log spectral flux, local mean removed) and the seconds per value.
pub fn onset_envelope(samples: &[f32], rate: u32) -> (Vec<f64>, f64) {
    let hop_s = BEAT_HOP as f64 / rate as f64;
    if samples.len() < BEAT_WIN {
        return (Vec::new(), hop_s);
    }
    let window: Vec<f64> = (0..BEAT_WIN).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / BEAT_WIN as f64).cos()).collect();
    let frames = (samples.len() - BEAT_WIN) / BEAT_HOP + 1;
    let mut prev = vec![0.0; BEAT_WIN / 2];
    let mut env = Vec::with_capacity(frames);
    let (mut re, mut im) = (vec![0.0; BEAT_WIN], vec![0.0; BEAT_WIN]);
    for f in 0..frames {
        let at = f * BEAT_HOP;
        for i in 0..BEAT_WIN {
            re[i] = samples[at + i] as f64 * window[i];
            im[i] = 0.0;
        }
        fft(&mut re, &mut im, false);
        let mut flux = 0.0;
        for k in 0..BEAT_WIN / 2 {
            let mag = (1.0 + 1000.0 * (re[k] * re[k] + im[k] * im[k]).sqrt()).ln();
            if f > 0 {
                flux += (mag - prev[k]).max(0.0);
            }
            prev[k] = mag;
        }
        env.push(flux);
    }
    // Remove the local mean (0.5 s) so loudness changes do not look like onsets.
    let half = (0.25 / hop_s).round() as usize;
    let mut prefix = vec![0.0; env.len() + 1];
    for (i, v) in env.iter().enumerate() {
        prefix[i + 1] = prefix[i] + v;
    }
    let out: Vec<f64> = (0..env.len())
        .map(|i| {
            let (a, b) = (i.saturating_sub(half), (i + half + 1).min(env.len()));
            (env[i] - (prefix[b] - prefix[a]) / (b - a) as f64).max(0.0)
        })
        .collect();
    let sd = (out.iter().map(|v| v * v).sum::<f64>() / out.len().max(1) as f64).sqrt();
    (out.iter().map(|v| if sd > 0.0 { v / sd } else { 0.0 }).collect(), hop_s)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BeatOptions {
    pub min_bpm: f64,
    pub max_bpm: f64,
    /// Preferred tempo the search leans towards when two tempi fit (double/half).
    pub prefer_bpm: f64,
    /// 0..1: how strong an onset must be to count as a rhythmic peak (higher finds fewer).
    pub peak_threshold: f64,
    /// Beats per bar used to number the beats (an assumption, not detected).
    pub beats_per_bar: u32,
}

impl Default for BeatOptions {
    fn default() -> Self {
        Self { min_bpm: 60.0, max_bpm: 200.0, prefer_bpm: 120.0, peak_threshold: 0.5, beats_per_bar: 4 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    pub time: f64,
    /// Onset strength at the beat (normalised, 1 = typical).
    pub strength: f64,
    /// Position in the bar, 1-based, when the bar phase was clear; otherwise `None`.
    pub beat_in_bar: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatReport {
    pub bpm: Option<f64>,
    /// How clearly the tempo stands out (autocorrelation peak over its mean); below ~1.5 the tempo is unreliable.
    pub tempo_confidence: f64,
    pub beats: Vec<Beat>,
    /// Strong onsets (accents, hits), seconds and strength.
    pub peaks: Vec<(f64, f64)>,
    /// Whether the beats could be grouped into bars of `beats_per_bar`.
    pub bars: bool,
}

/// Tempo, beats and accents in an onset envelope from [`onset_envelope`].
///
/// Tempo: autocorrelation weighted towards `prefer_bpm`; beats: dynamic
/// programming (Ellis 2007) that balances onset strength against steady spacing.
pub fn detect_beats(env: &[f64], hop_s: f64, o: &BeatOptions) -> BeatReport {
    let empty = BeatReport { bpm: None, tempo_confidence: 0.0, beats: Vec::new(), peaks: Vec::new(), bars: false };
    if env.len() < 16 || hop_s <= 0.0 {
        return empty;
    }
    let peaks = onset_peaks(env, hop_s, o.peak_threshold);
    let (lo, hi) = (o.min_bpm.clamp(20.0, 400.0), o.max_bpm.clamp(20.0, 400.0).max(o.min_bpm + 1.0));
    let lag_of = |bpm: f64| 60.0 / bpm / hop_s;
    let (lmin, lmax) = (lag_of(hi).floor().max(1.0) as usize, (lag_of(lo).ceil() as usize).min(env.len() - 1));
    if lmin >= lmax {
        return BeatReport { peaks, ..empty };
    }
    let ac = |l: usize| env[l..].iter().zip(env.iter()).map(|(a, b)| a * b).sum::<f64>() / (env.len() - l) as f64;
    let raw: Vec<f64> = (lmin..=lmax).map(ac).collect();
    let weight = |l: usize| {
        let bpm = 60.0 / (l as f64 * hop_s);
        (-0.5 * ((bpm / o.prefer_bpm.max(1.0)).log2() / 1.0).powi(2)).exp()
    };
    let scored: Vec<f64> = raw.iter().enumerate().map(|(k, v)| v * weight(lmin + k)).collect();
    let (best_k, _) = scored.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap();
    let mean = raw.iter().sum::<f64>() / raw.len() as f64;
    let confidence = if mean > 0.0 { raw[best_k] / mean } else { 0.0 };
    // Parabolic refinement of the period.
    let mut period = (lmin + best_k) as f64;
    if best_k > 0 && best_k + 1 < raw.len() {
        let (a, b, c) = (raw[best_k - 1], raw[best_k], raw[best_k + 1]);
        let den = a - 2.0 * b + c;
        if den.abs() > 1e-12 {
            period += (0.5 * (a - c) / den).clamp(-0.5, 0.5);
        }
    }
    let bpm = 60.0 / (period * hop_s);

    // Dynamic programming over beat positions.
    let n = env.len();
    let tightness = 100.0;
    let mut score = env.to_vec();
    let mut back = vec![usize::MAX; n];
    let (pmin, pmax) = ((period * 0.5).round() as usize, (period * 2.0).round() as usize);
    for t in 0..n {
        let mut best = f64::NEG_INFINITY;
        let from = t.saturating_sub(pmax);
        for (k, prev_score) in score[from..t.saturating_sub(pmin.max(1))].iter().enumerate() {
            let prev = from + k;
            let s = prev_score - tightness * (((t - prev) as f64) / period).ln().powi(2);
            if s > best {
                best = s;
                back[t] = prev;
            }
        }
        if best.is_finite() && best > 0.0 {
            score[t] += best;
        } else {
            back[t] = usize::MAX;
        }
    }
    let tail = (n as f64 - period).max(0.0) as usize;
    let mut t = (tail..n).max_by(|a, b| score[*a].total_cmp(&score[*b])).unwrap_or(n - 1);
    let mut idx = vec![t];
    while back[t] != usize::MAX {
        t = back[t];
        idx.push(t);
    }
    idx.reverse();
    let offset = BEAT_WIN as f64 / 2.0 * hop_s / BEAT_HOP as f64;
    let mut beats: Vec<Beat> = idx.iter().map(|i| Beat { time: *i as f64 * hop_s + offset, strength: env[*i], beat_in_bar: None }).collect();

    // Bar phase: the beat position with the strongest onsets on average starts
    // the bar. Only assigned when it clearly stands out.
    let per_bar = o.beats_per_bar.clamp(2, 12) as usize;
    let mut bars = false;
    if beats.len() >= per_bar * 4 {
        let sums: Vec<f64> = (0..per_bar).map(|p| beats.iter().skip(p).step_by(per_bar).map(|b| b.strength).sum::<f64>()).collect();
        let (phase, top) = sums.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(p, v)| (p, *v)).unwrap();
        let rest = (sums.iter().sum::<f64>() - top) / (per_bar - 1) as f64;
        if rest > 0.0 && top / rest >= 1.15 {
            bars = true;
            for (k, b) in beats.iter_mut().enumerate() {
                b.beat_in_bar = Some(((k + per_bar - phase) % per_bar) as u32 + 1);
            }
        }
    }
    BeatReport { bpm: (confidence >= 1.2).then_some(bpm), tempo_confidence: confidence, beats, peaks, bars }
}

fn onset_peaks(env: &[f64], hop_s: f64, threshold: f64) -> Vec<(f64, f64)> {
    let level = 1.0 + 3.0 * threshold.clamp(0.0, 1.0);
    let gap = (0.1 / hop_s).round() as usize;
    let offset = BEAT_WIN as f64 / 2.0 * hop_s / BEAT_HOP as f64;
    let mut out: Vec<(usize, f64)> = Vec::new();
    for i in 1..env.len().saturating_sub(1) {
        if env[i] >= level && env[i] >= env[i - 1] && env[i] > env[i + 1] {
            match out.last_mut() {
                Some(last) if i - last.0 < gap => {
                    if env[i] > last.1 {
                        *last = (i, env[i]);
                    }
                }
                _ => out.push((i, env[i])),
            }
        }
    }
    out.into_iter().map(|(i, v)| (i as f64 * hop_s + offset, v)).collect()
}

// --- highlights -----------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HighlightOptions {
    /// Length of a suggested moment, seconds.
    pub window: f64,
    /// Most suggestions returned.
    pub count: usize,
    /// Weights of the signals (0 switches one off).
    pub motion: f64,
    pub loudness: f64,
    pub cuts: f64,
}

impl Default for HighlightOptions {
    fn default() -> Self {
        Self { window: 5.0, count: 8, motion: 1.0, loudness: 1.0, cuts: 0.5 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub start: f64,
    pub end: f64,
    /// Weighted sum of standard scores; only meaningful relative to the other suggestions.
    pub score: f64,
    /// Which signals stand out (standard score above 1): "motion", "loudness", "cuts".
    pub reasons: Vec<String>,
}

fn zscores(v: &[f64]) -> Vec<f64> {
    let n = v.len().max(1) as f64;
    let mean = v.iter().sum::<f64>() / n;
    let sd = (v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n).sqrt();
    v.iter().map(|x| if sd > 1e-12 { (x - mean) / sd } else { 0.0 }).collect()
}

/// Suggests moments that stand out by motion, loudness and cut density.
///
/// `motion` is per video frame at `fps`, `levels` per [`BLOCK_S`] block (may be
/// empty for silent media), `cuts` in seconds; all relative to the same start.
/// These are measurements of activity, not of quality: the UI presents them as suggestions.
pub fn detect_highlights(motion: &[f64], fps: f64, levels: &[f64], cuts: &[f64], duration: f64, o: &HighlightOptions) -> Vec<Highlight> {
    let secs = duration.floor() as usize;
    let window = o.window.max(1.0).round() as usize;
    if secs < window || o.count == 0 {
        return Vec::new();
    }
    let per_sec = |f: &dyn Fn(usize) -> f64| (0..secs).map(f).collect::<Vec<f64>>();
    let mot = per_sec(&|s| {
        let (a, b) = (((s as f64) * fps) as usize, (((s + 1) as f64) * fps) as usize);
        let part = &motion[a.min(motion.len())..b.min(motion.len())];
        if part.is_empty() { 0.0 } else { part.iter().sum::<f64>() / part.len() as f64 }
    });
    let blocks = (1.0 / BLOCK_S) as usize;
    let loud = per_sec(&|s| {
        let part = &levels[(s * blocks).min(levels.len())..((s + 1) * blocks).min(levels.len())];
        if part.is_empty() {
            FLOOR_DB
        } else {
            10.0 * (part.iter().map(|l| 10f64.powf(l / 10.0)).sum::<f64>() / part.len() as f64).log10()
        }
    });
    let cut = per_sec(&|s| cuts.iter().filter(|c| **c >= s as f64 && **c < (s + 1) as f64).count() as f64);
    let (zm, zl, zc) = (zscores(&mot), zscores(&loud), zscores(&cut));
    let mut candidates: Vec<Highlight> = (0..=secs - window)
        .map(|s| {
            let avg = |z: &[f64]| z[s..s + window].iter().sum::<f64>() / window as f64;
            let (m, l, c) = (avg(&zm), if levels.is_empty() { 0.0 } else { avg(&zl) }, avg(&zc));
            let mut reasons = Vec::new();
            for (name, v, w) in [("motion", m, o.motion), ("loudness", l, o.loudness), ("cuts", c, o.cuts)] {
                if w > 0.0 && v > 1.0 {
                    reasons.push(name.to_string());
                }
            }
            Highlight { start: s as f64, end: (s + window) as f64, score: o.motion * m + o.loudness * l + o.cuts * c, reasons }
        })
        .collect();
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut out: Vec<Highlight> = Vec::new();
    for c in candidates {
        if out.len() >= o.count {
            break;
        }
        if c.score > 0.0 && out.iter().all(|h| c.end <= h.start || c.start >= h.end) {
            out.push(c);
        }
    }
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(r: u8, g: u8, b: u8) -> Vec<u8> {
        [r, g, b].repeat(STAT_W * STAT_H)
    }

    fn stats_of(frames: &[Vec<u8>]) -> Vec<FrameStats> {
        let (mut prev, mut cur) = (Vec::new(), Vec::new());
        frames
            .iter()
            .map(|f| {
                let s = FrameStats::of(f, (!prev.is_empty()).then_some(&prev[..]), &mut cur);
                std::mem::swap(&mut prev, &mut cur);
                s
            })
            .collect()
    }

    /// A textured frame that moves by `shift` pixels (busy, handheld-like footage).
    fn texture(shift: usize, tone: u8) -> Vec<u8> {
        let mut v = Vec::with_capacity(STAT_W * STAT_H * 3);
        for y in 0..STAT_H {
            for x in 0..STAT_W {
                let k = ((x + shift) / 4 + y / 4) % 2;
                let c = if k == 0 { tone } else { tone / 3 };
                v.extend([c, c / 2 + 40, 255 - c]);
            }
        }
        v
    }

    #[test]
    fn finds_hard_cuts_and_ignores_motion_and_flashes() {
        let fps = 25.0;
        let mut frames = Vec::new();
        for i in 0..50 {
            frames.push(texture(i, 200)); // moving texture, no cut
        }
        for _ in 0..50 {
            frames.push(solid(20, 120, 30)); // cut at 2.0 s
        }
        frames[75] = solid(255, 255, 255); // single-frame flash at 3.0 s
        for _ in 0..30 {
            frames.push(solid(200, 40, 40)); // cut at 4.0 s
        }
        let cuts = detect_scenes(&stats_of(&frames), fps, &SceneOptions::default());
        let times: Vec<f64> = cuts.iter().map(|c| c.time).collect();
        assert_eq!(times, vec![2.0, 4.0], "{cuts:?}");
        assert!(cuts.iter().all(|c| c.kind == CutKind::Hard));
        // Without flash suppression the flash shows up as well.
        let all = detect_scenes(&stats_of(&frames), fps, &SceneOptions { ignore_flashes: false, min_scene: 0.0, ..Default::default() });
        assert!(all.iter().any(|c| (c.time - 3.0).abs() < 0.05), "{all:?}");
    }

    #[test]
    fn finds_fades_as_gradual_changes() {
        let fps = 25.0;
        // A gradient picture (real footage spreads over many histogram bins).
        let picture = |f: f64| -> Vec<u8> {
            let mut v = Vec::with_capacity(STAT_W * STAT_H * 3);
            for y in 0..STAT_H {
                for x in 0..STAT_W {
                    let c = (x * 4) as f64;
                    v.extend([(c * f) as u8, ((255.0 - c) * f) as u8, ((y * 7) as f64 * f) as u8]);
                }
            }
            v
        };
        let mut frames: Vec<Vec<u8>> = (0..40).map(|_| picture(1.0)).collect();
        // 1.2 s fade to black, then black.
        for k in 1..=30 {
            frames.push(picture(1.0 - k as f64 / 30.0));
        }
        frames.extend((0..40).map(|_| solid(0, 0, 0)));
        let cuts = detect_scenes(&stats_of(&frames), fps, &SceneOptions::default());
        assert_eq!(cuts.len(), 1, "{cuts:?}");
        let c = &cuts[0];
        assert_eq!(c.kind, CutKind::Gradual);
        assert!(c.from >= 1.4 && c.to <= 3.0 && c.time > 1.8 && c.time < 2.8, "{c:?}");
        assert!(c.luma_change < -0.5, "a fade to black darkens: {c:?}");
        // Gradual detection can be switched off.
        assert!(detect_scenes(&stats_of(&frames), fps, &SceneOptions { gradual: false, ..Default::default() }).is_empty());
    }

    #[test]
    fn finds_pauses_relative_to_the_noise_floor() {
        let rate = 16_000;
        let mut s = Vec::new();
        let mut noise = 12345u32;
        let mut rnd = || {
            noise = noise.wrapping_mul(1_103_515_245).wrapping_add(12345);
            ((noise >> 16) as f32 / 32768.0 - 1.0) * 0.003 // about -55 dBFS hiss
        };
        let tone = |i: usize| (i as f32 * 0.07).sin() * 0.3;
        let mut push = |secs: f64, loud: bool, s: &mut Vec<f32>| {
            for i in 0..(secs * rate as f64) as usize {
                s.push(rnd() + if loud { tone(i) } else { 0.0 });
            }
        };
        push(1.0, true, &mut s);
        push(0.8, false, &mut s); // pause 1.0..1.8
        push(1.0, true, &mut s);
        push(0.3, false, &mut s); // too short
        push(1.0, true, &mut s);
        push(0.7, false, &mut s); // trailing pause 4.1..4.8
        let levels = block_levels(&s, rate);
        let r = detect_silence(&levels, &SilenceOptions::default());
        assert!(r.noise_floor_db < -50.0 && r.noise_floor_db > -65.0, "{r:?}");
        assert_eq!(r.silences.len(), 2, "{r:?}");
        let p = &r.silences[0];
        assert!((p.start - 1.0).abs() < 0.02 && (p.end - 1.8).abs() < 0.02, "{p:?}");
        assert!((p.cut_start - 1.15).abs() < 0.02 && (p.cut_end - 1.7).abs() < 0.02, "{p:?}");
        let tail = &r.silences[1];
        assert!((tail.cut_end - tail.end).abs() < 1e-9, "no padding at the end of the range");
        // An absolute threshold below the hiss finds nothing.
        let none = detect_silence(&levels, &SilenceOptions { relative: false, threshold_db: -80.0, ..Default::default() });
        assert!(none.silences.is_empty());
    }

    fn clicks(bpm: f64, secs: f64, accent_every: usize) -> Vec<f32> {
        let rate = BEAT_RATE as usize;
        let mut s = vec![0f32; (secs * rate as f64) as usize];
        let period = 60.0 / bpm;
        let mut k = 0;
        let mut t = 0.5;
        while t < secs - 0.1 {
            let at = (t * rate as f64) as usize;
            let amp = if k % accent_every == 0 { 0.9 } else { 0.4 };
            for i in 0..400.min(s.len() - at) {
                s[at + i] += amp * (i as f32 * 0.9).sin() * (-(i as f32) / 60.0).exp();
            }
            t += period;
            k += 1;
        }
        s
    }

    #[test]
    fn finds_tempo_beats_and_bars_of_a_click_track() {
        let s = clicks(120.0, 20.0, 4);
        let (env, hop) = onset_envelope(&s, BEAT_RATE);
        let r = detect_beats(&env, hop, &BeatOptions::default());
        let bpm = r.bpm.expect("tempo found");
        assert!((bpm - 120.0).abs() < 2.0, "bpm {bpm}");
        assert!(r.beats.len() >= 36, "{} beats", r.beats.len());
        // Every beat lies on a click (0.5 s grid from 0.5 s) within 25 ms.
        for b in &r.beats {
            let off = ((b.time - 0.5) / 0.5).round() * 0.5 + 0.5 - b.time;
            assert!(off.abs() < 0.025, "beat at {} is {off} s off", b.time);
        }
        assert!(r.bars, "accented downbeats give the bar phase");
        for b in &r.beats {
            let k = ((b.time - 0.5) / 0.5).round() as usize;
            assert_eq!(b.beat_in_bar, Some((k % 4) as u32 + 1), "at {}", b.time);
        }
        assert!(!r.peaks.is_empty());
        // Silence has no tempo.
        let quiet = vec![0f32; BEAT_RATE as usize * 5];
        let (env, hop) = onset_envelope(&quiet, BEAT_RATE);
        assert_eq!(detect_beats(&env, hop, &BeatOptions::default()).bpm, None);
    }

    #[test]
    fn suggests_the_busiest_and_loudest_moments() {
        let fps = 10.0;
        let duration = 60.0;
        let mut motion = vec![0.01; (duration * fps) as usize];
        motion[200..250].iter_mut().for_each(|m| *m = 0.2); // 20–25 s
        let mut levels = vec![-40.0; (duration / BLOCK_S) as usize];
        levels[4000..4500].iter_mut().for_each(|l| *l = -6.0); // 40–45 s
        let h = detect_highlights(&motion, fps, &levels, &[], duration, &HighlightOptions { count: 2, ..Default::default() });
        assert_eq!(h.len(), 2, "{h:?}");
        assert_eq!((h[0].start, h[0].end), (20.0, 25.0));
        assert_eq!(h[0].reasons, vec!["motion"]);
        assert_eq!((h[1].start, h[1].end), (40.0, 45.0));
        assert_eq!(h[1].reasons, vec!["loudness"]);
        assert!(detect_highlights(&motion, fps, &levels, &[], 3.0, &HighlightOptions::default()).is_empty());
    }
}
