use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use crate::MediaError;

/// Oldest FFmpeg release Kerf works with: the export passes its filter graph
/// with `-/filter_complex`, which FFmpeg 7.0 introduced.
pub const MIN_FFMPEG_MAJOR: u32 = 7;

/// Major release from the first line of `ffmpeg -version`, e.g.
/// "ffmpeg version 6.1.1-3ubuntu5 …" → 6, "ffmpeg version n7.0.2" → 7.
/// `None` for git snapshots ("N-112233-g…") and anything unrecognised.
pub fn ffmpeg_major(version_line: &str) -> Option<u32> {
    let v = version_line.split_whitespace().skip_while(|w| *w != "version").nth(1)?;
    let v = v.strip_prefix('n').unwrap_or(v);
    let digits: String = v.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || !v[digits.len()..].starts_with('.') {
        return None;
    }
    digits.parse().ok()
}

/// Paths of the FFmpeg executables.
#[derive(Clone, Debug)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

impl Tools {
    /// Finds ffmpeg/ffprobe: `KERF_FFMPEG_DIR`, next to the executable, `PATH`,
    /// then common package-manager locations.
    pub fn discover() -> Result<Self, MediaError> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(d) = std::env::var_os("KERF_FFMPEG_DIR") {
            dirs.push(d.into());
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(d) = exe.parent() {
                dirs.push(d.to_path_buf());
                dirs.push(d.join("ffmpeg"));
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        if cfg!(windows) {
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                let local = PathBuf::from(local);
                dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
                // winget portable packages live in versioned folders.
                let pkgs = local.join("Microsoft").join("WinGet").join("Packages");
                if let Ok(entries) = std::fs::read_dir(&pkgs) {
                    for e in entries.flatten() {
                        if e.file_name().to_string_lossy().to_lowercase().contains("ffmpeg") {
                            if let Ok(inner) = std::fs::read_dir(e.path()) {
                                for i in inner.flatten() {
                                    dirs.push(i.path().join("bin"));
                                }
                            }
                        }
                    }
                }
            }
            dirs.push(PathBuf::from(r"C:\ffmpeg\bin"));
        } else {
            dirs.push("/opt/homebrew/bin".into());
            dirs.push("/usr/local/bin".into());
            dirs.push("/usr/bin".into());
        }
        for d in dirs {
            let ffmpeg = d.join(format!("ffmpeg{EXE}"));
            let ffprobe = d.join(format!("ffprobe{EXE}"));
            if ffmpeg.is_file() && ffprobe.is_file() {
                return Ok(Self { ffmpeg, ffprobe });
            }
        }
        Err(MediaError::ToolMissing)
    }

    pub fn ffmpeg_cmd(&self) -> Command {
        let mut c = background_command(&self.ffmpeg);
        c.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
        c
    }

    pub fn ffprobe_cmd(&self) -> Command {
        let mut c = background_command(&self.ffprobe);
        c.args(["-hide_banner", "-loglevel", "error"]);
        c
    }

    /// First line of `ffmpeg -version`.
    pub fn version(&self) -> Result<String, MediaError> {
        let out = background_command(&self.ffmpeg).arg("-version").output()?;
        Ok(String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or_default().to_string())
    }

    /// The version of the installed FFmpeg when it is a release older than
    /// [`MIN_FFMPEG_MAJOR`]. Git snapshots and unparsable versions count as new enough.
    pub fn too_old(&self) -> Option<String> {
        let line = self.version().ok()?;
        let version = line.split_whitespace().skip_while(|w| *w != "version").nth(1)?.to_string();
        (ffmpeg_major(&line)? < MIN_FFMPEG_MAJOR).then_some(version)
    }

    /// Encoders that actually work on this machine (a 1-frame test encode
    /// each), so the export dialog never offers a codec that cannot run.
    pub fn working_hw_encoders(&self) -> Vec<String> {
        self.working_encoders(&["h264_nvenc", "hevc_nvenc", "h264_qsv", "hevc_qsv", "h264_amf", "hevc_amf"])
    }

    /// Those of `candidates` that encode a test frame with this FFmpeg.
    pub fn working_encoders(&self, candidates: &[&str]) -> Vec<String> {
        candidates
            .iter()
            .filter(|enc| {
                self.ffmpeg_cmd()
                    .args(["-f", "lavfi", "-i", "color=c=black:s=256x256:r=25", "-frames:v", "1", "-c:v"])
                    .arg(enc)
                    .args(["-f", "null", "-"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success())
            })
            .map(|s| s.to_string())
            .collect()
    }
}

/// A command that never opens a console window on Windows.
pub fn background_command(exe: impl AsRef<OsStr>) -> Command {
    let mut c = Command::new(exe);
    c.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Runs `cmd` to completion and maps a non-zero exit into [`MediaError::Failed`].
pub(crate) fn run(mut cmd: Command, what: &'static str) -> Result<Output, MediaError> {
    let out = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).output()?;
    if out.status.success() {
        Ok(out)
    } else {
        Err(MediaError::failed(what, &out.stderr))
    }
}

pub(crate) fn path_arg(p: &Path) -> &OsStr {
    p.as_os_str()
}

#[cfg(test)]
mod tests {
    use super::ffmpeg_major;

    #[test]
    fn major_version_from_real_version_lines() {
        assert_eq!(ffmpeg_major("ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers"), Some(6));
        assert_eq!(ffmpeg_major("ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024"), Some(7));
        assert_eq!(ffmpeg_major("ffmpeg version n7.0.2 Copyright (c) 2000-2024"), Some(7));
        assert_eq!(ffmpeg_major("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright"), Some(4));
        // Git snapshots and date builds carry no release number.
        assert_eq!(ffmpeg_major("ffmpeg version N-118000-g1a2b3c4d5e-20241231 Copyright"), None);
        assert_eq!(ffmpeg_major("ffmpeg version 2024-10-10-git-abc Copyright"), None);
        assert_eq!(ffmpeg_major(""), None);
    }
}
