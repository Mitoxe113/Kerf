//! License data per provider. Creative Commons codes follow Openverse's own
//! grouping (api/constants/licenses.py): a license allows commercial use
//! when its code has no "nc", modification when it has no "nd".
//! Nothing here is legal advice; it restates what the provider declares.

use crate::License;

fn yes_no(b: bool) -> String {
    if b { "yes" } else { "no" }.into()
}

/// A Creative Commons license or public-domain mark by its code ("by-sa", "cc0", "pdm", …).
pub fn creative_commons(code: &str, version: &str, url: &str) -> License {
    let code = code.trim().to_lowercase();
    let known = matches!(code.as_str(), "cc0" | "pdm" | "by" | "by-sa" | "by-nd" | "by-nc" | "by-nc-sa" | "by-nc-nd");
    if !known {
        // Deprecated sampling licenses and anything unrecognised.
        return License {
            code: code.clone(),
            name: if code.is_empty() { "Unbekannte Lizenz".into() } else { format!("Lizenz „{code}“") },
            url: url.into(),
            commercial: "unknown".into(),
            modification: "unknown".into(),
            attribution_required: true,
            attribution: String::new(),
            notes: "Lizenz nicht eindeutig zuordenbar: vor jeder Verwendung die Lizenzseite prüfen.".into(),
        };
    }
    let public = code == "cc0" || code == "pdm";
    let name = match code.as_str() {
        "cc0" => "CC0 1.0 (Public Domain Dedication)".to_string(),
        "pdm" => "Public Domain Mark".to_string(),
        c => format!("CC {}{}", c.to_uppercase(), if version.is_empty() { String::new() } else { format!(" {version}") }),
    };
    let commercial = !code.contains("nc");
    let modification = !code.contains("nd");
    let mut notes = Vec::new();
    if !commercial {
        notes.push("Nicht kommerziell (NC): keine kommerzielle Nutzung.");
    }
    if !modification {
        notes.push("Keine Bearbeitungen (ND): Schnitt, Effekte oder Ausschnitte können eine Bearbeitung sein.");
    }
    if code.contains("sa") {
        notes.push("Weitergabe unter gleichen Bedingungen (SA).");
    }
    if code == "pdm" {
        notes.push("Kennzeichnung als gemeinfrei durch die Quelle, keine Lizenz.");
    }
    License {
        code,
        name,
        url: url.into(),
        commercial: yes_no(commercial),
        modification: yes_no(modification),
        attribution_required: !public,
        attribution: String::new(),
        notes: notes.join(" "),
    }
}

/// Freesound states licenses as Creative Commons URLs.
pub fn from_cc_url(url: &str) -> License {
    let u = url.to_lowercase();
    let version = u.split('/').rev().find(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit())).unwrap_or("").to_string();
    let code = if u.contains("publicdomain/zero") {
        "cc0".to_string()
    } else if u.contains("publicdomain/mark") {
        "pdm".to_string()
    } else if u.contains("sampling") {
        if u.contains("nc-sampling") { "nc-sampling+" } else { "sampling+" }.to_string()
    } else if let Some(rest) = u.split("/licenses/").nth(1) {
        rest.split('/').next().unwrap_or("").to_string()
    } else {
        String::new()
    };
    creative_commons(&code, &version, url)
}

/// Pexels states one license for all its photos and videos. Its terms are on
/// pexels.com/license; Kerf shows them but cannot check the content of an
/// individual picture (people, brands, artworks).
pub fn pexels() -> License {
    License {
        code: "pexels".into(),
        name: "Pexels-Lizenz".into(),
        url: "https://www.pexels.com/license/".into(),
        commercial: "yes".into(),
        modification: "yes".into(),
        attribution_required: false,
        attribution: String::new(),
        notes: "Laut Pexels-Lizenz frei nutzbar, Namensnennung erwünscht, nicht verpflichtend. Einschränkungen der Lizenz (u. a. erkennbare Personen, Marken, unveränderter Weiterverkauf) gelten weiter; die Lizenzseite ist maßgeblich."
            .into(),
    }
}

/// GIPHY content belongs to its creators or third parties; access through the
/// API is not a license for commercial use.
pub fn giphy() -> License {
    License {
        code: "giphy".into(),
        name: "GIPHY-Nutzungsbedingungen".into(),
        url: "https://giphy.com/terms".into(),
        commercial: "unknown".into(),
        modification: "unknown".into(),
        attribution_required: true,
        attribution: String::new(),
        notes: "GIFs können urheberrechtlich geschützte Inhalte Dritter zeigen (Filme, Serien, Personen). API-Zugang ist keine Erlaubnis zur kommerziellen Nutzung. Quelle „Powered By GIPHY“ angeben."
            .into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cc_codes() {
        let l = creative_commons("by-nc-nd", "4.0", "u");
        assert_eq!((l.commercial.as_str(), l.modification.as_str(), l.attribution_required), ("no", "no", true));
        assert_eq!(l.name, "CC BY-NC-ND 4.0");
        let l = creative_commons("cc0", "1.0", "u");
        assert_eq!((l.commercial.as_str(), l.attribution_required), ("yes", false));
        let l = creative_commons("by-sa", "", "u");
        assert_eq!((l.commercial.as_str(), l.modification.as_str()), ("yes", "yes"));
        assert_eq!(creative_commons("sampling+", "", "").commercial, "unknown");
        assert_eq!(creative_commons("whatever", "", "").commercial, "unknown");
    }

    #[test]
    fn freesound_urls() {
        assert_eq!(from_cc_url("http://creativecommons.org/publicdomain/zero/1.0/").code, "cc0");
        let l = from_cc_url("https://creativecommons.org/licenses/by-nc/4.0/");
        assert_eq!((l.code.as_str(), l.commercial.as_str(), l.name.as_str()), ("by-nc", "no", "CC BY-NC 4.0"));
        assert_eq!(from_cc_url("http://creativecommons.org/licenses/by/3.0/").commercial, "yes");
        assert_eq!(from_cc_url("http://creativecommons.org/licenses/sampling+/1.0/").commercial, "unknown");
        assert_eq!(from_cc_url("").commercial, "unknown");
    }
}
