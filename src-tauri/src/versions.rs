//! Project versions.
//!
//! Every save also keeps a copy of the saved document in the app data folder
//! (`versions/<project id>/<saved at ms>.kerf`), pruned to the newest N.
//! Unlike `<name>.kerf.bak` (only the previous save) this lets the user go
//! back several saves without cluttering the project folder.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub file: PathBuf,
    pub saved_at: i64,
    pub size: u64,
}

fn folder(root: &Path, project: Uuid) -> PathBuf {
    root.join(project.to_string())
}

/// Copies the just-saved `saved` file into the version folder and prunes
/// versions beyond `keep` (0 disables versions and removes existing ones).
/// Saving an unchanged document does not add a duplicate version.
pub fn record(root: &Path, project: Uuid, saved: &Path, saved_at: i64, keep: usize) -> std::io::Result<()> {
    let dir = folder(root, project);
    if keep > 0 {
        let bytes = fs::read(saved)?;
        let newest = list(root, project).into_iter().next();
        if newest.and_then(|v| fs::read(v.file).ok()).is_none_or(|old| old != bytes) {
            fs::create_dir_all(&dir)?;
            fs::write(dir.join(format!("{saved_at}.kerf")), bytes)?;
        }
    }
    for old in list(root, project).into_iter().skip(keep) {
        let _ = fs::remove_file(old.file);
    }
    Ok(())
}

/// Versions of a project, newest first.
pub fn list(root: &Path, project: Uuid) -> Vec<VersionInfo> {
    let Ok(entries) = fs::read_dir(folder(root, project)) else { return Vec::new() };
    let mut out: Vec<VersionInfo> = entries
        .flatten()
        .filter_map(|e| {
            let file = e.path();
            if file.extension().is_none_or(|x| x != "kerf") {
                return None;
            }
            let saved_at = file.file_stem()?.to_str()?.parse().ok()?;
            Some(VersionInfo { size: e.metadata().ok()?.len(), file, saved_at })
        })
        .collect();
    out.sort_by_key(|v| std::cmp::Reverse(v.saved_at));
    out
}

/// Resolves a version file the frontend asked for; only files listed for
/// `project` are accepted (no arbitrary paths).
pub fn find(root: &Path, project: Uuid, file: &Path) -> Option<PathBuf> {
    list(root, project).into_iter().map(|v| v.file).find(|f| f == file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_newest_versions() {
        let root = std::env::temp_dir().join(format!("kerf-versions-{}", Uuid::new_v4()));
        let id = Uuid::new_v4();
        let saved = root.join("p.kerf");
        fs::create_dir_all(&root).unwrap();
        for t in 1..=5 {
            fs::write(&saved, format!("v{t}")).unwrap();
            record(&root, id, &saved, t, 3).unwrap();
        }
        record(&root, id, &saved, 9, 3).unwrap();
        let l = list(&root, id);
        assert_eq!(l.iter().map(|v| v.saved_at).collect::<Vec<_>>(), vec![5, 4, 3]);
        assert_eq!(fs::read_to_string(&l[0].file).unwrap(), "v5");
        assert!(find(&root, id, &l[2].file).is_some());
        assert!(find(&root, id, &saved).is_none(), "only listed version files resolve");
        assert!(find(&root, Uuid::new_v4(), &l[0].file).is_none());

        record(&root, id, &saved, 6, 0).unwrap();
        assert!(list(&root, id).is_empty(), "keep = 0 removes all versions");
        let _ = fs::remove_dir_all(root);
    }
}
