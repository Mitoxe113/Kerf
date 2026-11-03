//! HTTP: provider searches and checked downloads.
//!
//! Every request URL is either built here from a provider's fixed API base or
//! taken from a [`RemoteAsset`] that came out of [`Net::search`]. Redirects
//! are followed by hand (at most five) and every hop is checked against the
//! same rules as the first URL.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use url::Url;

use crate::{invalid, parse, AssetError, Provider, RemoteAsset, Result, SearchKind, SearchPage, SearchRequest, PER_PAGE};

/// Largest API response read.
const MAX_JSON: u64 = 8 << 20;
/// Largest thumbnail read.
const MAX_THUMB: u64 = 4 << 20;
/// Pause between two requests to the same provider.
const MIN_INTERVAL: Duration = Duration::from_millis(300);

pub struct Net {
    client: reqwest::Client,
    /// API base per provider (tests point these at a local mock server).
    bases: HashMap<Provider, String>,
    /// Tests only: allow plain http to 127.0.0.1 (the mock server).
    allow_loopback_http: bool,
    last: Mutex<HashMap<Provider, Instant>>,
}

/// A finished download.
#[derive(Clone, Debug, PartialEq)]
pub struct Downloaded {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
    pub mime: String,
}

fn net_err(e: reqwest::Error) -> AssetError {
    AssetError::Network(e.without_url().to_string())
}

/// Detected file type from the first bytes: (mime, extension, kind group).
pub fn sniff(head: &[u8]) -> Option<(&'static str, &'static str, &'static str)> {
    let h = head;
    let at = |i: usize, m: &[u8]| h.len() >= i + m.len() && &h[i..i + m.len()] == m;
    Some(if at(0, &[0xFF, 0xD8, 0xFF]) {
        ("image/jpeg", "jpg", "image")
    } else if at(0, b"\x89PNG\r\n\x1a\n") {
        ("image/png", "png", "image")
    } else if at(0, b"GIF87a") || at(0, b"GIF89a") {
        ("image/gif", "gif", "image")
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        ("image/webp", "webp", "image")
    } else if at(0, b"II*\0") || at(0, b"MM\0*") {
        ("image/tiff", "tif", "image")
    } else if at(4, b"ftyp") {
        if at(8, b"qt  ") {
            ("video/quicktime", "mov", "video")
        } else if at(8, b"M4A ") {
            ("audio/mp4", "m4a", "audio")
        } else {
            ("video/mp4", "mp4", "video")
        }
    } else if at(0, &[0x1A, 0x45, 0xDF, 0xA3]) {
        ("video/webm", "webm", "video")
    } else if at(0, b"ID3") || (h.len() >= 2 && h[0] == 0xFF && (h[1] & 0xE0) == 0xE0) {
        ("audio/mpeg", "mp3", "audio")
    } else if at(0, b"RIFF") && at(8, b"WAVE") {
        ("audio/wav", "wav", "audio")
    } else if at(0, b"OggS") {
        ("audio/ogg", "ogg", "audio")
    } else if at(0, b"fLaC") {
        ("audio/flac", "flac", "audio")
    } else {
        return None;
    })
}

/// File type groups an asset kind accepts, and its size limit.
fn accepts(kind: &str) -> (&'static [&'static str], u64) {
    match kind {
        "photo" | "graphic" => (&["image"], 200 << 20),
        "video" => (&["video"], 4 << 30),
        // GIPHY: MP4 rendition or the GIF itself.
        "gif" | "sticker" => (&["video", "image"], 500 << 20),
        "audio" | "music" | "sfx" => (&["audio"], 1 << 30),
        _ => (&[], 0),
    }
}

impl Net {
    pub fn new() -> Result<Self> {
        Self::with(HashMap::new(), false)
    }

    /// Tests: API bases on a local mock server, plain http to loopback allowed.
    pub fn for_tests(bases: HashMap<Provider, String>) -> Result<Self> {
        Self::with(bases, true)
    }

    fn with(bases: HashMap<Provider, String>, allow_loopback_http: bool) -> Result<Self> {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::Client::builder()
            .user_agent(concat!("Kerf/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .https_only(!allow_loopback_http)
            .build()
            .map_err(net_err)?;
        Ok(Self { client, bases, allow_loopback_http, last: Mutex::new(HashMap::new()) })
    }

    fn base(&self, p: Provider) -> String {
        self.bases.get(&p).cloned().unwrap_or_else(|| p.api_base().to_string())
    }

    /// Checks a URL a file may be fetched from.
    pub fn check_file_url(&self, provider: Provider, raw: &str) -> Result<Url> {
        let u = Url::parse(raw).map_err(|_| AssetError::Refused("ungültige Adresse".into()))?;
        let host = u.host_str().unwrap_or("").to_lowercase();
        let loopback = host == "127.0.0.1" || host == "localhost";
        if self.allow_loopback_http && loopback && (u.scheme() == "http" || u.scheme() == "https") {
            return Ok(u);
        }
        if u.scheme() != "https" {
            return Err(AssetError::Refused("nur HTTPS".into()));
        }
        // No IP literals or local names: the API returns public host names.
        if loopback || host.is_empty() || matches!(u.host(), Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_))) || !host.contains('.') || host.ends_with(".local") {
            return Err(AssetError::Refused(format!("Host {host} ist nicht erlaubt")));
        }
        if !u.username().is_empty() || u.password().is_some() {
            return Err(AssetError::Refused("Adresse mit Zugangsdaten".into()));
        }
        if let Some(hosts) = provider.file_hosts() {
            if !hosts.iter().any(|h| host == *h || host.ends_with(&format!(".{h}"))) {
                return Err(AssetError::Refused(format!("{host} ist kein Datei-Host von {}", provider.name())));
            }
        }
        Ok(u)
    }

    async fn pace(&self, p: Provider) {
        let wait = {
            let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let next = last.get(&p).map(|t| *t + MIN_INTERVAL).filter(|t| *t > now);
            last.insert(p, next.unwrap_or(now));
            next.map(|t| t - now)
        };
        if let Some(w) = wait {
            tokio::time::sleep(w).await;
        }
    }

    /// GET with the provider's auth, retried once on connection errors and 5xx.
    async fn get_json(&self, p: Provider, url: Url, auth: Option<String>) -> Result<serde_json::Value> {
        let mut attempt = 0;
        loop {
            self.pace(p).await;
            let mut req = self.client.get(url.clone()).header("Accept", "application/json");
            if let Some(a) = &auth {
                req = req.header("Authorization", a);
            }
            let res = req.send().await;
            let retry = match &res {
                Err(e) => e.is_connect() || e.is_timeout(),
                Ok(r) => r.status().is_server_error(),
            };
            if retry && attempt < 1 {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(800)).await;
                continue;
            }
            let mut res = res.map_err(net_err)?;
            let status = res.status();
            if status.as_u16() == 429 {
                return Err(AssetError::RateLimited(p.name()));
            }
            let body = read_limited(&mut res, MAX_JSON).await?;
            if !status.is_success() {
                let detail: String = String::from_utf8_lossy(&body).chars().filter(|c| !c.is_control()).take(200).collect();
                let detail = if matches!(status.as_u16(), 401 | 403) { format!("Zugriff verweigert, API-Schlüssel prüfen ({detail})") } else { detail };
                return Err(AssetError::Http { status: status.as_u16(), detail });
            }
            return serde_json::from_slice(&body).map_err(|_| invalid(format!("{} lieferte kein gültiges JSON", p.name())));
        }
    }

    /// Searches one provider. `key` is the user's API key (not needed for Openverse).
    pub async fn search(&self, req: &SearchRequest, key: Option<&str>) -> Result<SearchPage> {
        req.validate()?;
        let p = req.provider;
        let key = key.map(str::trim).filter(|k| !k.is_empty());
        if p.needs_key() && key.is_none() {
            return Err(AssetError::MissingKey(p.name()));
        }
        let base = self.base(p);
        let q = req.query.trim();
        let page = req.page;
        let per = PER_PAGE.to_string();
        let build = |path: &str, pairs: &[(&str, &str)]| -> Result<Url> {
            let mut u = Url::parse(&format!("{base}{path}")).map_err(|_| invalid("API-Adresse"))?;
            u.query_pairs_mut().extend_pairs(pairs);
            Ok(u)
        };
        let pg = page.to_string();
        if req.commercial_only && p == Provider::Giphy {
            return Ok(SearchPage {
                page,
                notice: "GIPHY gibt keine Lizenz für kommerzielle Nutzung an. Mit dem Filter „Kommerziell nutzbar“ gibt es hier keine Treffer.".into(),
                ..Default::default()
            });
        }
        let mut out = match p {
            Provider::Pexels => {
                let path = if req.kind == SearchKind::Video { "/videos/search" } else { "/v1/search" };
                let v = self.get_json(p, build(path, &[("query", q), ("page", &pg), ("per_page", &per)])?, key.map(str::to_string)).await?;
                parse::pexels(&v, req.kind, page)?
            }
            Provider::Giphy => {
                let offset = ((page - 1) * PER_PAGE).to_string();
                let k = key.unwrap_or_default();
                let v = self.get_json(p, build("/v1/gifs/search", &[("api_key", k), ("q", q), ("limit", &per), ("offset", &offset), ("rating", "g"), ("lang", "de")])?, None).await?;
                parse::giphy(&v, page)?
            }
            Provider::Freesound => {
                let v = self
                    .get_json(p, build("/apiv2/search/", &[("query", q), ("page", &pg), ("page_size", &per), ("fields", parse::FREESOUND_FIELDS)])?, key.map(|k| format!("Token {k}")))
                    .await?;
                parse::freesound(&v, page)?
            }
            Provider::Openverse => {
                let path = if req.kind == SearchKind::Audio { "/v1/audio/" } else { "/v1/images/" };
                let mut pairs = vec![("q", q), ("page", pg.as_str()), ("page_size", per.as_str())];
                if req.commercial_only {
                    pairs.push(("license_type", "commercial"));
                }
                let v = self.get_json(p, build(path, &pairs)?, None).await?;
                parse::openverse(&v, req.kind, page)?
            }
        };
        // Only files the download policy accepts are offered.
        for a in &mut out.results {
            a.files.retain(|f| self.check_file_url(p, &f.url).is_ok());
            if !a.thumb_url.is_empty() && self.check_file_url(p, &a.thumb_url).is_err() {
                a.thumb_url.clear();
            }
        }
        out.results.retain(|a| !a.files.is_empty());
        if req.commercial_only {
            let before = out.results.len();
            out.results.retain(|a| a.license.commercial == "yes");
            if out.results.len() < before {
                out.notice = format!("{} Treffer ohne ausdrückliche Erlaubnis zur kommerziellen Nutzung ausgeblendet.", before - out.results.len());
            }
        }
        Ok(out)
    }

    /// Follows redirects by hand, checking every hop.
    async fn open(&self, provider: Provider, url: &str) -> Result<reqwest::Response> {
        let mut u = self.check_file_url(provider, url)?;
        for _ in 0..6 {
            self.pace(provider).await;
            let res = self.client.get(u.clone()).send().await.map_err(net_err)?;
            if res.status().is_redirection() {
                let loc = res.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| AssetError::Refused("Weiterleitung ohne Ziel".into()))?;
                let next = u.join(loc).map_err(|_| AssetError::Refused("ungültige Weiterleitung".into()))?;
                u = self.check_file_url(provider, next.as_str())?;
                continue;
            }
            if res.status().as_u16() == 429 {
                return Err(AssetError::RateLimited(provider.name()));
            }
            if !res.status().is_success() {
                return Err(AssetError::Http { status: res.status().as_u16(), detail: "Datei nicht abrufbar".into() });
            }
            return Ok(res);
        }
        Err(AssetError::Refused("zu viele Weiterleitungen".into()))
    }

    /// Downloads file `file` of `asset` into `dir/<provider>/`. The content
    /// must match the asset kind by its first bytes; it is written to a
    /// `.part` file and renamed when complete. Files are named by content,
    /// so downloading the same file twice keeps one copy.
    pub async fn download(&self, asset: &RemoteAsset, file: usize, dir: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, Option<u64>)) -> Result<Downloaded> {
        let provider = Provider::from_id(&asset.provider).ok_or_else(|| invalid("Anbieter"))?;
        let f = asset.files.get(file).ok_or_else(|| invalid("Datei"))?;
        let (groups, max) = accepts(&asset.kind);
        if groups.is_empty() {
            return Err(invalid("Medienart"));
        }
        let mut res = self.open(provider, &f.url).await?;
        let total = res.content_length();
        if total.is_some_and(|t| t > max) {
            return Err(AssetError::Refused(format!("Datei größer als {} MB", max >> 20)));
        }
        if let Some(ct) = res.headers().get("content-type").and_then(|v| v.to_str().ok()) {
            let ct = ct.to_lowercase();
            if ct.starts_with("text/") || ct.contains("html") || ct.contains("javascript") || ct.contains("x-msdownload") || ct.contains("zip") {
                return Err(AssetError::Refused(format!("Inhaltstyp {ct} ist keine Mediendatei")));
            }
        }
        let sub = dir.join(provider.id());
        std::fs::create_dir_all(&sub).map_err(|e| AssetError::Io(e.to_string()))?;
        let tmp = sub.join(format!(".{}.part", uuid::Uuid::new_v4()));
        let result = async {
            use std::io::Write;
            let mut out = std::fs::File::create(&tmp).map_err(|e| AssetError::Io(e.to_string()))?;
            let mut hash = Sha256::new();
            let mut done: u64 = 0;
            let mut kind: Option<(&'static str, &'static str, &'static str)> = None;
            let mut head: Vec<u8> = Vec::new();
            while let Some(chunk) = res.chunk().await.map_err(net_err)? {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AssetError::Cancelled);
                }
                done += chunk.len() as u64;
                if done > max {
                    return Err(AssetError::Refused(format!("Datei größer als {} MB", max >> 20)));
                }
                if kind.is_none() {
                    let take = (64 - head.len()).min(chunk.len());
                    head.extend_from_slice(&chunk[..take]);
                    if head.len() >= 16 {
                        kind = Some(check_head(&head, groups)?);
                    }
                }
                hash.update(&chunk);
                out.write_all(&chunk).map_err(|e| AssetError::Io(e.to_string()))?;
                progress(done, total);
            }
            let (mime, ext, _) = match kind {
                Some(k) => k,
                None => check_head(&head, groups)?,
            };
            out.sync_all().map_err(|e| AssetError::Io(e.to_string()))?;
            if total.is_some_and(|t| t != done) {
                return Err(AssetError::Network("Download unvollständig".into()));
            }
            Ok((crate::report::hex(&hash.finalize()), done, mime.to_string(), ext))
        }
        .await;
        let (sha, size, mime, ext) = match result {
            Ok(x) => x,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        };
        let id: String = asset.provider_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(48).collect();
        let dest = sub.join(format!("{}-{id}-{}.{ext}", provider.id(), &sha[..12]));
        if dest.exists() {
            let _ = std::fs::remove_file(&tmp);
        } else {
            std::fs::rename(&tmp, &dest).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                AssetError::Io(e.to_string())
            })?;
        }
        Ok(Downloaded { path: dest, sha256: sha, size, mime })
    }

    /// Fetches a result's thumbnail into `cache` (named by URL) and returns its path.
    pub async fn thumbnail(&self, asset: &RemoteAsset, cache: &Path) -> Result<PathBuf> {
        let provider = Provider::from_id(&asset.provider).ok_or_else(|| invalid("Anbieter"))?;
        if asset.thumb_url.is_empty() {
            return Err(invalid("kein Vorschaubild"));
        }
        let name = crate::report::hex(&Sha256::digest(asset.thumb_url.as_bytes())[..12]);
        for ext in ["jpg", "png", "gif", "webp"] {
            let p = cache.join(format!("{name}.{ext}"));
            if p.exists() {
                return Ok(p);
            }
        }
        // Openverse thumbnails come from its API host; others from the provider's file hosts.
        let mut res = self.open(provider, &asset.thumb_url).await?;
        let body = read_limited(&mut res, MAX_THUMB).await?;
        let (_, ext, group) = sniff(&body).ok_or_else(|| AssetError::Refused("Vorschaubild ist kein Bild".into()))?;
        if group != "image" || ext == "tif" {
            return Err(AssetError::Refused("Vorschaubild ist kein Bild".into()));
        }
        std::fs::create_dir_all(cache).map_err(|e| AssetError::Io(e.to_string()))?;
        let p = cache.join(format!("{name}.{ext}"));
        let tmp = cache.join(format!(".{name}.part"));
        std::fs::write(&tmp, &body).and_then(|_| std::fs::rename(&tmp, &p)).map_err(|e| AssetError::Io(e.to_string()))?;
        Ok(p)
    }
}

fn check_head(head: &[u8], groups: &[&str]) -> Result<(&'static str, &'static str, &'static str)> {
    let k = sniff(head).ok_or_else(|| AssetError::Refused("Inhalt ist keine unterstützte Bild-, Video- oder Audiodatei".into()))?;
    if !groups.contains(&k.2) {
        return Err(AssetError::Refused(format!("Inhalt ({}) passt nicht zur Medienart", k.0)));
    }
    Ok(k)
}

async fn read_limited(res: &mut reqwest::Response, max: u64) -> Result<Vec<u8>> {
    if res.content_length().is_some_and(|l| l > max) {
        return Err(AssetError::Refused("Antwort zu groß".into()));
    }
    let mut body = Vec::new();
    while let Some(c) = res.chunk().await.map_err(net_err)? {
        if body.len() as u64 + c.len() as u64 > max {
            return Err(AssetError::Refused("Antwort zu groß".into()));
        }
        body.extend_from_slice(&c);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_urls_are_checked() {
        let n = Net::new().unwrap();
        assert!(n.check_file_url(Provider::Pexels, "https://images.pexels.com/photos/1/a.jpeg").is_ok());
        assert!(n.check_file_url(Provider::Pexels, "https://pexels.com.evil.example/a.jpg").is_err());
        assert!(n.check_file_url(Provider::Pexels, "http://images.pexels.com/a.jpg").is_err(), "https only");
        assert!(n.check_file_url(Provider::Giphy, "https://media2.giphy.com/media/x/giphy.mp4").is_ok());
        assert!(n.check_file_url(Provider::Giphy, "https://images.pexels.com/a.jpg").is_err());
        assert!(n.check_file_url(Provider::Openverse, "https://upload.wikimedia.org/a.jpg").is_ok(), "openverse files live on source sites");
        for bad in ["https://127.0.0.1/a.jpg", "https://localhost/a.jpg", "https://[::1]/a.jpg", "https://10.0.0.1/a.jpg", "https://printer.local/a.jpg", "https://intranet/a.jpg", "https://u:p@example.org/a.jpg", "file:///etc/passwd", "ftp://example.org/a"] {
            assert!(n.check_file_url(Provider::Openverse, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn sniffing() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]).unwrap().0, "image/jpeg");
        assert_eq!(sniff(b"\0\0\0\x18ftypmp42").unwrap().2, "video");
        assert_eq!(sniff(b"ID3\x04").unwrap().0, "audio/mpeg");
        assert!(sniff(b"MZ\x90\0").is_none(), "executables are not media");
        assert!(sniff(b"PK\x03\x04").is_none(), "archives are not media");
        assert!(sniff(b"<html>").is_none());
    }
}
