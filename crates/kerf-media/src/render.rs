//! Export renderer.
//!
//! A sequence is compiled into a single FFmpeg filter graph:
//!
//! ```text
//! color(black, WxH, fps) ── overlay(V1 clip) ── overlay(V2 clip) ── … ── overlay(subtitles) ── scale/bt709 ── [vout]
//! audio clip ─ tempo ─ gain ─ pan ─ fades ─ delay ┐
//! audio clip ─ …                                  ├─ amix ─ pad/trim ── [aout]
//! ```
//!
//! Every visible clip contributes one input (seeked with `-ss`, frame-accurate
//! because FFmpeg decodes from the previous keyframe). The transform math is
//! the same as the preview compositor's: crop -> fit -> scale/rotate about the
//! anchor -> place anchor at frame centre + offset.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use kerf_core::audio::{active as active_effects, AudioEffect, AudioEffectKind, EqShape, LIMITER_ATTACK_MS};
use kerf_core::model::{
    Clip, Cue, CurvePoint, Ease, EffectKind, Keyframe, MediaKind, MediaStatus, Param, Project, Sequence, TrackKind, TransitionKind, TransitionSpan,
    VideoInfo,
};
use kerf_core::text::{write_subtitles, SubtitleFormat};
use kerf_core::time::{Frame, Rational};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::analysis::display_size;
use crate::{MediaError, Tools};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoCodec {
    H264,
    Hevc,
    ProRes422,
    ProRes422Hq,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioCodec {
    Aac,
    Pcm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum RateControl {
    /// Constant quality (CRF / CQ), lower is better. Typical 16..28.
    Quality { crf: u8 },
    /// Variable bitrate around `kbps` (peaks up to 1.5x).
    Bitrate { kbps: u32 },
    /// Constant bitrate (broadcast / streaming ingest).
    Constant { kbps: u32 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub output: PathBuf,
    pub video_codec: VideoCodec,
    /// Use a hardware encoder when one is available for the codec.
    pub hardware: bool,
    pub width: u32,
    pub height: u32,
    pub fps: Rational,
    pub rate: RateControl,
    pub audio_codec: AudioCodec,
    pub audio_bitrate_kbps: u32,
    pub sample_rate: u32,
    /// 1 = mono (downmix), 2 = stereo.
    #[serde(default = "stereo")]
    pub audio_channels: u8,
    /// Render only the sequence in/out range.
    pub use_in_out: bool,
    #[serde(default)]
    pub subtitles: SubtitleOutput,
    /// Freshly drawn PNGs of titles (media id -> file), used instead of the
    /// stored ones so the export always matches the preview's drawing code.
    #[serde(default)]
    pub title_files: HashMap<Uuid, PathBuf>,
    /// Normalise the mix's loudness (EBU R128, two passes).
    #[serde(default)]
    pub loudness: Option<LoudnessTarget>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessTarget {
    /// Integrated loudness, LUFS (-70..-5).
    pub integrated: f64,
    /// Maximum true peak, dBTP (-9..0).
    pub true_peak: f64,
}

/// What FFmpeg's `loudnorm` measured in the first pass.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LoudnormMeasure {
    pub input_i: f64,
    pub input_tp: f64,
    pub input_lra: f64,
    pub input_thresh: f64,
    pub target_offset: f64,
}

/// Stands in the export graph for the `loudnorm` filter until pass 1 has measured.
const LOUDNORM_MARK: &str = "LOUDNORM_MEASURED";

impl LoudnormMeasure {
    /// False for a silent mix (FFmpeg reports -inf).
    pub fn audible(&self) -> bool {
        [self.input_i, self.input_tp, self.input_lra, self.input_thresh, self.target_offset].iter().all(|v| v.is_finite())
    }
}

impl LoudnessTarget {
    /// `loudnorm` for the target; with a measurement as a linear gain (FFmpeg
    /// falls back to its limiter when the gain would push the true peak over).
    /// The range target is FFmpeg's maximum, so a wide mix stays linear.
    pub fn filter(&self, measured: Option<LoudnormMeasure>) -> String {
        let mut f = format!(
            "loudnorm=I={}:TP={}:LRA=50:print_format=none",
            num(self.integrated.clamp(-70.0, -5.0)),
            num(self.true_peak.clamp(-9.0, 0.0))
        );
        if let Some(m) = measured {
            f.push_str(&format!(
                ":measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear=true",
                num(m.input_i),
                num(m.input_tp),
                num(m.input_lra),
                num(m.input_thresh),
                num(m.target_offset)
            ));
        }
        f
    }
}

/// Reads the JSON block `loudnorm` prints at the end of a run.
pub fn parse_loudnorm(log: &str) -> Option<LoudnormMeasure> {
    let start = log.rfind("[Parsed_loudnorm")?;
    let json = &log[start..];
    let (a, b) = (json.find('{')?, json.rfind('}')?);
    let v: serde_json::Value = serde_json::from_str(&json[a..=b]).ok()?;
    let f = |k: &str| v.get(k)?.as_str()?.trim().parse::<f64>().ok();
    Some(LoudnormMeasure { input_i: f("input_i")?, input_tp: f("input_tp")?, input_lra: f("input_lra")?, input_thresh: f("input_thresh")?, target_offset: f("target_offset")? })
}

/// What happens with the sequence's subtitles.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SubtitleOutput {
    /// Cue images to burn in, drawn by the UI at the sequence size (empty = none).
    pub burn: Vec<BurnCue>,
    /// Transparent frame at the sequence size, shown between burned-in cues.
    pub blank: Option<PathBuf>,
    /// Write a subtitle file with the output's name next to it.
    pub sidecar: Option<SubtitleFormat>,
    /// Add a soft subtitle stream (mov_text).
    pub embed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BurnCue {
    /// Sequence frames, end exclusive.
    pub start: Frame,
    pub end: Frame,
    pub path: PathBuf,
}

fn stereo() -> u8 {
    2
}

#[derive(Clone, Debug)]
pub struct RenderPlan {
    pub args: Vec<OsString>,
    pub graph: String,
    pub graph_path: PathBuf,
    pub partial_path: PathBuf,
    pub output: PathBuf,
    pub duration: f64,
    pub frames: u64,
    pub inputs: usize,
    /// Encoder actually used (e.g. "libx264", "h264_nvenc").
    pub encoder: String,
    /// What the file should contain, for the post-render check.
    pub width: u32,
    pub height: u32,
    pub fps: Rational,
    pub channels: u8,
    /// Helper files FFmpeg reads (concat lists, subtitle text), removed afterwards.
    pub files: Vec<(PathBuf, String)>,
    /// Subtitle file written next to the output after a successful render.
    pub sidecar: Option<(PathBuf, String)>,
    /// Loudness measurement run before the export (two-pass normalisation).
    pub measure: Option<MeasurePass>,
}

#[derive(Clone, Debug)]
pub struct MeasurePass {
    pub args: Vec<OsString>,
    pub graph: String,
    pub graph_path: PathBuf,
    pub target: LoudnessTarget,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgress {
    pub fraction: f64,
    pub frame: u64,
    pub elapsed: f64,
    pub eta: Option<f64>,
    pub speed: Option<f64>,
    /// Pass 1 of a loudness normalisation is running.
    pub measuring: bool,
}

/// Part of a clip that falls into the render range.
struct Segment {
    /// Timeline frame where the visible part starts.
    start: Frame,
    len: Frame,
    /// Frames skipped at the clip head.
    head: Frame,
}

/// The part of a clip lengthened by `before`/`after` frames into its
/// transitions that falls into `[t0, t1)`; `head` is negative where the
/// segment starts before the clip.
fn segment_ext(c: &Clip, before: Frame, after: Frame, t0: Frame, t1: Frame) -> Option<Segment> {
    let start = (c.start - before).max(t0);
    let end = (c.end() + after).min(t1);
    (end > start).then(|| Segment { start, len: end - start, head: start - c.start })
}

/// `fade`/`afade` (`name`) of `kind` in/out starting `st` seconds into the
/// stream. A start before the stream (the rendered range begins inside the
/// fade) is reached by shifting the timestamps around the filter, which only
/// takes non-negative starts.
fn fade_at(name: &str, kind: &str, st: f64, d: f64, extra: &str) -> String {
    let pts = if name == "afade" { "asetpts" } else { "setpts" };
    if st >= 0.0 {
        return format!("{name}=t={kind}:st={}:d={}{extra}", num(st), num(d));
    }
    let x = num(-st);
    format!("{pts}=PTS+{x}/TB,{name}=t={kind}:st=0:d={}{extra},{pts}=PTS-{x}/TB", num(d))
}

/// A prepared clip stream and where it goes on the frame.
struct Placed {
    label: String,
    /// Input index, names the clip's labels.
    k: usize,
    x: String,
    y: String,
    /// Timeline frames `[start, end)` the stream covers.
    start: Frame,
    end: Frame,
}

/// Stream laid over a composite at overlay position `x`, `y`.
struct Layer {
    label: String,
    x: String,
    y: String,
}

/// Mixes the composite with the outgoing clip (`ca`) into the composite of
/// `below` with the incoming clip (`clip`, absent when it is not shown)
/// inside `span`; returns the mixed stream's label. With p = (frame - t0) /
/// len, as in the preview: dissolve blends by p, wipes show the incoming side
/// up to an edge at floor(size * p), dips fade to the colour by 2p and back
/// from it by 2 - 2p, switching at p = 0.5.
#[allow(clippy::too_many_arguments)]
fn transition_chains(
    chains: &mut Vec<String>,
    span: TransitionSpan,
    n: usize,
    ca: &str,
    below: &str,
    clip: Option<&Layer>,
    t0: Frame,
    sf: Rational,
    of: Rational,
    (w, h): (u32, u32),
) -> String {
    let frame_s = 1.0 / of.as_f64();
    let ws = sf.frames_to_seconds(span.t0 - t0);
    let we = sf.frames_to_seconds(span.t1 - t0);
    let d = we - ws;
    let window = |from: f64| format!("between(t,{},{})", num(from), num(we - 0.5 * frame_s));
    let cb = match clip {
        Some(l) => {
            chains.push(format!(
                "[{below}][{}]overlay=x={}:y={}:eof_action=pass:format=rgb:enable='{}'[cb{n}]",
                l.label,
                l.x,
                l.y,
                window(ws - 0.5 * frame_s)
            ));
            format!("cb{n}")
        }
        None => below.to_string(),
    };
    // Generated streams run in transition time [0, d) and are moved into place
    // (cut where the rendered range starts inside the span).
    let src = |c: &str| format!("color=c={c}:s={w}x{h}:r={}:d={}", rate_str(of), num(d));
    let place = |chain: String, label: String| {
        let cut = if ws < 0.0 { format!(",trim=start={}", num(-ws)) } else { String::new() };
        let shift = if ws < 0.0 { format!("-{}", num(-ws)) } else { format!("+{}", num(ws)) };
        format!("{chain}{cut},setpts=PTS{shift}/TB[{label}]")
    };
    let mask = match span.kind {
        TransitionKind::DipBlack | TransitionKind::DipWhite => {
            // The incoming side replaces the outgoing one at the middle, under the colour.
            let colour = if span.kind == TransitionKind::DipBlack { "black" } else { "white" };
            chains.push(format!(
                "[{ca}][{cb}]overlay=eof_action=pass:format=rgb:enable='{}'[dip{n}]",
                window(ws + d / 2.0 - 1e-3 * frame_s)
            ));
            let half = num(d / 2.0);
            chains.push(place(
                format!("{},format=rgba,fade=t=in:st=0:d={half}:alpha=1,fade=t=out:st={half}:d={half}:alpha=1", src(colour)),
                format!("dc{n}"),
            ));
            chains.push(format!("[dip{n}][dc{n}]overlay=eof_action=pass:format=rgb[mix{n}]"));
            return format!("mix{n}");
        }
        TransitionKind::Dissolve | TransitionKind::Crossfade => {
            format!("{},format=rgb24,fade=t=in:st=0:d={},extractplanes=r", src("white"), num(d))
        }
        wipe => {
            // A white block slides over black; its edge is the wipe's edge.
            let edge = |size: &str| format!("floor({size}*t/{}+0.0001)", num(d));
            let (x, y) = match wipe {
                TransitionKind::WipeRight => (format!("-W+{}", edge("W")), "0".to_string()),
                TransitionKind::WipeLeft => (format!("W-{}", edge("W")), "0".to_string()),
                TransitionKind::WipeDown => ("0".to_string(), format!("-H+{}", edge("H"))),
                _ => ("0".to_string(), format!("H-{}", edge("H"))),
            };
            chains.push(format!("{},format=rgb24[mb{n}]", src("black")));
            chains.push(format!("{},format=rgba[mw{n}]", src("white")));
            format!("[mb{n}][mw{n}]overlay=x='{x}':y='{y}':format=rgb,extractplanes=r")
        }
    };
    chains.push(place(mask, format!("m{n}")));
    chains.push(format!("[{cb}][m{n}]alphamerge=eof_action=pass[cbm{n}]"));
    chains.push(format!("[{ca}][cbm{n}]overlay=eof_action=pass:format=rgb:enable='{}'[mix{n}]", window(ws - 0.5 * frame_s)));
    format!("mix{n}")
}

/// FFmpeg expression for `param` of `clip` over variable `var`, which counts
/// `unit`s (1 = frames, frame duration = seconds) from the start of the
/// rendered segment (`head` frames into the clip). Uses the same easing
/// polynomials as `Ease::apply`, so export matches the preview; Bezier
/// curves are approximated by linear pieces (one per frame, at most
/// `BEZIER_STEPS`).
fn param_expr(clip: &Clip, param: Param, head: Frame, var: &str, unit: f64) -> String {
    let keys = clip.keys_of(param);
    let (Some(first), Some(last)) = (keys.first(), keys.last()) else { return num(clip.base_value(param) as f64) };
    let pos = |k: &Keyframe| (clip.local_of(k.at) - head as f64) * unit;
    let mut e = num(last.value as f64);
    for w in keys.windows(2).rev() {
        let (a, b) = (w[0], w[1]);
        let (ta, tb) = (pos(&a), pos(&b));
        let (va, dv) = (a.value as f64, (b.value - a.value) as f64);
        let u = format!("(({var}-{})/{})", num(ta), num((tb - ta).max(1e-9)));
        let inner = match a.ease {
            Ease::Bezier { .. } => {
                let steps = ((b.at - a.at) as f64 / clip.speed).ceil().clamp(4.0, BEZIER_STEPS as f64) as usize;
                let mut pw = num(b.value as f64);
                for i in (0..steps).rev() {
                    let (u0, u1) = (i as f64 / steps as f64, (i + 1) as f64 / steps as f64);
                    let (x0, x1) = (ta + (tb - ta) * u0, ta + (tb - ta) * u1);
                    let (y0, y1) = (va + dv * a.ease.apply(u0), va + dv * a.ease.apply(u1));
                    pw = format!(
                        "if(lt({var},{}),{}+({})*({var}-{})/{},{pw})",
                        num(x1),
                        num(y0),
                        num(y1 - y0),
                        num(x0),
                        num((x1 - x0).max(1e-9))
                    );
                }
                pw
            }
            ease => {
                let eased = match ease {
                    Ease::EaseIn => format!("{u}*{u}"),
                    Ease::EaseOut => format!("{u}*(2-{u})"),
                    Ease::EaseInOut => format!("{u}*{u}*(3-2*{u})"),
                    Ease::Hold => "0".into(),
                    _ => u.clone(),
                };
                format!("{}+({})*{eased}", num(va), num(dv))
            }
        };
        e = format!("if(lt({var},{}),{inner},{e})", num(tb));
    }
    format!("if(lt({var},{}),{},{e})", num(pos(first)), num(first.value as f64))
}

const BEZIER_STEPS: usize = 32;

/// `sendcmd` script updating the clip's `colorchannelmixer`s on every
/// output frame where animated colour (`color`) or opacity (`alpha`)
/// changes; the mixer has no expressions. Both may name the same filter.
fn mixer_commands(clip: &Clip, seg: &Segment, frame_s: f64, color: &str, alpha: &str) -> String {
    const NAMES: [&str; 9] = ["rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb"];
    let mut out = Vec::new();
    let mut last: Option<[f32; 10]> = None;
    for i in 0..seg.len {
        let local = (seg.head + i) as f64;
        let m = clip.color_at(local).matrix();
        let mut v = [0f32; 10];
        for (j, cell) in m.iter().flatten().enumerate() {
            v[j] = (cell * 10_000.0).round() / 10_000.0;
        }
        v[9] = (clip.param_at(Param::Opacity, local) * 1000.0).round() / 1000.0;
        if last != Some(v) {
            let changed = |j: usize| last.is_none_or(|l| l[j] != v[j]);
            let mut cmds: Vec<String> =
                NAMES.iter().enumerate().filter(|(j, _)| changed(*j)).map(|(j, n)| format!("{color} {n} {}", num(v[j] as f64))).collect();
            if changed(9) {
                cmds.push(format!("{alpha} aa {}", num(v[9] as f64)));
            }
            out.push(format!("{} {}", num(i as f64 * frame_s), cmds.join(",")));
            last = Some(v);
        }
    }
    out.join(";")
}

/// `colorlevels` options realising contrast `slope` about mid-grey.
fn levels(slope: f64) -> [(&'static str, f64); 4] {
    let (imin, imax, omin, omax) = if slope >= 1.0 {
        (0.5 - 0.5 / slope, 0.5 + 0.5 / slope, 0.0, 1.0)
    } else {
        (0.0, 1.0, 0.5 - 0.5 * slope, 0.5 + 0.5 * slope)
    };
    [("imin", imin), ("imax", imax), ("omin", omin), ("omax", omax)]
}

/// `sendcmd` script for animated contrast on a named `colorlevels`.
fn levels_commands(clip: &Clip, seg: &Segment, frame_s: f64, target: &str) -> String {
    let mut out = Vec::new();
    let mut last = f64::NAN;
    for i in 0..seg.len {
        let k = clip.color_at((seg.head + i) as f64).contrast_slope() as f64;
        let k = (k * 10_000.0).round() / 10_000.0;
        if k != last {
            let cmds: Vec<String> =
                levels(k).iter().flat_map(|(n, v)| ["r", "g", "b"].map(|c| format!("{target} {c}{n} {}", num(*v)))).collect();
            out.push(format!("{} {}", num(i as f64 * frame_s), cmds.join(",")));
            last = k;
        }
    }
    out.join(";")
}

/// Transparent border (source pixels) added around animated clips before
/// warping: `perspective` repeats edge pixels outside the source.
const PAD: u32 = 2;

/// `perspective` filter that maps the padded, frame-sized source onto its
/// animated placement: corner = centre + offset + S * R(theta) * (corner - anchor).
fn perspective(clip: &Clip, head: Frame, cw: f64, ch: f64, fit: f64, w: f64, h: f64) -> String {
    let t = &clip.transform;
    let e = |p| param_expr(clip, p, head, "in", 1.0);
    let (x, y, s) = (e(Param::X), e(Param::Y), e(Param::Scale));
    let r = format!("(({})*PI/180)", e(Param::Rotation));
    let (pu, pv) = (0.5 + PAD as f64 / cw, 0.5 + PAD as f64 / ch);
    // Corner order of the filter: top-left, top-right, bottom-left, bottom-right.
    let corners = [(-pu, -pv), (pu, -pv), (-pu, pv), (pu, pv)];
    let mut opts = Vec::new();
    for (i, (u, v)) in corners.iter().enumerate() {
        let du = num((u - (t.anchor_x as f64 - 0.5)) * cw * fit);
        let dv = num((v - (t.anchor_y as f64 - 0.5)) * ch * fit);
        opts.push(format!("x{i}='{}+{x}+({s})*(({du})*cos({r})-({dv})*sin({r}))'", num(w / 2.0)));
        opts.push(format!("y{i}='{}+{y}+({s})*(({du})*sin({r})+({dv})*cos({r}))'", num(h / 2.0)));
    }
    format!("perspective={}:interpolation=cubic:sense=destination:eval=frame", opts.join(":"))
}

/// Steps of FFmpeg's IIR Gaussian (`gblur`); more steps approach a true
/// Gaussian like the preview's.
const GBLUR_STEPS: u32 = 4;

/// FFmpeg filters for one effect on an RGBA stream. Branches (split/blend)
/// use labels unique per clip `k` and effect `j`; a `;` inside a chain is
/// valid filtergraph syntax.
fn effect_filters(e: &EffectKind, k: usize, j: usize) -> Vec<String> {
    let l = |s: &str| format!("fx{k}e{j}{s}");
    let (a, b, c) = (l("a"), l("b"), l("c"));
    match e {
        EffectKind::Blur { radius } => vec![format!("gblur=sigma={}:steps={GBLUR_STEPS}", num(*radius as f64))],
        EffectKind::Sharpen { amount, radius } => {
            // `blend` stores expression results without clamping, so clip to 8 bits.
            let x = format!("clip(A+(A-B)*{},0,255)", num(*amount as f64));
            vec![format!(
                "split[{a}][{b}];[{b}]gblur=sigma={}:steps={GBLUR_STEPS}[{c}];[{a}][{c}]blend=c0_expr='{x}':c1_expr='{x}':c2_expr='{x}':c3_expr='A'",
                num(*radius as f64)
            )]
        }
        EffectKind::Vignette { amount } => vec![format!(
            // `vignette` drops alpha, so it shades a white copy that multiplies the clip.
            "split[{a}][{b}];[{b}]drawbox=c=white:t=fill,format=rgb24,vignette=angle={}:dither=0,format=rgba[{c}];[{a}][{c}]blend=c0_mode=multiply:c1_mode=multiply:c2_mode=multiply:c3_mode=normal",
            num(*amount as f64 * std::f64::consts::FRAC_PI_2)
        )],
        EffectKind::Lut { path, intensity } => {
            let lut = format!("lut3d=file='{}':interp=trilinear", filter_path(path));
            if *intensity >= 1.0 {
                vec![lut]
            } else {
                vec![format!("split[{a}][{b}];[{b}]{lut}[{c}];[{c}][{a}]blend=all_mode=normal:all_opacity={}", num(*intensity as f64))]
            }
        }
        EffectKind::ChromaKey { color, similarity, blend, spill } => {
            let (_, u, v) = bt601_limited(*color);
            let mut f = vec![
                "format=yuva444p".to_string(),
                format!("chromakey=color=0x80{u:02x}{v:02x}:yuv=1:similarity={}:blend={}", num(*similarity as f64), num(*blend as f64)),
                "format=rgba".to_string(),
            ];
            if *spill > 0.0 {
                let s = num(-*spill as f64);
                f.push(if color[2] > color[1] {
                    format!("despill=type=blue:mix=0.5:expand=0:red=0:green=0:blue={s}")
                } else {
                    format!("despill=type=green:mix=0.5:expand=0:red=0:green={s}:blue=0")
                });
            }
            f
        }
        EffectKind::ColorWheels { lift, gamma, gain } => {
            let ch = |i: usize| {
                format!(
                    "clip(pow(clip(val/maxval*{}+{},0,1),{}),0,1)*maxval",
                    num((gain[i] - lift[i]) as f64),
                    num(lift[i] as f64),
                    num(1.0 / gamma[i] as f64)
                )
            };
            vec![format!("lutrgb=r='{}':g='{}':b='{}'", ch(0), ch(1), ch(2))]
        }
        EffectKind::Curves { master, red, green, blue } => {
            let pts = |c: &[CurvePoint]| c.iter().map(|p| format!("{}/{}", num(p[0] as f64), num(p[1] as f64))).collect::<Vec<_>>().join(" ");
            let parts: Vec<String> = [("master", master), ("red", red), ("green", green), ("blue", blue)]
                .iter()
                .filter(|(_, c)| !kerf_core::model::curve_is_identity(c))
                .map(|(n, c)| format!("{n}='{}'", pts(c)))
                .collect();
            vec![format!("curves=interp=pchip:{}", parts.join(":"))]
        }
    }
}

/// BT.601 limited-range Y'CbCr (0..255) of an RGB colour in 0..1, as the
/// RGB to YUV conversion before `chromakey` produces it.
fn bt601_limited(c: [f32; 3]) -> (u8, u8, u8) {
    let [r, g, b] = c.map(|v| v as f64);
    let q = |v: f64| v.round().clamp(0.0, 255.0) as u8;
    (
        q(16.0 + 65.481 * r + 128.553 * g + 24.966 * b),
        q(128.0 - 37.797 * r - 74.203 * g + 112.0 * b),
        q(128.0 + 112.0 * r - 93.786 * g - 18.214 * b),
    )
}

/// A file path as a quoted filter option value: forward slashes, `:` and
/// `'` escaped.
fn filter_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").replace(':', "\\:").replace('\'', r"'\''")
}

/// The preview (Chromium) decodes video without a colour matrix tag as
/// BT.709 from 720 lines up and as BT.601 below; FFmpeg always assumes
/// BT.601. Untagged HD input is therefore tagged BT.709 before the RGB
/// conversion so export and preview show the same colours.
fn assumed_color(v: &VideoInfo) -> Option<String> {
    (v.color.space.is_none() && v.height >= 720)
        .then(|| format!("setparams=colorspace=bt709:range={}", v.color.range.as_deref().unwrap_or("tv")))
}

fn num(v: f64) -> String {
    let s = format!("{v:.6}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" || s.is_empty() { "0".into() } else { s.to_string() }
}

fn even(v: f64) -> u32 {
    ((v / 2.0).round() as u32 * 2).max(2)
}

fn rate_str(r: Rational) -> String {
    format!("{}/{}", r.num, r.den)
}

fn atempo_chain(speed: f64) -> Vec<String> {
    let mut s = speed;
    let mut out = Vec::new();
    while s > 2.0 {
        out.push("atempo=2".to_string());
        s /= 2.0;
    }
    while s < 0.5 {
        out.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 1e-6 {
        out.push(format!("atempo={}", num(s)));
    }
    out
}

/// Like `num` with nine decimals, for gains that are compared bit for bit
/// against FFmpeg in the parity fixture.
fn fine(v: f64) -> String {
    let s = format!("{v:.9}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" || s.is_empty() { "0".into() } else { s.to_string() }
}

fn linear(db: f32) -> String {
    fine(10f64.powf(db as f64 / 20.0))
}

/// FFmpeg filters for the active effects at sample rate `sr`. The preview runs
/// ports of the same filters (src/engine/dsp.ts); fixtures/parity/audio.json
/// holds both. `latency` lets the limiter remove its look-ahead delay.
pub fn audio_effect_filters(effects: &[AudioEffect], sr: u32, latency: bool) -> Vec<String> {
    let mut out = Vec::new();
    for e in active_effects(effects) {
        match e {
            AudioEffectKind::Eq { bands } => {
                // Bands above Nyquist are bypassed by FFmpeg and the preview alike.
                for b in bands.iter().filter(|b| b.enabled && b.freq > 0.0 && 2.0 * b.freq as f64 <= sr as f64) {
                    let (f, g, q) = (num(b.freq as f64), num(b.gain_db as f64), num(b.q as f64));
                    let filter = match b.shape {
                        EqShape::HighPass => format!("highpass=f={f}:p=2:t=q:w={q}"),
                        EqShape::LowPass => format!("lowpass=f={f}:p=2:t=q:w={q}"),
                        _ if b.gain_db == 0.0 => continue,
                        EqShape::LowShelf => format!("lowshelf=f={f}:t=s:w=1:g={g}"),
                        EqShape::HighShelf => format!("highshelf=f={f}:t=s:w=1:g={g}"),
                        EqShape::Peak => format!("equalizer=f={f}:t=q:w={q}:g={g}"),
                    };
                    out.push(filter + ":r=f64");
                }
            }
            AudioEffectKind::Compressor { threshold_db, ratio, attack_ms, release_ms, knee_db, makeup_db } => out.push(format!(
                "acompressor=threshold={}:ratio={}:attack={}:release={}:knee={}:makeup={}:detection=rms:link=average",
                linear(*threshold_db),
                num(*ratio as f64),
                num(*attack_ms as f64),
                num(*release_ms as f64),
                linear(*knee_db),
                linear(*makeup_db)
            )),
            AudioEffectKind::Gate { threshold_db, range_db, ratio, attack_ms, release_ms } => out.push(format!(
                // FFmpeg's default knee (2.828427125 = 9 dB), which the preview uses too.
                "agate=threshold={}:range={}:ratio={}:attack={}:release={}:knee=2.828427125:detection=rms:link=average",
                linear(*threshold_db),
                linear(*range_db),
                num(*ratio as f64),
                num(*attack_ms as f64),
                num(*release_ms as f64)
            )),
            AudioEffectKind::Limiter { ceiling_db, release_ms } => out.push(format!(
                "alimiter=limit={}:attack={}:release={}:asc=0:level=0{}",
                linear(*ceiling_db),
                num(LIMITER_ATTACK_MS),
                num(*release_ms as f64),
                if latency { ":latency=1" } else { "" }
            )),
        }
    }
    out
}

/// `pan` for a stereo gain matrix `[[l<-l, l<-r], [r<-l, r<-r]]`.
fn pan_matrix(m: [[f64; 2]; 2]) -> String {
    let side = |g: [f64; 2]| {
        let terms: Vec<String> = g.iter().enumerate().map(|(i, v)| (i, num(*v))).filter(|(_, v)| v != "0").map(|(i, v)| format!("{v}*c{i}")).collect();
        if terms.is_empty() { "0*c0".to_string() } else { terms.join("+") }
    };
    format!("pan=stereo|c0={}|c1={}", side(m[0]), side(m[1]))
}

/// WebAudio's StereoPannerNode for stereo input (the preview pans with it):
/// left of centre the left side takes in part of the right channel, right of
/// centre the other way round, with equal-power gains.
fn stereo_pan(pan: f64) -> [[f64; 2]; 2] {
    use std::f64::consts::FRAC_PI_2;
    let p = pan.clamp(-1.0, 1.0);
    if p <= 0.0 {
        let x = (p + 1.0) * FRAC_PI_2;
        [[1.0, x.cos()], [0.0, x.sin()]]
    } else {
        let x = p * FRAC_PI_2;
        [[x.cos(), 0.0], [x.sin(), 1.0]]
    }
}

struct AudioMix {
    args: Vec<OsString>,
    chains: Vec<String>,
    inputs: usize,
}

/// Inputs and filter chains of the audio mix over `t0..t1`, ending in
/// `[aout]`; input indices start at `first`. Per clip: channels to stereo
/// (mono on both sides at full level, as the preview upmixes), channel map,
/// effects, volume, pan, fades. A track with effects or set to mono is mixed
/// on its own first, its effects and volume applied to the sum. `master`
/// goes after the master sum (loudness normalisation).
fn audio_mix(project: &Project, seq: &Sequence, s: &ExportSettings, (t0, t1): (Frame, Frame), first: usize, master: Option<String>) -> Result<AudioMix, MediaError> {
    let sf = seq.settings.fps;
    let frame_s = 1.0 / s.fps.as_f64();
    let sr = s.sample_rate.clamp(8_000, 192_000);
    let duration = sf.frames_to_seconds(t1 - t0);
    let mut args: Vec<OsString> = Vec::new();
    let mut chains = Vec::new();
    let mut k = first;

    let audio_tracks: Vec<_> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Audio).collect();
    let any_solo = audio_tracks.iter().any(|t| t.solo);
    let mut mix_inputs = Vec::new();
    for (ti, track) in audio_tracks.iter().enumerate().filter(|(_, t)| !t.muted && (!any_solo || t.solo)) {
        let track_fx = audio_effect_filters(&track.effects, sr, true);
        let submix = track.mono || !track_fx.is_empty();
        // Without a submix the track volume goes into each clip's gain.
        let track_db = if submix { 0.0 } else { track.volume_db };
        let mut track_inputs = Vec::new();
        let spans: Vec<Option<TransitionSpan>> =
            (0..track.clips.len()).map(|i| track.transition_into(i).filter(|s| s.t1 > t0 && s.t0 < t1)).collect();
        for (ci, clip) in track.clips.iter().enumerate().filter(|(_, c)| c.enabled) {
            let gain_db = clip.volume_db + track_db;
            let ramped = !clip.keys_of(Param::Volume).is_empty();
            if clip.volume_db + track.volume_db <= -96.0 && !ramped {
                continue;
            }
            // Crossfades lengthen both clips like video transitions. A crossfade
            // the range starts in is rendered from its start and cut afterwards.
            let (incoming, outgoing) = (spans[ci], spans.get(ci + 1).copied().flatten());
            let before = incoming.map_or(0, |s| s.cut - s.t0);
            let after = outgoing.map_or(0, |s| s.t1 - s.cut);
            let lo = [incoming, outgoing].iter().flatten().fold(t0, |lo, s| lo.min(s.t0));
            let Some(seg) = segment_ext(clip, before, after, lo, t1) else { continue };
            let Some(asset) = project.media(clip.media_id) else { continue };
            if asset.status == MediaStatus::Missing {
                return Err(MediaError::Unsupported(format!("media offline: {}", asset.name)));
            }
            let Some(audio) = asset.info.as_ref().and_then(|i| i.audio.as_ref()).filter(|_| asset.has_audio()) else { continue };
            let src_start = sf.frames_to_seconds(clip.source_in) + sf.frames_to_seconds(seg.head) * clip.speed;
            let seg_len = sf.frames_to_seconds(seg.len);
            let lead = sf.frames_to_seconds((t0 - seg.start).max(0));
            let offset = sf.frames_to_seconds((seg.start - t0).max(0));
            args.extend(["-ss".into(), num(src_start.max(0.0)).into()]);
            args.extend(["-t".into(), num(seg_len * clip.speed + 0.1).into()]);
            args.push("-i".into());
            args.push(asset.path.clone().into_os_string());

            let mut f = vec!["asetpts=PTS-STARTPTS".to_string()];
            f.extend(atempo_chain(clip.speed));
            if audio.channels == 1 {
                f.push("pan=stereo|c0=c0|c1=c0".into());
            }
            f.push(format!("aformat=sample_fmts=fltp:sample_rates={sr}:channel_layouts=stereo"));
            if src_start < 0.0 {
                // Silence before the media start (incoming side of a crossfade).
                f.push(format!("adelay=delays={}S:all=1", (-src_start / clip.speed * sr as f64).round() as u64));
            }
            if !clip.channels.is_stereo() {
                f.push(pan_matrix(clip.channels.matrix().map(|r| r.map(f64::from))));
            }
            f.extend(audio_effect_filters(&clip.audio_effects, sr, true));
            if ramped {
                // Volume keys in dB over output time `t` of this segment.
                let db = param_expr(clip, Param::Volume, seg.head, "t", frame_s);
                f.push(format!("volume='pow(10,(({db})+{})/20)':eval=frame", num(track_db as f64)));
            } else if gain_db != 0.0 {
                f.push(format!("volume={}dB", num(gain_db as f64)));
            }
            if clip.pan != 0.0 {
                f.push(pan_matrix(stereo_pan(clip.pan as f64)));
            }
            if clip.fade_in > 0 && clip.fade_in > seg.head {
                f.push(fade_at("afade", "in", sf.frames_to_seconds(-seg.head), sf.frames_to_seconds(clip.fade_in), ""));
            }
            if clip.fade_out > 0 {
                let st = sf.frames_to_seconds(clip.end() - clip.fade_out - seg.start);
                if st < seg_len {
                    f.push(fade_at("afade", "out", st, sf.frames_to_seconds(clip.fade_out), ""));
                }
            }
            for (span, kind) in [(incoming, "in"), (outgoing, "out")] {
                if let Some(s) = span {
                    f.push(fade_at("afade", kind, sf.frames_to_seconds(s.t0 - seg.start), sf.frames_to_seconds(s.len()), ":curve=tri"));
                }
            }
            if lead > 0.0 {
                f.push(format!("atrim=start={},asetpts=PTS-STARTPTS", num(lead)));
            }
            f.push(format!("atrim=end={}", num(seg_len - lead)));
            let delay = (offset * sr as f64).round() as u64;
            if delay > 0 {
                f.push(format!("adelay=delays={delay}S:all=1"));
            }
            chains.push(format!("[{k}:a:0]{}[a{k}]", f.join(",")));
            track_inputs.push(format!("[a{k}]"));
            k += 1;
        }
        if !submix || track_inputs.is_empty() {
            mix_inputs.append(&mut track_inputs);
            continue;
        }
        let mut f = Vec::new();
        if track_inputs.len() > 1 {
            f.push(format!("amix=inputs={}:normalize=0:dropout_transition=0", track_inputs.len()));
        }
        if track.mono {
            f.push(pan_matrix([[0.5, 0.5], [0.5, 0.5]]));
        }
        f.extend(track_fx);
        if track.volume_db != 0.0 {
            f.push(format!("volume={}dB", num(track.volume_db as f64)));
        }
        chains.push(format!("{}{}[at{ti}]", track_inputs.join(""), f.join(",")));
        mix_inputs.push(format!("[at{ti}]"));
    }
    let tail = format!("apad=whole_dur={d},atrim=end={d}", d = num(duration));
    let sum = match mix_inputs.len() {
        0 => format!("anullsrc=r={sr}:cl=stereo,{tail}"),
        1 => format!("{}{tail}", mix_inputs[0]),
        n => format!("{}amix=inputs={n}:normalize=0:dropout_transition=0,{tail}", mix_inputs.join("")),
    };
    // loudnorm works at 192 kHz; the tail again holds the length exactly.
    chains.push(match master {
        Some(m) => format!("{sum},{m},aresample={sr},{tail}[aout]"),
        None => format!("{sum}[aout]"),
    });
    Ok(AudioMix { args, chains, inputs: k - first })
}

/// Builds the FFmpeg invocation for `seq`. `work_dir` receives the graph script.
pub fn plan(
    project: &Project,
    seq: &Sequence,
    s: &ExportSettings,
    work_dir: &Path,
    hw_encoders: &[String],
) -> Result<RenderPlan, MediaError> {
    let ext = s.output.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let container = match ext.as_str() {
        "mp4" | "m4v" => "mp4",
        "mov" => "mov",
        _ => return Err(MediaError::Unsupported("output must be .mp4 or .mov".into())),
    };
    let prores = matches!(s.video_codec, VideoCodec::ProRes422 | VideoCodec::ProRes422Hq);
    if prores && container != "mov" {
        return Err(MediaError::Unsupported("ProRes requires a .mov file".into()));
    }
    if s.audio_codec == AudioCodec::Pcm && container != "mov" {
        return Err(MediaError::Unsupported("PCM audio requires a .mov file".into()));
    }
    if !s.fps.is_valid() {
        return Err(MediaError::Unsupported("invalid frame rate".into()));
    }

    let sf = seq.settings.fps;
    let (t0, t1) = if s.use_in_out {
        (seq.in_point.unwrap_or(0), seq.out_point.unwrap_or_else(|| seq.duration()))
    } else {
        (0, seq.duration())
    };
    if t1 <= t0 {
        return Err(MediaError::Unsupported("the sequence is empty".into()));
    }
    let duration = sf.frames_to_seconds(t1 - t0);
    let of = s.fps;
    let frames = (duration * of.as_f64()).round().max(1.0) as u64;
    let frame_s = 1.0 / of.as_f64();
    let (w, h) = (seq.settings.width as f64, seq.settings.height as f64);
    let sr = s.sample_rate.clamp(8_000, 192_000);
    let channels = s.audio_channels.clamp(1, 2);

    let mut args: Vec<OsString> = ["-hide_banner", "-nostdin", "-loglevel", "warning", "-y"].iter().map(OsString::from).collect();
    let mut chains: Vec<String> = Vec::new();
    let mut inputs = 0usize;

    chains.push(format!(
        "color=c=black:s={}x{}:r={}:d={},format=rgba[base]",
        seq.settings.width,
        seq.settings.height,
        rate_str(of),
        num(duration)
    ));
    let mut last = "base".to_string();

    let asset_for = |c: &Clip| -> Result<Option<&kerf_core::model::MediaAsset>, MediaError> {
        let Some(a) = project.media(c.media_id) else { return Ok(None) };
        if a.status == MediaStatus::Missing {
            return Err(MediaError::Unsupported(format!("media offline: {}", a.name)));
        }
        Ok(a.info.as_ref().map(|_| a))
    };

    // --- video, bottom track first ------------------------------------------
    // A transition mixes two composites inside its span: the one with the
    // outgoing clip (the stream so far, where that clip plays on to the span's
    // end) and the composite under it with the incoming clip laid over. All
    // streams that are mixed run from the start, so no branch is read ahead.
    let mut labels = 0usize;
    for track in seq.tracks.iter().filter(|t| t.kind == TrackKind::Video && !t.hidden) {
        // Transitions into each clip that reach into the rendered range.
        let spans: Vec<Option<TransitionSpan>> =
            (0..track.clips.len()).map(|i| track.transition_into(i).filter(|s| s.t1 > t0 && s.t0 < t1)).collect();
        // Composite under the outgoing clip of a transition, for the incoming side.
        let mut below: Option<String> = None;
        for (ci, clip) in track.clips.iter().enumerate() {
            let incoming = spans[ci];
            let outgoing = spans.get(ci + 1).copied().flatten();
            let placed = 'clip: {
            let visible = clip.enabled && (clip.opacity > 0.0 || !clip.keys_of(Param::Opacity).is_empty());
            // The outgoing clip of a transition plays on until its end, the incoming
            // one starts at its beginning; both hold a frame where the media ends.
            let head_ext = incoming.map_or(0, |s| s.cut - s.t0);
            let tail_ext = outgoing.map_or(0, |s| s.t1 - s.cut);
            let Some(seg) = segment_ext(clip, head_ext, tail_ext, t0, t1).filter(|_| visible) else { break 'clip None };
            // Animated position/scale/rotation: the clip is warped onto the frame by
            // `perspective` with per-frame corner expressions (same math as `place`).
            let animated = [Param::X, Param::Y, Param::Scale, Param::Rotation].iter().any(|p| !clip.keys_of(*p).is_empty());
            let fading = !clip.keys_of(Param::Opacity).is_empty();
            let Some(asset) = asset_for(clip)? else { break 'clip None };
            let info = asset.info.as_ref().expect("checked");
            let Some((dw, dh)) = display_size(info) else { break 'clip None };
            let t = &clip.transform;
            if t.scale <= 0.0 && !animated {
                break 'clip None;
            }
            let cw = dw as f64 * (1.0 - t.crop_left as f64 - t.crop_right as f64);
            let ch = dh as f64 * (1.0 - t.crop_top as f64 - t.crop_bottom as f64);
            let fit = (w / cw).min(h / ch);
            let (sw, sh) = (even(cw * fit * t.scale as f64), even(ch * fit * t.scale as f64));

            let src_start = sf.frames_to_seconds(clip.source_in) + sf.frames_to_seconds(seg.head) * clip.speed;
            let seg_len = sf.frames_to_seconds(seg.len);
            let offset = sf.frames_to_seconds(seg.start - t0);
            let image = asset.kind == MediaKind::Image;
            // Past the clip's last frame (outgoing side of a transition) the media may
            // have ended: reading starts at that frame, which holds, and is cut to the segment.
            let last_used = sf.frames_to_seconds(clip.source_in) + sf.frames_to_seconds(clip.duration - 1) * clip.speed;
            let read_at = src_start.clamp(0.0, last_used.max(0.0));
            let skip = (src_start - read_at).max(0.0) / clip.speed;
            if image {
                args.extend(["-loop", "1", "-framerate"].map(OsString::from));
                args.push(rate_str(of).into());
                args.extend(["-t".into(), num(seg_len + 2.0 * frame_s).into()]);
            } else {
                args.extend(["-ss".into(), num(read_at).into()]);
                args.extend(["-t".into(), num((seg_len + skip) * clip.speed + 2.0 * frame_s).into()]);
            }
            args.push("-i".into());
            args.push(s.title_files.get(&asset.id).unwrap_or(&asset.path).clone().into_os_string());

            let k = inputs;
            inputs += 1;
            let mut f: Vec<String> = Vec::new();
            if let Some(p) = info.video.as_ref().filter(|_| !image).and_then(assumed_color) {
                f.push(p);
            }
            f.push(format!("setpts=(PTS-STARTPTS)/{}", num(clip.speed)));
            f.push(format!("fps={}", rate_str(of)));
            // Before the source start (incoming side of a transition) the first frame holds.
            if src_start < 0.0 && !image {
                f.push(format!("tpad=start_duration={}:start_mode=clone", num(-src_start / clip.speed)));
            }
            if tail_ext > 0 && !image {
                f.push(format!("tpad=stop_duration={}:stop_mode=clone", num(sf.frames_to_seconds(tail_ext) + skip + 2.0 * frame_s)));
            }
            if skip > 0.0 && !image {
                f.push(format!("trim=start={},setpts=PTS-STARTPTS", num(skip - 0.5 * frame_s)));
            }
            // Colour first, then the effect stack, then opacity: with effects the
            // alpha multiplier is a second mixer so a key cannot discard it.
            let effects: Vec<&EffectKind> = clip.active_effects().map(|e| &e.kind).collect();
            let dynamic = fading || clip.color_animated();
            let mixer = if dynamic { format!("colorchannelmixer@op{k}") } else { "colorchannelmixer".into() };
            let alpha_mixer = if effects.is_empty() { mixer.clone() } else { format!("colorchannelmixer@al{k}") };
            if dynamic {
                f.push(format!("sendcmd=c='{}'", mixer_commands(clip, &seg, frame_s, &mixer, &alpha_mixer)));
            }
            let contrast_keys = !clip.keys_of(Param::Contrast).is_empty();
            let lv = format!("colorlevels@cl{k}");
            if contrast_keys {
                f.push(format!("sendcmd=c='{}'", levels_commands(clip, &seg, frame_s, &lv)));
            }
            if t.crop_left > 0.0 || t.crop_right > 0.0 || t.crop_top > 0.0 || t.crop_bottom > 0.0 {
                f.push(format!(
                    "crop=w=iw*{}:h=ih*{}:x=iw*{}:y=ih*{}",
                    num(1.0 - t.crop_left as f64 - t.crop_right as f64),
                    num(1.0 - t.crop_top as f64 - t.crop_bottom as f64),
                    num(t.crop_left as f64),
                    num(t.crop_top as f64)
                ));
            }
            // Effects work at the fitted size (sequence pixels at scale 1), so
            // pixel radii mean the same in preview and export.
            let (fw, fh) = (even(cw * fit), even(ch * fit));
            if !effects.is_empty() {
                f.push(format!("scale={fw}:{fh}:flags=bicubic"));
            } else if !animated {
                f.push(format!("scale={sw}:{sh}:flags=bicubic"));
            }
            f.push("format=rgba".into());
            let col = clip.color_at(seg.head as f64);
            let alpha = clip.param_at(Param::Opacity, seg.head as f64);
            let alpha_here = effects.is_empty() && (clip.opacity < 1.0 || dynamic);
            if !col.is_identity() || dynamic || alpha_here {
                let m = col.matrix();
                f.push(format!(
                    "{mixer}=rr={}:rg={}:rb={}:gr={}:gg={}:gb={}:br={}:bg={}:bb={}:aa={}",
                    num(m[0][0] as f64),
                    num(m[0][1] as f64),
                    num(m[0][2] as f64),
                    num(m[1][0] as f64),
                    num(m[1][1] as f64),
                    num(m[1][2] as f64),
                    num(m[2][0] as f64),
                    num(m[2][1] as f64),
                    num(m[2][2] as f64),
                    num(if effects.is_empty() { alpha as f64 } else { 1.0 })
                ));
            }
            if col.contrast != 0.0 || contrast_keys {
                let opts: Vec<String> =
                    levels(col.contrast_slope() as f64).iter().flat_map(|(n, v)| ["r", "g", "b"].map(|c| format!("{c}{n}={}", num(*v)))).collect();
                let name = if contrast_keys { lv.as_str() } else { "colorlevels" };
                f.push(format!("{name}={}", opts.join(":")));
            }
            for (j, e) in effects.iter().enumerate() {
                f.extend(effect_filters(e, k, j));
            }
            if !effects.is_empty() {
                if clip.opacity < 1.0 || dynamic {
                    f.push(format!("{alpha_mixer}=aa={}", num(alpha as f64)));
                }
                if !animated && (sw, sh) != (fw, fh) {
                    f.push(format!("scale={sw}:{sh}:flags=bicubic"));
                }
            }
            // Fades run from the clip's edges, wherever the segment starts.
            if clip.fade_in > 0 && clip.fade_in > seg.head {
                f.push(fade_at("fade", "in", sf.frames_to_seconds(-seg.head), sf.frames_to_seconds(clip.fade_in), ":alpha=1"));
            }
            if clip.fade_out > 0 {
                let st = sf.frames_to_seconds(clip.end() - clip.fade_out - seg.start);
                if st < seg_len {
                    f.push(fade_at("fade", "out", st, sf.frames_to_seconds(clip.fade_out), ":alpha=1"));
                }
            }
            let theta = (t.rotation as f64).to_radians();
            if animated {
                // Transparent border: `perspective` repeats edge pixels outside the source.
                f.push(format!("pad=iw+{p2}:ih+{p2}:{PAD}:{PAD}:color=black@0", p2 = 2 * PAD));
                f.push(format!("scale={}:{}:flags=bicubic", seq.settings.width, seq.settings.height));
                f.push(perspective(clip, seg.head, cw, ch, fit, w, h));
            } else if theta.abs() > 1e-9 {
                let a = num(theta);
                f.push(format!("rotate=a={a}:ow=rotw({a}):oh=roth({a}):c=none"));
            }
            f.push(format!("setpts=PTS+{}/TB", num(offset)));
            chains.push(format!("[{k}:v:0]{}[v{k}]", f.join(",")));

            // Anchor placement: centre = P - R(theta) * (anchor offset).
            let (ax, ay) = ((t.anchor_x as f64 - 0.5) * sw as f64, (t.anchor_y as f64 - 0.5) * sh as f64);
            let (rx, ry) = (ax * theta.cos() - ay * theta.sin(), ax * theta.sin() + ay * theta.cos());
            let cx = w / 2.0 + t.x as f64 - rx;
            let cy = h / 2.0 + t.y as f64 - ry;
            let (ox, oy) = if animated { ("0".to_string(), "0".to_string()) } else { (format!("{}-overlay_w/2", num(cx)), format!("{}-overlay_h/2", num(cy))) };
            Some(Placed { label: format!("v{k}"), k, x: ox, y: oy, start: seg.start, end: seg.start + seg.len })
            };

            // The clip's own overlay starts where its incoming transition ends.
            let own = placed.as_ref().is_some_and(|p| incoming.is_none_or(|s| s.t1 < p.end));
            let mut own_label = placed.as_ref().map(|p| p.label.clone());
            if let (Some(span), Some(lower)) = (incoming, below.take()) {
                let n = labels;
                labels += 1;
                let lay = placed.as_ref().map(|p| {
                    let input = if own {
                        chains.push(format!("[{}]split[{0}t][{0}n]", p.label));
                        own_label = Some(format!("{}n", p.label));
                        format!("{}t", p.label)
                    } else {
                        p.label.clone()
                    };
                    Layer { label: input, x: p.x.clone(), y: p.y.clone() }
                });
                last = transition_chains(&mut chains, span, n, &last, &lower, lay.as_ref(), t0, sf, of, (seq.settings.width, seq.settings.height));
            }
            if outgoing.is_some() {
                let n = labels;
                labels += 1;
                chains.push(format!("[{last}]split[keep{n}][below{n}]"));
                last = format!("keep{n}");
                below = Some(format!("below{n}"));
            }
            if let (Some(p), Some(label), true) = (placed, own_label, own) {
                let from = incoming.map_or(p.start, |s| s.t1.max(p.start));
                let out = format!("o{}", p.k);
                chains.push(format!(
                    "[{last}][{label}]overlay=x={}:y={}:eof_action=pass:format=rgb:enable='between(t,{},{})'[{out}]",
                    p.x,
                    p.y,
                    num(sf.frames_to_seconds(from - t0) - 0.5 * frame_s),
                    num(sf.frames_to_seconds(p.end - t0) - 0.5 * frame_s)
                ));
                last = out;
            }
        }
    }

    // --- subtitles ------------------------------------------------------------
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    // Cues inside the rendered range, cut to it.
    let cues: Vec<Cue> = seq
        .subtitles
        .cues
        .iter()
        .filter(|c| c.end > t0 && c.start < t1)
        .map(|c| Cue { start: c.start.max(t0), end: c.end.min(t1), ..c.clone() })
        .collect();
    if !s.subtitles.burn.is_empty() {
        // All cue images in one concat input: a frame per cue, blank frames in between.
        let blank = s.subtitles.blank.as_deref().ok_or_else(|| MediaError::Unsupported("subtitles: blank frame missing".into()))?;
        let list = work_dir.join(format!("subs-{}.ffconcat", uuid::Uuid::new_v4()));
        files.push((list.clone(), burn_list(&s.subtitles.burn, blank, t0, t1, sf)));
        args.extend(["-f", "concat", "-safe", "0", "-i"].map(OsString::from));
        args.push(list.into_os_string());
        let k = inputs;
        inputs += 1;
        chains.push(format!(
            "[{k}:v:0]fps={},format=rgba,scale={}:{}[subs]",
            rate_str(of),
            seq.settings.width,
            seq.settings.height
        ));
        chains.push(format!("[{last}][subs]overlay=0:0:eof_action=pass:format=rgb[subbed]"));
        last = "subbed".into();
    }
    let embedded = if s.subtitles.embed && !cues.is_empty() {
        let srt = work_dir.join(format!("subs-{}.srt", uuid::Uuid::new_v4()));
        files.push((srt.clone(), write_subtitles(&cues, sf, t0, SubtitleFormat::Srt)));
        args.extend(["-f", "srt", "-i"].map(OsString::from));
        args.push(srt.into_os_string());
        inputs += 1;
        Some(inputs - 1)
    } else {
        None
    };
    let sidecar = s.subtitles.sidecar.filter(|_| !cues.is_empty()).map(|f| {
        let ext = if f == SubtitleFormat::Srt { "srt" } else { "vtt" };
        (s.output.with_extension(ext), write_subtitles(&cues, sf, t0, f))
    });

    let pix_fmt = if prores { "yuv422p10le" } else { "yuv420p" };
    let (ow, oh) = (even(s.width as f64), even(s.height as f64));
    // A different output aspect (e.g. 9:16 from a 16:9 sequence) is letterboxed
    // on the sequence canvas first, so the colour conversion stays in one scale.
    let (target, src) = (ow as f64 / oh as f64, w / h);
    if (target - src).abs() > 1e-3 {
        let (pw, ph) = if target > src { (even(h * target), h as u32) } else { (w as u32, even(w / target)) };
        chains.push(format!("[{last}]pad={pw}:{ph}:(ow-iw)/2:(oh-ih)/2:color=black[boxed]"));
        last = "boxed".into();
    }
    chains.push(format!(
        "[{last}]scale={ow}:{oh}:flags=bicubic:out_color_matrix=bt709:out_range=tv,format={pix_fmt}[vout]"
    ));

    // --- audio ----------------------------------------------------------------
    let mix = audio_mix(project, seq, s, (t0, t1), inputs, s.loudness.map(|_| LOUDNORM_MARK.to_string()))?;
    args.extend(mix.args);
    chains.extend(mix.chains);
    inputs += mix.inputs;
    // Pass 1 measures the mix alone; pass 2 puts the measured values in for the mark.
    let measure = match s.loudness {
        Some(target) => {
            let measuring = target.filter(None).replace(":print_format=none", ":print_format=json");
            let m = audio_mix(project, seq, s, (t0, t1), 0, Some(measuring))?;
            let graph_path = work_dir.join(format!("measure-{}.ffgraph", uuid::Uuid::new_v4()));
            let mut a: Vec<OsString> = ["-hide_banner", "-nostdin", "-loglevel", "info", "-y"].iter().map(OsString::from).collect();
            a.extend(m.args);
            a.push("-/filter_complex".into());
            a.push(graph_path.clone().into_os_string());
            a.extend(["-map", "[aout]", "-progress", "pipe:1", "-nostats", "-f", "null", "-"].map(OsString::from));
            Some(MeasurePass { args: a, graph: m.chains.join(";\n"), graph_path, target })
        }
        None => None,
    };
    let graph = chains.join(";\n");

    let graph_path = work_dir.join(format!("render-{}.ffgraph", uuid::Uuid::new_v4()));
    args.push("-/filter_complex".into());
    args.push(graph_path.clone().into_os_string());
    args.extend(["-map", "[vout]", "-map", "[aout]"].map(OsString::from));
    if let Some(k) = embedded {
        args.extend(["-map".into(), format!("{k}:s:0").into()]);
        args.extend(["-c:s", "mov_text", "-metadata:s:s:0", "handler_name=Untertitel"].map(OsString::from));
    }

    let has = |e: &str| hw_encoders.iter().any(|x| x == e);
    let rate = s.rate;
    let mut v: Vec<String> = Vec::new();
    let encoder = match s.video_codec {
        VideoCodec::ProRes422 | VideoCodec::ProRes422Hq => {
            let profile = if s.video_codec == VideoCodec::ProRes422Hq { "3" } else { "2" };
            v.extend(["-c:v", "prores_ks", "-profile:v", profile, "-vendor", "apl0"].map(String::from));
            "prores_ks".to_string()
        }
        codec => {
            let (sw_enc, family) = match codec {
                VideoCodec::H264 => ("libx264", "h264"),
                _ => ("libx265", "hevc"),
            };
            let hw = if s.hardware {
                ["nvenc", "qsv", "amf"].iter().map(|v| format!("{family}_{v}")).find(|e| has(e))
            } else {
                None
            };
            match hw.as_deref() {
                Some(e) if e.ends_with("nvenc") => {
                    v.extend(["-c:v", e, "-preset", "p5", "-tune", "hq"].map(String::from));
                    match rate {
                        RateControl::Quality { crf } => {
                            v.extend(["-rc", "vbr", "-cq", &crf.to_string(), "-b:v", "0"].map(String::from))
                        }
                        RateControl::Bitrate { kbps } => v.extend(bitrate_args(kbps, true)),
                        RateControl::Constant { kbps } => {
                            v.extend(["-rc", "cbr"].map(String::from));
                            v.extend(cbr_args(kbps));
                        }
                    }
                }
                Some(e) if e.ends_with("qsv") => {
                    v.extend(["-c:v", e, "-preset", "medium"].map(String::from));
                    match rate {
                        RateControl::Quality { crf } => v.extend(["-global_quality", &crf.to_string()].map(String::from)),
                        RateControl::Bitrate { kbps } => v.extend(bitrate_args(kbps, false)),
                        // QSV encodes CBR when maxrate equals the target.
                        RateControl::Constant { kbps } => v.extend(cbr_args(kbps)),
                    }
                }
                Some(e) => {
                    v.extend(["-c:v", e, "-quality", "quality"].map(String::from));
                    match rate {
                        RateControl::Quality { crf } => {
                            let q = crf.to_string();
                            v.extend(["-rc", "cqp", "-qp_i", &q, "-qp_p", &q].map(String::from))
                        }
                        RateControl::Bitrate { kbps } => v.extend(bitrate_args(kbps, false)),
                        RateControl::Constant { kbps } => {
                            v.extend(["-rc", "cbr"].map(String::from));
                            v.extend(cbr_args(kbps));
                        }
                    }
                }
                None => {
                    v.extend(["-c:v", sw_enc, "-preset", "medium"].map(String::from));
                    let cbr = matches!(rate, RateControl::Constant { .. });
                    if family == "hevc" {
                        let params = if cbr { "log-level=error:strict-cbr=1" } else { "log-level=error" };
                        v.extend(["-x265-params", params].map(String::from));
                    } else if cbr {
                        v.extend(["-x264-params", "nal-hrd=cbr"].map(String::from));
                    }
                    match rate {
                        RateControl::Quality { crf } => v.extend(["-crf", &crf.to_string()].map(String::from)),
                        RateControl::Bitrate { kbps } => v.extend(bitrate_args(kbps, true)),
                        RateControl::Constant { kbps } => v.extend(cbr_args(kbps)),
                    }
                }
            }
            if family == "hevc" {
                v.extend(["-tag:v", "hvc1"].map(String::from));
            } else {
                v.extend(["-profile:v", "high"].map(String::from));
            }
            hw.unwrap_or_else(|| sw_enc.to_string())
        }
    };
    args.extend(v.into_iter().map(OsString::from));
    args.extend(["-pix_fmt", pix_fmt, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"].map(OsString::from));
    match s.audio_codec {
        AudioCodec::Aac => {
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), format!("{}k", s.audio_bitrate_kbps.clamp(64, 512)).into()])
        }
        AudioCodec::Pcm => args.extend(["-c:a", "pcm_s16le"].map(OsString::from)),
    }
    args.extend(["-ar".into(), sr.to_string().into(), "-ac".into(), channels.to_string().into()]);
    args.extend(["-frames:v".into(), frames.to_string().into()]);
    if container == "mp4" {
        args.extend(["-movflags", "+faststart"].map(OsString::from));
    }
    args.extend(["-progress", "pipe:1", "-nostats", "-f", container].map(OsString::from));
    let partial_path = {
        let mut p = s.output.as_os_str().to_owned();
        p.push(".partial");
        PathBuf::from(p)
    };
    args.push(partial_path.clone().into_os_string());

    Ok(RenderPlan {
        args,
        graph,
        graph_path,
        partial_path,
        output: s.output.clone(),
        duration,
        frames,
        inputs,
        encoder,
        width: ow,
        height: oh,
        fps: of,
        channels,
        files,
        sidecar,
        measure,
    })
}

/// Concat list (ffconcat) of burned-in cue images over `t0..t1`, with the blank
/// frame in the gaps and once more at the end so the last cue keeps its length.
fn burn_list(cues: &[BurnCue], blank: &Path, t0: Frame, t1: Frame, sf: Rational) -> String {
    let quote = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\\', "/").replace('\'', r"'\''"));
    let mut sorted: Vec<&BurnCue> = cues.iter().filter(|c| c.end > t0 && c.start < t1 && c.end > c.start).collect();
    sorted.sort_by_key(|c| c.start);
    let mut out = String::from("ffconcat version 1.0\n");
    let mut at = t0;
    let mut entry = |path: &Path, from: Frame, to: Frame| {
        out.push_str(&format!("file {}\nduration {}\n", quote(path), num(sf.frames_to_seconds(to - from))));
    };
    for c in sorted {
        let (a, b) = (c.start.max(at), c.end.min(t1));
        if b <= a {
            continue;
        }
        if a > at {
            entry(blank, at, a);
        }
        entry(&c.path, a, b);
        at = b;
    }
    entry(blank, at, t1.max(at + 1));
    out
}

fn cbr_args(kbps: u32) -> Vec<String> {
    let k = format!("{}k", kbps.clamp(500, 400_000));
    ["-b:v", &k, "-minrate", &k, "-maxrate", &k, "-bufsize", &k].map(String::from).to_vec()
}

fn bitrate_args(kbps: u32, vbv: bool) -> Vec<String> {
    let k = kbps.clamp(500, 400_000);
    let mut v = vec!["-b:v".to_string(), format!("{k}k")];
    if vbv {
        v.extend(["-maxrate".to_string(), format!("{}k", k * 3 / 2), "-bufsize".to_string(), format!("{}k", k * 2)]);
    }
    v
}

/// Executes a plan. Progress is reported about twice per second; setting
/// `cancel` stops FFmpeg and removes the partial file.
pub fn render(tools: &Tools, plan: &RenderPlan, cancel: &AtomicBool, progress: impl FnMut(&RenderProgress)) -> Result<(), MediaError> {
    render_logged(tools, plan, cancel, progress, &mut String::new())
}

/// Lines of FFmpeg output kept in a job log.
const LOG_LINES: usize = 400;

fn append_log(log: &mut String, stderr: &[u8]) {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.lines().collect();
    let skip = lines.len().saturating_sub(LOG_LINES);
    if skip > 0 {
        log.push_str(&format!("… {skip} Zeilen ausgelassen\n"));
    }
    for l in &lines[skip..] {
        log.push_str(l);
        log.push('\n');
    }
}

fn quoted(args: &[OsString]) -> String {
    let parts: Vec<String> = args
        .iter()
        .map(|a| {
            let a = a.to_string_lossy();
            if a.contains(' ') { format!("\"{a}\"") } else { a.into_owned() }
        })
        .collect();
    parts.join(" ")
}

/// Runs FFmpeg with `-progress pipe:1`, handing each key/value pair to `on`.
/// Returns whether it succeeded (None when cancelled) and its stderr.
fn run_ffmpeg(tools: &Tools, args: &[OsString], cancel: &AtomicBool, mut on: impl FnMut(&str, &str)) -> Result<(Option<bool>, Vec<u8>), MediaError> {
    let mut child = crate::tools::background_command(&tools.ffmpeg).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stderr = child.stderr.take().expect("piped");
    let err_thread = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut s);
        s
    });
    let stdout = child.stdout.take().expect("piped");
    for line in BufReader::new(stdout).lines() {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            break;
        }
        let Ok(line) = line else { break };
        if let Some((key, value)) = line.split_once('=') {
            on(key, value.trim());
        }
    }
    let status = child.wait()?;
    let err = err_thread.join().unwrap_or_default();
    Ok((if cancel.load(Ordering::Relaxed) { None } else { Some(status.success()) }, err))
}

/// [`render`], recording the command line and FFmpeg's warnings and errors in `log`.
pub fn render_logged(
    tools: &Tools,
    plan: &RenderPlan,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&RenderProgress),
    log: &mut String,
) -> Result<(), MediaError> {
    if let Some(dir) = plan.graph_path.parent() {
        fs::create_dir_all(dir)?;
    }
    let started = Instant::now();
    let mut state = RenderProgress::default();
    let tick = |state: &mut RenderProgress, fraction: f64| {
        state.elapsed = started.elapsed().as_secs_f64();
        state.fraction = fraction.clamp(0.0, 1.0);
        state.eta = (state.fraction > 0.01).then(|| state.elapsed * (1.0 - state.fraction) / state.fraction);
    };

    // Two-pass loudness normalisation: measure the mix, then put loudnorm with
    // the measured values where the graph holds the mark.
    let mut graph = plan.graph.clone();
    if let Some(m) = &plan.measure {
        log.push_str(&format!("# Lautheit messen\nffmpeg {}\n\n{}\n\n", quoted(&m.args), m.graph));
        fs::write(&m.graph_path, &m.graph)?;
        state.measuring = true;
        let mut out_s = 0.0;
        let run = run_ffmpeg(tools, &m.args, cancel, |key, value| match key {
            "out_time_us" => out_s = value.parse::<f64>().map_or(out_s, |us| us / 1e6),
            "progress" => {
                tick(&mut state, out_s / plan.duration.max(1e-3));
                progress(&state);
            }
            _ => {}
        });
        let _ = fs::remove_file(&m.graph_path);
        let (done, err) = run?;
        let text = String::from_utf8_lossy(&err);
        match done {
            None => return Err(MediaError::Cancelled),
            Some(false) => {
                append_log(log, &err);
                return Err(MediaError::failed("loudness", &err));
            }
            Some(true) => {}
        }
        let Some(measured) = parse_loudnorm(&text) else {
            append_log(log, &err);
            return Err(MediaError::Unsupported("loudnorm printed no measurement".into()));
        };
        log.push_str(&format!(
            "gemessen: {} LUFS, {} dBTP, LRA {} LU\n\n",
            num(measured.input_i),
            num(measured.input_tp),
            num(measured.input_lra)
        ));
        // A silent mix has nothing to normalise.
        let filter = if measured.audible() { m.target.filter(Some(measured)) } else { "anull".to_string() };
        graph = graph.replace(LOUDNORM_MARK, &filter);
        state = RenderProgress::default();
    }

    log.push_str(&format!("ffmpeg {}\n\n# filter graph\n{}\n\n# ffmpeg\n", quoted(&plan.args), graph));
    fs::write(&plan.graph_path, &graph)?;
    for (path, text) in &plan.files {
        fs::write(path, text)?;
    }
    let cleanup = |partial: bool| {
        let _ = fs::remove_file(&plan.graph_path);
        for (path, _) in &plan.files {
            let _ = fs::remove_file(path);
        }
        if partial {
            let _ = fs::remove_file(&plan.partial_path);
        }
    };
    let run = run_ffmpeg(tools, &plan.args, cancel, |key, value| match key {
        "frame" => state.frame = value.parse().unwrap_or(state.frame),
        "speed" => state.speed = value.trim_end_matches('x').parse().ok(),
        "progress" => {
            let f = state.frame as f64 / plan.frames as f64;
            tick(&mut state, f);
            progress(&state);
        }
        _ => {}
    });
    let (done, err) = match run {
        Ok(r) => r,
        Err(e) => {
            cleanup(false);
            return Err(e);
        }
    };
    append_log(log, &err);
    match done {
        None => {
            cleanup(true);
            return Err(MediaError::Cancelled);
        }
        Some(false) => {
            cleanup(true);
            return Err(MediaError::failed("export", &err));
        }
        Some(true) => {}
    }
    cleanup(false);
    fs::rename(&plan.partial_path, &plan.output)?;
    if let Some((path, text)) = &plan.sidecar {
        fs::write(path, text)?;
    }
    state.fraction = 1.0;
    state.eta = Some(0.0);
    progress(&state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kerf_core::model::*;
    use kerf_core::ops::{apply, EditCommand, PlaceMode};

    fn project_with_clip() -> (Project, uuid::Uuid) {
        let mut p = Project::new("t", 0);
        let id = uuid::Uuid::new_v4();
        p.media.push(MediaAsset {
            id,
            path: "C:/media/a.mp4".into(),
            name: "a".into(),
            kind: MediaKind::Video,
            status: MediaStatus::Ready,
            info: Some(MediaInfo {
                duration: 10.0,
                size_bytes: 1,
                container: "mov,mp4".into(),
                bit_rate: None,
                video: Some(VideoInfo {
                    codec: "h264".into(),
                    profile: None,
                    width: 1280,
                    height: 720,
                    fps: Rational::new(25, 1),
                    pix_fmt: Some("yuv420p".into()),
                    bit_rate: None,
                    rotation: 0,
                    color: Default::default(),
                }),
                audio: Some(AudioInfo { codec: "aac".into(), channels: 2, sample_rate: 48_000, channel_layout: None, bit_rate: None }),
            }),
            bin: None,
            favorite: false,
            label: Default::default(),
            tags: Vec::new(),
            note: String::new(),
            imported_at: 0,
            derived: Derived::default(),
            marks: Default::default(),
            title: None,
        });
        let seq = p.active_sequence;
        apply(
            &mut p,
            &EditCommand::PlaceMedia {
                sequence: seq,
                media: id,
                video_track: None,
                audio_track: None,
                at: 25,
                mode: PlaceMode::Overwrite,
                source_in: Some(50),
                source_out: Some(100),
                match_sequence: false,
            },
        )
        .unwrap();
        (p, seq)
    }

    fn settings() -> ExportSettings {
        ExportSettings {
            output: "C:/out/film.mp4".into(),
            video_codec: VideoCodec::H264,
            hardware: false,
            width: 1920,
            height: 1080,
            fps: Rational::new(25, 1),
            rate: RateControl::Quality { crf: 18 },
            audio_codec: AudioCodec::Aac,
            audio_bitrate_kbps: 320,
            sample_rate: 48_000,
            audio_channels: 2,
            use_in_out: false,
            subtitles: Default::default(),
            title_files: Default::default(),
            loudness: None,
        }
    }

    #[test]
    fn plans_offset_clip_with_audio() {
        let (p, seq) = project_with_clip();
        let plan = plan(&p, p.sequence(seq).unwrap(), &settings(), Path::new("C:/tmp"), &[]).unwrap();
        assert_eq!(plan.inputs, 2);
        assert_eq!(plan.frames, 75);
        assert!((plan.duration - 3.0).abs() < 1e-9);
        let args: Vec<String> = plan.args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        // Seek to source in-point of 2 s.
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss + 1], "2");
        assert!(plan.graph.contains("setpts=PTS+1/TB"), "{}", plan.graph);
        assert!(plan.graph.contains("adelay=delays=48000S:all=1"), "{}", plan.graph);
        // 1280x720 fitted into 1920x1080.
        assert!(plan.graph.contains("scale=1920:1080:flags=bicubic,format=rgba"), "{}", plan.graph);
        assert_eq!(plan.encoder, "libx264");
    }

    #[test]
    fn hardware_encoder_is_used_only_when_available() {
        let (p, seq) = project_with_clip();
        let mut s = settings();
        s.hardware = true;
        let none = plan(&p, p.sequence(seq).unwrap(), &s, Path::new("C:/tmp"), &[]).unwrap();
        assert_eq!(none.encoder, "libx264");
        let nv = plan(&p, p.sequence(seq).unwrap(), &s, Path::new("C:/tmp"), &["h264_nvenc".into()]).unwrap();
        assert_eq!(nv.encoder, "h264_nvenc");
    }

    #[test]
    fn constant_bitrate_mono_and_letterboxed_output() {
        let (p, seq) = project_with_clip();
        let seq = p.sequence(seq).unwrap();
        let args = |plan: &RenderPlan| plan.args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        let mut s = settings();
        s.rate = RateControl::Constant { kbps: 8000 };
        s.audio_channels = 1;
        let cbr = plan(&p, seq, &s, Path::new("C:/tmp"), &[]).unwrap();
        let a = args(&cbr);
        assert!(a.contains("-b:v 8000k -minrate 8000k -maxrate 8000k -bufsize 8000k"), "{a}");
        assert!(a.contains("nal-hrd=cbr") && a.contains("-ac 1"), "{a}");
        assert_eq!(cbr.channels, 1);
        assert!(!cbr.graph.contains("[boxed]"), "same aspect needs no letterbox");
        let nv = plan(&p, seq, &s, Path::new("C:/tmp"), &["h264_nvenc".into()]);
        assert!(nv.is_ok());
        // A vertical export of a 16:9 sequence is letterboxed, not stretched.
        s.width = 1080;
        s.height = 1920;
        let tall = plan(&p, seq, &s, Path::new("C:/tmp"), &[]).unwrap();
        assert!(tall.graph.contains("pad=1920:3414:(ow-iw)/2:(oh-ih)/2:color=black"), "{}", tall.graph);
        assert!(tall.graph.contains("scale=1080:1920"), "{}", tall.graph);
        assert_eq!((tall.width, tall.height), (1080, 1920));
    }

    /// Evaluates the subset of FFmpeg's expression language that `param_expr`
    /// emits (nested `if(lt(a,b),x,y)` with + - * / and parentheses).
    fn eval_expr(e: &str, var: &str, v: f64) -> f64 {
        fn parse(s: &mut &str, var: &str, v: f64) -> f64 {
            let mut acc = term(s, var, v);
            loop {
                if let Some(r) = s.strip_prefix('+') {
                    *s = r;
                    acc += term(s, var, v);
                } else if let Some(r) = s.strip_prefix('-') {
                    *s = r;
                    acc -= term(s, var, v);
                } else {
                    return acc;
                }
            }
        }
        fn term(s: &mut &str, var: &str, v: f64) -> f64 {
            let mut acc = atom(s, var, v);
            loop {
                if let Some(r) = s.strip_prefix('*') {
                    *s = r;
                    acc *= atom(s, var, v);
                } else if let Some(r) = s.strip_prefix('/') {
                    *s = r;
                    acc /= atom(s, var, v);
                } else {
                    return acc;
                }
            }
        }
        fn atom(s: &mut &str, var: &str, v: f64) -> f64 {
            if let Some(r) = s.strip_prefix("if(lt(") {
                *s = r;
                let a = parse(s, var, v);
                *s = &s[1..];
                let b = parse(s, var, v);
                *s = &s[2..];
                let x = parse(s, var, v);
                *s = &s[1..];
                let y = parse(s, var, v);
                *s = &s[1..];
                return if a < b { x } else { y };
            }
            if let Some(r) = s.strip_prefix('(') {
                *s = r;
                let x = parse(s, var, v);
                *s = &s[1..];
                return x;
            }
            if let Some(r) = s.strip_prefix(var) {
                *s = r;
                return v;
            }
            if let Some(r) = s.strip_prefix('-') {
                *s = r;
                return -atom(s, var, v);
            }
            let end = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
            let n = s[..end].parse().unwrap();
            *s = &s[end..];
            n
        }
        let mut s = e;
        parse(&mut s, var, v)
    }

    #[test]
    fn bezier_keys_are_approximated_closely_in_expressions() {
        let mut c = Clip::new(uuid::Uuid::new_v4(), "c", 0, 100, 0);
        let curve = Ease::Bezier { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1.0 };
        c.keys.insert(Param::X, vec![Keyframe { at: 10, value: 0.0, ease: curve }, Keyframe { at: 60, value: 200.0, ease: Ease::Linear }]);
        let e = param_expr(&c, Param::X, 0, "in", 1.0);
        let mut worst = 0f64;
        for i in 0..=80 {
            let f = i as f64;
            worst = worst.max((eval_expr(&e, "in", f) - c.param_at(Param::X, f) as f64).abs());
        }
        // 16 linear pieces over 50 frames: well under a pixel.
        assert!(worst < 0.5, "max error {worst}");
    }

    #[test]
    fn animated_colour_drives_the_mixer_per_frame() {
        let (mut p, seq) = project_with_clip();
        let clip = p.sequence(seq).unwrap().tracks[0].clips[0].clone();
        let s = p.sequence_mut(seq).unwrap();
        let c = &mut s.tracks[0].clips[0];
        c.keys.insert(Param::Exposure, vec![Keyframe { at: clip.source_in, value: -1.0, ease: Ease::Linear }, Keyframe { at: clip.source_in + 10, value: 0.0, ease: Ease::Linear }]);
        c.keys.insert(Param::Contrast, vec![Keyframe { at: clip.source_in, value: 0.5, ease: Ease::Hold }]);
        let plan = plan(&p, p.sequence(seq).unwrap(), &settings(), Path::new("C:/tmp"), &[]).unwrap();
        let g = &plan.graph;
        assert!(g.contains("sendcmd=c='0 colorchannelmixer@op0 rr 0.5"), "{g}");
        assert!(g.contains("colorchannelmixer@op0=rr=0.5:"), "starts at -1 EV: {g}");
        assert!(g.contains("sendcmd=c='0 colorlevels@cl0 rimin 0.166667"), "{g}");
        assert!(g.contains("colorlevels@cl0=rimin=0.166667"), "{g}");
    }

    #[test]
    fn untagged_hd_is_read_as_bt709() {
        let (mut p, seq) = project_with_clip();
        let g = plan(&p, p.sequence(seq).unwrap(), &settings(), Path::new("C:/tmp"), &[]).unwrap().graph;
        assert!(g.contains("[0:v:0]setparams=colorspace=bt709:range=tv,"), "{g}");
        let v = p.media[0].info.as_mut().unwrap().video.as_mut().unwrap();
        v.color.space = Some("smpte170m".into());
        let g = plan(&p, p.sequence(seq).unwrap(), &settings(), Path::new("C:/tmp"), &[]).unwrap().graph;
        assert!(!g.contains("setparams"), "tagged input keeps its own matrix: {g}");
        let v = p.media[0].info.as_mut().unwrap().video.as_mut().unwrap();
        (v.color.space, v.height) = (None, 480);
        let g = plan(&p, p.sequence(seq).unwrap(), &settings(), Path::new("C:/tmp"), &[]).unwrap().graph;
        assert!(!g.contains("setparams"), "untagged SD stays BT.601: {g}");
    }

    #[test]
    fn rejects_invalid_containers_and_empty_sequences() {
        let (p, seq) = project_with_clip();
        let mut s = settings();
        s.video_codec = VideoCodec::ProRes422;
        assert!(plan(&p, p.sequence(seq).unwrap(), &s, Path::new("C:/tmp"), &[]).is_err());
        let empty = Project::new("e", 0);
        assert!(plan(&empty, &empty.sequences[0], &settings(), Path::new("C:/tmp"), &[]).is_err());
    }

    #[test]
    fn muted_tracks_are_excluded() {
        let (mut p, seq) = project_with_clip();
        for t in &mut p.sequence_mut(seq).unwrap().tracks {
            if t.kind == TrackKind::Audio {
                t.muted = true;
            }
        }
        let plan = plan(&p, p.sequence(seq).unwrap(), &settings(), Path::new("C:/tmp"), &[]).unwrap();
        assert_eq!(plan.inputs, 1);
        assert!(plan.graph.contains("anullsrc"));
    }

    #[test]
    fn audio_effects_build_the_fixture_filters() {
        // The preview's DSP is checked against FFmpeg running exactly these strings.
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/parity/audio.json");
        let fixture: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        let sr = fixture["sampleRate"].as_u64().unwrap() as u32;
        for c in fixture["cases"].as_array().unwrap() {
            let kind: AudioEffectKind = serde_json::from_value(c["effect"].clone()).unwrap();
            let e = AudioEffect { id: uuid::Uuid::nil(), enabled: true, kind };
            assert_eq!(audio_effect_filters(&[e], sr, false).join(","), c["filter"].as_str().unwrap());
        }
    }

    #[test]
    fn audio_effects_skip_what_does_nothing() {
        let band = |shape, freq, gain_db| EqBand { shape, freq, gain_db, q: 1.0, enabled: true };
        let eq = AudioEffect {
            id: uuid::Uuid::nil(),
            enabled: true,
            kind: AudioEffectKind::Eq { bands: vec![band(EqShape::Peak, 1000.0, 0.0), band(EqShape::LowPass, 15_000.0, 0.0), band(EqShape::HighShelf, 9000.0, 2.0)] },
        };
        // At 22.05 kHz the low-pass is above Nyquist; the 0 dB peak changes nothing.
        assert_eq!(audio_effect_filters(std::slice::from_ref(&eq), 22_050, true), vec!["highshelf=f=9000:t=s:w=1:g=2:r=f64"]);
        let off = AudioEffect { enabled: false, ..eq };
        assert!(audio_effect_filters(&[off], 48_000, true).is_empty());
        let lim = AudioEffect { id: uuid::Uuid::nil(), enabled: true, kind: AudioEffectKind::Limiter { ceiling_db: -1.0, release_ms: 50.0 } };
        assert_eq!(audio_effect_filters(&[lim], 48_000, true), vec!["alimiter=limit=0.891250938:attack=5:release=50:asc=0:level=0:latency=1"]);
    }

    #[test]
    fn pan_follows_the_stereo_panner() {
        assert_eq!(pan_matrix(stereo_pan(0.0)), "pan=stereo|c0=1*c0|c1=1*c1");
        assert_eq!(pan_matrix(stereo_pan(-1.0)), "pan=stereo|c0=1*c0+1*c1|c1=0*c0");
        assert_eq!(pan_matrix(stereo_pan(0.5)), "pan=stereo|c0=0.707107*c0|c1=0.707107*c0+1*c1");
        assert_eq!(pan_matrix(ChannelMap::Left.matrix().map(|r| r.map(f64::from))), "pan=stereo|c0=1*c0|c1=1*c0");
    }

    #[test]
    fn audio_routes_channels_effects_and_track_submix() {
        let (mut p, seq) = project_with_clip();
        if let Some(a) = p.media[0].info.as_mut().and_then(|i| i.audio.as_mut()) {
            a.channels = 1;
        }
        let comp = AudioEffect {
            id: uuid::Uuid::nil(),
            enabled: true,
            kind: AudioEffectKind::Compressor { threshold_db: -20.0, ratio: 4.0, attack_ms: 5.0, release_ms: 80.0, knee_db: 6.0, makeup_db: 0.0 },
        };
        {
            let s = p.sequence_mut(seq).unwrap();
            let track = s.tracks.iter_mut().find(|t| t.kind == TrackKind::Audio && !t.clips.is_empty()).unwrap();
            track.volume_db = -6.0;
            track.mono = true;
            track.effects = vec![comp.clone()];
            let clip = &mut track.clips[0];
            clip.channels = ChannelMap::Swap;
            clip.pan = -0.5;
            clip.volume_db = 2.0;
            clip.audio_effects = vec![AudioEffect { kind: AudioEffectKind::Limiter { ceiling_db: -6.0, release_ms: 30.0 }, ..comp }];
        }
        let plan = plan(&p, p.sequence(seq).unwrap(), &settings(), Path::new("C:/tmp"), &[]).unwrap();
        let g = &plan.graph;
        // Mono source on both sides at full level, then the map, the effects, the clip gain alone, the pan.
        let order = ["pan=stereo|c0=c0|c1=c0", "aformat=", "pan=stereo|c0=1*c1|c1=1*c0", "alimiter=limit=0.501187234", "volume=2dB", "pan=stereo|c0=1*c0+0.707107*c1|c1=0.707107*c1"];
        let at: Vec<usize> = order.iter().map(|f| g.find(f).unwrap_or_else(|| panic!("{f} missing in {g}"))).collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "{g}");
        // The track: folded to mono, compressed, then its volume.
        assert!(g.contains("[a1]pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,acompressor=threshold=0.1:ratio=4"), "{g}");
        assert!(g.contains(":link=average,volume=-6dB[at"), "{g}");
        assert!(plan.measure.is_none());
    }

    #[test]
    fn loudness_is_measured_first() {
        let (p, seq) = project_with_clip();
        let s = ExportSettings { loudness: Some(LoudnessTarget { integrated: -14.0, true_peak: -1.0 }), ..settings() };
        let plan = plan(&p, p.sequence(seq).unwrap(), &s, Path::new("C:/tmp"), &[]).unwrap();
        assert!(plan.graph.contains(&format!(",{LOUDNORM_MARK},aresample=48000,apad=")), "{}", plan.graph);
        let m = plan.measure.unwrap();
        assert!(m.graph.contains("loudnorm=I=-14:TP=-1:LRA=50:print_format=json,aresample=48000"), "{}", m.graph);
        // The measuring pass reads only the audio input, as input 0.
        assert!(m.graph.contains("[0:a:0]"), "{}", m.graph);
        let args: Vec<String> = m.args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), 1);
        assert!(args.ends_with(&["-f".into(), "null".into(), "-".into()]));

        let log = r#"[Parsed_loudnorm_3 @ 000001]
{
	"input_i" : "-27.61",
	"input_tp" : "-4.47",
	"input_lra" : "18.06",
	"input_thresh" : "-39.20",
	"output_i" : "-14.00",
	"output_tp" : "-1.00",
	"output_lra" : "17.00",
	"output_thresh" : "-25.20",
	"normalization_type" : "linear",
	"target_offset" : "0.01"
}
[out#0/null @ 000002] video:0KiB audio:1KiB"#;
        let measured = parse_loudnorm(log).unwrap();
        assert!(measured.audible());
        assert_eq!(
            m.target.filter(Some(measured)),
            "loudnorm=I=-14:TP=-1:LRA=50:print_format=none:measured_I=-27.61:measured_TP=-4.47:measured_LRA=18.06:measured_thresh=-39.2:offset=0.01:linear=true"
        );
        let silent = log.replace("\"-27.61\"", "\"-inf\"");
        assert!(!parse_loudnorm(&silent).unwrap().audible());
    }
}
