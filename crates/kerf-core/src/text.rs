//! Titles and subtitles: text styles, title definitions, subtitle cues and the
//! SRT/WebVTT formats.
//!
//! Text is drawn by the UI (Canvas2D, `src/engine/text.ts`) both for the preview
//! and for the PNGs the export overlays, so this module only stores, checks and
//! converts the data.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::time::{Frame, Rational};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    Left,
    #[default]
    Center,
    Right,
}

/// How a block of text looks. Sizes are pixels at 1080 lines and scale with
/// the frame height.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextStyle {
    /// CSS font family.
    pub font: String,
    pub size: f32,
    pub bold: bool,
    pub italic: bool,
    /// RGB 0..1.
    pub color: [f32; 3],
    pub align: TextAlign,
    /// Line distance as a multiple of the size.
    pub line_height: f32,
    /// Outline width; 0 = none.
    pub outline: f32,
    pub outline_color: [f32; 3],
    /// Soft drop shadow (blur radius); 0 = none.
    pub shadow: f32,
    /// Box behind the text; opacity 0 = none.
    pub box_opacity: f32,
    pub box_color: [f32; 3],
    pub box_padding: f32,
    /// Lines wrap at this fraction of the frame width.
    pub wrap: f32,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            font: "Inter Variable".into(),
            size: 96.0,
            bold: true,
            italic: false,
            color: [1.0, 1.0, 1.0],
            align: TextAlign::Center,
            line_height: 1.2,
            outline: 0.0,
            outline_color: [0.0, 0.0, 0.0],
            shadow: 0.0,
            box_opacity: 0.0,
            box_color: [0.0, 0.0, 0.0],
            box_padding: 16.0,
            wrap: 0.9,
        }
    }
}

impl TextStyle {
    /// Default look of subtitles: white, outlined, near the bottom.
    pub fn subtitles() -> Self {
        Self { size: 48.0, bold: false, outline: 3.0, shadow: 4.0, wrap: 0.8, ..Self::default() }
    }

    /// Clamps every value to its range; `None` for non-finite numbers.
    pub fn sanitized(&self) -> Option<Self> {
        let ok = |v: f32, lo: f32, hi: f32| v.is_finite().then(|| v.clamp(lo, hi));
        let rgb = |c: [f32; 3]| -> Option<[f32; 3]> { Some([ok(c[0], 0.0, 1.0)?, ok(c[1], 0.0, 1.0)?, ok(c[2], 0.0, 1.0)?]) };
        let font: String = self.font.chars().filter(|c| !c.is_control() && !matches!(c, ';' | '{' | '}')).take(64).collect();
        Some(Self {
            font: if font.trim().is_empty() { "Inter Variable".into() } else { font.trim().to_string() },
            size: ok(self.size, 4.0, 1000.0)?,
            bold: self.bold,
            italic: self.italic,
            color: rgb(self.color)?,
            align: self.align,
            line_height: ok(self.line_height, 0.5, 4.0)?,
            outline: ok(self.outline, 0.0, 50.0)?,
            outline_color: rgb(self.outline_color)?,
            shadow: ok(self.shadow, 0.0, 100.0)?,
            box_opacity: ok(self.box_opacity, 0.0, 1.0)?,
            box_color: rgb(self.box_color)?,
            box_padding: ok(self.box_padding, 0.0, 400.0)?,
            wrap: ok(self.wrap, 0.1, 1.0)?,
        })
    }
}

/// A generated title: text drawn onto a transparent frame of `width` × `height`
/// (the sequence size when it was created). Stored on its media asset; the
/// asset's file is the rendered PNG.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleSpec {
    pub text: String,
    #[serde(default)]
    pub style: TextStyle,
    /// Anchor of the text block, 0..1 of the frame: `x` is its left edge,
    /// centre or right edge by the alignment, `y` its vertical centre.
    #[serde(default = "half")]
    pub x: f32,
    #[serde(default = "half")]
    pub y: f32,
    pub width: u32,
    pub height: u32,
}

fn half() -> f32 {
    0.5
}

/// Longest text of a title or cue.
pub const MAX_TEXT: usize = 10_000;

impl TitleSpec {
    pub fn sanitized(&self) -> Option<Self> {
        if !(16..=8192).contains(&self.width) || !(16..=8192).contains(&self.height) || !self.x.is_finite() || !self.y.is_finite() {
            return None;
        }
        Some(Self {
            text: clean_text(&self.text),
            style: self.style.sanitized()?,
            x: self.x.clamp(-1.0, 2.0),
            y: self.y.clamp(-1.0, 2.0),
            width: self.width,
            height: self.height,
        })
    }
}

/// Normalised line breaks, no control characters, bounded length.
fn clean_text(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n").chars().filter(|c| *c == '\n' || !c.is_control()).take(MAX_TEXT).collect()
}

/// One subtitle: shown from `start` (inclusive) to `end` (exclusive), in
/// sequence frames.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub id: Uuid,
    pub start: Frame,
    pub end: Frame,
    pub text: String,
}

/// The subtitles of a sequence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Subtitles {
    /// Sorted by start, never overlapping.
    pub cues: Vec<Cue>,
    pub style: TextStyle,
    /// Distance of the last line's bottom from the frame bottom, 0..1 of the height.
    pub margin: f32,
    /// Shown in the program monitor.
    pub visible: bool,
}

impl Default for Subtitles {
    fn default() -> Self {
        Self { cues: Vec::new(), style: TextStyle::subtitles(), margin: 0.08, visible: true }
    }
}

/// Sorts cues, drops empty ones and shortens a cue that runs into the next one
/// (burned-in subtitles show one cue at a time).
pub fn clean_cues(cues: &[Cue]) -> Vec<Cue> {
    let mut out: Vec<Cue> = cues
        .iter()
        .map(|c| Cue { id: c.id, start: c.start.max(0), end: c.end, text: clean_text(c.text.trim_end()) })
        .filter(|c| c.end > c.start)
        .collect();
    out.sort_by_key(|c| (c.start, c.end));
    let mut i = 0;
    while i + 1 < out.len() {
        let next = out[i + 1].start;
        if out[i].end > next {
            out[i].end = next;
        }
        if out[i].end <= out[i].start {
            out.remove(i);
        } else {
            i += 1;
        }
    }
    out
}

/// A cue in seconds, as read from or written to a subtitle file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimedText {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubtitleFormat {
    Srt,
    Vtt,
}

/// Reads SRT or WebVTT (detected from the content). Styling tags are removed;
/// unreadable blocks are skipped.
pub fn parse_subtitles(text: &str) -> Vec<TimedText> {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    for block in text.split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        let Some(at) = lines.iter().position(|l| l.contains("-->")) else { continue };
        let mut parts = lines[at].split("-->");
        let (Some(a), Some(b)) = (parts.next(), parts.next()) else { continue };
        // WebVTT cue settings follow the end time ("00:01.000 --> 00:02.000 line:90%").
        let b = b.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (parse_time(a.trim()), parse_time(b)) else { continue };
        let body: Vec<String> = lines[at + 1..].iter().map(|l| strip_tags(l)).collect();
        let body = body.join("\n").trim().to_string();
        if end > start && !body.is_empty() {
            out.push(TimedText { start, end, text: body });
        }
    }
    out
}

/// `hh:mm:ss,mmm`, `hh:mm:ss.mmm` or `mm:ss.mmm` in seconds.
fn parse_time(s: &str) -> Option<f64> {
    let s = s.replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    let (h, m, sec) = match parts.as_slice() {
        [h, m, s] => (h.parse::<u64>().ok()?, m.parse::<u64>().ok()?, *s),
        [m, s] => (0, m.parse::<u64>().ok()?, *s),
        _ => return None,
    };
    let sec: f64 = sec.parse().ok()?;
    (m < 60 && (0.0..60.0).contains(&sec)).then(|| (h * 3600 + m * 60) as f64 + sec)
}

/// Removes `<i>`, `<b>`, `<font …>`, `<c.class>`, `<v Name>` and `{\an8}` style markup.
fn strip_tags(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut depth = None;
    for c in line.chars() {
        match (depth, c) {
            (None, '<') => depth = Some('>'),
            (None, '{') if line.contains("{\\") => depth = Some('}'),
            (Some(end), c) if c == end => depth = None,
            (Some(_), _) => {}
            (None, c) => out.push(c),
        }
    }
    out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", "\u{a0}")
}

/// Writes cues (sequence frames at `fps`, shifted by `-offset` frames) as SRT or WebVTT.
pub fn write_subtitles(cues: &[Cue], fps: Rational, offset: Frame, format: SubtitleFormat) -> String {
    let stamp = |f: Frame| {
        let ms = (fps.frames_to_seconds((f - offset).max(0)) * 1000.0).round() as u64;
        let (h, m, s, ms) = (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
        match format {
            SubtitleFormat::Srt => format!("{h:02}:{m:02}:{s:02},{ms:03}"),
            SubtitleFormat::Vtt => format!("{h:02}:{m:02}:{s:02}.{ms:03}"),
        }
    };
    let mut out = String::new();
    if format == SubtitleFormat::Vtt {
        out.push_str("WEBVTT\n\n");
    }
    let mut n = 0;
    for c in cues.iter().filter(|c| c.end > offset && !c.text.trim().is_empty()) {
        n += 1;
        if format == SubtitleFormat::Srt {
            out.push_str(&format!("{n}\n"));
        }
        // Blank lines would end the block early.
        let text: Vec<&str> = c.text.lines().filter(|l| !l.trim().is_empty()).collect();
        let text = match format {
            SubtitleFormat::Vtt => text.join("\n").replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;"),
            SubtitleFormat::Srt => text.join("\n"),
        };
        out.push_str(&format!("{} --> {}\n{text}\n\n", stamp(c.start), stamp(c.end)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FPS: Rational = Rational::new(25, 1);

    fn cue(start: Frame, end: Frame, text: &str) -> Cue {
        Cue { id: Uuid::new_v4(), start, end, text: text.into() }
    }

    #[test]
    fn reads_srt_and_vtt() {
        let srt = "\u{feff}1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hallo</i>\r\nWelt\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n{\\an8}Oben &amp; mehr\r\n\r\n";
        let got = parse_subtitles(srt);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], TimedText { start: 1.0, end: 2.5, text: "Hallo\nWelt".into() });
        assert_eq!(got[1].text, "Oben & mehr");

        let vtt = "WEBVTT\n\nNOTE comment\n\nintro\n00:05.000 --> 00:06.250 line:90%\n<v Anna>Hi</v>\n\n00:00:07.000 --> 00:00:06.000\nbackwards\n";
        let got = parse_subtitles(vtt);
        assert_eq!(got, vec![TimedText { start: 5.0, end: 6.25, text: "Hi".into() }]);
    }

    #[test]
    fn writes_srt_and_vtt() {
        let cues = vec![cue(25, 50, "Eins"), cue(75, 100, "a < b\n\nzwei")];
        assert_eq!(
            write_subtitles(&cues, FPS, 0, SubtitleFormat::Srt),
            "1\n00:00:01,000 --> 00:00:02,000\nEins\n\n2\n00:00:03,000 --> 00:00:04,000\na < b\nzwei\n\n"
        );
        let vtt = write_subtitles(&cues, FPS, 25, SubtitleFormat::Vtt);
        assert!(vtt.starts_with("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nEins\n\n"));
        assert!(vtt.contains("a &lt; b\nzwei"));
        // Round trip.
        let back = parse_subtitles(&write_subtitles(&cues, FPS, 0, SubtitleFormat::Vtt));
        assert_eq!(back[1].text, "a < b\nzwei");
    }

    #[test]
    fn cues_are_sorted_and_never_overlap() {
        let out = clean_cues(&[cue(50, 80, "b"), cue(0, 60, "a"), cue(70, 70, "empty"), cue(50, 55, "c")]);
        let spans: Vec<_> = out.iter().map(|c| (c.start, c.end, c.text.as_str())).collect();
        // "a" is cut where the next cue starts; "c" starts with "b" and is cut to nothing.
        assert_eq!(spans, vec![(0, 50, "a"), (50, 80, "b")]);
    }

    #[test]
    fn styles_are_clamped() {
        let s = TextStyle { size: 1e6, font: "  ".into(), color: [2.0, -1.0, 0.5], ..TextStyle::default() }.sanitized().unwrap();
        assert_eq!((s.size, s.font.as_str(), s.color), (1000.0, "Inter Variable", [1.0, 0.0, 0.5]));
        assert!(TextStyle { outline: f32::NAN, ..TextStyle::default() }.sanitized().is_none());
    }
}
