//! Render queue. Jobs capture a snapshot of the project at enqueue time, so
//! editing continues safely while exports run one after another. Finished
//! files are checked (probe + loudness) and every run keeps an FFmpeg log.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kerf_media::analysis::{self, Loudness};
use kerf_media::render::{self, RenderPlan, RenderProgress};
use kerf_media::{probe, MediaError, Tools};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::state::{lock, now_ms, AppState};

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ExportStatus {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub id: Uuid,
    pub sequence_name: String,
    pub output: PathBuf,
    pub status: ExportStatus,
    pub progress: RenderProgress,
    pub encoder: String,
    pub duration: f64,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
    /// What the file should contain.
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub channels: u8,
    /// Post-render check; None while it runs or before the job is done.
    pub qc: Option<ExportQc>,
}

/// What the rendered file actually contains.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportQc {
    pub duration: f64,
    pub size_bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub loudness: Option<Loudness>,
    /// The file could not be read back.
    pub error: Option<String>,
}

pub struct ExportService {
    jobs: Mutex<Vec<ExportJob>>,
    /// Kept after the run so a job can be retried.
    plans: Mutex<HashMap<Uuid, RenderPlan>>,
    logs: Mutex<HashMap<Uuid, String>>,
    cancels: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
    tx: Mutex<Option<Sender<Uuid>>>,
}

impl ExportService {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new(Vec::new()),
            plans: Mutex::new(HashMap::new()),
            logs: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            tx: Mutex::new(None),
        }
    }

    pub fn start(&self, app: &AppHandle) {
        let (tx, rx) = channel::<Uuid>();
        *lock(&self.tx) = Some(tx);
        let app = app.clone();
        std::thread::Builder::new()
            .name("kerf-export".into())
            .spawn(move || {
                while let Ok(id) = rx.recv() {
                    run_job(&app, id);
                }
            })
            .expect("spawn export worker");
    }

    pub fn enqueue(&self, app: &AppHandle, sequence_name: String, plan: RenderPlan) -> ExportJob {
        let job = ExportJob {
            id: Uuid::new_v4(),
            sequence_name,
            output: plan.output.clone(),
            status: ExportStatus::Queued,
            progress: RenderProgress::default(),
            encoder: plan.encoder.clone(),
            duration: plan.duration,
            created_at: now_ms(),
            finished_at: None,
            error: None,
            width: plan.width,
            height: plan.height,
            fps: plan.fps.as_f64(),
            channels: plan.channels,
            qc: None,
        };
        lock(&self.cancels).insert(job.id, Arc::new(AtomicBool::new(false)));
        lock(&self.plans).insert(job.id, plan);
        lock(&self.jobs).push(job.clone());
        let _ = app.emit("export-updated", &job);
        if let Some(tx) = lock(&self.tx).as_ref() {
            let _ = tx.send(job.id);
        }
        job
    }

    /// Cancels every queued and running export (used when the app ends).
    pub fn cancel_all(&self, app: &AppHandle) {
        let ids: Vec<Uuid> = lock(&self.jobs).iter().filter(|j| matches!(j.status, ExportStatus::Queued | ExportStatus::Running)).map(|j| j.id).collect();
        for id in ids {
            self.cancel(app, id);
        }
    }

    /// True when `path` is the output of an export that finished in this session.
    pub fn is_finished_output(&self, path: &std::path::Path) -> bool {
        lock(&self.jobs).iter().any(|j| j.status == ExportStatus::Done && j.output == path)
    }

    /// True while an export is rendering (its FFmpeg processes may still run).
    pub fn running(&self) -> bool {
        lock(&self.jobs).iter().any(|j| j.status == ExportStatus::Running)
    }

    pub fn cancel(&self, app: &AppHandle, id: Uuid) {
        if let Some(flag) = lock(&self.cancels).get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
        // Queued jobs are cancelled immediately; running ones when FFmpeg stops.
        let job = {
            let mut jobs = lock(&self.jobs);
            jobs.iter_mut().find(|j| j.id == id && j.status == ExportStatus::Queued).map(|j| {
                j.status = ExportStatus::Cancelled;
                j.finished_at = Some(now_ms());
                j.clone()
            })
        };
        if let Some(job) = job {
            let _ = app.emit("export-updated", &job);
        }
    }

    pub fn jobs(&self) -> Vec<ExportJob> {
        lock(&self.jobs).clone()
    }

    pub fn clear_finished(&self) {
        let mut jobs = lock(&self.jobs);
        jobs.retain(|j| matches!(j.status, ExportStatus::Queued | ExportStatus::Running));
        let live: Vec<Uuid> = jobs.iter().map(|j| j.id).collect();
        lock(&self.plans).retain(|id, _| live.contains(id));
        lock(&self.logs).retain(|id, _| live.contains(id));
    }

    /// Queues a failed or cancelled job again with the same snapshot.
    pub fn retry(&self, app: &AppHandle, id: Uuid) -> Option<ExportJob> {
        let name = lock(&self.jobs)
            .iter()
            .find(|j| j.id == id && matches!(j.status, ExportStatus::Failed | ExportStatus::Cancelled))?
            .sequence_name
            .clone();
        let plan = lock(&self.plans).get(&id).cloned()?;
        Some(self.enqueue(app, name, plan))
    }

    pub fn log(&self, id: Uuid) -> Option<String> {
        lock(&self.logs).get(&id).cloned()
    }

    fn set(&self, app: &AppHandle, id: Uuid, f: impl FnOnce(&mut ExportJob)) {
        let job = {
            let mut jobs = lock(&self.jobs);
            let Some(j) = jobs.iter_mut().find(|j| j.id == id) else { return };
            f(j);
            j.clone()
        };
        let _ = app.emit("export-updated", &job);
    }
}

fn run_job(app: &AppHandle, id: Uuid) {
    let state = app.state::<AppState>();
    let svc = &state.exports;
    let Some(plan) = lock(&svc.plans).get(&id).cloned() else { return };
    let cancel = lock(&svc.cancels).get(&id).cloned().unwrap_or_default();
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    let Some(tools) = state.media.tools.as_ref() else {
        svc.set(app, id, |j| {
            j.status = ExportStatus::Failed;
            j.error = Some("FFmpeg not found".into());
        });
        return;
    };
    svc.set(app, id, |j| j.status = ExportStatus::Running);
    log::info!("export {id} -> {} ({} inputs, {})", plan.output.display(), plan.inputs, plan.encoder);
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut log = String::new();
    let result = render::render_logged(
        tools,
        &plan,
        &cancel,
        |p| {
            if last.elapsed() >= Duration::from_millis(200) || p.fraction >= 1.0 {
                last = Instant::now();
                let p = p.clone();
                svc.set(app, id, |j| j.progress = p);
            }
        },
        &mut log,
    );
    lock(&svc.logs).insert(id, log);
    let done = result.is_ok();
    svc.set(app, id, |j| {
        j.finished_at = Some(now_ms());
        match result {
            Ok(()) => {
                j.status = ExportStatus::Done;
                j.progress.fraction = 1.0;
            }
            Err(MediaError::Cancelled) => j.status = ExportStatus::Cancelled,
            Err(e) => {
                log::error!("export {id} failed: {e}");
                j.status = ExportStatus::Failed;
                j.error = Some(match tools.too_old() {
                    Some(v) => format!(
                        "{e}\n\nDas installierte FFmpeg ist zu alt ({v}). Kerf braucht FFmpeg {} oder neuer.",
                        kerf_media::tools::MIN_FFMPEG_MAJOR
                    ),
                    None => e.to_string(),
                });
            }
        }
    });
    lock(&svc.cancels).remove(&id);
    if done {
        let qc = check(tools, &plan);
        svc.set(app, id, |j| j.qc = Some(qc));
    }
}

/// Reads the finished file back: streams, size and loudness.
fn check(tools: &Tools, plan: &RenderPlan) -> ExportQc {
    let mut qc = ExportQc::default();
    match probe::probe(tools, &plan.output) {
        Ok((_, info)) => {
            qc.duration = info.duration;
            qc.size_bytes = info.size_bytes;
            if let Some(v) = &info.video {
                qc.width = Some(v.width);
                qc.height = Some(v.height);
                qc.fps = Some(v.fps.as_f64());
                qc.video_codec = Some(v.codec.clone());
            }
            if let Some(a) = &info.audio {
                qc.audio_codec = Some(a.codec.clone());
                qc.channels = Some(a.channels);
                qc.sample_rate = Some(a.sample_rate);
                qc.loudness = analysis::loudness(tools, &plan.output, 0.0, None).map_err(|e| log::warn!("loudness check: {e}")).ok();
            }
        }
        Err(e) => qc.error = Some(e.to_string()),
    }
    qc
}
