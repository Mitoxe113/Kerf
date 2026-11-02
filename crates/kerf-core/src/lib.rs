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

pub mod error;
pub mod history;
pub mod io;
pub mod model;
pub mod ops;
pub mod text;
pub mod time;

pub use error::{EditError, Result};
