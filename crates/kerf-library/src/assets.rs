//! Downloaded and imported creative assets with their license data.
//!
//! An asset is identified by `(provider, provider_id)` and, once a file is
//! on disk, by its SHA-256. The license fields store what the provider's API
//! said; `commercial` is `"yes"` only when the provider's license explicitly
//! allows commercial use, `"no"` when it forbids it, and `"unknown"`
//! otherwise. Kerf never upgrades `"unknown"` on its own.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{clean_text, invalid, Library, LibraryError, Result};

pub(crate) const MIGRATION: &str = "CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        creator TEXT NOT NULL DEFAULT '',
        creator_url TEXT NOT NULL DEFAULT '',
        page_url TEXT NOT NULL DEFAULT '',
        license_code TEXT NOT NULL DEFAULT '',
        license_name TEXT NOT NULL DEFAULT '',
        license_url TEXT NOT NULL DEFAULT '',
        commercial TEXT NOT NULL DEFAULT 'unknown',
        attribution_required INTEGER NOT NULL DEFAULT 1,
        attribution TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        mime TEXT NOT NULL DEFAULT '',
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        favorite INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        UNIQUE (provider, provider_id)
    );
    CREATE INDEX assets_sha ON assets(sha256);
    CREATE INDEX assets_kind ON assets(kind, added_at);
    CREATE TABLE collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE collection_items (
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        PRIMARY KEY (collection_id, asset_id)
    );";

pub const ASSET_KINDS: &[&str] = &["photo", "video", "audio", "music", "sfx", "gif", "sticker", "graphic", "font", "lut", "template"];
pub const COMMERCIAL: &[&str] = &["yes", "no", "unknown"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssetRecord {
    pub id: String,
    pub provider: String,
    pub provider_id: String,
    pub kind: String,
    pub title: String,
    pub creator: String,
    pub creator_url: String,
    pub page_url: String,
    pub license_code: String,
    pub license_name: String,
    pub license_url: String,
    pub commercial: String,
    pub attribution_required: bool,
    pub attribution: String,
    pub file_path: String,
    pub sha256: String,
    pub size: i64,
    pub mime: String,
    pub width: i64,
    pub height: i64,
    pub duration_ms: i64,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub added_at: i64,
    /// Not stored: whether `file_path` exists right now.
    pub missing: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub count: i64,
}

const COLS: &str = "id, provider, provider_id, kind, title, creator, creator_url, page_url, license_code, license_name, license_url,
    commercial, attribution_required, attribution, file_path, sha256, size, mime, width, height, duration_ms, tags, favorite, added_at";

fn row_asset(r: &rusqlite::Row) -> rusqlite::Result<AssetRecord> {
    let tags: String = r.get(21)?;
    let file_path: String = r.get(14)?;
    Ok(AssetRecord {
        id: r.get(0)?,
        provider: r.get(1)?,
        provider_id: r.get(2)?,
        kind: r.get(3)?,
        title: r.get(4)?,
        creator: r.get(5)?,
        creator_url: r.get(6)?,
        page_url: r.get(7)?,
        license_code: r.get(8)?,
        license_name: r.get(9)?,
        license_url: r.get(10)?,
        commercial: r.get(11)?,
        attribution_required: r.get(12)?,
        attribution: r.get(13)?,
        missing: !file_path.is_empty() && !std::path::Path::new(&file_path).exists(),
        file_path,
        sha256: r.get(15)?,
        size: r.get(16)?,
        mime: r.get(17)?,
        width: r.get(18)?,
        height: r.get(19)?,
        duration_ms: r.get(20)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        favorite: r.get(22)?,
        added_at: r.get(23)?,
    })
}

/// Filters for [`Library::assets`].
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssetQuery {
    pub kind: Option<String>,
    pub provider: Option<String>,
    pub text: Option<String>,
    pub favorites: bool,
    /// Only assets whose license explicitly allows commercial use.
    pub commercial_only: bool,
    pub collection: Option<String>,
    pub limit: Option<i64>,
}

impl Library {
    /// Inserts or updates an asset (matched by provider and provider id).
    pub fn upsert_asset(&self, a: &AssetRecord, now: i64) -> Result<AssetRecord> {
        if !ASSET_KINDS.contains(&a.kind.as_str()) {
            return Err(invalid(format!("unknown asset kind {}", a.kind)));
        }
        if !COMMERCIAL.contains(&a.commercial.as_str()) {
            return Err(invalid("commercial must be yes, no or unknown"));
        }
        let provider = clean_text(&a.provider, 40);
        let pid = clean_text(&a.provider_id, 200);
        if provider.is_empty() || pid.is_empty() {
            return Err(invalid("provider and provider id are required"));
        }
        let existing: Option<String> =
            self.conn().query_row("SELECT id FROM assets WHERE provider = ?1 AND provider_id = ?2", params![provider, pid], |r| r.get(0)).optional()?;
        let id = existing.unwrap_or_else(|| if a.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { a.id.clone() });
        let tags: Vec<String> = a.tags.iter().take(40).map(|t| clean_text(t, 40)).filter(|t| !t.is_empty()).collect();
        self.conn().execute(
            &format!(
                "INSERT INTO assets ({COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)
                 ON CONFLICT(id) DO UPDATE SET kind=?4, title=?5, creator=?6, creator_url=?7, page_url=?8, license_code=?9, license_name=?10,
                 license_url=?11, commercial=?12, attribution_required=?13, attribution=?14, file_path=?15, sha256=?16, size=?17, mime=?18,
                 width=?19, height=?20, duration_ms=?21, tags=?22"
            ),
            params![
                id,
                provider,
                pid,
                a.kind,
                clean_text(&a.title, 300),
                clean_text(&a.creator, 200),
                clean_text(&a.creator_url, 1000),
                clean_text(&a.page_url, 1000),
                clean_text(&a.license_code, 40),
                clean_text(&a.license_name, 200),
                clean_text(&a.license_url, 1000),
                a.commercial,
                a.attribution_required,
                clean_text(&a.attribution, 1000),
                a.file_path,
                a.sha256,
                a.size,
                clean_text(&a.mime, 100),
                a.width,
                a.height,
                a.duration_ms,
                serde_json::to_string(&tags).expect("tags serialize"),
                a.favorite,
                now,
            ],
        )?;
        self.asset(&id)
    }

    pub fn asset(&self, id: &str) -> Result<AssetRecord> {
        self.conn()
            .query_row(&format!("SELECT {COLS} FROM assets WHERE id = ?1"), params![id], row_asset)
            .optional()?
            .ok_or(LibraryError::NotFound)
    }

    pub fn asset_by_provider(&self, provider: &str, provider_id: &str) -> Result<Option<AssetRecord>> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT {COLS} FROM assets WHERE provider = ?1 AND provider_id = ?2"), params![provider, provider_id], row_asset)
            .optional()?)
    }

    /// An asset already on disk with the same content.
    pub fn asset_by_hash(&self, sha256: &str) -> Result<Option<AssetRecord>> {
        if sha256.is_empty() {
            return Ok(None);
        }
        Ok(self
            .conn()
            .query_row(&format!("SELECT {COLS} FROM assets WHERE sha256 = ?1 AND file_path != '' LIMIT 1"), params![sha256], row_asset)
            .optional()?)
    }

    pub fn assets(&self, q: &AssetQuery) -> Result<Vec<AssetRecord>> {
        let text = q.text.as_deref().map(|t| format!("%{}%", t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
        let mut st = self.conn().prepare(&format!(
            "SELECT {COLS} FROM assets a WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR provider = ?2)
             AND (?3 IS NULL OR title LIKE ?3 ESCAPE '\\' OR creator LIKE ?3 ESCAPE '\\' OR tags LIKE ?3 ESCAPE '\\')
             AND (?4 = 0 OR favorite = 1) AND (?5 = 0 OR commercial = 'yes')
             AND (?6 IS NULL OR EXISTS (SELECT 1 FROM collection_items c WHERE c.asset_id = a.id AND c.collection_id = ?6))
             ORDER BY added_at DESC LIMIT ?7"
        ))?;
        let rows = st.query_map(params![q.kind, q.provider, text, q.favorites, q.commercial_only, q.collection, q.limit.unwrap_or(500).clamp(1, 5000)], row_asset)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn set_asset_favorite(&self, id: &str, on: bool) -> Result<()> {
        if self.conn().execute("UPDATE assets SET favorite = ?2 WHERE id = ?1", params![id, on])? == 0 {
            return Err(LibraryError::NotFound);
        }
        Ok(())
    }

    /// Points an asset at a (relinked) file.
    pub fn set_asset_file(&self, id: &str, path: &str, sha256: &str, size: i64) -> Result<()> {
        if self.conn().execute("UPDATE assets SET file_path = ?2, sha256 = ?3, size = ?4 WHERE id = ?1", params![id, path, sha256, size])? == 0 {
            return Err(LibraryError::NotFound);
        }
        Ok(())
    }

    /// Removes the record; the caller decides about the file.
    pub fn delete_asset(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM assets WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn collections(&self) -> Result<Vec<Collection>> {
        let mut st = self.conn().prepare(
            "SELECT c.id, c.name, c.created_at, (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id)
             FROM collections c ORDER BY c.name COLLATE NOCASE",
        )?;
        let rows = st.query_map([], |r| Ok(Collection { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, count: r.get(3)? }))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn create_collection(&self, name: &str, now: i64) -> Result<Collection> {
        let name = clean_text(name, 80);
        if name.is_empty() {
            return Err(invalid("name"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.conn().execute("INSERT INTO collections (id, name, created_at) VALUES (?1, ?2, ?3)", params![id, name, now])?;
        Ok(Collection { id, name, created_at: now, count: 0 })
    }

    pub fn delete_collection(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM collections WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_in_collection(&self, collection: &str, asset: &str, on: bool) -> Result<()> {
        if on {
            self.conn().execute("INSERT OR IGNORE INTO collection_items (collection_id, asset_id) VALUES (?1, ?2)", params![collection, asset])?;
        } else {
            self.conn().execute("DELETE FROM collection_items WHERE collection_id = ?1 AND asset_id = ?2", params![collection, asset])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(pid: &str) -> AssetRecord {
        AssetRecord {
            provider: "pexels".into(),
            provider_id: pid.into(),
            kind: "photo".into(),
            title: "Berg 100%".into(),
            commercial: "yes".into(),
            sha256: format!("h{pid}"),
            file_path: "/nonexistent/kerf/file.jpg".into(),
            ..Default::default()
        }
    }

    #[test]
    fn upsert_dedupes_by_provider_id() {
        let lib = Library::open_in_memory().unwrap();
        let a = lib.upsert_asset(&rec("1"), 1).unwrap();
        let b = lib.upsert_asset(&AssetRecord { title: "Neu".into(), ..rec("1") }, 2).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(b.title, "Neu");
        assert_eq!(b.added_at, 1);
        assert!(b.missing);
        assert_eq!(lib.asset_by_hash("h1").unwrap().unwrap().id, a.id);
    }

    #[test]
    fn query_filters() {
        let lib = Library::open_in_memory().unwrap();
        lib.upsert_asset(&rec("1"), 1).unwrap();
        lib.upsert_asset(&AssetRecord { commercial: "unknown".into(), title: "See".into(), ..rec("2") }, 2).unwrap();
        assert_eq!(lib.assets(&AssetQuery::default()).unwrap().len(), 2);
        assert_eq!(lib.assets(&AssetQuery { commercial_only: true, ..Default::default() }).unwrap().len(), 1);
        // LIKE wildcards in the search text are literal.
        assert_eq!(lib.assets(&AssetQuery { text: Some("100%".into()), ..Default::default() }).unwrap().len(), 1);
        assert_eq!(lib.assets(&AssetQuery { text: Some("_".into()), ..Default::default() }).unwrap().len(), 0);
    }

    #[test]
    fn rejects_unknown_license_state() {
        let lib = Library::open_in_memory().unwrap();
        assert!(lib.upsert_asset(&AssetRecord { commercial: "probably".into(), ..rec("1") }, 1).is_err());
        assert!(lib.upsert_asset(&AssetRecord { kind: "exe".into(), ..rec("1") }, 1).is_err());
    }

    #[test]
    fn collections() {
        let lib = Library::open_in_memory().unwrap();
        let a = lib.upsert_asset(&rec("1"), 1).unwrap();
        let c = lib.create_collection("Intro", 1).unwrap();
        lib.set_in_collection(&c.id, &a.id, true).unwrap();
        assert_eq!(lib.collections().unwrap()[0].count, 1);
        assert_eq!(lib.assets(&AssetQuery { collection: Some(c.id.clone()), ..Default::default() }).unwrap().len(), 1);
        lib.delete_asset(&a.id).unwrap();
        assert_eq!(lib.collections().unwrap()[0].count, 0);
    }
}
