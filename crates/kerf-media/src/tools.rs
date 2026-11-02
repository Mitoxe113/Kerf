use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use crate::MediaError;

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

    /// Encoders that actually work on this machine (a 1-frame test encode
    /// each), so the export dialog never offers a codec that cannot run.
    pub fn working_hw_encoders(&self) -> Vec<String> {
        const CANDIDATES: [&str; 6] = ["h264_nvenc", "hevc_nvenc", "h264_qsv", "hevc_qsv", "h264_amf", "hevc_amf"];
        CANDIDATES
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
