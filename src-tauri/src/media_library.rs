//! Media browser backend: provider keys (OS credential store), searches,
//! thumbnails, the download queue, the downloaded-asset library and license
//! reports. The webview never sees API keys or download URLs it could choose:
//! it names results by provider and id, and the URLs come from the API
//! responses kept here.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use kerf_assets::net::Net;
use kerf_assets::report::{self, ReportEntry, ReportFormat};
use kerf_assets::{AssetError, Provider, RemoteAsset, SearchKind, SearchPage, SearchRequest};
use kerf_library::assets::{AssetQuery, AssetRecord, Collection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{CmdResult, CommandError};
use crate::library::with;
use crate::state::{lock, now_ms, AppState};

impl From<AssetError> for CommandError {
    fn from(e: AssetError) -> Self {
        let code = match &e {
            AssetError::MissingKey(_) => "providerKeyMissing",
            AssetError::RateLimited(_) => "providerRateLimited",
            AssetError::Http { status: 401 | 403, .. } => "providerDenied",
            AssetError::Network(_) | AssetError::Http { .. } => "providerFailed",
            AssetError::Refused(_) => "downloadRefused",
            AssetError::Cancelled => "cancelled",
            AssetError::Invalid(_) | AssetError::Io(_) => "invalid",
        };
        CommandError::new(code, e)
    }
}

const KEYRING_SERVICE: &str = "Kerf media providers";
const MAX_CACHED: usize = 3000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub provider: String,
    pub provider_id: String,
    pub title: String,
    pub kind: String,
    /// "queued", "running", "done", "failed", "cancelled".
    pub state: String,
    pub done: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    /// The library record once done.
    pub asset: Option<AssetRecord>,
    /// True when the file was already in the library (nothing downloaded).
    pub existing: bool,
}

struct Pending {
    job: DownloadJob,
    remote: RemoteAsset,
    file: usize,
    cancel: Arc<AtomicBool>,
}

/// Results by (provider, id), plus their insertion order for eviction.
type ResultCache = (HashMap<(String, String), RemoteAsset>, VecDeque<(String, String)>);

pub struct MediaHub {
    net: Result<Net, String>,
    /// Results of this session's searches, by (provider, id).
    results: Mutex<ResultCache>,
    /// Keys kept only for this session (when the user chose not to store them).
    session_keys: Mutex<HashMap<Provider, String>>,
    jobs: Mutex<Vec<DownloadJob>>,
    queue: Mutex<VecDeque<Pending>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    running: Mutex<usize>,
}

impl MediaHub {
    pub fn new() -> Self {
        Self {
            net: Net::new().map_err(|e| e.to_string()),
            results: Mutex::new((HashMap::new(), VecDeque::new())),
            session_keys: Mutex::new(HashMap::new()),
            jobs: Mutex::new(Vec::new()),
            queue: Mutex::new(VecDeque::new()),
            cancels: Mutex::new(HashMap::new()),
            running: Mutex::new(0),
        }
    }

    fn net(&self) -> CmdResult<&Net> {
        self.net.as_ref().map_err(|e| CommandError::new("providerFailed", e))
    }

    fn remember(&self, page: &SearchPage) {
        let mut g = lock(&self.results);
        let (map, order) = &mut *g;
        for a in &page.results {
            let k = (a.provider.clone(), a.provider_id.clone());
            if map.insert(k.clone(), a.clone()).is_none() {
                order.push_back(k);
            }
        }
        while order.len() > MAX_CACHED {
            if let Some(k) = order.pop_front() {
                map.remove(&k);
            }
        }
    }

    fn result(&self, provider: &str, id: &str) -> CmdResult<RemoteAsset> {
        lock(&self.results)
            .0
            .get(&(provider.to_string(), id.to_string()))
            .cloned()
            .ok_or_else(|| CommandError::new("notFound", "Treffer nicht mehr bekannt; bitte erneut suchen"))
    }

    fn key(&self, p: Provider) -> Option<String> {
        if let Some(k) = lock(&self.session_keys).get(&p) {
            return Some(k.clone());
        }
        keyring::Entry::new(KEYRING_SERVICE, p.id()).ok()?.get_password().ok()
    }

    fn update(&self, app: &AppHandle, id: &str, f: impl FnOnce(&mut DownloadJob)) {
        let job = {
            let mut jobs = lock(&self.jobs);
            let Some(j) = jobs.iter_mut().find(|j| j.id == id) else { return };
            f(j);
            j.clone()
        };
        let _ = app.emit("media-download", &job);
    }
}

fn provider(id: &str) -> CmdResult<Provider> {
    Provider::from_id(id).ok_or_else(|| CommandError::new("invalid", format!("unknown provider {id}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    id: &'static str,
    name: &'static str,
    kinds: Vec<SearchKind>,
    needs_key: bool,
    /// "system" (OS credential store), "session" (until Kerf quits) or "" (none).
    key_storage: &'static str,
    key_url: &'static str,
}

#[tauri::command]
pub fn media_providers(hub: State<MediaHub>) -> Vec<ProviderInfo> {
    Provider::ALL
        .iter()
        .map(|&p| {
            let storage = if !p.needs_key() {
                ""
            } else if lock(&hub.session_keys).contains_key(&p) {
                "session"
            } else if keyring::Entry::new(KEYRING_SERVICE, p.id()).and_then(|e| e.get_password()).is_ok() {
                "system"
            } else {
                ""
            };
            ProviderInfo { id: p.id(), name: p.name(), kinds: p.kinds().to_vec(), needs_key: p.needs_key(), key_storage: storage, key_url: p.key_url() }
        })
        .collect()
}

/// Stores a key in the OS credential store (`persist`) or for this session only.
/// The key never travels back to the webview.
#[tauri::command]
pub fn media_set_key(hub: State<MediaHub>, provider: String, key: String, persist: bool) -> CmdResult<&'static str> {
    let p = self::provider(&provider)?;
    let key = key.trim().to_string();
    if key.is_empty() || key.len() > 512 || key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(CommandError::new("invalid", "API-Schlüssel ungültig"));
    }
    if persist {
        let entry = keyring::Entry::new(KEYRING_SERVICE, p.id()).map_err(|e| CommandError::new("keyStoreFailed", e))?;
        entry.set_password(&key).map_err(|e| CommandError::new("keyStoreFailed", e))?;
        lock(&hub.session_keys).remove(&p);
        Ok("system")
    } else {
        lock(&hub.session_keys).insert(p, key);
        Ok("session")
    }
}

#[tauri::command]
pub fn media_clear_key(hub: State<MediaHub>, provider: String) -> CmdResult<()> {
    let p = self::provider(&provider)?;
    lock(&hub.session_keys).remove(&p);
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, p.id()) {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(CommandError::new("keyStoreFailed", e)),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn media_search(hub: State<'_, MediaHub>, request: SearchRequest) -> CmdResult<SearchPage> {
    let key = if request.provider.needs_key() { hub.key(request.provider) } else { None };
    let page = hub.net()?.search(&request, key.as_deref()).await?;
    hub.remember(&page);
    Ok(page)
}

/// A search result's thumbnail, fetched into the cache (shown via the asset protocol).
#[tauri::command]
pub async fn media_thumb(hub: State<'_, MediaHub>, state: State<'_, AppState>, provider: String, id: String) -> CmdResult<String> {
    let a = hub.result(&provider, &id)?;
    let dir = state.paths.cache.join("remote-thumbs");
    Ok(hub.net()?.thumbnail(&a, &dir).await?.to_string_lossy().into_owned())
}

fn record_of(a: &RemoteAsset) -> AssetRecord {
    AssetRecord {
        provider: a.provider.clone(),
        provider_id: a.provider_id.clone(),
        kind: a.kind.clone(),
        title: a.title.clone(),
        creator: a.creator.clone(),
        creator_url: a.creator_url.clone(),
        page_url: a.page_url.clone(),
        license_code: a.license.code.clone(),
        license_name: a.license.name.clone(),
        license_url: a.license.url.clone(),
        commercial: a.license.commercial.clone(),
        attribution_required: a.license.attribution_required,
        attribution: a.license.attribution.clone(),
        width: a.width as i64,
        height: a.height as i64,
        duration_ms: a.duration_ms as i64,
        tags: a.tags.clone(),
        ..Default::default()
    }
}

/// Queues a download of file `file` of a search result.
#[tauri::command]
pub fn media_download(app: AppHandle, hub: State<MediaHub>, state: State<AppState>, provider: String, id: String, file: usize) -> CmdResult<DownloadJob> {
    let remote = hub.result(&provider, &id)?;
    if file >= remote.files.len() {
        return Err(CommandError::new("invalid", "Datei"));
    }
    // Already downloaded and still on disk: nothing to fetch.
    if let Some(rec) = with(&state, |l| l.asset_by_provider(&provider, &id))? {
        if !rec.file_path.is_empty() && !rec.missing {
            let job = DownloadJob {
                id: uuid::Uuid::new_v4().to_string(),
                provider,
                provider_id: id,
                title: remote.title.clone(),
                kind: remote.kind.clone(),
                state: "done".into(),
                done: rec.size as u64,
                total: Some(rec.size as u64),
                error: None,
                asset: Some(rec),
                existing: true,
            };
            lock(&hub.jobs).push(job.clone());
            let _ = app.emit("media-download", &job);
            return Ok(job);
        }
    }
    let job = DownloadJob {
        id: uuid::Uuid::new_v4().to_string(),
        provider,
        provider_id: id,
        title: if remote.title.is_empty() { remote.provider_id.clone() } else { remote.title.clone() },
        kind: remote.kind.clone(),
        state: "queued".into(),
        done: 0,
        total: Some(remote.files[file].size).filter(|s| *s > 0),
        error: None,
        asset: None,
        existing: false,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    lock(&hub.cancels).insert(job.id.clone(), cancel.clone());
    lock(&hub.jobs).push(job.clone());
    lock(&hub.queue).push_back(Pending { job: job.clone(), remote, file, cancel });
    let _ = app.emit("media-download", &job);
    pump(&app);
    Ok(job)
}

/// Starts queued downloads (at most two at a time).
fn pump(app: &AppHandle) {
    let hub = app.state::<MediaHub>();
    loop {
        let next = {
            let mut running = lock(&hub.running);
            if *running >= 2 {
                return;
            }
            let Some(p) = lock(&hub.queue).pop_front() else { return };
            *running += 1;
            p
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run(&app, next).await;
            let hub = app.state::<MediaHub>();
            *lock(&hub.running) -= 1;
            pump(&app);
        });
    }
}

/// Cancels queued and running downloads; returns how many are still running.
pub(crate) fn cancel_all(hub: &MediaHub) -> usize {
    lock(&hub.cancels).values().for_each(|f| f.store(true, Ordering::Relaxed));
    *lock(&hub.running)
}

async fn run(app: &AppHandle, p: Pending) {
    let hub = app.state::<MediaHub>();
    let state = app.state::<AppState>();
    let id = p.job.id.clone();
    if p.cancel.load(Ordering::Relaxed) {
        hub.update(app, &id, |j| j.state = "cancelled".into());
        return;
    }
    hub.update(app, &id, |j| j.state = "running".into());
    let net = match hub.net() {
        Ok(n) => n,
        Err(e) => {
            hub.update(app, &id, |j| {
                j.state = "failed".into();
                j.error = Some(e.message.clone());
            });
            return;
        }
    };
    let mut last = std::time::Instant::now();
    let result = net
        .download(&p.remote, p.file, &state.paths.assets, &p.cancel, |done, total| {
            if last.elapsed().as_millis() >= 150 {
                last = std::time::Instant::now();
                hub.update(app, &id, |j| {
                    j.done = done;
                    j.total = total;
                });
            }
        })
        .await;
    lock(&hub.cancels).remove(&id);
    match result {
        Ok(d) => {
            let mut rec = record_of(&p.remote);
            rec.file_path = d.path.to_string_lossy().into_owned();
            rec.sha256 = d.sha256;
            rec.size = d.size as i64;
            rec.mime = d.mime;
            let f = &p.remote.files[p.file];
            if f.width > 0 {
                rec.width = f.width as i64;
                rec.height = f.height as i64;
            }
            match with(&state, |l| l.upsert_asset(&rec, now_ms())) {
                Ok(saved) => hub.update(app, &id, |j| {
                    j.state = "done".into();
                    j.done = d.size;
                    j.total = Some(d.size);
                    j.asset = Some(saved);
                }),
                Err(e) => hub.update(app, &id, |j| {
                    j.state = "failed".into();
                    j.error = Some(format!("In der Bibliothek nicht gespeichert: {}", e.message));
                }),
            }
        }
        Err(AssetError::Cancelled) => hub.update(app, &id, |j| j.state = "cancelled".into()),
        Err(e) => hub.update(app, &id, |j| {
            j.state = "failed".into();
            j.error = Some(e.to_string());
        }),
    }
}

#[tauri::command]
pub fn media_download_cancel(app: AppHandle, hub: State<MediaHub>, id: String) {
    if let Some(c) = lock(&hub.cancels).get(&id) {
        c.store(true, Ordering::Relaxed);
    }
    // A job still waiting in the queue ends right away.
    let queued = {
        let mut q = lock(&hub.queue);
        let before = q.len();
        q.retain(|p| p.job.id != id);
        q.len() < before
    };
    if queued {
        lock(&hub.cancels).remove(&id);
        hub.update(&app, &id, |j| j.state = "cancelled".into());
    }
}

#[tauri::command]
pub fn media_downloads(hub: State<MediaHub>) -> Vec<DownloadJob> {
    lock(&hub.jobs).clone()
}

#[tauri::command]
pub fn media_downloads_clear(hub: State<MediaHub>) {
    lock(&hub.jobs).retain(|j| j.state == "queued" || j.state == "running");
}

/// Opens a result's or library asset's web page, creator page or license in the browser.
#[tauri::command]
pub fn media_open_link(hub: State<MediaHub>, state: State<AppState>, provider: String, id: String, which: String) -> CmdResult<()> {
    let p = self::provider(&provider)?;
    let url = if which == "key" {
        p.key_url().to_string()
    } else {
        let (page, creator, license) = match hub.result(&provider, &id) {
            Ok(a) => (a.page_url, a.creator_url, a.license.url),
            Err(_) => {
                let rec = with(&state, |l| l.asset_by_provider(&provider, &id))?.ok_or_else(|| CommandError::new("notFound", "unknown asset"))?;
                (rec.page_url, rec.creator_url, rec.license_url)
            }
        };
        match which.as_str() {
            "page" => page,
            "creator" => creator,
            "license" => license,
            _ => return Err(CommandError::new("invalid", "link")),
        }
    };
    open_url(&url)
}

/// Opens an http(s) URL in the default browser.
fn open_url(url: &str) -> CmdResult<()> {
    let u = url::Url::parse(url).map_err(|_| CommandError::new("invalid", "Adresse"))?;
    if !matches!(u.scheme(), "https" | "http") || u.host_str().is_none() {
        return Err(CommandError::new("invalid", "nur Webadressen"));
    }
    let s = u.as_str().to_string();
    #[cfg(windows)]
    std::process::Command::new("explorer").arg(&s).spawn().map_err(|e| CommandError::new("openFileFailed", e))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&s).spawn().map_err(|e| CommandError::new("openFileFailed", e))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(&s).spawn().map_err(|e| CommandError::new("openFileFailed", e))?;
    Ok(())
}

// --- library -----------------------------------------------------------------------------

#[tauri::command]
pub fn asset_list(state: State<AppState>, query: AssetQuery) -> CmdResult<Vec<AssetRecord>> {
    with(&state, |l| l.assets(&query))
}

#[tauri::command]
pub fn asset_favorite(state: State<AppState>, id: String, on: bool) -> CmdResult<()> {
    with(&state, |l| l.set_asset_favorite(&id, on))
}

/// Removes an asset from the library; its file is deleted only when it lies in
/// Kerf's asset folder and `delete_file` is set.
#[tauri::command]
pub fn asset_delete(state: State<AppState>, id: String, delete_file: bool) -> CmdResult<()> {
    let rec = with(&state, |l| l.asset(&id))?;
    if delete_file && !rec.file_path.is_empty() {
        let p = PathBuf::from(&rec.file_path);
        let inside = match (p.canonicalize(), state.paths.assets.canonicalize()) {
            (Ok(f), Ok(d)) => f.starts_with(&d),
            _ => false,
        };
        if inside {
            std::fs::remove_file(&p).map_err(|e| CommandError::new("ioFailed", e))?;
        }
    }
    with(&state, |l| l.delete_asset(&id))
}

#[tauri::command]
pub fn collection_list(state: State<AppState>) -> CmdResult<Vec<Collection>> {
    with(&state, |l| l.collections())
}

#[tauri::command]
pub fn collection_create(state: State<AppState>, name: String) -> CmdResult<Collection> {
    with(&state, |l| l.create_collection(&name, now_ms()))
}

#[tauri::command]
pub fn collection_delete(state: State<AppState>, id: String) -> CmdResult<()> {
    with(&state, |l| l.delete_collection(&id))
}

#[tauri::command]
pub fn collection_set(state: State<AppState>, collection: String, asset: String, on: bool) -> CmdResult<()> {
    with(&state, |l| l.set_in_collection(&collection, &asset, on))
}

/// License data of the given project files (library records where known).
#[tauri::command]
pub fn license_entries(state: State<AppState>, files: Vec<String>) -> CmdResult<Vec<ReportEntry>> {
    let mut seen = std::collections::HashSet::new();
    let files: Vec<String> = files.into_iter().filter(|f| seen.insert(f.clone())).take(20_000).collect();
    with(&state, |l| files.iter().map(|f| Ok(ReportEntry { file: f.clone(), asset: l.asset_by_path(f)? })).collect())
}

/// Writes a license and attribution report for the given project files.
#[tauri::command(async)]
pub fn license_report(state: State<AppState>, project: String, files: Vec<String>, format: ReportFormat, path: String) -> CmdResult<()> {
    let p = PathBuf::from(&path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext != format.ext() {
        return Err(CommandError::new("invalid", format!("report files end in .{}", format.ext())));
    }
    let entries = license_entries(state, files)?;
    let text = report::render(&project, &entries, format, &chrono_like_now());
    kerf_core::io::write_atomic(&p, text.as_bytes(), false).map_err(|e| CommandError::new("ioFailed", e))
}

/// "YYYY-MM-DD HH:MM UTC" without a date library.
fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", rem / 3600, (rem % 3600) / 60)
}

#[cfg(test)]
mod tests {
    #[test]
    fn date_format() {
        let s = super::chrono_like_now();
        assert!(s.len() == 20 && s.ends_with("UTC") && s.starts_with("20"), "{s}");
    }
}
