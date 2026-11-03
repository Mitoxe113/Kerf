// Presets, favourites and recently used items from the local library
// (kerf-library, SQLite in the app data directory), plus the in-memory
// effect clipboard.

import { create } from "zustand";
import { api } from "../lib/ipc";
import type { Effect, ItemKind, Preset, PresetKind } from "../lib/types";
import { reportError } from "./project";

interface LibraryState {
  loaded: boolean;
  /** Set when the library could not be read (the browser still works without it). */
  error: string | null;
  presets: Preset[];
  favorites: Partial<Record<ItemKind, string[]>>;
  recents: Partial<Record<ItemKind, string[]>>;
  /** Copied effects (a whole stack or one effect). */
  effectClipboard: Effect[] | null;
  set: (p: Partial<LibraryState>) => void;
}

export const useLibrary = create<LibraryState>((set) => ({
  loaded: false,
  error: null,
  presets: [],
  favorites: {},
  recents: {},
  effectClipboard: null,
  set: (p) => set(p),
}));

const lib = () => useLibrary.getState();

let loading: Promise<void> | null = null;

/** Loads presets and the favourites and recents of `kinds` (once). */
export function loadLibrary(kinds: ItemKind[] = ["effect", "preset", "transition"]): Promise<void> {
  loading ??= (async () => {
    try {
      const presets = await api.presetList();
      const favorites: LibraryState["favorites"] = {};
      const recents: LibraryState["recents"] = {};
      for (const k of kinds) {
        favorites[k] = await api.favoriteList(k);
        recents[k] = await api.recentList(k);
      }
      lib().set({ presets, favorites, recents, loaded: true, error: null });
    } catch (e) {
      lib().set({ loaded: true, error: e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e) });
    }
  })();
  return loading;
}

export async function setFavorite(kind: ItemKind, key: string, on: boolean) {
  const cur = lib().favorites[kind] ?? [];
  lib().set({ favorites: { ...lib().favorites, [kind]: on ? [key, ...cur.filter((k) => k !== key)] : cur.filter((k) => k !== key) } });
  try {
    await api.favoriteSet(kind, key, on);
  } catch (e) {
    lib().set({ favorites: { ...lib().favorites, [kind]: cur } });
    reportError(e);
  }
}

export async function touchRecent(kind: ItemKind, key: string) {
  const cur = lib().recents[kind] ?? [];
  lib().set({ recents: { ...lib().recents, [kind]: [key, ...cur.filter((k) => k !== key)].slice(0, 30) } });
  // A missing library only costs the recents list.
  await api.recentTouch(kind, key).catch(() => undefined);
}

export async function savePreset(kind: PresetKind, name: string, data: unknown, category = ""): Promise<Preset | null> {
  try {
    const p = await api.presetSave({ id: "", kind, name, category, favorite: false, data, version: 1, createdAt: 0, updatedAt: 0 });
    lib().set({ presets: [...lib().presets, p] });
    return p;
  } catch (e) {
    reportError(e);
    return null;
  }
}

export async function renamePreset(id: string, name: string) {
  try {
    const p = await api.presetRename(id, name);
    lib().set({ presets: lib().presets.map((x) => (x.id === id ? p : x)) });
  } catch (e) {
    reportError(e);
  }
}

export async function favoritePreset(id: string, on: boolean) {
  try {
    await api.presetFavorite(id, on);
    lib().set({ presets: lib().presets.map((x) => (x.id === id ? { ...x, favorite: on } : x)) });
  } catch (e) {
    reportError(e);
  }
}

export async function deletePreset(id: string) {
  try {
    await api.presetDelete(id);
    lib().set({ presets: lib().presets.filter((x) => x.id !== id) });
  } catch (e) {
    reportError(e);
  }
}

export async function importPresets(path: string): Promise<number> {
  try {
    const got = await api.presetImport(path);
    const ids = new Set(got.map((p) => p.id));
    lib().set({ presets: [...lib().presets.filter((p) => !ids.has(p.id)), ...got] });
    return got.length;
  } catch (e) {
    reportError(e);
    return 0;
  }
}
