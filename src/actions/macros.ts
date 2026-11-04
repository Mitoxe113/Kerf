// Macros: named lists of commands from the action registry, run one after
// the other. Recorded from the commands run while recording (shortcuts,
// menus, command palette) or put together in the Makros dialog. Stored per
// user in localStorage, like the keyboard profiles.

import { create } from "zustand";

export interface Macro {
  id: string;
  name: string;
  /** Action ids (registry), in order. */
  steps: string[];
}

export const MAX_MACROS = 50;
export const MAX_STEPS = 100;
/** Macros reachable by the actions "Makro 1 ausführen" … */
export const NUMBERED_MACROS = 9;

const KEY = "kerf.macros.v1";

/** Commands that manage macros themselves never become steps. */
export const recordable = (id: string) => !id.startsWith("macro.");

/** Valid macros from stored or imported data: names trimmed, steps limited, unknown shapes dropped. */
export function parseMacros(data: unknown): Macro[] {
  if (!Array.isArray(data)) return [];
  const out: Macro[] = [];
  const ids = new Set<string>();
  for (const m of data) {
    if (!m || typeof m !== "object") continue;
    const { id, name, steps } = m as Partial<Macro>;
    if (typeof id !== "string" || !id || ids.has(id) || !Array.isArray(steps)) continue;
    ids.add(id);
    out.push({ id, name: (typeof name === "string" && name.trim()) || "Makro", steps: steps.filter((s): s is string => typeof s === "string" && recordable(s)).slice(0, MAX_STEPS) });
    if (out.length === MAX_MACROS) break;
  }
  return out;
}

function load(): Macro[] {
  try {
    return parseMacros(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return [];
  }
}

interface MacroStore {
  macros: Macro[];
  /** Steps recorded so far, null when not recording. */
  recording: string[] | null;
  add: (name: string, steps: string[]) => Macro | null;
  update: (id: string, patch: Partial<Omit<Macro, "id">>) => void;
  remove: (id: string) => void;
  move: (id: string, by: number) => void;
  startRecording: () => void;
  /** Records a command that just ran (ignored while not recording). */
  record: (action: string) => void;
  /** Ends the recording and returns its steps. */
  stopRecording: () => string[];
}

export const useMacros = create<MacroStore>((set, get) => ({
  macros: load(),
  recording: null,
  add: (name, steps) => {
    const n = name.trim();
    if (!n || get().macros.length >= MAX_MACROS) return null;
    const m: Macro = { id: crypto.randomUUID(), name: n, steps: steps.filter(recordable).slice(0, MAX_STEPS) };
    set((s) => ({ macros: [...s.macros, m] }));
    return m;
  },
  update: (id, patch) =>
    set((s) => ({
      macros: s.macros.map((m) =>
        // The name as typed (an empty one reads back as "Makro").
        m.id !== id ? m : { ...m, name: patch.name ?? m.name, steps: patch.steps ? patch.steps.filter(recordable).slice(0, MAX_STEPS) : m.steps },
      ),
    })),
  remove: (id) => set((s) => ({ macros: s.macros.filter((m) => m.id !== id) })),
  move: (id, by) =>
    set((s) => {
      const i = s.macros.findIndex((m) => m.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= s.macros.length) return {};
      const macros = [...s.macros];
      [macros[i], macros[j]] = [macros[j], macros[i]];
      return { macros };
    }),
  startRecording: () => set({ recording: [] }),
  record: (action) =>
    set((s) => (s.recording && recordable(action) && s.recording.length < MAX_STEPS ? { recording: [...s.recording, action] } : {})),
  stopRecording: () => {
    const steps = get().recording ?? [];
    set({ recording: null });
    return steps;
  },
}));

useMacros.subscribe((s, before) => {
  if (s.macros === before.macros) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s.macros));
  } catch {
    // Storage unavailable: macros last for this session.
  }
});

export interface StepAction {
  run: () => void | Promise<unknown>;
  enabled?: () => boolean;
}

export type MacroStop = { index: number; reason: "unknown" | "disabled" | "failed"; error?: unknown };

/**
 * Runs `steps` in order. Each step waits for the previous one (its promise
 * and `settle`, e.g. edits still on their way), and the macro stops at the
 * first command that does not exist, is not possible right now, or fails.
 */
export async function runSteps(steps: string[], lookup: (id: string) => StepAction | undefined, settle: () => Promise<void>): Promise<{ done: number; stop?: MacroStop }> {
  for (let i = 0; i < steps.length; i++) {
    const a = lookup(steps[i]);
    if (!a) return { done: i, stop: { index: i, reason: "unknown" } };
    if (a.enabled && !a.enabled()) return { done: i, stop: { index: i, reason: "disabled" } };
    try {
      await a.run();
      await settle();
    } catch (error) {
      return { done: i, stop: { index: i, reason: "failed", error } };
    }
  }
  return { done: steps.length };
}
