//! Noise reduction (FFmpeg `afftdn`) as a cached rendering of a media file's
//! sound.
//!
//! The denoised sound is rendered once per media file and setting into the
//! media's cache folder, as 32-bit float WAV that starts at the file's time 0
//! (sound that starts later is padded with silence). The preview plays that
//! file instead of the original's sound and the export reads it in place of
//! the original, so both hear exactly the same samples, also at the start of
//! a clip, where a filter run on the clip alone would still be settling.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use kerf_core::model::Denoise;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::analysis::{cache_dir, fnv1a};
use crate::tools::{path_arg, run};
use crate::{MediaError, Tools};

/// Bumped when the rendering below changes, so old cache files are not reused.
const VERSION: u32 = 1;

/// A number as the filter gets it (shortest decimal of the stored f32).
fn n(v: f32) -> String {
    format!("{v}")
}

/// The `afftdn` filter for `d`.
pub fn afftdn(d: &Denoise) -> String {
    let mut f = format!("afftdn=nr={}:nf={}:tn={}", n(d.reduction_db), n(d.floor_db), u8::from(d.track));
    if !d.profile.is_empty() {
        let bands: Vec<String> = d.profile.iter().map(|v| n(*v)).collect();
        f.push_str(&format!(":nt=custom:bn='{}'", bands.join("|")));
    }
    f
}

/// Cache file of the sound of `src` with `d` applied.
pub fn cache_path(cache_root: &Path, src: &Path, d: &Denoise) -> PathBuf {
    let key = format!("v{VERSION}|{}", afftdn(d));
    cache_dir(cache_root, src).join(format!("denoise_{:016x}.wav", fnv1a(key.as_bytes())))
}

/// One cache file an export needs before it can start.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DenoiseJob {
    pub src: PathBuf,
    pub out: PathBuf,
    pub filter: String,
    /// Length of the media in seconds (for the progress).
    pub duration: f64,
}

impl DenoiseJob {
    pub fn new(cache_root: &Path, src: &Path, d: &Denoise, duration: f64) -> Self {
        Self { src: src.to_path_buf(), out: cache_path(cache_root, src, d), filter: afftdn(d), duration }
    }

    /// FFmpeg arguments rendering the cache file into `partial` (without the program's own options).
    pub fn args(&self, partial: &Path) -> Vec<OsString> {
        let mut a: Vec<OsString> = vec!["-i".into(), self.src.clone().into_os_string()];
        // first_pts=0 pads sound that starts after the file's start, so that
        // time t of the cache file is time t of the media, as `-ss` reads both.
        let af = format!("{},aresample=first_pts=0", self.filter);
        for s in ["-map", "0:a:0", "-af", &af, "-c:a", "pcm_f32le", "-rf64", "auto", "-f", "wav", "-y"] {
            a.push(s.into());
        }
        a.push(partial.as_os_str().to_owned());
        a
    }

    /// A unique temporary name next to the cache file.
    pub fn partial(&self) -> PathBuf {
        self.out.with_file_name(format!("partial_{}.wav", Uuid::new_v4()))
    }
}

/// Renders the cache file of `job` unless it exists; returns its path.
pub fn render(tools: &Tools, job: &DenoiseJob) -> Result<PathBuf, MediaError> {
    if job.out.is_file() {
        return Ok(job.out.clone());
    }
    if let Some(dir) = job.out.parent() {
        fs::create_dir_all(dir)?;
    }
    let partial = job.partial();
    let mut cmd = tools.ffmpeg_cmd();
    cmd.args(job.args(&partial));
    let res = run(cmd, "noise reduction");
    if let Err(e) = res {
        let _ = fs::remove_file(&partial);
        return Err(e);
    }
    fs::rename(&partial, &job.out)?;
    Ok(job.out.clone())
}

/// Shortest part a noise profile is learned from.
pub const MIN_PROFILE_S: f64 = 0.25;

/// Learns the shape of the noise in seconds `from..to` of the sound of `src`
/// (a part with noise only): `afftdn` samples the part and reports the band
/// levels it found, which [`Denoise::profile`] then passes back as `bn`.
pub fn learn_profile(tools: &Tools, src: &Path, from: f64, to: f64) -> Result<Vec<f32>, MediaError> {
    let len = to - from;
    if !len.is_finite() || len < MIN_PROFILE_S {
        return Err(MediaError::Unsupported("the part is too short to learn the noise from".into()));
    }
    let mut cmd = tools.ffmpeg_cmd();
    // The band levels are printed at the info level.
    cmd.args(["-loglevel", "info", "-ss", &format!("{:.6}", from.max(0.0)), "-t", &format!("{len:.6}"), "-i"]).arg(path_arg(src));
    // Sampling stops on the first padded (silent) frame after the part.
    let af = format!("apad=pad_dur=1,asendcmd=c='0 afftdn sn start; {len:.6} afftdn sn stop',afftdn");
    cmd.args(["-map", "0:a:0", "-af", &af, "-f", "null", "-"]);
    let out = run(cmd, "noise profile")?;
    parse_profile(&String::from_utf8_lossy(&out.stderr)).ok_or_else(|| MediaError::Unsupported("FFmpeg reported no noise profile".into()))
}

/// The band levels of the last `bn=` line `afftdn` logged.
fn parse_profile(log: &str) -> Option<Vec<f32>> {
    let line = log.lines().rev().find_map(|l| l.split_once("bn=").map(|(_, rest)| rest))?;
    let bands: Vec<f32> = line.split_whitespace().map(|v| v.parse::<f32>()).collect::<Result<_, _>>().ok()?;
    (bands.len() == kerf_core::audio::DENOISE_BANDS && bands.iter().all(|v| v.is_finite())).then_some(bands)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_and_cache_name_follow_the_setting() {
        let mut d = Denoise::default();
        assert_eq!(afftdn(&d), "afftdn=nr=12:nf=-50:tn=0");
        d.track = true;
        d.profile = (0..15).map(|i| i as f32 - 7.5).collect();
        let f = afftdn(&d);
        assert!(f.starts_with("afftdn=nr=12:nf=-50:tn=1:nt=custom:bn='-7.5|-6.5|"), "{f}");
        let root = Path::new("/cache");
        let src = Path::new("/media/a.wav");
        let a = cache_path(root, src, &d);
        d.reduction_db = 20.0;
        assert_ne!(a, cache_path(root, src, &d), "another setting is another file");
        assert!(a.file_name().unwrap().to_string_lossy().starts_with("denoise_"));
        let args: Vec<String> = DenoiseJob::new(root, src, &d, 1.0).args(Path::new("p.wav")).iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert!(args.iter().any(|a| a.ends_with(",aresample=first_pts=0")), "{args:?}");
    }

    #[test]
    fn profile_is_read_from_the_log() {
        // As FFmpeg 6.1 logs it after `sn stop`.
        let log = "[Parsed_asendcmd_0 @ 0x1] Processing command #0 target:afftdn command:sn arg:stop\n[afftdn @ 0x55d669ea0740] bn=14.274211 11.463749 9.083121 7.002098 5.111484 3.323124 1.569899 -0.194270 -1.994427 -3.834576 -5.697684 -7.545681 -9.319457 -10.938867 -12.302725 \n";
        let p = parse_profile(log).unwrap();
        assert_eq!(p.len(), 15);
        assert_eq!(p[0], 14.274211);
        assert_eq!(p[14], -12.302725);
        assert_eq!(parse_profile("bn=1 2 3"), None);
        assert_eq!(parse_profile("nothing"), None);
    }
}
