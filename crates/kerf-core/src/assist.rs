//! Edits derived from analysis results: ducking curves and the timeline
//! ranges of source-time findings. Pure functions; the app turns their output
//! into ordinary edit commands, so everything stays undoable and editable.

use serde::{Deserialize, Serialize};

use crate::model::{Clip, Ease, Keyframe, Param};
use crate::time::Frame;

/// Joins ranges that overlap or lie less than `gap` apart; the result is sorted.
pub fn merge_ranges(mut ranges: Vec<(f64, f64)>, gap: f64) -> Vec<(f64, f64)> {
    ranges.retain(|(a, b)| b > a);
    ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (a, b) in ranges {
        match out.last_mut() {
            Some(last) if a - last.1 <= gap => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DuckOptions {
    /// How far the music goes down while someone speaks, dB.
    pub depth_db: f32,
    /// Fade down before speech starts, seconds.
    pub attack: f64,
    /// Time the music stays down after speech ends, seconds.
    pub hold: f64,
    /// Fade back up, seconds.
    pub release: f64,
}

impl Default for DuckOptions {
    fn default() -> Self {
        Self { depth_db: 12.0, attack: 0.25, hold: 0.3, release: 0.6 }
    }
}

/// The gain curve (dB below the clip's own volume) as breakpoints on the
/// sequence clock: 0 outside speech, `-depth` while ducked, linear ramps.
pub fn duck_curve(speech: &[(f64, f64)], o: &DuckOptions) -> Vec<(f64, f32)> {
    let depth = -o.depth_db.abs();
    let (attack, hold, release) = (o.attack.max(0.0), o.hold.max(0.0), o.release.max(0.0));
    // Pauses too short to come back up stay ducked.
    let ducked = merge_ranges(speech.iter().map(|(a, b)| (*a, *b + hold)).collect(), attack + release);
    let mut points = Vec::new();
    for (a, b) in ducked {
        points.extend([(a - attack, 0.0), (a, depth), (b, depth), (b + release, 0.0)]);
    }
    points
}

/// Value of a breakpoint curve at `t` (0 outside it).
fn curve_at(points: &[(f64, f32)], t: f64) -> f32 {
    for w in points.windows(2) {
        let ((a, va), (b, vb)) = (w[0], w[1]);
        if t >= a && t <= b {
            return if b > a { va + (vb - va) * ((t - a) / (b - a)) as f32 } else { vb };
        }
    }
    0.0
}

/// Volume keys for `clip` that duck it under `speech` (sequence seconds) at
/// `fps`. Existing volume keys are replaced. `None` for clips whose source
/// time does not run straight (reversed or speed-ramped), where a curve in
/// source positions would not follow the timeline; an empty list when no
/// speech overlaps the clip.
pub fn duck_keys(clip: &Clip, fps: f64, speech: &[(f64, f64)], o: &DuckOptions) -> Option<Vec<Keyframe>> {
    if clip.reverse || clip.is_warped() || fps <= 0.0 {
        return None;
    }
    let curve = duck_curve(speech, o);
    let (start, end) = (clip.start as f64 / fps, clip.end() as f64 / fps);
    if !curve.windows(2).any(|w| w[0].0 < end && w[1].0 > start && (w[0].1 != 0.0 || w[1].1 != 0.0)) {
        return Some(Vec::new());
    }
    let mut times: Vec<f64> = vec![start];
    times.extend(curve.iter().map(|p| p.0).filter(|t| *t > start && *t < end));
    times.push(end);
    let base = clip.volume_db;
    let (lo, hi) = Param::Volume.range();
    let mut keys: Vec<Keyframe> = Vec::new();
    for t in times {
        let at = clip.source_at(t * fps - clip.start as f64).round() as Frame;
        let value = (base + curve_at(&curve, t)).clamp(lo, hi);
        if keys.last().is_some_and(|k| k.at == at) {
            keys.last_mut().unwrap().value = value;
            continue;
        }
        keys.push(Keyframe { at, value, ease: Ease::Linear });
    }
    // Drop keys in the middle of flat stretches.
    let mut out: Vec<Keyframe> = Vec::new();
    for (i, k) in keys.iter().enumerate() {
        let flat = i > 0 && i + 1 < keys.len() && keys[i - 1].value == k.value && keys[i + 1].value == k.value;
        if !flat {
            out.push(*k);
        }
    }
    Some(out)
}

/// The timeline frames `[a, b)` showing source seconds `[from, to)` of `clip`
/// (sequence at `fps`), cut to the clip; `None` when the clip does not show
/// that part, or runs reversed or ramped.
pub fn timeline_range(clip: &Clip, fps: f64, from: f64, to: f64) -> Option<(Frame, Frame)> {
    if clip.reverse || clip.is_warped() || clip.speed <= 0.0 || to <= from {
        return None;
    }
    // Source position (in sequence frames at speed 1) -> clip-local frame.
    let local = |s: f64| (s * fps - clip.source_in as f64) / clip.speed;
    let a = (clip.start as f64 + local(from)).round().max(clip.start as f64) as Frame;
    let b = (clip.start as f64 + local(to)).round().min(clip.end() as f64) as Frame;
    (b > a).then_some((a, b))
}

/// The timeline frame showing source second `at` of `clip`, when it does.
pub fn timeline_frame(clip: &Clip, fps: f64, at: f64) -> Option<Frame> {
    if clip.reverse || clip.is_warped() || clip.speed <= 0.0 {
        return None;
    }
    let f = (clip.start as f64 + (at * fps - clip.source_in as f64) / clip.speed).round();
    (f >= clip.start as f64 && f < clip.end() as f64).then_some(f as Frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn clip(start: Frame, duration: Frame, source_in: Frame) -> Clip {
        Clip::new(Uuid::new_v4(), "music", start, duration, source_in)
    }

    #[test]
    fn merges_ranges() {
        assert_eq!(merge_ranges(vec![(5.0, 6.0), (1.0, 2.0), (2.2, 3.0), (3.0, 3.0)], 0.5), vec![(1.0, 3.0), (5.0, 6.0)]);
    }

    #[test]
    fn ducks_under_speech_with_attack_hold_and_release() {
        let o = DuckOptions { depth_db: 10.0, attack: 0.2, hold: 0.4, release: 0.4 };
        let mut c = clip(0, 250, 100); // 10 s at 25 fps, source from frame 100
        c.volume_db = -3.0;
        let keys = duck_keys(&c, 25.0, &[(2.0, 4.0), (4.5, 5.0)], &o).unwrap();
        let pairs: Vec<(Frame, f32)> = keys.iter().map(|k| (k.at, k.value)).collect();
        // The 0.5 s gap is shorter than hold + attack + release: one ducked stretch 2.0..5.4.
        assert_eq!(pairs, vec![(100, -3.0), (145, -3.0), (150, -13.0), (235, -13.0), (245, -3.0), (350, -3.0)]);
        // Speech beyond the clip: nothing to do.
        assert!(duck_keys(&c, 25.0, &[(20.0, 22.0)], &o).unwrap().is_empty());
        // Clip starting while ducked starts low.
        let late = clip(75, 100, 0); // 3 s .. 7 s
        let k = duck_keys(&late, 25.0, &[(2.0, 4.0)], &o).unwrap();
        assert_eq!((k[0].at, k[0].value), (0, -10.0));
        // Reversed clips are not handled.
        let mut rev = clip(0, 100, 0);
        rev.reverse = true;
        assert!(duck_keys(&rev, 25.0, &[(1.0, 2.0)], &o).is_none());
    }

    #[test]
    fn maps_source_seconds_to_timeline_frames() {
        let mut c = clip(50, 100, 25); // timeline 50..150 shows source frames 25..125
        assert_eq!(timeline_range(&c, 25.0, 2.0, 3.0), Some((75, 100)));
        assert_eq!(timeline_range(&c, 25.0, 0.0, 1.5), Some((50, 63))); // cut to the clip start
        assert_eq!(timeline_range(&c, 25.0, 10.0, 11.0), None);
        assert_eq!(timeline_frame(&c, 25.0, 2.0), Some(75));
        assert_eq!(timeline_frame(&c, 25.0, 0.5), None);
        c.speed = 2.0; // 50..150 shows 25..225
        assert_eq!(timeline_range(&c, 25.0, 3.0, 5.0), Some((75, 100)));
    }
}
