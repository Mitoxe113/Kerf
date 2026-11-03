//! A small evaluator for the FFmpeg expression subset the renderer writes
//! (tests only): numbers, one variable, + - * / with the usual precedence,
//! unary minus and the functions used by the tone curves.

pub fn eval(src: &str, var: &str, value: f64) -> f64 {
    let mut p = Parser { s: src.as_bytes(), i: 0, var, value };
    let v = p.sum();
    assert_eq!(p.i, p.s.len(), "trailing input in {src:?} at {}", p.i);
    v
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    var: &'a str,
    value: f64,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn sum(&mut self) -> f64 {
        let mut v = self.product();
        while let Some(c @ (b'+' | b'-')) = self.peek() {
            self.i += 1;
            let r = self.product();
            v = if c == b'+' { v + r } else { v - r };
        }
        v
    }

    fn product(&mut self) -> f64 {
        let mut v = self.unary();
        while let Some(c @ (b'*' | b'/')) = self.peek() {
            self.i += 1;
            let r = self.unary();
            v = if c == b'*' { v * r } else { v / r };
        }
        v
    }

    fn unary(&mut self) -> f64 {
        match self.peek() {
            Some(b'-') => {
                self.i += 1;
                -self.unary()
            }
            Some(b'+') => {
                self.i += 1;
                self.unary()
            }
            _ => self.atom(),
        }
    }

    fn args(&mut self) -> Vec<f64> {
        assert_eq!(self.peek(), Some(b'('));
        self.i += 1;
        let mut out = vec![self.sum()];
        while self.peek() == Some(b',') {
            self.i += 1;
            out.push(self.sum());
        }
        assert_eq!(self.peek(), Some(b')'));
        self.i += 1;
        out
    }

    fn atom(&mut self) -> f64 {
        let start = self.i;
        if self.peek() == Some(b'(') {
            self.i += 1;
            let v = self.sum();
            assert_eq!(self.peek(), Some(b')'));
            self.i += 1;
            return v;
        }
        while self.peek().is_some_and(|c| c.is_ascii_digit() || c == b'.' || (c == b'e' && self.i > start)) {
            self.i += 1;
        }
        if self.i > start {
            return std::str::from_utf8(&self.s[start..self.i]).unwrap().parse().unwrap();
        }
        while self.peek().is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_') {
            self.i += 1;
        }
        let name = std::str::from_utf8(&self.s[start..self.i]).unwrap();
        if name == self.var {
            return self.value;
        }
        let a = self.args();
        match name {
            "pow" => a[0].powf(a[1]),
            "clip" => a[0].max(a[1]).min(a[2]),
            "max" => a[0].max(a[1]),
            "min" => a[0].min(a[1]),
            "floor" => a[0].floor(),
            "abs" => a[0].abs(),
            "gt" => (a[0] > a[1]) as u8 as f64,
            "lt" => (a[0] < a[1]) as u8 as f64,
            "if" => {
                if a[0] != 0.0 {
                    a[1]
                } else {
                    a.get(2).copied().unwrap_or(0.0)
                }
            }
            other => panic!("unknown function {other}"),
        }
    }
}
