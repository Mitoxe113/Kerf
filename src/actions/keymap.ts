// Keyboard shortcuts: defaults from the action registry, user overrides in
// localStorage, and the global key handler.

import { create } from "zustand";
import { ACTIONS, ACTION_BY_ID, runAction } from "./registry";

const KEY = "kerf.keymap.v1";
const PROFILES_KEY = "kerf.keymap.profiles.v1";
/** The built-in bindings (no overrides). */
export const DEFAULT_PROFILE = "Standard";

export type Overrides = Record<string, string[]>;

/** File format of an exported keyboard profile. */
export interface KeymapFile {
  app: "kerf";
  kind: "keymap";
  version: 1;
  name: string;
  overrides: Overrides;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

interface KeymapStore {
  overrides: Overrides;
  /** Saved profiles by name (the default one is implicit). */
  profiles: Record<string, Overrides>;
  /** Profile the current bindings started from. */
  profile: string;
  setKeys: (action: string, keys: string[]) => void;
  reset: (action?: string) => void;
  saveProfile: (name: string) => void;
  loadProfile: (name: string) => void;
  deleteProfile: (name: string) => void;
}

const stored = read<{ profiles: Record<string, Overrides>; profile: string }>(PROFILES_KEY, { profiles: {}, profile: DEFAULT_PROFILE });

export const useKeymap = create<KeymapStore>((set) => ({
  overrides: read<Overrides>(KEY, {}),
  profiles: stored.profiles,
  profile: stored.profiles[stored.profile] ? stored.profile : DEFAULT_PROFILE,
  setKeys: (action, keys) => set((s) => ({ overrides: { ...s.overrides, [action]: keys } })),
  reset: (action) =>
    set((s) => {
      if (!action) return { overrides: {} };
      const o = { ...s.overrides };
      delete o[action];
      return { overrides: o };
    }),
  saveProfile: (name) => set((s) => ({ profiles: { ...s.profiles, [name]: s.overrides }, profile: name })),
  loadProfile: (name) => set((s) => ({ overrides: { ...(s.profiles[name] ?? {}) }, profile: s.profiles[name] ? name : DEFAULT_PROFILE })),
  deleteProfile: (name) =>
    set((s) => {
      const profiles = { ...s.profiles };
      delete profiles[name];
      return { profiles, profile: s.profile === name ? DEFAULT_PROFILE : s.profile };
    }),
}));

useKeymap.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s.overrides));
    localStorage.setItem(PROFILES_KEY, JSON.stringify({ profiles: s.profiles, profile: s.profile }));
  } catch {
    // ignore
  }
});

/** True when the bindings differ from the profile they started from. */
export function profileChanged(s: Pick<KeymapStore, "overrides" | "profiles" | "profile">): boolean {
  const base = s.profile === DEFAULT_PROFILE ? {} : (s.profiles[s.profile] ?? {});
  const norm = (o: Overrides) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  return norm(s.overrides) !== norm(base);
}

export function keymapFile(name: string, overrides: Overrides): KeymapFile {
  return { app: "kerf", kind: "keymap", version: 1, name, overrides };
}

/**
 * Validates an imported profile. Unknown commands (e.g. from a newer
 * version) are skipped and counted.
 */
export function parseKeymapFile(text: string, knownIds: Set<string>): { name: string; overrides: Overrides; skipped: number } {
  const data = JSON.parse(text) as Partial<KeymapFile>;
  if (data?.app !== "kerf" || data.kind !== "keymap" || typeof data.overrides !== "object" || data.overrides === null) {
    throw new Error("Keine Kerf-Tastaturbelegung");
  }
  const overrides: Overrides = {};
  let skipped = 0;
  for (const [id, keys] of Object.entries(data.overrides)) {
    if (!knownIds.has(id) || !Array.isArray(keys) || !keys.every((k) => typeof k === "string")) skipped++;
    else overrides[id] = keys;
  }
  return { name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Importiert", overrides, skipped };
}

export function keysFor(action: string): string[] {
  return useKeymap.getState().overrides[action] ?? ACTION_BY_ID.get(action)?.keys ?? [];
}

/** Canonical combo string for a keyboard event, e.g. "Ctrl+Shift+K". */
export function comboOf(e: KeyboardEvent): string | null {
  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "Dead"].includes(k)) return null;
  let key: string;
  if (k === " ") key = "Space";
  else if (k.length === 1) key = k.toUpperCase();
  else key = k;
  // Shifted symbols already encode Shift (e.g. "+" on QWERTZ is unshifted, "*" is Shift++).
  const symbol = k.length === 1 && k !== " " && !/[a-z0-9]/i.test(k);
  const mods = [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey && !symbol ? "Shift" : ""].filter(Boolean);
  return [...mods, key].join("+");
}

export function formatCombo(combo: string): string {
  return combo
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("ArrowUp", "↑")
    .replace("ArrowDown", "↓")
    .replace("Ctrl", "Strg")
    .replace("Shift", "⇧")
    .replace("Delete", "Entf")
    .replace("Backspace", "⌫")
    .replace("Escape", "Esc")
    .replace("Space", "Leertaste")
    .replace("Home", "Pos1")
    .replace("End", "Ende");
}

function buildIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const a of ACTIONS) for (const k of keysFor(a.id)) if (!index.has(k)) index.set(k, a.id);
  return index;
}

let index = buildIndex();
useKeymap.subscribe(() => (index = buildIndex()));

export function actionForCombo(combo: string): string | undefined {
  return index.get(combo);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Set while the shortcut editor records a new binding. */
export const recording = { active: false };

export function installKeyboard(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (recording.active) return;
    const combo = comboOf(e);
    if (!combo) return;
    if (isTyping(e.target) && !["Ctrl+S", "Ctrl+Z", "Ctrl+Shift+Z", "Escape"].includes(combo)) return;
    if (isTyping(e.target) && combo === "Escape") {
      (e.target as HTMLElement).blur();
      return;
    }
    const id = actionForCombo(combo);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    runAction(id);
  };
  window.addEventListener("keydown", onKey, { capture: true });
  return () => window.removeEventListener("keydown", onKey, { capture: true });
}
