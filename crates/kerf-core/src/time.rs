//! Time base.
//!
//! The timeline works exclusively in integer frames of the sequence frame
//! rate, so every edit is frame-accurate by construction. Conversion to
//! seconds only happens at the media boundary (decode, playback, export).

use serde::{Deserialize, Serialize};

/// A position or length on the timeline, in sequence frames.
pub type Frame = i64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Rational {
    pub num: i64,
    pub den: i64,
}

impl Rational {
    pub const fn new(num: i64, den: i64) -> Self {
        Self { num, den }
    }

    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    pub fn is_valid(self) -> bool {
        self.num > 0 && self.den > 0
    }

    /// Seconds at the start of `frames`.
    pub fn frames_to_seconds(self, frames: Frame) -> f64 {
        frames as f64 * self.den as f64 / self.num as f64
    }

    /// Number of whole frames that fit into `seconds`.
    pub fn seconds_to_frames_floor(self, seconds: f64) -> Frame {
        (seconds * self.num as f64 / self.den as f64 + 1e-6).floor() as Frame
    }

    pub fn seconds_to_frames_round(self, seconds: f64) -> Frame {
        (seconds * self.num as f64 / self.den as f64).round() as Frame
    }

    /// Parses ffprobe style rates ("30000/1001", "25/1", "25").
    pub fn parse(s: &str) -> Option<Self> {
        let (n, d) = match s.split_once('/') {
            Some((n, d)) => (n.trim().parse::<i64>().ok()?, d.trim().parse::<i64>().ok()?),
            None => (s.trim().parse::<i64>().ok()?, 1),
        };
        let r = Self::new(n, d);
        r.is_valid().then_some(r)
    }

    /// Nominal integer rate used for timecode counting (30 for 29.97).
    pub fn timecode_base(self) -> i64 {
        self.as_f64().round().max(1.0) as i64
    }

    /// True for the NTSC rates where SMPTE drop-frame timecode applies.
    pub fn supports_drop_frame(self) -> bool {
        self.den == 1001 && (self.num == 30000 || self.num == 60000)
    }
}

/// Formats `frame` as SMPTE timecode `HH:MM:SS:FF` (`;` before frames for drop-frame).
pub fn format_timecode(frame: Frame, rate: Rational, drop_frame: bool) -> String {
    let sign = if frame < 0 { "-" } else { "" };
    let mut f = frame.abs();
    let base = rate.timecode_base();
    let drop = drop_frame && rate.supports_drop_frame();
    if drop {
        let dropped = if base == 30 { 2 } else { 4 };
        let per_10min = base * 600 - dropped * 9;
        let per_min = base * 60 - dropped;
        let tens = f / per_10min;
        let rem = f % per_10min;
        f += dropped * 9 * tens;
        if rem > dropped {
            f += dropped * ((rem - dropped) / per_min);
        }
    }
    let ff = f % base;
    let total_s = f / base;
    let ss = total_s % 60;
    let mm = (total_s / 60) % 60;
    let hh = total_s / 3600;
    let sep = if drop { ';' } else { ':' };
    format!("{sign}{hh:02}:{mm:02}:{ss:02}{sep}{ff:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rates() {
        assert_eq!(Rational::parse("30000/1001"), Some(Rational::new(30000, 1001)));
        assert_eq!(Rational::parse("25"), Some(Rational::new(25, 1)));
        assert_eq!(Rational::parse("0/0"), None);
        assert_eq!(Rational::parse("abc"), None);
    }

    #[test]
    fn converts_frames_and_seconds() {
        let r = Rational::new(25, 1);
        assert_eq!(r.frames_to_seconds(50), 2.0);
        assert_eq!(r.seconds_to_frames_floor(1.999), 49);
        assert_eq!(r.seconds_to_frames_floor(2.0), 50);
        let ntsc = Rational::new(30000, 1001);
        assert_eq!(ntsc.seconds_to_frames_round(ntsc.frames_to_seconds(1799)), 1799);
    }

    #[test]
    fn formats_non_drop_timecode() {
        let r = Rational::new(25, 1);
        assert_eq!(format_timecode(0, r, false), "00:00:00:00");
        assert_eq!(format_timecode(25 * 3661 + 7, r, false), "01:01:01:07");
        assert_eq!(format_timecode(-1, r, false), "-00:00:00:01");
    }

    #[test]
    fn formats_drop_frame_timecode() {
        let r = Rational::new(30000, 1001);
        // Frame 1800 at 29.97 DF skips 00:01:00;00 and 00:01:00;01.
        assert_eq!(format_timecode(1799, r, true), "00:00:59;29");
        assert_eq!(format_timecode(1800, r, true), "00:01:00;02");
        // Every tenth minute is not dropped.
        assert_eq!(format_timecode(17982, r, true), "00:10:00;00");
    }
}
