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

use kerf_core::model::{Clip, Cue, CurvePoint, Ease, EffectKind, Keyframe, MediaKind, MediaStatus, Param, Project, Sequence, TrackKind, VideoInfo};
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
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgress {
    pub fraction: f64,
    pub frame: u64,
    pub elapsed: f64,
    pub eta: Option<f64>,
    pub speed: Option<f64>,
}

/// Part of a clip that falls into the render range.
struct Segment {
    /// Timeline frame where the visible part starts.
    start: Frame,
    len: Frame,
    /// Frames skipped at the clip head.
    head: Frame,
}

fn segment(c: &Clip, t0: Frame, t1: Frame) -> Option<Segment> {
    let start = c.start.max(t0);
    let end = c.end().min(t1);
    (end > start).then(|| Segment { start, len: end - start, head: start - c.start })
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
    for track in seq.tracks.iter().filter(|t| t.kind == TrackKind::Video && !t.hidden) {
        for clip in track.clips.iter().filter(|c| c.enabled && (c.opacity > 0.0 || !c.keys_of(Param::Opacity).is_empty())) {
            let Some(seg) = segment(clip, t0, t1) else { continue };
            // Animated position/scale/rotation: the clip is warped onto the frame by
            // `perspective` with per-frame corner expressions (same math as `place`).
            let animated = [Param::X, Param::Y, Param::Scale, Param::Rotation].iter().any(|p| !clip.keys_of(*p).is_empty());
            let fading = !clip.keys_of(Param::Opacity).is_empty();
            let Some(asset) = asset_for(clip)? else { continue };
            let info = asset.info.as_ref().expect("checked");
            let Some((dw, dh)) = display_size(info) else { continue };
            let t = &clip.transform;
            if t.scale <= 0.0 && !animated {
                continue;
            }
            let cw = dw as f64 * (1.0 - t.crop_left as f64 - t.crop_right as f64);
            let ch = dh as f64 * (1.0 - t.crop_top as f64 - t.crop_bottom as f64);
            let fit = (w / cw).min(h / ch);
            let (sw, sh) = (even(cw * fit * t.scale as f64), even(ch * fit * t.scale as f64));

            let src_start = sf.frames_to_seconds(clip.source_in) + sf.frames_to_seconds(seg.head) * clip.speed;
            let seg_len = sf.frames_to_seconds(seg.len);
            let offset = sf.frames_to_seconds(seg.start - t0);
            let image = asset.kind == MediaKind::Image;
            if image {
                args.extend(["-loop", "1", "-framerate"].map(OsString::from));
                args.push(rate_str(of).into());
                args.extend(["-t".into(), num(seg_len + 2.0 * frame_s).into()]);
            } else {
                args.extend(["-ss".into(), num(src_start.max(0.0)).into()]);
                args.extend(["-t".into(), num(seg_len * clip.speed + 2.0 * frame_s).into()]);
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
            if clip.fade_in > seg.head {
                f.push(format!("fade=t=in:st=0:d={}:alpha=1", num(sf.frames_to_seconds(clip.fade_in - seg.head))));
            }
            if clip.fade_out > 0 {
                let st = sf.frames_to_seconds(clip.end() - clip.fade_out - seg.start);
                if st < seg_len {
                    f.push(format!("fade=t=out:st={}:d={}:alpha=1", num(st), num(sf.frames_to_seconds(clip.fade_out))));
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
            let (from, to) = (offset - 0.5 * frame_s, offset + seg_len - 0.5 * frame_s);
            let out = format!("o{k}");
            let (ox, oy) = if animated { ("0".to_string(), "0".to_string()) } else { (format!("{}-overlay_w/2", num(cx)), format!("{}-overlay_h/2", num(cy))) };
            chains.push(format!(
                "[{last}][v{k}]overlay=x={ox}:y={oy}:eof_action=pass:format=rgb:enable='between(t,{},{})'[{out}]",
                num(from),
                num(to)
            ));
            last = out;
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
    let audio_tracks: Vec<_> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Audio).collect();
    let any_solo = audio_tracks.iter().any(|t| t.solo);
    let mut mix_inputs = Vec::new();
    for track in audio_tracks.iter().filter(|t| !t.muted && (!any_solo || t.solo)) {
        for clip in track.clips.iter().filter(|c| c.enabled) {
            let gain_db = clip.volume_db + track.volume_db;
            let ramped = !clip.keys_of(Param::Volume).is_empty();
            if gain_db <= -96.0 && !ramped {
                continue;
            }
            let Some(seg) = segment(clip, t0, t1) else { continue };
            let Some(asset) = asset_for(clip)? else { continue };
            if !asset.has_audio() {
                continue;
            }
            let src_start = sf.frames_to_seconds(clip.source_in) + sf.frames_to_seconds(seg.head) * clip.speed;
            let seg_len = sf.frames_to_seconds(seg.len);
            let offset = sf.frames_to_seconds(seg.start - t0);
            args.extend(["-ss".into(), num(src_start.max(0.0)).into()]);
            args.extend(["-t".into(), num(seg_len * clip.speed + 0.1).into()]);
            args.push("-i".into());
            args.push(asset.path.clone().into_os_string());
            let k = inputs;
            inputs += 1;

            let mut f = vec!["asetpts=PTS-STARTPTS".to_string()];
            f.extend(atempo_chain(clip.speed));
            f.push(format!("aformat=sample_fmts=fltp:sample_rates={sr}:channel_layouts=stereo"));
            if ramped {
                // Volume keys in dB over output time `t` of this segment.
                let db = param_expr(clip, Param::Volume, seg.head, "t", frame_s);
                f.push(format!("volume='pow(10,(({db})+{})/20)':eval=frame", num(track.volume_db as f64)));
            } else if gain_db != 0.0 {
                f.push(format!("volume={}dB", num(gain_db as f64)));
            }
            if clip.pan != 0.0 {
                let l = (1.0 - clip.pan as f64).min(1.0);
                let r = (1.0 + clip.pan as f64).min(1.0);
                f.push(format!("pan=stereo|c0={}*c0|c1={}*c1", num(l), num(r)));
            }
            if clip.fade_in > seg.head {
                f.push(format!("afade=t=in:st=0:d={}", num(sf.frames_to_seconds(clip.fade_in - seg.head))));
            }
            if clip.fade_out > 0 {
                let st = sf.frames_to_seconds(clip.end() - clip.fade_out - seg.start);
                if st < seg_len {
                    f.push(format!("afade=t=out:st={}:d={}", num(st), num(sf.frames_to_seconds(clip.fade_out))));
                }
            }
            f.push(format!("atrim=end={}", num(seg_len)));
            let delay = (offset * sr as f64).round() as u64;
            if delay > 0 {
                f.push(format!("adelay=delays={delay}S:all=1"));
            }
            chains.push(format!("[{k}:a:0]{}[a{k}]", f.join(",")));
            mix_inputs.push(format!("[a{k}]"));
        }
    }
    let tail = format!("apad=whole_dur={d},atrim=end={d}", d = num(duration));
    match mix_inputs.len() {
        0 => chains.push(format!("anullsrc=r={sr}:cl=stereo,{tail}[aout]")),
        1 => chains.push(format!("{}{tail}[aout]", mix_inputs[0])),
        n => chains.push(format!(
            "{}amix=inputs={n}:normalize=0:dropout_transition=0,{tail}[aout]",
            mix_inputs.join("")
        )),
    }
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

/// [`render`], recording the command line and FFmpeg's warnings and errors in `log`.
pub fn render_logged(
    tools: &Tools,
    plan: &RenderPlan,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&RenderProgress),
    log: &mut String,
) -> Result<(), MediaError> {
    let quoted: Vec<String> = plan
        .args
        .iter()
        .map(|a| {
            let a = a.to_string_lossy();
            if a.contains(' ') { format!("\"{a}\"") } else { a.into_owned() }
        })
        .collect();
    log.push_str(&format!("ffmpeg {}\n\n# filter graph\n{}\n\n# ffmpeg\n", quoted.join(" "), plan.graph));
    let mut append = |stderr: &[u8]| {
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
    };
    if let Some(dir) = plan.graph_path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&plan.graph_path, &plan.graph)?;
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
    let mut child = match crate::tools::background_command(&tools.ffmpeg)
        .args(&plan.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            cleanup(false);
            return Err(e.into());
        }
    };
    let stderr = child.stderr.take().expect("piped");
    let err_thread = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut s);
        s
    });
    let started = Instant::now();
    let mut state = RenderProgress::default();
    let stdout = child.stdout.take().expect("piped");
    for line in BufReader::new(stdout).lines() {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            append(&err_thread.join().unwrap_or_default());
            cleanup(true);
            return Err(MediaError::Cancelled);
        }
        let Ok(line) = line else { break };
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key {
            "frame" => state.frame = value.parse().unwrap_or(state.frame),
            "speed" => state.speed = value.trim_end_matches('x').parse().ok(),
            "progress" => {
                state.elapsed = started.elapsed().as_secs_f64();
                state.fraction = (state.frame as f64 / plan.frames as f64).clamp(0.0, 1.0);
                state.eta = (state.fraction > 0.01).then(|| state.elapsed * (1.0 - state.fraction) / state.fraction);
                progress(&state);
            }
            _ => {}
        }
    }
    let status = child.wait()?;
    let err = err_thread.join().unwrap_or_default();
    append(&err);
    if cancel.load(Ordering::Relaxed) {
        cleanup(true);
        return Err(MediaError::Cancelled);
    }
    if !status.success() {
        cleanup(true);
        return Err(MediaError::failed("export", &err));
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
}
