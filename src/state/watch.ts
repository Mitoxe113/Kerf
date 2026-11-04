// Watch folders (Project.watchFolders): scanned every few seconds while the
// project is open; new media files are imported into the folder's bin
// (lib/watch.ts decides which). Files that were in a folder before the
// project was opened are not imported on their own: a notice lists them and
// "Abgleichen" imports them.

import { create } from "zustand";
import { api } from "../lib/ipc";
import type { Uuid, WatchFolder } from "../lib/types";
import { fileKey, scanStep, type FolderScan } from "../lib/watch";
import { useProject } from "./project";
import { toast } from "./toasts";

export interface WatchStatus {
  missing: boolean;
  /** Files in the folder that are not in the project and were there before. */
  outside: number;
  /** Media imported from the folder in this session. */
  imported: number;
}

export const useWatch = create<{ status: Record<Uuid, WatchStatus> }>(() => ({ status: {} }));

const SCAN_MS = 3000;
let scans = new Map<Uuid, FolderScan>();
let imported = new Map<Uuid, number>();
let projectId: string | null = null;
let announced = false;
let busy = false;

export const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

function projectKeys(): Set<string> {
  return new Set((useProject.getState().project?.media ?? []).filter((m) => !m.title).map((m) => fileKey(m.path)));
}

function publish(folders: WatchFolder[]) {
  const status: Record<Uuid, WatchStatus> = {};
  for (const w of folders) {
    const s = scans.get(w.id);
    if (s) status[w.id] = { missing: s.missing, outside: s.outside.length, imported: imported.get(w.id) ?? 0 };
  }
  useWatch.setState({ status });
}

async function importInto(w: WatchFolder, paths: string[]) {
  const d = await api.importMedia(paths, w.bin);
  if (useProject.getState().project?.id !== projectId) return 0;
  useProject.getState().applyDelta(d);
  const n = d.outcome.created.length;
  imported.set(w.id, (imported.get(w.id) ?? 0) + n);
  return n;
}

/** Forgets the scans when another project is open. */
function follow(): WatchFolder[] | null {
  const p = useProject.getState().project;
  if (!p) return null;
  if (p.id !== projectId) {
    projectId = p.id;
    scans = new Map();
    imported = new Map();
    announced = false;
    useWatch.setState({ status: {} });
  }
  const folders = p.watchFolders ?? [];
  for (const id of [...scans.keys()]) if (!folders.some((w) => w.id === id)) scans.delete(id);
  return folders;
}

async function tick() {
  const folders = follow();
  if (!folders || busy) return;
  if (!folders.length) {
    announced = true;
    return;
  }
  busy = true;
  try {
    const listing = await api.watchScan(folders.map((w) => ({ path: w.path, subfolders: w.subfolders })));
    if (useProject.getState().project?.id !== projectId) return;
    const keys = projectKeys();
    for (const [i, w] of folders.entries()) {
      const { state, ready } = scanStep(scans.get(w.id), listing[i] ?? null, (k) => keys.has(k));
      scans.set(w.id, state);
      if (!ready.length) continue;
      const n = await importInto(w, ready);
      if (n) toast.success(n === 1 ? "1 neues Medium importiert" : `${n} neue Medien importiert`, `Überwachter Ordner „${folderName(w.path)}“`);
    }
    if (!announced) {
      announced = true;
      const outside = folders.reduce((n, w) => n + (scans.get(w.id)?.outside.length ?? 0), 0);
      if (outside) toast.info(outside === 1 ? "1 Datei in überwachten Ordnern ist nicht im Projekt" : `${outside} Dateien in überwachten Ordnern sind nicht im Projekt`, "Projekt › Ordner › Abgleichen importiert sie.");
    }
    publish(folders);
  } catch (e) {
    void api.logFrontend("warn", `Überwachte Ordner: ${String(e)}`);
  } finally {
    busy = false;
  }
}

/** Imports the folder's files that are not in the project, now. Returns how many were imported (null = folder missing). */
export async function syncWatchFolder(id: Uuid): Promise<number | null> {
  const w = follow()?.find((x) => x.id === id);
  if (!w) return 0;
  const [files] = await api.watchScan([{ path: w.path, subfolders: w.subfolders }]);
  if (!files) {
    scans.set(id, scanStep(scans.get(id), null, () => false).state);
    publish(follow() ?? []);
    return null;
  }
  const keys = projectKeys();
  const { state } = scanStep(undefined, files, (k) => keys.has(k));
  scans.set(id, state);
  const n = state.outside.length ? await importInto(w, state.outside) : 0;
  state.outside = [];
  publish(follow() ?? []);
  return n;
}

/** Starts scanning; returns the cleanup. */
export function startWatchFolders(): () => void {
  const timer = window.setInterval(() => void tick(), SCAN_MS);
  void tick();
  return () => window.clearInterval(timer);
}
