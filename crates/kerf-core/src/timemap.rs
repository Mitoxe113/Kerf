//! Time warp of a clip with keyframed speed: maps source positions
//! (sequence frames at speed 1) to timeline positions and back.
//!
//! Speed keys sit at source positions like every key. Between two keys the
//! speed changes linearly over timeline time (constant acceleration), so a
//! piece covering `ds` source frames from speed `a` to `b` takes
//! `2 ds / (a + b)` timeline frames and both directions have closed forms;
//! a Hold key keeps its speed up to the next key. Before the first and after
//! the last key the speed is constant. The preview mirrors this in
//! `src/lib/warp.ts`; the export writes [`Warp::expr`] into `setpts`.

use crate::model::{Ease, Keyframe};

/// Allowed speed range (factor).
pub const MIN_SPEED: f64 = 0.1;
pub const MAX_SPEED: f64 = 16.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Piece {
    /// Source and timeline position where the piece starts.
    s0: f64,
    w0: f64,
    /// Speed at the start and its change per timeline frame.
    v0: f64,
    acc: f64,
}

impl Piece {
    fn w(&self, s: f64) -> f64 {
        let ds = s - self.s0;
        // ds = v0 dw + acc dw² / 2, solved without dividing by acc.
        self.w0 + 2.0 * ds / (self.v0 + (self.v0 * self.v0 + 2.0 * self.acc * ds).max(0.0).sqrt())
    }

    fn s(&self, w: f64) -> f64 {
        let dw = w - self.w0;
        self.s0 + self.v0 * dw + 0.5 * self.acc * dw * dw
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Warp {
    /// Ordered by `s0` (and so by `w0`); the first also covers everything before it.
    pieces: Vec<Piece>,
}

impl Warp {
    /// Warp for speed `keys` (source positions), or constant `base` without keys.
    pub fn new(keys: &[Keyframe], base: f64) -> Self {
        let clamp = |v: f32| (v as f64).clamp(MIN_SPEED, MAX_SPEED);
        let Some(first) = keys.first() else {
            return Self { pieces: vec![Piece { s0: 0.0, w0: 0.0, v0: base.clamp(MIN_SPEED, MAX_SPEED), acc: 0.0 }] };
        };
        let mut pieces = vec![Piece { s0: first.at as f64, w0: 0.0, v0: clamp(first.value), acc: 0.0 }];
        let mut w = 0.0;
        for pair in keys.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let ds = (b.at - a.at).max(0) as f64;
            let (va, vb) = (clamp(a.value), clamp(b.value));
            let (dw, acc) = if a.ease == Ease::Hold || ds == 0.0 {
                (ds / va, 0.0)
            } else {
                let dw = 2.0 * ds / (va + vb);
                (dw, (vb - va) / dw)
            };
            pieces.push(Piece { s0: a.at as f64, w0: w, v0: va, acc });
            w += dw;
        }
        let last = keys[keys.len() - 1];
        pieces.push(Piece { s0: last.at as f64, w0: w, v0: clamp(last.value), acc: 0.0 });
        Self { pieces }
    }

    fn piece_by(&self, key: impl Fn(&Piece) -> f64, x: f64) -> &Piece {
        let i = self.pieces.partition_point(|p| key(p) <= x);
        &self.pieces[i.saturating_sub(1)]
    }

    /// Timeline position of source position `s`.
    pub fn w(&self, s: f64) -> f64 {
        self.piece_by(|p| p.s0, s).w(s)
    }

    /// Source position at timeline position `w`.
    pub fn s(&self, w: f64) -> f64 {
        self.piece_by(|p| p.w0, w).s(w)
    }

    /// Speed at timeline position `w`.
    pub fn speed(&self, w: f64) -> f64 {
        let p = self.piece_by(|p| p.w0, w);
        (p.v0 + p.acc * (w - p.w0)).clamp(MIN_SPEED, MAX_SPEED)
    }

    /// Slowest and fastest speed anywhere.
    pub fn speed_range(&self) -> (f64, f64) {
        let mut v: Vec<f64> = self.pieces.iter().map(|p| p.v0).collect();
        for pair in self.pieces.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            v.push(a.v0 + a.acc * (b.w0 - a.w0));
        }
        let lo = v.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = v.iter().copied().fold(0.0, f64::max);
        (lo.clamp(MIN_SPEED, MAX_SPEED), hi.clamp(MIN_SPEED, MAX_SPEED))
    }

    /// FFmpeg expression for `w(s)` where `s` is the expression of a source position.
    pub fn expr(&self, s: &str, fmt: impl Fn(f64) -> String) -> String {
        let piece = |p: &Piece| {
            if p.acc == 0.0 {
                format!("({}+({s}-{})/{})", fmt(p.w0), fmt(p.s0), fmt(p.v0))
            } else {
                let v0 = fmt(p.v0);
                format!("({}+2*({s}-{})/({v0}+sqrt(max(0,{v0}*{v0}+2*{}*({s}-{})))))", fmt(p.w0), fmt(p.s0), fmt(p.acc), fmt(p.s0))
            }
        };
        let mut e = piece(&self.pieces[self.pieces.len() - 1]);
        for i in (0..self.pieces.len() - 1).rev() {
            e = format!("if(lt({s},{}),{},{e})", fmt(self.pieces[i + 1].s0), piece(&self.pieces[i]));
        }
        e
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(at: i64, value: f32, ease: Ease) -> Keyframe {
        Keyframe { at, value, ease }
    }

    #[test]
    fn ramps_have_constant_acceleration() {
        // 1x -> 3x over 200 source frames: 2 * 200 / (1 + 3) = 100 timeline frames.
        let w = Warp::new(&[key(100, 1.0, Ease::Linear), key(300, 3.0, Ease::Linear)], 1.0);
        assert!((w.w(300.0) - 100.0).abs() < 1e-9);
        // Half way in time: 50 frames at 1 plus 0.5 * 0.02 * 50² = 75 source frames.
        assert!((w.s(50.0) - 175.0).abs() < 1e-9);
        assert!((w.speed(50.0) - 2.0).abs() < 1e-9);
        // Constant before and after.
        assert!((w.w(50.0) + 50.0).abs() < 1e-9);
        assert!((w.s(110.0) - 330.0).abs() < 1e-9);
        for s in [-20.0, 100.0, 133.3, 250.0, 300.0, 512.0] {
            assert!((w.s(w.w(s)) - s).abs() < 1e-9, "{s}");
        }
        assert_eq!(w.speed_range(), (1.0, 3.0));
    }

    #[test]
    fn hold_keeps_the_speed_and_no_keys_is_constant() {
        let w = Warp::new(&[key(0, 2.0, Ease::Hold), key(100, 0.5, Ease::Linear)], 1.0);
        assert!((w.w(100.0) - 50.0).abs() < 1e-9);
        assert!((w.w(150.0) - 150.0).abs() < 1e-9);
        let c = Warp::new(&[], 4.0);
        assert!((c.w(40.0) - 10.0).abs() < 1e-12 && (c.s(10.0) - 40.0).abs() < 1e-12);
    }

    #[test]
    fn expression_matches_the_function() {
        let w = Warp::new(&[key(100, 1.0, Ease::Linear), key(300, 3.0, Ease::Hold), key(400, 0.5, Ease::Linear)], 1.0);
        let e = w.expr("S", |v| format!("{v}"));
        // Evaluate the expression by hand-rolled substitution of a tiny subset of FFmpeg's syntax.
        for s in [50.0, 150.0, 299.0, 350.0, 500.0] {
            let got = eval(&e.replace('S', &format!("({s})")));
            assert!((got - w.w(s)).abs() < 1e-9, "{s}: {got} vs {}", w.w(s));
        }
    }

    /// Evaluates numbers, + - * /, parentheses, sqrt, max, lt and if.
    fn eval(e: &str) -> f64 {
        fn expr(t: &[u8], i: &mut usize) -> f64 {
            let mut v = term(t, i);
            while *i < t.len() && (t[*i] == b'+' || t[*i] == b'-') {
                let op = t[*i];
                *i += 1;
                let r = term(t, i);
                v = if op == b'+' { v + r } else { v - r };
            }
            v
        }
        fn term(t: &[u8], i: &mut usize) -> f64 {
            let mut v = atom(t, i);
            while *i < t.len() && (t[*i] == b'*' || t[*i] == b'/') {
                let op = t[*i];
                *i += 1;
                let r = atom(t, i);
                v = if op == b'*' { v * r } else { v / r };
            }
            v
        }
        fn args(t: &[u8], i: &mut usize) -> Vec<f64> {
            *i += 1; // (
            let mut out = vec![expr(t, i)];
            while t[*i] == b',' {
                *i += 1;
                out.push(expr(t, i));
            }
            *i += 1; // )
            out
        }
        fn atom(t: &[u8], i: &mut usize) -> f64 {
            if t[*i] == b'-' {
                *i += 1;
                return -atom(t, i);
            }
            if t[*i] == b'(' {
                *i += 1;
                let v = expr(t, i);
                *i += 1;
                return v;
            }
            let start = *i;
            while *i < t.len() && (t[*i].is_ascii_alphanumeric() || t[*i] == b'.') {
                *i += 1;
            }
            let word = std::str::from_utf8(&t[start..*i]).unwrap();
            match word {
                "sqrt" => args(t, i)[0].sqrt(),
                "max" => {
                    let a = args(t, i);
                    a[0].max(a[1])
                }
                "lt" => {
                    let a = args(t, i);
                    (a[0] < a[1]) as i32 as f64
                }
                "if" => {
                    let a = args(t, i);
                    if a[0] != 0.0 { a[1] } else { a[2] }
                }
                n => n.parse().unwrap(),
            }
        }
        expr(e.as_bytes(), &mut 0)
    }
}
