//! Kerf media engine.
//!
//! FFmpeg is used as an external process (not linked), which keeps the build
//! simple, isolates codec crashes from the editor and lets users swap in an
//! LGPL or hardware-enabled build without recompiling.
//!
//! * [`tools`]    – locating and invoking ffmpeg/ffprobe
//! * [`probe`]    – stream analysis into [`kerf_core::model::MediaInfo`]
//! * [`analysis`] – posters, filmstrips, waveform peaks, proxies (cached)
//! * [`render`]   – the export renderer (timeline -> ffmpeg filter graph)

pub mod analysis;
pub mod detect;
pub mod error;
#[cfg(test)]
mod exprtest;
pub mod fx;
pub mod probe;
pub mod render;
pub mod tools;

pub use error::MediaError;
pub use tools::Tools;
