// Typed bridge to the Rust engine. All document edits are funnelled through a
// FIFO queue so they reach the engine in the order the user made them.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AnalysisProgress,
  Denoise,
  ArchiveOptions,
  ArchivePlan,
  ArchiveProgress,
  ArchiveReport,
  CacheInfo,
  CacheSettings,
  CacheKind,
  RelinkSearch,
  AnalysisRequest,
  AnalysisResult,
  AnalysisTarget,
  DuckOptions,
  DuckPlan,
  SilenceOptions,
  AppInfo,
  ClipLoudness,
  CommandError,
  Delta,
  WatchedFile,
  EditCommand,
  ExportJob,
  ExportSettings,
  FontFaceInfo,
  AssetQuery,
  AssetRecord,
  DownloadJob,
  LicenseEntry,
  ProviderId,
  ProviderInfo,
  ReportFormat,
  SearchPage,
  SearchRequest,
  HistoryList,
  ItemKind,
  MediaAsset,
  Preset,
  PresetKind,
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
  reversedAudio: (media: Uuid, denoise?: Denoise | null) => invoke<string>("reversed_audio", { media, denoise: denoise ?? null }),
  denoisedAudio: (media: Uuid, denoise: Denoise) => invoke<string>("denoised_audio", { media, denoise }),
  denoiseProfile: (media: Uuid, from: number, to: number) => invoke<number[]>("denoise_profile", { media, from, to }),
  analyze: (job: Uuid, target: AnalysisTarget, request: AnalysisRequest) => invoke<AnalysisResult>("analyze", { job, target, request }),
  analyzeCancel: (job: Uuid) => invoke<void>("analyze_cancel", { job }),
  duckPlan: (job: Uuid, sequence: Uuid, triggers: Uuid[], targets: Uuid[], speech: SilenceOptions, duck: DuckOptions) =>
    invoke<DuckPlan>("duck_plan", { job, sequence, triggers, targets, speech, duck }),
  archivePlan: (options: ArchiveOptions) => invoke<ArchivePlan>("archive_plan", { options }),
  archiveWrite: (job: Uuid, dest: string, options: ArchiveOptions) => invoke<ArchiveReport>("archive_write", { job, dest, options }),
  relinkSearch: (media: Uuid[], dirs: string[]) => invoke<RelinkSearch>("relink_search", { media, dirs }),
  cacheInfo: () => invoke<CacheInfo>("cache_info"),
  cacheClear: (kinds: CacheKind[], includeOpen: boolean) => invoke<number>("cache_clear", { kinds, includeOpen }),
  cacheSettings: () => invoke<CacheSettings>("cache_settings"),
  /** Cache folder for the next start; null: the app's own. */
  cacheLocationSet: (root: string | null) => invoke<CacheSettings>("cache_location_set", { root }),
  /** Size limit in bytes (null: none), applied at once; returns the bytes freed. */
  cacheLimitSet: (bytes: number | null) => invoke<number>("cache_limit_set", { bytes }),
  mediaMetadata: (media: Uuid) => invoke<Record<string, unknown>>("media_metadata", { media }),
  syncAngles: (media: Uuid[]) => invoke<(number | null)[]>("sync_angles", { media }),
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
  existingPaths: (paths: string[]) => invoke<string[]>("existing_paths", { paths }),
  /** Media files per watch folder; null = folder missing or unreadable. */
  watchScan: (folders: { path: string; subfolders: boolean }[]) => invoke<(WatchedFile[] | null)[]>("watch_scan", { folders }),
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
  logFrontend: (level: "error" | "warn", message: string) => invoke<void>("log_frontend", { level, message }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  presetList: (kind?: PresetKind) => invoke<Preset[]>("preset_list", { kind: kind ?? null }),
  presetSave: (preset: Preset) => invoke<Preset>("preset_save", { preset }),
  presetRename: (id: string, name: string) => invoke<Preset>("preset_rename", { id, name }),
  presetFavorite: (id: string, on: boolean) => invoke<void>("preset_favorite", { id, on }),
  presetDelete: (id: string) => invoke<void>("preset_delete", { id }),
  presetExport: (ids: string[], path: string) => invoke<void>("preset_export", { ids, path }),
  presetImport: (path: string) => invoke<Preset[]>("preset_import", { path }),
  favoriteList: (kind: ItemKind) => invoke<string[]>("favorite_list", { kind }),
  favoriteSet: (kind: ItemKind, key: string, on: boolean) => invoke<void>("favorite_set", { kind, key, on }),
  recentList: (kind: ItemKind) => invoke<string[]>("recent_list", { kind }),
  recentTouch: (kind: ItemKind, key: string) => invoke<void>("recent_touch", { kind, key }),
  fontList: (refresh = false) => invoke<FontFaceInfo[]>("font_list", { refresh }),
  fontImport: (paths: string[]) => invoke<FontFaceInfo[]>("font_import", { paths }),
  fontRemove: (path: string) => invoke<void>("font_remove", { path }),
  mediaProviders: () => invoke<ProviderInfo[]>("media_providers"),
  mediaSetKey: (provider: ProviderId, key: string, persist: boolean) => invoke<"system" | "session">("media_set_key", { provider, key, persist }),
  mediaClearKey: (provider: ProviderId) => invoke<void>("media_clear_key", { provider }),
  mediaSearch: (request: SearchRequest) => invoke<SearchPage>("media_search", { request }),
  mediaThumb: (provider: string, id: string) => invoke<string>("media_thumb", { provider, id }),
  mediaDownload: (provider: string, id: string, file: number) => invoke<DownloadJob>("media_download", { provider, id, file }),
  mediaDownloadCancel: (id: string) => invoke<void>("media_download_cancel", { id }),
  mediaDownloads: () => invoke<DownloadJob[]>("media_downloads"),
  mediaDownloadsClear: () => invoke<void>("media_downloads_clear"),
  /** which: "page", "creator", "license" or "key" (where to get an API key). */
  mediaOpenLink: (provider: string, id: string, which: "page" | "creator" | "license" | "key") => invoke<void>("media_open_link", { provider, id, which }),
  assetList: (query: AssetQuery) => invoke<AssetRecord[]>("asset_list", { query }),
  assetFavorite: (id: string, on: boolean) => invoke<void>("asset_favorite", { id, on }),
  assetDelete: (id: string, deleteFile: boolean) => invoke<void>("asset_delete", { id, deleteFile }),
  licenseEntries: (files: string[]) => invoke<LicenseEntry[]>("license_entries", { files }),
  licenseReport: (project: string, files: string[], format: ReportFormat, path: string) => invoke<void>("license_report", { project, files, format, path }),
};

export interface MediaJobEvent {
  mediaId: Uuid;
  kind: "proxy";
  progress: number;
}

export const events = {
  mediaUpdated: (cb: (a: MediaAsset) => void): Promise<UnlistenFn> => listen<MediaAsset>("media-updated", (e) => whenIdle(() => cb(e.payload))),
  archiveProgress: (cb: (p: ArchiveProgress) => void): Promise<UnlistenFn> => listen<ArchiveProgress>("archive-progress", (e) => cb(e.payload)),
  analysisProgress: (cb: (p: AnalysisProgress) => void): Promise<UnlistenFn> => listen<AnalysisProgress>("analysis-progress", (e) => cb(e.payload)),
  mediaJob: (cb: (e: MediaJobEvent) => void): Promise<UnlistenFn> => listen<MediaJobEvent>("media-job", (e) => cb(e.payload)),
  exportUpdated: (cb: (j: ExportJob) => void): Promise<UnlistenFn> => listen<ExportJob>("export-updated", (e) => cb(e.payload)),
  appInfoChanged: (cb: () => void): Promise<UnlistenFn> => listen("app-info-changed", () => cb()),
  autosaved: (cb: (at: number) => void): Promise<UnlistenFn> => listen<number>("autosaved", (e) => cb(e.payload)),
  /** A .kerf file was opened from the OS while Kerf runs. */
  openProject: (cb: (path: string) => void): Promise<UnlistenFn> => listen<string>("open-project", (e) => cb(e.payload)),
  projectForeign: (cb: (f: { path: string; fields: string[] }) => void): Promise<UnlistenFn> => listen<{ path: string; fields: string[] }>("project-foreign", (e) => cb(e.payload)),
  mediaDownload: (cb: (j: DownloadJob) => void): Promise<UnlistenFn> => listen<DownloadJob>("media-download", (e) => cb(e.payload)),
};
