// Read-only mirror of the engine's document. Only the engine mutates the
// project; this store applies the snapshots and deltas it returns.

import { create } from "zustand";
import { api, isCommandError } from "../lib/ipc";
import { errorText } from "../lib/i18n";
import type { AppInfo, Delta, EditCommand, ExportJob, HistoryState, MediaAsset, Project, ProjectState, Sequence, Uuid } from "../lib/types";
import { applyDeltaToProject } from "./delta";
import { toast } from "./toasts";

interface ProjectStore {
  project: Project | null;
  mediaById: Map<Uuid, MediaAsset>;
  path: string | null;
  dirty: boolean;
  revision: number;
  history: HistoryState;
  /** Proxy generation progress per media id. */
  proxyJobs: Record<Uuid, number>;
  exports: ExportJob[];
  appInfo: AppInfo | null;
  /** Last explicit save and last recovery snapshot in this session (ms). */
  savedAt: number | null;
  autosavedAt: number | null;

  applyState: (s: ProjectState) => void;
  applyDelta: (d: Delta) => void;
  applyMedia: (a: MediaAsset) => void;
  setProxyJob: (id: Uuid, progress: number) => void;
  upsertExport: (j: ExportJob) => void;
  setExports: (j: ExportJob[]) => void;
  setAppInfo: (i: AppInfo) => void;
  markSaved: (path: string, revision: number, dirty: boolean, name: string) => void;
  markDirty: () => void;
  setAutosaved: (at: number) => void;
  setActiveSequence: (id: Uuid) => void;
}

const index = (media: MediaAsset[]) => new Map(media.map((m) => [m.id, m]));

export const useProject = create<ProjectStore>((set) => ({
  project: null,
  mediaById: new Map(),
  path: null,
  dirty: false,
  revision: 0,
  history: { undo: null, redo: null },
  proxyJobs: {},
  exports: [],
  appInfo: null,
  savedAt: null,
  autosavedAt: null,

  applyState: (s) =>
    set((st) => ({
      project: s.project,
      mediaById: index(s.project.media),
      path: s.path,
      dirty: s.dirty,
      revision: s.revision,
      history: s.history,
      ...(st.project?.id !== s.project.id && { savedAt: null, autosavedAt: null }),
    })),

  applyDelta: (d) =>
    set((st) => {
      if (!st.project) return {};
      const p = applyDeltaToProject(st.project, d);
      return {
        project: p,
        mediaById: d.media ? index(d.media) : st.mediaById,
        dirty: d.dirty,
        revision: d.revision,
        history: d.history,
      };
    }),

  applyMedia: (a) =>
    set((st) => {
      if (!st.project || !st.mediaById.has(a.id)) return {};
      const media = st.project.media.map((m) => (m.id === a.id ? a : m));
      const mediaById = new Map(st.mediaById);
      mediaById.set(a.id, a);
      return { project: { ...st.project, media }, mediaById };
    }),

  setProxyJob: (id, progress) =>
    set((st) => {
      const proxyJobs = { ...st.proxyJobs };
      if (progress < 0) delete proxyJobs[id];
      else proxyJobs[id] = progress;
      return { proxyJobs };
    }),

  upsertExport: (j) =>
    set((st) => {
      const i = st.exports.findIndex((x) => x.id === j.id);
      const exports = i < 0 ? [...st.exports, j] : st.exports.map((x) => (x.id === j.id ? j : x));
      return { exports };
    }),
  setExports: (exports) => set({ exports }),
  setAppInfo: (appInfo) => set({ appInfo }),
  markSaved: (path, revision, dirty, name) =>
    set((st) => ({ path, revision, dirty, savedAt: Date.now(), autosavedAt: null, project: st.project ? { ...st.project, name } : st.project })),
  markDirty: () => set({ dirty: true }),
  setAutosaved: (autosavedAt) => set({ autosavedAt }),
  setActiveSequence: (id) => set((st) => (st.project ? { project: { ...st.project, activeSequence: id }, dirty: true } : {})),
}));

export function activeSequence(p: Project | null): Sequence | null {
  if (!p) return null;
  return p.sequences.find((s) => s.id === p.activeSequence) ?? p.sequences[0] ?? null;
}

export const useActiveSequence = () => useProject((s) => activeSequence(s.project));

export function reportError(e: unknown, fallback = "Die Aktion ist fehlgeschlagen.") {
  if (isCommandError(e)) {
    // Engine detail is only informative for I/O failures and validation errors.
    const detailed = e.code.endsWith("Failed") || e.code === "invalid";
    toast.error(errorText(e.code, e.message), detailed ? e.message : undefined);
  } else {
    toast.error(fallback, String(e));
  }
}

/** Sends an edit to the engine and applies the result. Returns null on failure. */
export async function edit(cmd: EditCommand, opts: { silent?: boolean } = {}): Promise<Delta | null> {
  try {
    const d = await api.edit(cmd);
    useProject.getState().applyDelta(d);
    return d;
  } catch (e) {
    if (!opts.silent) reportError(e);
    return null;
  }
}
