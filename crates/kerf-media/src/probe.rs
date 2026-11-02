//! ffprobe -> [`MediaInfo`].

use std::path::Path;

use kerf_core::model::{AudioInfo, ColorTags, MediaInfo, MediaKind, VideoInfo};
use kerf_core::time::Rational;
use serde::Deserialize;

use crate::tools::{path_arg, run};
use crate::{MediaError, Tools};

pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp", "gif"];
pub const VIDEO_EXTENSIONS: &[&str] =
    &["mp4", "mov", "m4v", "mkv", "webm", "avi", "mxf", "mts", "m2ts", "ts", "mpg", "mpeg", "wmv", "flv", "3gp"];
pub const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "aac", "m4a", "flac", "ogg", "opus", "aif", "aiff", "wma"];

/// True if the extension looks like importable media.
pub fn is_media_path(path: &Path) -> bool {
    let ext = extension(path);
    IMAGE_EXTENSIONS.contains(&ext.as_str()) || VIDEO_EXTENSIONS.contains(&ext.as_str()) || AUDIO_EXTENSIONS.contains(&ext.as_str())
}

pub(crate) fn extension(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

#[derive(Deserialize)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    pix_fmt: Option<String>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
    bit_rate: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    color_space: Option<String>,
    color_range: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    #[serde(default)]
    disposition: Disposition,
    #[serde(default)]
    tags: Tags,
    #[serde(default)]
    side_data_list: Vec<SideData>,
}

#[derive(Deserialize, Default)]
struct Disposition {
    #[serde(default)]
    attached_pic: u8,
}

#[derive(Deserialize, Default)]
struct Tags {
    rotate: Option<String>,
}

#[derive(Deserialize)]
struct SideData {
    rotation: Option<f64>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    format_name: Option<String>,
    duration: Option<String>,
    size: Option<String>,
    bit_rate: Option<String>,
}

pub fn probe(tools: &Tools, path: &Path) -> Result<(MediaKind, MediaInfo), MediaError> {
    let mut cmd = tools.ffprobe_cmd();
    cmd.args(["-print_format", "json", "-show_format", "-show_streams"]).arg(path_arg(path));
    let out = run(cmd, "ffprobe")?;
    parse(&out.stdout, path)
}

/// A colour tag, `None` when the file leaves it unspecified.
fn tag(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && !matches!(*v, "unknown" | "unspecified" | "reserved"))
        .map(str::to_string)
}

fn num<T: std::str::FromStr>(s: &Option<String>) -> Option<T> {
    s.as_deref().and_then(|v| v.trim().parse().ok())
}

/// Snaps measured rates (e.g. variable-frame-rate phone footage) to the
/// nearest standard rate when within 0.5 %.
pub fn snap_rate(r: Rational) -> Rational {
    const STANDARD: [Rational; 13] = [
        Rational::new(24000, 1001),
        Rational::new(24, 1),
        Rational::new(25, 1),
        Rational::new(30000, 1001),
        Rational::new(30, 1),
        Rational::new(48000, 1001),
        Rational::new(48, 1),
        Rational::new(50, 1),
        Rational::new(60000, 1001),
        Rational::new(60, 1),
        Rational::new(100, 1),
        Rational::new(120000, 1001),
        Rational::new(120, 1),
    ];
    let f = r.as_f64();
    STANDARD
        .iter()
        .copied()
        .find(|s| ((s.as_f64() - f) / s.as_f64()).abs() < 0.005)
        .unwrap_or(r)
}

pub(crate) fn parse(json: &[u8], path: &Path) -> Result<(MediaKind, MediaInfo), MediaError> {
    let p: ProbeOutput = serde_json::from_slice(json)
        .map_err(|e| MediaError::Failed { what: "ffprobe", detail: e.to_string() })?;
    let format = p.format.as_ref();
    let format_name = format.and_then(|f| f.format_name.clone()).unwrap_or_default();
    let ext = extension(path);
    let is_image_container =
        IMAGE_EXTENSIONS.contains(&ext.as_str()) || format_name.contains("image2") || format_name.ends_with("_pipe");

    let video = p
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video") && s.disposition.attached_pic == 0);
    let audio = p.streams.iter().find(|s| s.codec_type.as_deref() == Some("audio"));

    let video = video.map(|s| {
        let avg = s.avg_frame_rate.as_deref().and_then(Rational::parse);
        let real = s.r_frame_rate.as_deref().and_then(Rational::parse);
        let fps = avg
            .filter(|r| (1.0..=240.0).contains(&r.as_f64()))
            .or(real)
            .map(snap_rate)
            .unwrap_or(Rational::new(25, 1));
        let rotation = s
            .side_data_list
            .iter()
            .find_map(|d| d.rotation)
            .map(|r| -r) // display matrix rotation is counter-clockwise
            .or_else(|| num::<f64>(&s.tags.rotate))
            .unwrap_or(0.0)
            .round() as i32;
        VideoInfo {
            codec: s.codec_name.clone().unwrap_or_default(),
            profile: s.profile.clone(),
            width: s.width.unwrap_or(0),
            height: s.height.unwrap_or(0),
            fps,
            pix_fmt: s.pix_fmt.clone(),
            bit_rate: num(&s.bit_rate),
            rotation: rotation.rem_euclid(360),
            color: ColorTags {
                space: tag(&s.color_space),
                range: tag(&s.color_range),
                transfer: tag(&s.color_transfer),
                primaries: tag(&s.color_primaries),
            },
        }
    });
    let audio = audio.map(|s| AudioInfo {
        codec: s.codec_name.clone().unwrap_or_default(),
        channels: s.channels.unwrap_or(2),
        sample_rate: num(&s.sample_rate).unwrap_or(48_000),
        channel_layout: s.channel_layout.clone(),
        bit_rate: num(&s.bit_rate),
    });

    let kind = match (&video, &audio) {
        (Some(_), _) if is_image_container => MediaKind::Image,
        (Some(_), _) => MediaKind::Video,
        (None, Some(_)) => MediaKind::Audio,
        (None, None) => return Err(MediaError::Unsupported("no audio or video stream".into())),
    };
    if let Some(v) = &video {
        if v.width == 0 || v.height == 0 {
            return Err(MediaError::Unsupported("video stream without dimensions".into()));
        }
    }

    let stream_duration = p.streams.iter().filter_map(|s| num::<f64>(&s.duration)).fold(0.0, f64::max);
    let duration = format.and_then(|f| num::<f64>(&f.duration)).filter(|d| *d > 0.0).unwrap_or(stream_duration);
    if kind != MediaKind::Image && duration <= 0.0 {
        return Err(MediaError::Unsupported("unknown duration".into()));
    }
    let size_bytes = format
        .and_then(|f| num::<u64>(&f.size))
        .or_else(|| std::fs::metadata(path).ok().map(|m| m.len()))
        .unwrap_or(0);

    Ok((
        kind,
        MediaInfo {
            duration: if kind == MediaKind::Image { 0.0 } else { duration },
            size_bytes,
            container: format_name,
            bit_rate: format.and_then(|f| num(&f.bit_rate)),
            video: if kind == MediaKind::Audio { None } else { video },
            audio: if kind == MediaKind::Image { None } else { audio },
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_phone_footage() {
        let json = br#"{
          "streams": [
            {"codec_type":"video","codec_name":"hevc","profile":"Main 10","width":3840,"height":2160,
             "pix_fmt":"yuv420p10le","r_frame_rate":"30/1","avg_frame_rate":"8100000/270271",
             "side_data_list":[{"rotation":-90}]},
            {"codec_type":"audio","codec_name":"aac","sample_rate":"44100","channels":2,"channel_layout":"stereo"}
          ],
          "format": {"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"12.5","size":"1000","bit_rate":"640"}
        }"#;
        let (kind, info) = parse(json, Path::new("IMG_0001.MOV")).unwrap();
        assert_eq!(kind, MediaKind::Video);
        let v = info.video.unwrap();
        assert_eq!(v.fps, Rational::new(30000, 1001));
        assert_eq!(v.rotation, 90);
        assert_eq!(info.audio.unwrap().sample_rate, 44_100);
        assert_eq!(info.duration, 12.5);
    }

    #[test]
    fn cover_art_does_not_make_audio_a_video() {
        let json = br#"{
          "streams": [
            {"codec_type":"audio","codec_name":"mp3","sample_rate":"44100","channels":2},
            {"codec_type":"video","codec_name":"mjpeg","width":500,"height":500,"disposition":{"attached_pic":1}}
          ],
          "format": {"format_name":"mp3","duration":"180.0"}
        }"#;
        let (kind, info) = parse(json, Path::new("song.mp3")).unwrap();
        assert_eq!(kind, MediaKind::Audio);
        assert!(info.video.is_none());
    }

    #[test]
    fn detects_stills() {
        let json = br#"{"streams":[{"codec_type":"video","codec_name":"png","width":800,"height":600}],
                        "format":{"format_name":"png_pipe"}}"#;
        let (kind, info) = parse(json, Path::new("logo.png")).unwrap();
        assert_eq!(kind, MediaKind::Image);
        assert_eq!(info.duration, 0.0);
    }
}
