// Media browser state: providers (with key status), the current search, the
// download queue (mirrored from the backend's events) and the asset library.
// Downloads land in the library; adding them to the project goes through the
// normal media import, placing them through the normal timeline edit.

import { create } from "zustand";
import { api, events } from "../lib/ipc";
import type { AssetQuery, AssetRecord, DownloadJob, MediaAsset, ProviderId, ProviderInfo, RemoteAsset, SearchKind, Uuid } from "../lib/types";
import { useEditor } from "./editor";
import { reportError, useProject } from "./project";
import { toast } from "./toasts";

interface SearchState {
  provider: ProviderId;
  kind: SearchKind;
  query: string;
  commercialOnly: boolean;
  page: number;
  results: RemoteAsset[];
  hasMore: boolean;
  total: number | null;
  notice: string;
  loading: boolean;
  error: string | null;
}

interface AssetState {
  providers: ProviderInfo[];
  search: SearchState;
  downloads: DownloadJob[];
  library: AssetRecord[];
  libraryQuery: AssetQuery;
  libraryError: string | null;
}

export const useAssets = create<AssetState>(() => ({
  providers: [],
  search: { provider: "openverse", kind: "photo", query: "", commercialOnly: false, page: 1, results: [], hasMore: false, total: null, notice: "", loading: false, error: null },
  downloads: [],
  library: [],
  libraryQuery: { limit: 500 },
  libraryError: null,
}));

const st = () => useAssets.getState();
const setSearch = (p: Partial<SearchState>) => useAssets.setState({ search: { ...st().search, ...p } });

const message = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));

let started = false;
/** Loads providers and downloads and follows download events (once). */
export function initAssets() {
  if (started) return;
  started = true;
  void refreshProviders();
  void api.mediaDownloads().then((downloads) => useAssets.setState({ downloads })).catch(() => undefined);
  void loadAssetLibrary();
  void events.mediaDownload((j) => {
    const list = st().downloads;
    const i = list.findIndex((d) => d.id === j.id);
    useAssets.setState({ downloads: i < 0 ? [...list, j] : list.map((d, k) => (k === i ? j : d)) });
    if (j.state === "done" && (i < 0 || list[i].state !== "done")) {
      void loadAssetLibrary();
      toast.success(j.existing ? "Bereits in der Bibliothek" : "Download abgeschlossen", j.title);
    } else if (j.state === "failed" && (i < 0 || list[i].state !== "failed")) {
      toast.error("Download fehlgeschlagen", j.error ?? undefined);
    }
  });
}

export async function refreshProviders() {
  try {
    useAssets.setState({ providers: await api.mediaProviders() });
  } catch (e) {
    reportError(e);
  }
}

export async function setProviderKey(provider: ProviderId, key: string, persist: boolean) {
  try {
    const where = await api.mediaSetKey(provider, key, persist);
    toast.success("API-Schlüssel gespeichert", where === "system" ? "Im Schlüsselspeicher des Betriebssystems" : "Nur bis Kerf beendet wird");
  } catch (e) {
    reportError(e);
  }
  await refreshProviders();
}

export async function clearProviderKey(provider: ProviderId) {
  try {
    await api.mediaClearKey(provider);
  } catch (e) {
    reportError(e);
  }
  await refreshProviders();
}

export function setSearchOptions(p: Partial<Pick<SearchState, "provider" | "kind" | "query" | "commercialOnly">>) {
  const next = { ...st().search, ...p };
  const info = st().providers.find((x) => x.id === next.provider);
  if (info && !info.kinds.includes(next.kind)) next.kind = info.kinds[0];
  useAssets.setState({ search: next });
}

let searchSeq = 0;
/** Runs the search (page 1), or loads the next page with `more`. */
export async function runSearch(more = false) {
  const s = st().search;
  const query = s.query.trim();
  if (!query) return;
  const page = more ? s.page + 1 : 1;
  const n = ++searchSeq;
  setSearch({ loading: true, error: null, ...(more ? {} : { results: [], notice: "", total: null }) });
  try {
    const r = await api.mediaSearch({ provider: s.provider, kind: s.kind, query, page, commercialOnly: s.commercialOnly });
    if (n !== searchSeq) return;
    setSearch({ loading: false, page, results: more ? [...st().search.results, ...r.results] : r.results, hasMore: r.hasMore, total: r.total, notice: r.notice });
  } catch (e) {
    if (n !== searchSeq) return;
    setSearch({ loading: false, error: message(e) });
  }
}

export async function download(a: RemoteAsset, file = 0) {
  try {
    const job = await api.mediaDownload(a.provider, a.providerId, file);
    const list = st().downloads;
    if (!list.some((d) => d.id === job.id)) useAssets.setState({ downloads: [...list, job] });
  } catch (e) {
    reportError(e);
  }
}

export const cancelDownload = (id: string) => api.mediaDownloadCancel(id).catch(reportError);

export async function clearDownloads() {
  await api.mediaDownloadsClear().catch(reportError);
  useAssets.setState({ downloads: st().downloads.filter((d) => d.state === "queued" || d.state === "running") });
}

export async function loadAssetLibrary(q: AssetQuery = st().libraryQuery) {
  useAssets.setState({ libraryQuery: q });
  try {
    useAssets.setState({ library: await api.assetList(q), libraryError: null });
  } catch (e) {
    useAssets.setState({ libraryError: message(e) });
  }
}

export async function favoriteAsset(a: AssetRecord, on: boolean) {
  try {
    await api.assetFavorite(a.id, on);
    useAssets.setState({ library: st().library.map((x) => (x.id === a.id ? { ...x, favorite: on } : x)) });
  } catch (e) {
    reportError(e);
  }
}

export async function deleteAsset(a: AssetRecord, deleteFile: boolean) {
  try {
    await api.assetDelete(a.id, deleteFile);
    await loadAssetLibrary();
  } catch (e) {
    reportError(e);
  }
}

// --- project integration ------------------------------------------------------------------

const mediaWithPath = (path: string): MediaAsset | undefined => useProject.getState().project?.media.find((m) => m.path === path);

/** Imports a library file into the project (or finds it there) and returns its media id. */
export async function addToProject(a: AssetRecord): Promise<Uuid | null> {
  if (a.missing || !a.filePath) {
    toast.error("Datei fehlt", "Die heruntergeladene Datei ist nicht mehr vorhanden. Bitte erneut herunterladen.");
    return null;
  }
  const existing = mediaWithPath(a.filePath);
  if (existing) return existing.id;
  try {
    const d = await api.importMedia([a.filePath], useEditor.getState().currentBin);
    useProject.getState().applyDelta(d);
    const id = d.outcome.created[0] ?? mediaWithPath(a.filePath)?.id ?? null;
    if (id) useEditor.getState().set({ mediaSelection: [id] });
    return id;
  } catch (e) {
    reportError(e);
    return null;
  }
}

/** Resolves once the media's analysis finished (ready), or false on failure/timeout. */
function whenReady(id: Uuid, ms = 120_000): Promise<boolean> {
  const state = () => useProject.getState().mediaById.get(id)?.status.state;
  return new Promise((resolve) => {
    const check = () => {
      const s = state();
      if (s === "ready") return true;
      if (s === "missing" || s === "error") return false;
      return null;
    };
    const now = check();
    if (now !== null) return resolve(now);
    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, ms);
    const unsub = useProject.subscribe(() => {
      const r = check();
      if (r === null) return;
      clearTimeout(timer);
      unsub();
      resolve(r);
    });
  });
}

/** Adds the asset to the project and inserts it at the playhead of the active sequence. */
export async function insertAtPlayhead(a: AssetRecord) {
  const id = await addToProject(a);
  if (!id) return;
  if (!(await whenReady(id))) {
    toast.error("Medium nicht bereit", "Die Datei konnte nicht analysiert werden.");
    return;
  }
  const { placeMedia } = await import("../actions/editing");
  await placeMedia([id], "insert");
}
