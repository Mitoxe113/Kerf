//! License and attribution reports for the media a project uses.
//!
//! A report lists what Kerf knows: the license data stored when an asset was
//! downloaded, and every project file without such data as "no license data".
//! It is a working list, not a legal clearance.

use kerf_library::assets::AssetRecord;
use serde::Serialize;

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportEntry {
    /// The project file.
    pub file: String,
    /// License data from the library, when the file was downloaded through Kerf.
    pub asset: Option<AssetRecord>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportFormat {
    Txt,
    Csv,
    Html,
    Json,
}

impl ReportFormat {
    pub fn ext(self) -> &'static str {
        match self {
            ReportFormat::Txt => "txt",
            ReportFormat::Csv => "csv",
            ReportFormat::Html => "html",
            ReportFormat::Json => "json",
        }
    }
}

const DISCLAIMER: &str = "Diese Liste gibt die Lizenzangaben der Anbieter zum Zeitpunkt des Downloads wieder. Sie ist keine Rechtsberatung und keine Garantie, dass eine Nutzung erlaubt ist.";

fn commercial_label(c: &str) -> &'static str {
    match c {
        "yes" => "erlaubt (laut Lizenz)",
        "no" => "nicht erlaubt",
        _ => "unbekannt",
    }
}

fn name_of(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Spreadsheet-safe CSV cell (quotes, and no leading formula characters).
fn csv(s: &str) -> String {
    let s = if s.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{s}") } else { s.to_string() };
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// Only http(s) links become anchors.
fn link(url: &str, text: &str) -> String {
    if url.starts_with("https://") || url.starts_with("http://") {
        format!("<a href=\"{}\">{}</a>", html(url), html(text))
    } else {
        html(text)
    }
}

/// Credit lines for assets that need (or offer) attribution, for end credits or a description.
pub fn credits(entries: &[ReportEntry]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in entries {
        if let Some(a) = &e.asset {
            let line = if !a.attribution.is_empty() {
                a.attribution.clone()
            } else {
                let by = if a.creator.is_empty() { String::new() } else { format!(" von {}", a.creator) };
                format!("„{}“{by} ({}), {}", if a.title.is_empty() { name_of(&e.file) } else { &a.title }, a.provider, a.license_name)
            };
            if !out.contains(&line) {
                out.push(line);
            }
        }
    }
    out
}

pub fn render(project: &str, entries: &[ReportEntry], format: ReportFormat, generated: &str) -> String {
    match format {
        ReportFormat::Json => serde_json::to_string_pretty(&serde_json::json!({
            "app": "kerf",
            "kind": "licenseReport",
            "version": 1,
            "project": project,
            "generated": generated,
            "disclaimer": DISCLAIMER,
            "entries": entries,
            "credits": credits(entries),
        }))
        .expect("report serializes"),
        ReportFormat::Csv => {
            let mut s = String::from("Datei,Anbieter,ID,Titel,Urheber,Urheber-URL,Quelle,Lizenz,Lizenz-URL,Kommerziell,Namensnennung nötig,Namensnennung,SHA-256\n");
            for e in entries {
                let row: Vec<String> = match &e.asset {
                    Some(a) => vec![
                        e.file.clone(),
                        a.provider.clone(),
                        a.provider_id.clone(),
                        a.title.clone(),
                        a.creator.clone(),
                        a.creator_url.clone(),
                        a.page_url.clone(),
                        a.license_name.clone(),
                        a.license_url.clone(),
                        commercial_label(&a.commercial).into(),
                        if a.attribution_required { "ja" } else { "nein" }.into(),
                        a.attribution.clone(),
                        a.sha256.clone(),
                    ],
                    None => vec![e.file.clone(), "".into(), "".into(), "".into(), "".into(), "".into(), "".into(), "keine Lizenzdaten".into(), "".into(), "unbekannt".into(), "".into(), "".into(), "".into()],
                };
                s += &row.iter().map(|c| csv(c)).collect::<Vec<_>>().join(",");
                s.push('\n');
            }
            s
        }
        ReportFormat::Txt => {
            let mut s = format!("Lizenz- und Quellenbericht: {project}\nErstellt: {generated}\n\n{DISCLAIMER}\n\n");
            for e in entries {
                s += &format!("• {}\n", name_of(&e.file));
                match &e.asset {
                    Some(a) => {
                        s += &format!("  Anbieter: {} (ID {})\n", a.provider, a.provider_id);
                        if !a.title.is_empty() {
                            s += &format!("  Titel: {}\n", a.title);
                        }
                        if !a.creator.is_empty() {
                            s += &format!("  Urheber: {} {}\n", a.creator, a.creator_url);
                        }
                        if !a.page_url.is_empty() {
                            s += &format!("  Quelle: {}\n", a.page_url);
                        }
                        s += &format!("  Lizenz: {} {}\n  Kommerzielle Nutzung: {}\n", a.license_name, a.license_url, commercial_label(&a.commercial));
                        s += &format!("  Namensnennung nötig: {}\n", if a.attribution_required { "ja" } else { "nein" });
                        if !a.attribution.is_empty() {
                            s += &format!("  Namensnennung: {}\n", a.attribution);
                        }
                    }
                    None => s += "  Keine Lizenzdaten (nicht über Kerf heruntergeladen). Rechte selbst prüfen.\n",
                }
                s.push('\n');
            }
            let c = credits(entries);
            if !c.is_empty() {
                s += "Namensnennungen (für Abspann oder Beschreibung):\n";
                for l in c {
                    s += &format!("{l}\n");
                }
            }
            s
        }
        ReportFormat::Html => {
            let mut rows = String::new();
            for e in entries {
                rows += &match &e.asset {
                    Some(a) => format!(
                        "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td class=\"c-{}\">{}</td><td>{}</td></tr>\n",
                        html(name_of(&e.file)),
                        html(&a.provider),
                        link(&a.page_url, if a.title.is_empty() { &a.provider_id } else { &a.title }),
                        link(&a.creator_url, &a.creator),
                        link(&a.license_url, &a.license_name),
                        html(&a.commercial),
                        commercial_label(&a.commercial),
                        html(&a.attribution)
                    ),
                    None => format!("<tr><td>{}</td><td colspan=\"6\" class=\"c-unknown\">Keine Lizenzdaten (nicht über Kerf heruntergeladen). Rechte selbst prüfen.</td></tr>\n", html(name_of(&e.file))),
                };
            }
            let credits: String = credits(entries).iter().map(|l| format!("<li>{}</li>", html(l))).collect();
            format!(
                "<!doctype html>\n<html lang=\"de\"><head><meta charset=\"utf-8\"><title>Lizenzbericht – {p}</title>\n<style>body{{font:14px system-ui,sans-serif;margin:24px;color:#222}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}}.c-no{{color:#b00}}.c-unknown{{color:#a60}}.c-yes{{color:#070}}</style></head>\n<body><h1>Lizenz- und Quellenbericht: {p}</h1><p>Erstellt: {g}</p><p><em>{d}</em></p>\n<table><thead><tr><th>Datei</th><th>Anbieter</th><th>Titel / Quelle</th><th>Urheber</th><th>Lizenz</th><th>Kommerziell</th><th>Namensnennung</th></tr></thead><tbody>\n{rows}</tbody></table>\n<h2>Namensnennungen</h2><ul>{credits}</ul></body></html>\n",
                p = html(project),
                g = html(generated),
                d = html(DISCLAIMER)
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries() -> Vec<ReportEntry> {
        vec![
            ReportEntry {
                file: "/a/pexels-1.jpg".into(),
                asset: Some(AssetRecord {
                    provider: "pexels".into(),
                    provider_id: "1".into(),
                    title: "=cmd|' /C calc'!A0".into(),
                    creator: "Ann <script>".into(),
                    license_name: "Pexels-Lizenz".into(),
                    commercial: "yes".into(),
                    attribution: "Foto von Ann auf Pexels".into(),
                    page_url: "javascript:alert(1)".into(),
                    ..Default::default()
                }),
            },
            ReportEntry { file: "C:\\clips\\own.mp4".into(), asset: None },
        ]
    }

    #[test]
    fn formats_escape_and_list_unknowns() {
        let e = entries();
        let c = render("P", &e, ReportFormat::Csv, "2026-01-01");
        assert!(c.contains("\"'=cmd"), "formula injection is neutralised: {c}");
        assert!(c.contains("keine Lizenzdaten"));
        let h = render("P", &e, ReportFormat::Html, "2026-01-01");
        assert!(!h.contains("<script>") && h.contains("&lt;script&gt;"));
        assert!(!h.contains("href=\"javascript"), "only http(s) links");
        assert!(h.contains("own.mp4"));
        let t = render("P", &e, ReportFormat::Txt, "2026-01-01");
        assert!(t.contains("Foto von Ann auf Pexels") && t.contains("Rechte selbst prüfen"));
        let j: serde_json::Value = serde_json::from_str(&render("P", &e, ReportFormat::Json, "x")).unwrap();
        assert_eq!(j["entries"].as_array().unwrap().len(), 2);
        assert_eq!(j["credits"][0], "Foto von Ann auf Pexels");
    }
}
