// Project-level operations: new/open/save/import/recovery, plus the
// unsaved-changes guard shared by every operation that replaces the document.

import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../lib/ipc";
import { engine } from "../engine/playback";
import { useEditor } from "../state/editor";
import { edit, reportError, useProject } from "../state/project";
import { toast } from "../state/toasts";

const PROJECT_FILTER = [{ name: "Kerf-Projekt", extensions: ["kerf"] }];
export const MEDIA_EXTENSIONS = [
  "mp4", "mov", "m4v", "mkv", "webm", "avi", "mxf", "mts", "m2ts", "ts", "mpg", "mpeg", "wmv", "3gp",
  "wav", "mp3", "aac", "m4a", "flac", "ogg", "opus", "aif", "aiff",
  "png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp", "gif",
];

export function confirm(opts: { title: string; body: string; confirm: string; danger?: boolean; discard?: string }) {
  return new Promise<boolean | "discard">((resolve) =>
    useEditor.getState().set({ dialog: { kind: "confirm", ...opts, resolve } }),
  );
}

/** Asks for a line of text; resolves null when cancelled. */
export function prompt(opts: { title: string; label: string; value: string; confirm: string }) {
  return new Promise<string | null>((resolve) => useEditor.getState().set({ dialog: { kind: "prompt", ...opts, resolve } }));
}

/** Resolves true when it is OK to replace the current document. */
export async function guardUnsaved(): Promise<boolean> {
  if (!useProject.getState().dirty) return true;
  const answer = await confirm({
    title: "Ungespeicherte Änderungen",
    body: `Möchtest du die Änderungen an „${useProject.getState().project?.name ?? "Projekt"}“ speichern?`,
    confirm: "Speichern",
    discard: "Nicht speichern",
  });
  if (answer === "discard") return true;
  if (answer === true) return saveProject();
  return false;
}

function resetView() {
  engine.pause();
  engine.seek(0);
  useEditor.getState().set({ selection: [], mediaSelection: [], currentBin: null, scrollX: 0, scrollY: 0 });
}

export async function newProject() {
  if (!(await guardUnsaved())) return;
  try {
    useProject.getState().applyState(await api.projectNew("Unbenanntes Projekt"));
    resetView();
  } catch (e) {
    reportError(e);
  }
}

export async function openProject(path?: string) {
  if (!(await guardUnsaved())) return;
  const file = path ?? (await open({ multiple: false, directory: false, filters: PROJECT_FILTER }));
  if (!file || Array.isArray(file)) return;
  try {
    const { state, usedBackup } = await api.projectOpen(file);
    useProject.getState().applyState(state);
    resetView();
    rememberRecent(file);
    if (usedBackup) toast.info("Projektdatei war beschädigt", "Die letzte Sicherung (.bak) wurde geladen. Bitte speichern.");
    const missing = state.project.media.filter((m) => m.status.state === "missing").length;
    if (missing) toast.error(`${missing} Mediendatei(en) offline`, "Rechtsklick auf die Medien → Neu verknüpfen.");
  } catch (e) {
    reportError(e);
  }
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const st = useProject.getState();
  let path = saveAs ? null : st.path;
  if (!path) {
    path = await save({ filters: PROJECT_FILTER, defaultPath: `${st.project?.name ?? "Projekt"}.kerf` });
    if (!path) return false;
  }
  try {
    const r = await api.projectSave(path);
    useProject.getState().markSaved(r.path, r.revision, r.dirty, r.name);
    rememberRecent(r.path);
    toast.success("Gespeichert", r.path);
    return true;
  } catch (e) {
    reportError(e);
    return false;
  }
}

export async function importMedia(paths?: string[], directory = false) {
  let files = paths;
  if (!files) {
    const sel = await open({
      multiple: true,
      directory,
      filters: directory ? undefined : [{ name: "Medien", extensions: MEDIA_EXTENSIONS }],
    });
    if (!sel) return;
    files = Array.isArray(sel) ? sel : [sel];
  }
  if (!files.length) return;
  try {
    const d = await api.importMedia(files, useEditor.getState().currentBin);
    useProject.getState().applyDelta(d);
    const n = d.outcome.created.length;
    if (n === 0) toast.info("Keine neuen Medien", "Die Dateien sind bereits im Projekt oder werden nicht unterstützt.");
    else useEditor.getState().set({ mediaSelection: d.outcome.created });
  } catch (e) {
    reportError(e);
  }
}

export async function relinkMedia(id: string) {
  const sel = await open({ multiple: false, directory: false, filters: [{ name: "Medien", extensions: MEDIA_EXTENSIONS }] });
  if (!sel || Array.isArray(sel)) return;
  await edit({ type: "relinkMedia", media: id, path: sel });
}

export async function undo() {
  try {
    const d = await api.undo();
    if (d) {
      useProject.getState().applyDelta(d);
      pruneSelection();
    }
  } catch (e) {
    reportError(e);
  }
}

export async function redo() {
  try {
    const d = await api.redo();
    if (d) {
      useProject.getState().applyDelta(d);
      pruneSelection();
    }
  } catch (e) {
    reportError(e);
  }
}

/** Jumps to any step of the undo history (History panel). */
export async function historyGoto(position: number) {
  try {
    useProject.getState().applyState(await api.historyGoto(position));
    pruneSelection();
  } catch (e) {
    reportError(e);
  }
}

function pruneSelection() {
  const p = useProject.getState().project;
  if (!p) return;
  const ids = new Set(p.sequences.flatMap((s) => s.tracks.flatMap((t) => t.clips.map((c) => c.id))));
  const ed = useEditor.getState();
  ed.set({ selection: ed.selection.filter((id) => ids.has(id)) });
}

// --- recent projects ---------------------------------------------------------

const RECENT_KEY = "kerf.recent.v1";

// The same file can arrive as "C:/x" (file dialogs) or "C:\x" (shell, drag and drop).
const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

export function recentProjects(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
    return list.filter((p, i) => list.findIndex((q) => samePath(p, q)) === i);
  } catch {
    return [];
  }
}

function rememberRecent(path: string) {
  try {
    const list = [path, ...recentProjects().filter((p) => !samePath(p, path))].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

// --- window ------------------------------------------------------------------

export async function quit() {
  if (!(await guardUnsaved())) return;
  await api.sessionEnd().catch(() => undefined);
  await getCurrentWindow().destroy();
}
