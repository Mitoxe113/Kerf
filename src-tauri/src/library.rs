//! Commands for the local library (presets, favourites, recents).

use kerf_library::{Library, LibraryError, Preset};
use tauri::State;

use crate::commands::{CmdResult, CommandError};
use crate::state::{lock, now_ms, AppState};

impl From<LibraryError> for CommandError {
    fn from(e: LibraryError) -> Self {
        let code = match &e {
            LibraryError::NotFound => "notFound",
            LibraryError::Invalid(_) => "invalid",
            LibraryError::Db(_) | LibraryError::TooNew(_) => "libraryFailed",
        };
        CommandError::new(code, e)
    }
}

pub(crate) fn with<T>(state: &AppState, f: impl FnOnce(&Library) -> kerf_library::Result<T>) -> CmdResult<T> {
    let guard = lock(&state.library);
    let lib = guard.as_ref().ok_or_else(|| CommandError::new("libraryFailed", "the library database could not be opened"))?;
    Ok(f(lib)?)
}

#[tauri::command]
pub fn preset_list(state: State<AppState>, kind: Option<String>) -> CmdResult<Vec<Preset>> {
    with(&state, |l| l.presets(kind.as_deref()))
}

#[tauri::command]
pub fn preset_save(state: State<AppState>, preset: Preset) -> CmdResult<Preset> {
    with(&state, |l| l.save_preset(&preset, now_ms()))
}

#[tauri::command]
pub fn preset_rename(state: State<AppState>, id: String, name: String) -> CmdResult<Preset> {
    with(&state, |l| l.rename_preset(&id, &name, now_ms()))
}

#[tauri::command]
pub fn preset_favorite(state: State<AppState>, id: String, on: bool) -> CmdResult<()> {
    with(&state, |l| l.set_preset_favorite(&id, on))
}

#[tauri::command]
pub fn preset_delete(state: State<AppState>, id: String) -> CmdResult<()> {
    with(&state, |l| l.delete_preset(&id))
}

/// Writes the given presets to a `.kerfpreset` file chosen by the user.
#[tauri::command(async)]
pub fn preset_export(state: State<AppState>, ids: Vec<String>, path: String) -> CmdResult<()> {
    let p = preset_path(&path)?;
    let text = with(&state, |l| l.export_presets(&ids))?;
    kerf_core::io::write_atomic(&p, text.as_bytes(), false).map_err(|e| CommandError::new("ioFailed", e))
}

#[tauri::command(async)]
pub fn preset_import(state: State<AppState>, path: String) -> CmdResult<Vec<Preset>> {
    let p = preset_path(&path)?;
    let len = std::fs::metadata(&p).map_err(|e| CommandError::new("ioFailed", e))?.len();
    if len > 8 << 20 {
        return Err(CommandError::new("ioFailed", "file too large"));
    }
    let text = std::fs::read_to_string(&p).map_err(|e| CommandError::new("ioFailed", e))?;
    with(&state, |l| l.import_presets(&text, now_ms()))
}

fn preset_path(path: &str) -> CmdResult<std::path::PathBuf> {
    let p = std::path::PathBuf::from(path);
    if p.extension().is_none_or(|e| e != "kerfpreset") {
        return Err(CommandError::new("ioFailed", "preset files end in .kerfpreset"));
    }
    Ok(p)
}

#[tauri::command]
pub fn favorite_list(state: State<AppState>, kind: String) -> CmdResult<Vec<String>> {
    with(&state, |l| l.favorites(&kind))
}

#[tauri::command]
pub fn favorite_set(state: State<AppState>, kind: String, key: String, on: bool) -> CmdResult<()> {
    with(&state, |l| l.set_favorite(&kind, &key, on, now_ms()))
}

#[tauri::command]
pub fn recent_list(state: State<AppState>, kind: String) -> CmdResult<Vec<String>> {
    with(&state, |l| l.recents(&kind))
}

#[tauri::command]
pub fn recent_touch(state: State<AppState>, kind: String, key: String) -> CmdResult<()> {
    with(&state, |l| l.touch_recent(&kind, &key, now_ms()))
}
