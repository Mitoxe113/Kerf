//! Font discovery: system fonts (read only) and fonts the user imported into
//! Kerf's own font folder. Kerf never installs fonts system-wide; imported
//! fonts are only loaded by Kerf's webview.
//!
//! License fields come from the font file itself: the OS/2 embedding
//! permissions (`fsType`) and the name table's license description and URL.
//! They are what the file states, not a legal assessment.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use skrifa::raw::tables::os2::SelectionFlags;
use skrifa::raw::{FileRef, FontRef, TableProvider};
use skrifa::{MetadataProvider, string::StringId};

use crate::{invalid, Result};

pub const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "ttc", "otc"];
/// Formats that can be imported (loadable by the webview's @font-face).
pub const IMPORT_EXTENSIONS: &[&str] = &["ttf", "otf"];
/// Largest font file read (big CJK collections are around 60 MB).
const MAX_FONT: u64 = 128 << 20;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontAxis {
    pub tag: String,
    pub min: f32,
    pub default: f32,
    pub max: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFace {
    /// Typographic family (name ID 16, else 1).
    pub family: String,
    /// Typographic subfamily (name ID 17, else 2), e.g. "Bold Italic".
    pub style: String,
    pub full_name: String,
    pub weight: u16,
    pub italic: bool,
    pub variable: bool,
    pub axes: Vec<FontAxis>,
    pub path: String,
    /// Face index inside a collection.
    pub index: u32,
    /// "system" or "imported".
    pub source: String,
    /// OS/2 fsType: "installable", "restricted", "previewAndPrint", "editable", or "" when absent.
    pub embedding: String,
    pub license: String,
    pub license_url: String,
    pub designer: String,
    pub vendor_url: String,
}

fn name(face: &FontRef, ids: &[u16]) -> String {
    for id in ids {
        // Prefer the English (US) Windows name, then any decodable one.
        let mut any = None;
        for n in face.localized_strings(StringId::new(*id)) {
            let s = n.to_string();
            if s.is_empty() {
                // Encodings read-fonts cannot decode yield no characters.
                continue;
            }
            if n.language() == Some("en-US") {
                return clean(&s, 2000);
            }
            any.get_or_insert(s);
        }
        if let Some(s) = any {
            return clean(&s, 2000);
        }
    }
    String::new()
}

/// OS/2 fsType as embedding permission. Up to version 2 several bits may be
/// set and the most permissive applies; from version 3 they are exclusive.
fn embedding(os2: &skrifa::raw::tables::os2::Os2) -> &'static str {
    let n = os2.fs_type();
    if os2.version() <= 2 {
        if n & 0xF == 0 {
            "installable"
        } else if n & 8 != 0 {
            "editable"
        } else if n & 4 != 0 {
            "previewAndPrint"
        } else {
            "restricted"
        }
    } else {
        match n & 0xF {
            0 => "installable",
            2 => "restricted",
            4 => "previewAndPrint",
            8 => "editable",
            _ => "",
        }
    }
}

fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n').take(max).collect::<String>().trim().to_string()
}

/// Faces of one font file (all faces of a collection).
pub fn read_faces(path: &Path, source: &str) -> Result<Vec<FontFace>> {
    let meta = std::fs::metadata(path).map_err(|e| invalid(format!("font: {e}")))?;
    if meta.len() > MAX_FONT {
        return Err(invalid("font file too large"));
    }
    let data = std::fs::read(path).map_err(|e| invalid(format!("font: {e}")))?;
    faces_of(&data, path, source)
}

pub fn faces_of(data: &[u8], path: &Path, source: &str) -> Result<Vec<FontFace>> {
    // With their index in the collection (the webview and FFmpeg address faces by it).
    let fonts: Vec<(u32, FontRef)> = match FileRef::new(data) {
        Ok(FileRef::Font(f)) => vec![(0, f)],
        Ok(FileRef::Collection(c)) => (0..c.len().min(64)).filter_map(|i| c.get(i).ok().map(|f| (i, f))).collect(),
        Err(_) => Vec::new(),
    };
    let mut out = Vec::new();
    for (index, face) in &fonts {
        // The tables every usable font has (also what a renderer needs first).
        if face.head().is_err() || face.hhea().is_err() || face.maxp().is_err() {
            continue;
        }
        let family = name(face, &[16, 1]);
        if family.is_empty() {
            continue;
        }
        let os2 = face.os2().ok();
        let italic_bit = os2.as_ref().is_some_and(|t| t.fs_selection().contains(SelectionFlags::ITALIC));
        // A face can have a normal style and a non-zero italic angle, which also makes it italic.
        let italic_angle = face.post().map(|p| p.italic_angle().to_f32()).unwrap_or(0.0);
        let axes = face.fvar().ok().and_then(|f| f.axes().ok()).unwrap_or(&[]);
        out.push(FontFace {
            style: name(face, &[17, 2]),
            full_name: name(face, &[4]),
            weight: os2.as_ref().map_or(400, |t| t.us_weight_class()),
            italic: italic_bit || italic_angle != 0.0,
            variable: !axes.is_empty(),
            axes: axes
                .iter()
                .map(|a| FontAxis {
                    tag: a.axis_tag().to_string(),
                    min: a.min_value().to_f32(),
                    default: a.default_value().to_f32(),
                    max: a.max_value().to_f32(),
                })
                .collect(),
            path: path.to_string_lossy().into_owned(),
            index: *index,
            source: source.into(),
            embedding: os2.as_ref().map_or("", embedding).into(),
            license: name(face, &[13]),
            license_url: name(face, &[14]),
            designer: name(face, &[9]),
            vendor_url: name(face, &[11]),
            family,
        });
    }
    if out.is_empty() {
        return Err(invalid("not a readable font"));
    }
    Ok(out)
}

/// Font folders of the operating system and the user (only those that exist).
pub fn system_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    if cfg!(windows) {
        if let Some(w) = std::env::var_os("WINDIR") {
            dirs.push(PathBuf::from(w).join("Fonts"));
        }
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(l).join("Microsoft").join("Windows").join("Fonts"));
        }
    } else if cfg!(target_os = "macos") {
        dirs.extend(["/System/Library/Fonts", "/Library/Fonts"].map(PathBuf::from));
        if let Some(h) = &home {
            dirs.push(h.join("Library/Fonts"));
        }
    } else {
        dirs.extend(["/usr/share/fonts", "/usr/local/share/fonts"].map(PathBuf::from));
        if let Some(h) = &home {
            dirs.push(h.join(".local/share/fonts"));
            dirs.push(h.join(".fonts"));
        }
    }
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

fn is_font(p: &Path) -> bool {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).is_some_and(|e| FONT_EXTENSIONS.contains(&e.as_str()))
}

/// Every readable face under `dirs` (recursively, at most `limit` files);
/// unreadable files are skipped.
pub fn scan(dirs: &[PathBuf], source: &str, limit: usize) -> Vec<FontFace> {
    let mut files = Vec::new();
    let mut stack: Vec<(PathBuf, u32)> = dirs.iter().map(|d| (d.clone(), 0)).collect();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() && depth < 6 {
                stack.push((p, depth + 1));
            } else if ft.is_file() && is_font(&p) && files.len() < limit {
                files.push(p);
            }
        }
    }
    files.sort();
    let mut out: Vec<FontFace> = files.iter().filter_map(|f| read_faces(f, source).ok()).flatten().collect();
    out.sort_by(|a, b| a.family.to_lowercase().cmp(&b.family.to_lowercase()).then(a.weight.cmp(&b.weight)).then(a.italic.cmp(&b.italic)));
    out
}

/// Copies a font into Kerf's font folder (named by content, so importing
/// twice keeps one copy) after checking that it parses. Returns its faces.
pub fn import(src: &Path, dir: &Path) -> Result<Vec<FontFace>> {
    // Collections (.ttc/.otc) are listed from the system but cannot be loaded
    // by the webview's @font-face, so importing them would only look like it worked.
    let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !IMPORT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(invalid("only .ttf and .otf fonts can be imported (font collections .ttc/.otc are not supported)"));
    }
    let meta = std::fs::metadata(src).map_err(|e| invalid(format!("font: {e}")))?;
    if meta.len() > MAX_FONT {
        return Err(invalid("font file too large"));
    }
    let data = std::fs::read(src).map_err(|e| invalid(format!("font: {e}")))?;
    let hash = hex(&Sha256::digest(&data)[..8]);
    let stem: String = src
        .file_stem()
        .map(|s| s.to_string_lossy().chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).take(60).collect())
        .unwrap_or_default();
    let dest = dir.join(format!("{hash}-{stem}.{ext}"));
    // Parse before writing: a broken file never lands in the folder.
    let faces = faces_of(&data, &dest, "imported")?;
    std::fs::create_dir_all(dir).map_err(|e| invalid(format!("font folder: {e}")))?;
    if !dest.exists() {
        let tmp = dest.with_extension("part");
        std::fs::write(&tmp, &data).map_err(|e| invalid(format!("font: {e}")))?;
        std::fs::rename(&tmp, &dest).map_err(|e| invalid(format!("font: {e}")))?;
    }
    Ok(faces)
}

/// Removes an imported font file (only files inside `dir`).
pub fn remove(path: &Path, dir: &Path) -> Result<()> {
    let (Ok(p), Ok(d)) = (path.canonicalize(), dir.canonicalize()) else { return Err(crate::LibraryError::NotFound) };
    if p.parent() != Some(d.as_path()) || !is_font(&p) {
        return Err(invalid("only imported fonts can be removed"));
    }
    std::fs::remove_file(&p).map_err(|e| invalid(format!("font: {e}")))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A font from the system folders, if this machine has one.
    fn any_system_font() -> Option<PathBuf> {
        let faces = scan(&system_dirs(), "system", 50);
        faces.iter().map(|f| PathBuf::from(&f.path)).find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("ttf") || e.eq_ignore_ascii_case("otf")))
    }

    #[test]
    fn rejects_non_fonts() {
        let dir = std::env::temp_dir().join(format!("kerf-fonts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("evil.ttf");
        std::fs::write(&fake, b"MZ not a font").unwrap();
        assert!(import(&fake, &dir.join("store")).is_err());
        assert!(!dir.join("store").exists(), "nothing written for a broken file");
        let ttc = dir.join("c.ttc");
        std::fs::write(&ttc, b"ttcf").unwrap();
        assert!(import(&ttc, &dir.join("store")).is_err(), "collections are not importable");
        let exe = dir.join("x.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert!(import(&exe, &dir.join("store")).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn imports_and_removes_a_real_font() {
        let Some(src) = any_system_font() else {
            eprintln!("no system font found; skipped");
            return;
        };
        let dir = std::env::temp_dir().join(format!("kerf-fonts-{}", uuid::Uuid::new_v4()));
        let faces = import(&src, &dir).unwrap();
        assert!(!faces[0].family.is_empty());
        assert_eq!(faces[0].source, "imported");
        let again = import(&src, &dir).unwrap();
        assert_eq!(faces[0].path, again[0].path, "same content, same file");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let listed = scan(std::slice::from_ref(&dir), "imported", 10);
        assert_eq!(listed.len(), faces.len());
        // Only files inside the folder can be removed.
        assert!(remove(&src, &dir).is_err());
        remove(Path::new(&faces[0].path), &dir).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).ok();
    }
}
