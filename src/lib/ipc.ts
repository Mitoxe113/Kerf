// Typed bridge to the Rust engine. All document edits are funnelled through a
// FIFO queue so they reach the engine in the order the user made them.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  ClipLoudness,
  CommandError,
  Delta,
  EditCommand,
  ExportJob,
  ExportSettings,
  HistoryList,
  MediaAsset,
  ProjectState,
  RecoveryInfo,
  TimedText,
  Uuid,
  VersionInfo,
} from "./types";

let queue: Promise<unknown> = Promise.resolve();
let inFlight = 0;
const idleWaiters: (() => void)[] = [];

function serial<T>(fn: () => Promise<T>): Promise<T> {
  inFlight++;
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  void queue.then(() => {
    // Defer one macrotask so the caller has applied the result first.
    if (--inFlight === 0)
      setTimeout(() => {
        if (inFlight === 0) idleWaiters.splice(0).forEach((w) => w());
      }, 0);
  });
  return run;
}

/**
 * Runs `fn` once no queued command is pending. Engine events (e.g. analysis
 * results) can overtake the response of the command that triggered them; a
 * response carries an older snapshot, so events must land after it.
 */
function whenIdle(fn: () => void) {
  if (inFlight === 0 && idleWaiters.length === 0) fn();
  else idleWaiters.push(fn);
}

export function isCommandError(e: unknown): e is CommandError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  projectState: () => invoke<ProjectState>("project_state"),
  projectNew: (name: string) => serial(() => invoke<ProjectState>("project_new", { name })),
  projectOpen: (path: string) => serial(() => invoke<{ state: ProjectState; usedBackup: boolean }>("project_open", { path })),
  projectSave: (path?: string) =>
    serial(() => invoke<{ path: string; revision: number; dirty: boolean; name: string }>("project_save", { path: path ?? null })),
  edit: (command: EditCommand) => serial(() => invoke<Delta>("edit", { command })),
  /** Read-only; waits for queued edits so the clips exist in the engine. */
  measureClips: (sequence: Uuid, clips: Uuid[]) => new Promise<void>((r) => whenIdle(r)).then(() => invoke<ClipLoudness[]>("measure_clips", { sequence, clips })),
  freezeFrame: (sequence: Uuid, clip: Uuid, frame: number, seconds: number) => serial(() => invoke<Delta>("freeze_frame", { sequence, clip, frame, seconds })),
  undo: () => serial(() => invoke<Delta | null>("undo")),
  redo: () => serial(() => invoke<Delta | null>("redo")),
  historyList: () => invoke<HistoryList>("history_list"),
  historyGoto: (position: number) => serial(() => invoke<ProjectState>("history_goto", { position })),
  setActiveSequence: (sequence: Uuid) => serial(() => invoke<void>("set_active_sequence", { sequence })),
  importMedia: (paths: string[], bin: Uuid | null) => serial(() => invoke<Delta>("media_import", { paths, bin })),
  analyzeMedia: (ids: Uuid[]) => invoke<void>("media_analyze", { ids }),
  createProxies: (ids: Uuid[]) => invoke<void>("media_proxy", { ids }),
  exportStart: (sequence: Uuid, settings: ExportSettings) => serial(() => invoke<ExportJob>("export_start", { sequence, settings })),
  exportCancel: (id: Uuid) => invoke<void>("export_cancel", { id }),
  exportJobs: () => invoke<ExportJob[]>("export_jobs"),
  exportClear: () => invoke<void>("export_clear"),
  exportRetry: (id: Uuid) => invoke<ExportJob>("export_retry", { id }),
  exportLog: (id: Uuid) => invoke<string | null>("export_log", { id }),
  textRead: (path: string) => invoke<string>("text_read", { path }),
  subtitlesParse: (path: string) => invoke<TimedText[]>("subtitles_parse", { path }),
  /** Read-only on the project, but waits for queued edits of the cues. */
  subtitlesWrite: (path: string, sequence: Uuid) => serial(() => invoke<void>("subtitles_write", { path, sequence })),
  /** Stores a PNG (raw body) in the cache by content; returns its path. */
  titlePng: (png: Uint8Array) => invoke<string>("title_png", png),
  /** Free bytes on the drive holding `path`, null when unknown. */
  diskFree: (path: string) => invoke<number | null>("disk_free", { path }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  jsonRead: (path: string) => invoke<string>("json_read", { path }),
  /** The project Kerf was launched with (double-click on a .kerf file), once. */
  takeLaunchFile: () => invoke<string | null>("take_launch_file"),
  jsonWrite: (path: string, text: string) => invoke<void>("json_write", { path, text }),
  recoveryList: () => invoke<RecoveryInfo[]>("recovery_list"),
  recoveryRestore: (id: Uuid) => serial(() => invoke<ProjectState>("recovery_restore", { id })),
  recoveryDiscard: (id: Uuid) => invoke<void>("recovery_discard", { id }),
  versionList: () => invoke<VersionInfo[]>("version_list"),
  versionRestore: (file: string) => serial(() => invoke<ProjectState>("version_restore", { file })),
  setPreferences: (autosaveSecs: number, keepVersions: number) => invoke<void>("set_preferences", { autosaveSecs, keepVersions }),
  sessionEnd: () => invoke<void>("session_end"),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
};

export interface MediaJobEvent {
  mediaId: Uuid;
  kind: "proxy";
  progress: number;
}

export const events = {
  mediaUpdated: (cb: (a: MediaAsset) => void): Promise<UnlistenFn> => listen<MediaAsset>("media-updated", (e) => whenIdle(() => cb(e.payload))),
  mediaJob: (cb: (e: MediaJobEvent) => void): Promise<UnlistenFn> => listen<MediaJobEvent>("media-job", (e) => cb(e.payload)),
  exportUpdated: (cb: (j: ExportJob) => void): Promise<UnlistenFn> => listen<ExportJob>("export-updated", (e) => cb(e.payload)),
  appInfoChanged: (cb: () => void): Promise<UnlistenFn> => listen("app-info-changed", () => cb()),
  autosaved: (cb: (at: number) => void): Promise<UnlistenFn> => listen<number>("autosaved", (e) => cb(e.payload)),
  /** A .kerf file was opened from the OS while Kerf runs. */
  openProject: (cb: (path: string) => void): Promise<UnlistenFn> => listen<string>("open-project", (e) => cb(e.payload)),
};
