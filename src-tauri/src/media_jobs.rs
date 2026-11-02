//! Background media analysis and proxy generation.
//!
//! Jobs run on dedicated worker threads and never hold the session lock while
//! FFmpeg works; results are written back in short critical sections and
//! pushed to the UI as `media-updated` events.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kerf_core::model::{MediaAsset, MediaKind, MediaStatus};
use kerf_media::{analysis, probe, Tools};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::state::{lock, AppState};

const ANALYSIS_WORKERS: usize = 3;

pub enum Job {
    Analyze(Uuid),
    Proxy(Uuid),
}

pub struct MediaService {
    pub tools: Option<Tools>,
    pub hw_encoders: Mutex<Option<Vec<String>>>,
    analysis_tx: Mutex<Option<Sender<Uuid>>>,
    proxy_tx: Mutex<Option<Sender<Uuid>>>,
    /// Media currently queued or running, to avoid duplicate work.
    pending: Mutex<HashSet<(Uuid, bool)>>,
    pub cancel_proxies: Arc<AtomicBool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaJobEvent {
    pub media_id: Uuid,
    pub kind: &'static str,
    /// 0..1, or -1 when finished.
    pub progress: f64,
}

impl MediaService {
    pub fn new(tools: Option<Tools>) -> Self {
        Self {
            tools,
            hw_encoders: Mutex::new(None),
            analysis_tx: Mutex::new(None),
            proxy_tx: Mutex::new(None),
            pending: Mutex::new(HashSet::new()),
            cancel_proxies: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Spawns the worker threads. Called once from setup.
    pub fn start(&self, app: &AppHandle) {
        let (atx, arx) = channel::<Uuid>();
        let arx = Arc::new(Mutex::new(arx));
        for i in 0..ANALYSIS_WORKERS {
            let app = app.clone();
            let rx = arx.clone();
            std::thread::Builder::new()
                .name(format!("kerf-analysis-{i}"))
                .spawn(move || worker(app, rx, false))
                .expect("spawn analysis worker");
        }
        let (ptx, prx) = channel::<Uuid>();
        let prx = Arc::new(Mutex::new(prx));
        {
            let app = app.clone();
            std::thread::Builder::new()
                .name("kerf-proxy".into())
                .spawn(move || worker(app, prx, true))
                .expect("spawn proxy worker");
        }
        *lock(&self.analysis_tx) = Some(atx);
        *lock(&self.proxy_tx) = Some(ptx);

        // Hardware encoder detection takes a second or two; do it off-thread.
        if let Some(tools) = self.tools.clone() {
            let app = app.clone();
            std::thread::spawn(move || {
                let encoders = tools.working_hw_encoders();
                log::info!("hardware encoders: {encoders:?}");
                let state = app.state::<AppState>();
                *lock(&state.media.hw_encoders) = Some(encoders);
                let _ = app.emit("app-info-changed", ());
            });
        }
    }

    pub fn submit(&self, job: Job) {
        let (id, proxy) = match job {
            Job::Analyze(id) => (id, false),
            Job::Proxy(id) => (id, true),
        };
        if !lock(&self.pending).insert((id, proxy)) {
            return;
        }
        let tx = if proxy { &self.proxy_tx } else { &self.analysis_tx };
        if let Some(tx) = lock(tx).as_ref() {
            let _ = tx.send(id);
        }
    }
}

fn worker(app: AppHandle, rx: Arc<Mutex<Receiver<Uuid>>>, proxy: bool) {
    loop {
        let id = match lock(&rx).recv() {
            Ok(id) => id,
            Err(_) => return,
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if proxy {
                run_proxy(&app, id)
            } else {
                run_analysis(&app, id)
            }
        }));
        if result.is_err() {
            log::error!("media worker panicked on {id}");
            update(&app, id, None, |a| a.status = MediaStatus::Error("internal error during analysis".into()));
        }
        lock(&app.state::<AppState>().media.pending).remove(&(id, proxy));
    }
}

/// Applies `f` to the asset (if it still exists and still points at
/// `expected_path`), propagates it into undo history and notifies the UI.
fn update(app: &AppHandle, id: Uuid, expected_path: Option<&Path>, f: impl FnOnce(&mut MediaAsset)) -> Option<MediaAsset> {
    let state = app.state::<AppState>();
    let asset = {
        let mut s = lock(&state.session);
        let a = s.project.media_mut(id)?;
        if expected_path.is_some_and(|p| a.path != p) {
            return None;
        }
        f(a);
        let a = a.clone();
        s.history.patch_media(&a);
        a
    };
    let _ = app.emit("media-updated", &asset);
    Some(asset)
}

fn run_analysis(app: &AppHandle, id: Uuid) {
    let state = app.state::<AppState>();
    let Some(path) = lock(&state.session).project.media(id).map(|a| a.path.clone()) else { return };
    let p = Some(path.as_path());
    let Some(tools) = state.media.tools.as_ref() else {
        update(app, id, p, |a| a.status = MediaStatus::Error("FFmpeg not found".into()));
        return;
    };
    if !path.is_file() {
        update(app, id, p, |a| a.status = MediaStatus::Missing);
        return;
    }
    let _ = app.asset_protocol_scope().allow_file(&path);
    let started = Instant::now();
    let (kind, info) = match probe::probe(tools, &path) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("probe failed for {}: {e}", path.display());
            update(app, id, p, |a| a.status = MediaStatus::Error(e.to_string()));
            return;
        }
    };
    let native = analysis::preview_native(kind, &info, &path);
    let dir = analysis::cache_dir(&state.paths.cache, &path);
    // Keep valid derived data from a previous run; refresh the rest.
    update(app, id, p, |a| {
        a.kind = kind;
        a.info = Some(info.clone());
        a.status = MediaStatus::Ready;
        a.derived.preview_native = native;
        if a.derived.proxy.as_ref().is_some_and(|x| !x.is_file()) {
            a.derived.proxy = None;
        }
    });

    if kind != MediaKind::Audio {
        match analysis::poster(tools, &path, kind, &info, &dir) {
            Ok(poster) => {
                update(app, id, p, |a| a.derived.poster = Some(poster));
            }
            Err(e) => log::warn!("poster failed for {}: {e}", path.display()),
        }
    }
    if kind == MediaKind::Video {
        match analysis::filmstrip(tools, &path, &info, &dir) {
            Ok(strip) => {
                update(app, id, p, |a| a.derived.filmstrip = Some(strip));
            }
            Err(e) => log::warn!("filmstrip failed for {}: {e}", path.display()),
        }
    }
    if info.audio.is_some() && kind != MediaKind::Image {
        match analysis::peaks(tools, &path, &dir) {
            Ok(peaks) => {
                update(app, id, p, |a| a.derived.peaks = Some(peaks));
            }
            Err(e) => log::warn!("waveform failed for {}: {e}", path.display()),
        }
    }
    log::info!("analysed {} in {:?}", path.display(), started.elapsed());
    let has_proxy = lock(&state.session).project.media(id).is_some_and(|a| a.derived.proxy.is_some());
    if !native && !has_proxy {
        state.media.submit(Job::Proxy(id));
    }
}

fn run_proxy(app: &AppHandle, id: Uuid) {
    let state = app.state::<AppState>();
    let Some(asset) = lock(&state.session).project.media(id).cloned() else { return };
    let (Some(tools), Some(info)) = (state.media.tools.as_ref(), asset.info.as_ref()) else { return };
    if asset.status != MediaStatus::Ready {
        return;
    }
    let dir = analysis::cache_dir(&state.paths.cache, &asset.path);
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let emit = |progress: f64| {
        let _ = app.emit("media-job", MediaJobEvent { media_id: id, kind: "proxy", progress });
    };
    emit(0.0);
    let result = analysis::proxy(tools, &asset.path, asset.kind, info, &dir, &state.media.cancel_proxies, |f| {
        if last_emit.elapsed() > Duration::from_millis(250) {
            last_emit = Instant::now();
            emit(f);
        }
    });
    emit(-1.0);
    match result {
        Ok(proxy) => {
            update(app, id, Some(&asset.path), |a| a.derived.proxy = Some(proxy));
        }
        Err(e) => log::warn!("proxy failed for {}: {e}", asset.path.display()),
    }
}
