//! Where Kerf keeps its cache of derived media and how large it may grow.
//! The folder is read once at startup (the webview may only load files from
//! the folder it was given then); a new choice applies from the next start.
//! The limit applies at once: unused entries go, least recently written first.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// Stored next to the library database in the app's data folder.
pub const FILE: &str = "cache.json";
/// The smallest limit the preferences accept (smaller would evict the
/// proxies of a single long clip).
pub const MIN_LIMIT: u64 = 1 << 30;

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CacheConfig {
    /// Folder chosen by the user; `None` uses the app's cache folder.
    pub root: Option<PathBuf>,
    /// Size above which unused entries are deleted; `None` keeps everything.
    pub limit_bytes: Option<u64>,
}

/// The stored settings; defaults when the file is missing or unreadable.
pub fn load(file: &Path) -> CacheConfig {
    match fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            log::warn!("cache settings {} unreadable, using defaults: {e}", file.display());
            CacheConfig::default()
        }),
        Err(_) => CacheConfig::default(),
    }
}

/// Writes the settings through a temporary file, so a crash never leaves half a file.
pub fn save(file: &Path, config: &CacheConfig) -> io::Result<()> {
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(config).map_err(io::Error::other)?)?;
    fs::rename(&tmp, file)
}

/// A folder the cache can live in: absolute, created if needed, writable.
pub fn check_root(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err(format!("{} is not an absolute path", dir.display()));
    }
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let probe = dir.join(".kerf-write-test");
    fs::write(&probe, b"").map_err(|e| format!("{} is not writable: {e}", dir.display()))?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// The cache folder to use at startup: the configured one when it is
/// usable, otherwise `default` (logged, so a missing drive does not stop Kerf).
pub fn resolve(config: &CacheConfig, default: &Path) -> PathBuf {
    match &config.root {
        Some(dir) => match check_root(dir) {
            Ok(()) => dir.clone(),
            Err(e) => {
                log::warn!("cache folder unusable, using {}: {e}", default.display());
                default.to_path_buf()
            }
        },
        None => default.to_path_buf(),
    }
}

/// One cache entry (the folder of one source file).
#[derive(Debug, Clone)]
pub struct Entry {
    pub path: PathBuf,
    pub bytes: u64,
    /// When a file in it was last written.
    pub newest: SystemTime,
}

/// Entries to delete so the cache fits under `limit`: never one in `keep`,
/// the least recently written first, and no more than needed.
pub fn over_limit(mut entries: Vec<Entry>, keep: &HashSet<PathBuf>, limit: u64) -> Vec<PathBuf> {
    let mut total: u64 = entries.iter().map(|e| e.bytes).sum();
    entries.sort_by(|a, b| a.newest.cmp(&b.newest).then_with(|| a.path.cmp(&b.path)));
    let mut out = Vec::new();
    for e in entries {
        if total <= limit {
            break;
        }
        if keep.contains(&e.path) {
            continue;
        }
        total -= e.bytes;
        out.push(e.path);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn entry(name: &str, bytes: u64, age_secs: u64) -> Entry {
        Entry { path: PathBuf::from(name), bytes, newest: SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000 - age_secs) }
    }

    #[test]
    fn oldest_unused_entries_go_until_the_cache_fits() {
        let entries = vec![entry("a", 40, 10), entry("b", 30, 300), entry("c", 20, 200), entry("d", 50, 400)];
        let keep: HashSet<PathBuf> = [PathBuf::from("d")].into();
        // 140 in all; d is the oldest but kept, b (30) and c (20) bring it to 90.
        assert_eq!(over_limit(entries.clone(), &keep, 100), vec![PathBuf::from("b"), PathBuf::from("c")]);
        assert!(over_limit(entries.clone(), &keep, 140).is_empty());
        // Below what the kept entries need: everything else goes, the kept stays.
        assert_eq!(over_limit(entries, &keep, 10).len(), 3);
    }

    #[test]
    fn settings_round_trip_and_unusable_folders_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE);
        assert_eq!(load(&file), CacheConfig::default());
        let c = CacheConfig { root: Some(dir.path().join("Cache")), limit_bytes: Some(5 << 30) };
        save(&file, &c).unwrap();
        assert_eq!(load(&file), c);
        fs::write(&file, b"{ not json").unwrap();
        assert_eq!(load(&file), CacheConfig::default());

        let default = dir.path().join("default");
        assert_eq!(resolve(&c, &default), dir.path().join("Cache"));
        assert!(dir.path().join("Cache").is_dir());
        assert!(check_root(Path::new("relative/cache")).is_err());
        // A file where the folder should be.
        fs::write(dir.path().join("blocked"), b"x").unwrap();
        let blocked = CacheConfig { root: Some(dir.path().join("blocked")), limit_bytes: None };
        assert_eq!(resolve(&blocked, &default), default);
    }
}
