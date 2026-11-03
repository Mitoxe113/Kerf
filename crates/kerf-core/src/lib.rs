//! Kerf core engine.
//!
//! Everything that defines *what* a project is and *how* it may change lives
//! here, independent of any UI or media backend:
//!
//! * [`time`]    – frame/rational arithmetic and SMPTE timecode
//! * [`model`]   – the serialisable project data model
//! * [`ops`]     – the editing engine (every timeline mutation is an [`ops::EditCommand`])
//! * [`history`] – undo/redo
//! * [`io`]      – project file loading/saving with atomic writes and migration

pub mod archive;
pub mod assist;
pub mod audio;
pub mod error;
pub mod fx;
pub mod history;
pub mod io;
pub mod model;
pub mod ops;
pub mod text;
pub mod time;
pub mod timemap;

pub use error::{EditError, Result};
