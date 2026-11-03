//! Kerf's local library: user presets, favourites and recently used items,
//! kept in one SQLite file in the app data directory.
//!
//! The schema is versioned with `PRAGMA user_version`; every migration runs
//! once, in order, inside a transaction. Data written by a newer Kerf (a
//! higher version than [`SCHEMA_VERSION`]) is refused instead of guessed at.

use std::path::Path;

use kerf_core::model::{Effect, EffectKind, Transition};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod assets;
pub mod fonts;

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("invalid: {0}")]
    Invalid(String),
    #[error("not found")]
    NotFound,
    #[error("the library was written by a newer Kerf (schema {0})")]
    TooNew(i64),
}

pub type Result<T> = std::result::Result<T, LibraryError>;

fn invalid(m: impl Into<String>) -> LibraryError {
    LibraryError::Invalid(m.into())
}

/// Migrations, index = version - 1.
const MIGRATIONS: &[&str] = &[
    // 1: presets, favourites, recents.
    "CREATE TABLE presets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        favorite INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX presets_kind ON presets(kind, name);
    CREATE TABLE favorites (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
    );
    CREATE TABLE recents (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
    );",
    // 2: downloaded and imported assets (see assets.rs).
    assets::MIGRATION,
];

pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

/// Preset kinds and what their `data` holds.
pub const PRESET_KINDS: &[&str] = &[
    // A whole effect stack: JSON array of `Effect`.
    "effects",
    // A transition with its settings: JSON `Transition`.
    "transition",
    // A text style: JSON `TextStyle`.
    "textStyle",
    // A title layout (text, style, position, animation): JSON `TitleSpec`.
    "titleTemplate",
];

/// Item kinds that can be favourites or recents.
pub const ITEM_KINDS: &[&str] = &["effect", "preset", "transition", "font", "template", "asset"];

const MAX_DATA: usize = 256 * 1024;
const MAX_RECENTS: i64 = 30;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub favorite: bool,
    /// Kind-specific JSON (see [`PRESET_KINDS`]).
    pub data: serde_json::Value,
    #[serde(default = "one")]
    pub version: i64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

fn one() -> i64 {
    1
}

/// The file format of an exported preset collection.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetFile {
    pub app: String,
    pub kind: String,
    pub version: i64,
    pub presets: Vec<Preset>,
}

pub struct Library {
    conn: Connection,
}

/// Single-line text without control characters, at most `max` characters.
pub fn clean_text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

/// Validates and normalises a preset's data for its kind.
pub fn validate_data(kind: &str, data: &serde_json::Value) -> Result<serde_json::Value> {
    if serde_json::to_vec(data).map(|v| v.len()).unwrap_or(usize::MAX) > MAX_DATA {
        return Err(invalid("preset too large"));
    }
    match kind {
        "effects" => {
            let effects: Vec<Effect> = serde_json::from_value(data.clone()).map_err(|e| invalid(format!("effects: {e}")))?;
            if effects.is_empty() || effects.len() > 64 {
                return Err(invalid("an effect preset holds 1 to 64 effects"));
            }
            let mut clean = Vec::with_capacity(effects.len());
            for e in effects {
                let kind: EffectKind = e.kind.sanitized().ok_or_else(|| invalid("effect parameter"))?;
                // Unknown catalogue ids would silently do nothing: refuse them.
                if let EffectKind::Fx { fx, .. } = &kind {
                    if kerf_core::fx::def(fx).is_none() {
                        return Err(invalid(format!("unknown effect {fx}")));
                    }
                }
                clean.push(Effect { id: Uuid::new_v4(), enabled: e.enabled, name: clean_text(&e.name, 80), kind });
            }
            Ok(serde_json::to_value(clean).expect("effects serialize"))
        }
        "transition" => {
            let t: Transition = serde_json::from_value(data.clone()).map_err(|e| invalid(format!("transition: {e}")))?;
            Ok(serde_json::to_value(t).expect("transition serializes"))
        }
        "textStyle" => {
            let t: kerf_core::text::TextStyle = serde_json::from_value(data.clone()).map_err(|e| invalid(format!("text style: {e}")))?;
            let t = t.sanitized().ok_or_else(|| invalid("text style"))?;
            Ok(serde_json::to_value(t).expect("text style serializes"))
        }
        "titleTemplate" => {
            let t: kerf_core::text::TitleSpec = serde_json::from_value(data.clone()).map_err(|e| invalid(format!("title template: {e}")))?;
            let t = t.sanitized().ok_or_else(|| invalid("title template"))?;
            Ok(serde_json::to_value(t).expect("title serializes"))
        }
        _ => Err(invalid(format!("unknown preset kind {kind}"))),
    }
}

fn check_item_kind(kind: &str) -> Result<()> {
    if ITEM_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(invalid(format!("unknown item kind {kind}")))
    }
}

fn check_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_control) {
        return Err(invalid("key"));
    }
    Ok(())
}

impl Library {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let have: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if have > SCHEMA_VERSION {
            return Err(LibraryError::TooNew(have));
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(have as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
        }
        Ok(Self { conn })
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    // ---- presets ----

    pub fn presets(&self, kind: Option<&str>) -> Result<Vec<Preset>> {
        let mut st = self.conn.prepare(
            "SELECT id, kind, name, category, favorite, data, version, created_at, updated_at FROM presets
             WHERE ?1 IS NULL OR kind = ?1 ORDER BY favorite DESC, name COLLATE NOCASE",
        )?;
        let rows = st.query_map(params![kind], row_preset)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn preset(&self, id: &str) -> Result<Preset> {
        self.conn
            .query_row(
                "SELECT id, kind, name, category, favorite, data, version, created_at, updated_at FROM presets WHERE id = ?1",
                params![id],
                row_preset,
            )
            .optional()?
            .ok_or(LibraryError::NotFound)
    }

    /// Inserts a new preset (empty `id`) or replaces an existing one.
    pub fn save_preset(&self, p: &Preset, now: i64) -> Result<Preset> {
        self.store_preset(p, now, false)
    }

    fn store_preset(&self, p: &Preset, now: i64, keep_new_id: bool) -> Result<Preset> {
        if !PRESET_KINDS.contains(&p.kind.as_str()) {
            return Err(invalid(format!("unknown preset kind {}", p.kind)));
        }
        let name = clean_text(&p.name, 80);
        if name.is_empty() {
            return Err(invalid("name"));
        }
        let data = validate_data(&p.kind, &p.data)?;
        let category = clean_text(&p.category, 40);
        let (id, created) = if p.id.is_empty() {
            (Uuid::new_v4().to_string(), now)
        } else {
            match self.preset(&p.id) {
                Ok(old) if old.kind != p.kind => return Err(invalid("a preset keeps its kind")),
                Ok(old) => (old.id, old.created_at),
                Err(LibraryError::NotFound) if keep_new_id => (p.id.clone(), now),
                Err(e) => return Err(e),
            }
        };
        self.conn.execute(
            "INSERT INTO presets (id, kind, name, category, favorite, data, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET name = ?3, category = ?4, favorite = ?5, data = ?6, updated_at = ?8",
            params![id, p.kind, name, category, p.favorite, data.to_string(), created, now],
        )?;
        self.preset(&id)
    }

    pub fn rename_preset(&self, id: &str, name: &str, now: i64) -> Result<Preset> {
        let name = clean_text(name, 80);
        if name.is_empty() {
            return Err(invalid("name"));
        }
        if self.conn.execute("UPDATE presets SET name = ?2, updated_at = ?3 WHERE id = ?1", params![id, name, now])? == 0 {
            return Err(LibraryError::NotFound);
        }
        self.preset(id)
    }

    pub fn set_preset_favorite(&self, id: &str, on: bool) -> Result<()> {
        if self.conn.execute("UPDATE presets SET favorite = ?2 WHERE id = ?1", params![id, on])? == 0 {
            return Err(LibraryError::NotFound);
        }
        Ok(())
    }

    pub fn delete_preset(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM presets WHERE id = ?1", params![id])?;
        self.conn.execute("DELETE FROM favorites WHERE kind = 'preset' AND key = ?1", params![id])?;
        self.conn.execute("DELETE FROM recents WHERE kind = 'preset' AND key = ?1", params![id])?;
        Ok(())
    }

    /// Serialises presets for sharing (ids kept so a re-import updates
    /// instead of duplicating).
    pub fn export_presets(&self, ids: &[String]) -> Result<String> {
        let mut presets = Vec::with_capacity(ids.len());
        for id in ids {
            presets.push(self.preset(id)?);
        }
        let file = PresetFile { app: "kerf".into(), kind: "presets".into(), version: 1, presets };
        Ok(serde_json::to_string_pretty(&file).expect("presets serialize"))
    }

    /// Imports a preset file. Every preset is validated; an invalid one
    /// fails the whole import. Returns the imported presets.
    pub fn import_presets(&self, text: &str, now: i64) -> Result<Vec<Preset>> {
        let file: PresetFile = serde_json::from_str(text).map_err(|e| invalid(format!("preset file: {e}")))?;
        if file.app != "kerf" || file.kind != "presets" {
            return Err(invalid("not a Kerf preset file"));
        }
        if file.version > 1 {
            return Err(invalid("preset file from a newer Kerf"));
        }
        if file.presets.len() > 1000 {
            return Err(invalid("too many presets"));
        }
        for p in &file.presets {
            if !PRESET_KINDS.contains(&p.kind.as_str()) {
                return Err(invalid(format!("unknown preset kind {}", p.kind)));
            }
            validate_data(&p.kind, &p.data)?;
        }
        let mut out = Vec::with_capacity(file.presets.len());
        for p in file.presets {
            // An id from another machine may collide with a preset of a
            // different kind; such a preset is imported as a new one.
            let keep = Uuid::parse_str(&p.id).is_ok()
                && match self.preset(&p.id) {
                    Ok(o) => o.kind == p.kind,
                    Err(LibraryError::NotFound) => true,
                    Err(e) => return Err(e),
                };
            let id = if keep { p.id.clone() } else { String::new() };
            let saved = self.store_preset(&Preset { id, ..p.clone() }, now, true)?;
            out.push(saved);
        }
        Ok(out)
    }

    // ---- favourites and recents ----

    pub fn favorites(&self, kind: &str) -> Result<Vec<String>> {
        check_item_kind(kind)?;
        let mut st = self.conn.prepare("SELECT key FROM favorites WHERE kind = ?1 ORDER BY added_at DESC")?;
        let rows = st.query_map(params![kind], |r| r.get(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn set_favorite(&self, kind: &str, key: &str, on: bool, now: i64) -> Result<()> {
        check_item_kind(kind)?;
        check_key(key)?;
        if on {
            self.conn.execute("INSERT OR IGNORE INTO favorites (kind, key, added_at) VALUES (?1, ?2, ?3)", params![kind, key, now])?;
        } else {
            self.conn.execute("DELETE FROM favorites WHERE kind = ?1 AND key = ?2", params![kind, key])?;
        }
        Ok(())
    }

    pub fn recents(&self, kind: &str) -> Result<Vec<String>> {
        check_item_kind(kind)?;
        let mut st = self.conn.prepare("SELECT key FROM recents WHERE kind = ?1 ORDER BY used_at DESC LIMIT ?2")?;
        let rows = st.query_map(params![kind, MAX_RECENTS], |r| r.get(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn touch_recent(&self, kind: &str, key: &str, now: i64) -> Result<()> {
        check_item_kind(kind)?;
        check_key(key)?;
        self.conn.execute(
            "INSERT INTO recents (kind, key, used_at) VALUES (?1, ?2, ?3) ON CONFLICT(kind, key) DO UPDATE SET used_at = MAX(used_at + 1, ?3)",
            params![kind, key, now],
        )?;
        self.conn.execute(
            "DELETE FROM recents WHERE kind = ?1 AND key NOT IN (SELECT key FROM recents WHERE kind = ?1 ORDER BY used_at DESC LIMIT ?2)",
            params![kind, MAX_RECENTS],
        )?;
        Ok(())
    }
}

fn row_preset(r: &rusqlite::Row) -> rusqlite::Result<Preset> {
    let data: String = r.get(5)?;
    Ok(Preset {
        id: r.get(0)?,
        kind: r.get(1)?,
        name: r.get(2)?,
        category: r.get(3)?,
        favorite: r.get(4)?,
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
        version: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fx_preset(name: &str) -> Preset {
        Preset {
            id: String::new(),
            kind: "effects".into(),
            name: name.into(),
            category: "Look".into(),
            favorite: false,
            data: json!([{ "id": Uuid::new_v4(), "type": "fx", "fx": "sepia", "params": { "amount": 0.8 } }]),
            version: 1,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn migrates_and_reopens() {
        let dir = std::env::temp_dir().join(format!("kerf-lib-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.db");
        {
            let lib = Library::open(&path).unwrap();
            lib.save_preset(&fx_preset("Alt"), 1).unwrap();
        }
        let lib = Library::open(&path).unwrap();
        assert_eq!(lib.presets(None).unwrap().len(), 1);
        let v: i64 = lib.conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        drop(lib);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_newer_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        assert!(matches!(Library::init(conn), Err(LibraryError::TooNew(99))));
    }

    #[test]
    fn preset_roundtrip_rename_delete() {
        let lib = Library::open_in_memory().unwrap();
        let p = lib.save_preset(&fx_preset("  Warm\u{7}look "), 10).unwrap();
        assert_eq!(p.name, "Warmlook");
        assert_eq!(p.created_at, 10);
        let r = lib.rename_preset(&p.id, "Neu", 20).unwrap();
        assert_eq!((r.name.as_str(), r.created_at, r.updated_at), ("Neu", 10, 20));
        lib.set_preset_favorite(&p.id, true).unwrap();
        assert!(lib.preset(&p.id).unwrap().favorite);
        lib.delete_preset(&p.id).unwrap();
        assert!(matches!(lib.preset(&p.id), Err(LibraryError::NotFound)));
    }

    #[test]
    fn effect_data_is_sanitized_and_checked() {
        let lib = Library::open_in_memory().unwrap();
        let mut p = fx_preset("x");
        p.data = json!([{ "id": Uuid::new_v4(), "type": "fx", "fx": "sepia", "params": { "amount": 9, "bogus": 1 } }]);
        let s = lib.save_preset(&p, 0).unwrap();
        assert_eq!(s.data[0]["params"], json!({ "amount": 1.0 }));
        p.data = json!([{ "id": Uuid::new_v4(), "type": "fx", "fx": "doesNotExist", "params": {} }]);
        assert!(lib.save_preset(&p, 0).is_err());
        p.data = json!([]);
        assert!(lib.save_preset(&p, 0).is_err());
        p.kind = "script".into();
        assert!(lib.save_preset(&p, 0).is_err());
    }

    #[test]
    fn title_templates_are_validated() {
        let lib = Library::open_in_memory().unwrap();
        let mut p = fx_preset("Bauchbinde");
        p.kind = "titleTemplate".into();
        p.data = json!({ "text": "Name\u{7}", "style": { "size": 9999, "font": "Inter Variable" }, "x": 0.1, "y": 0.8, "width": 1920, "height": 1080 });
        let s = lib.save_preset(&p, 0).unwrap();
        assert_eq!(s.data["text"], json!("Name"));
        assert!(s.data["style"]["size"].as_f64().unwrap() <= 1000.0);
        p.data = json!({ "text": "x", "width": 0, "height": 1080 });
        assert!(lib.save_preset(&p, 0).is_err(), "invalid frame size");
        p.kind = "textStyle".into();
        p.data = json!("not a style");
        assert!(lib.save_preset(&p, 0).is_err());
    }

    #[test]
    fn export_import() {
        let a = Library::open_in_memory().unwrap();
        let p = a.save_preset(&fx_preset("Teilen"), 5).unwrap();
        let text = a.export_presets(std::slice::from_ref(&p.id)).unwrap();
        let b = Library::open_in_memory().unwrap();
        let got = b.import_presets(&text, 6).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "Teilen");
        // Importing again updates instead of duplicating.
        b.import_presets(&text, 7).unwrap();
        assert_eq!(b.presets(Some("effects")).unwrap().len(), 1);
        assert!(b.import_presets(r#"{"app":"other","kind":"presets","version":1,"presets":[]}"#, 0).is_err());
    }

    #[test]
    fn favorites_and_recents() {
        let lib = Library::open_in_memory().unwrap();
        lib.set_favorite("effect", "fx:glow", true, 1).unwrap();
        lib.set_favorite("effect", "fx:glow", true, 2).unwrap();
        assert_eq!(lib.favorites("effect").unwrap(), vec!["fx:glow"]);
        lib.set_favorite("effect", "fx:glow", false, 3).unwrap();
        assert!(lib.favorites("effect").unwrap().is_empty());
        assert!(lib.set_favorite("nope", "x", true, 1).is_err());
        for i in 0..40 {
            lib.touch_recent("effect", &format!("k{i}"), i).unwrap();
        }
        lib.touch_recent("effect", "k0", 5).unwrap();
        let r = lib.recents("effect").unwrap();
        assert_eq!(r.len(), MAX_RECENTS as usize);
        assert_eq!(r[0], "k39");
    }
}
