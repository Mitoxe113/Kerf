use thiserror::Error;

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("FFmpeg was not found. Install FFmpeg or set KERF_FFMPEG_DIR.")]
    ToolMissing,
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{what} failed: {detail}")]
    Failed { what: &'static str, detail: String },
    #[error("unsupported media: {0}")]
    Unsupported(String),
    #[error("cancelled")]
    Cancelled,
}

impl MediaError {
    pub(crate) fn failed(what: &'static str, stderr: &[u8]) -> Self {
        let text = String::from_utf8_lossy(stderr);
        // FFmpeg prints the relevant reason last; keep the message short.
        let detail = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        Self::Failed { what, detail: if detail.is_empty() { "unknown error".into() } else { detail } }
    }
}
