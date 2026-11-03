// Effect browser entries and the operations shared by the browser, the
// Inspector's effect stack, the timeline drop target and the action registry.

import { open, save } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { FX_CATALOG, fxDefaults, type FxCategory } from "../engine/fx";
import { engine } from "../engine/playback";
import { api } from "../lib/ipc";
import type { Clip, Effect, EffectKind, Preset, Sequence, Uuid } from "../lib/types";
import { findClip } from "../timeline/geometry";
import { useEditor } from "../state/editor";
import { importPresets, savePreset, touchRecent, useLibrary } from "../state/library";
import { activeSequence, edit, reportError, useProject } from "../state/project";
import { toast } from "../state/toasts";
import { prompt } from "./project";

export type BrowserCategory = FxCategory | "basic";

export const CATEGORY_LABELS: Record<BrowserCategory, string> = {
  basic: "Grundlagen",
  color: "Farbe",
  blur: "Unschärfe und Schärfe",
  light: "Licht",
  distort: "Verzerren",
  stylize: "Stilisieren",
  keying: "Keying und Masken",
  transform: "Transformieren",
};

export interface EffectEntry {
  /** "fx:<id>" for catalogue effects, "builtin:<type>" for the original ones. */
  key: string;
  label: string;
  description: string;
  category: BrowserCategory;
  /** Export is noticeably slower for this effect. */
  heavy: boolean;
  /** Needs a file (LUT) chosen when applied. */
  needsFile?: boolean;
  make: () => EffectKind | null;
}

const BUILTINS: EffectEntry[] = [
  { key: "builtin:blur", label: "Gaußscher Weichzeichner", category: "blur", heavy: false, description: "Weichzeichnen mit einstellbarem Radius.", make: () => ({ type: "blur", radius: 4 }) },
  { key: "builtin:sharpen", label: "Schärfen", category: "blur", heavy: false, description: "Unscharf maskieren: hebt Kanten an.", make: () => ({ type: "sharpen", amount: 0.6, radius: 1.5 }) },
  { key: "builtin:vignette", label: "Vignette", category: "light", heavy: false, description: "Dunkelt die Bildränder ab.", make: () => ({ type: "vignette", amount: 0.4 }) },
  { key: "builtin:lut", label: "LUT (.cube)", category: "color", heavy: false, needsFile: true, description: "Wendet eine 3D-LUT aus einer .cube-Datei an.", make: () => null },
  {
    key: "builtin:chromaKey",
    label: "Chroma-Key",
    category: "keying",
    heavy: false,
    description: "Stanzt eine Farbe aus (Greenscreen), mit Pipette im Monitor.",
    make: () => ({ type: "chromaKey", color: [0, 1, 0], similarity: 0.12, blend: 0.08, spill: 0.5 }),
  },
  { key: "builtin:colorWheels", label: "Farbräder", category: "color", heavy: false, description: "Lift, Gamma und Gain je Farbkanal.", make: () => ({ type: "colorWheels", lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] }) },
  { key: "builtin:curves", label: "Kurven", category: "color", heavy: false, description: "Gradationskurven für Master, Rot, Grün und Blau.", make: () => ({ type: "curves", master: [], red: [], green: [], blue: [] }) },
];

export const EFFECT_ENTRIES: EffectEntry[] = [
  ...BUILTINS,
  ...FX_CATALOG.map(
    (d): EffectEntry => ({
      key: `fx:${d.id}`,
      label: d.label,
      description: d.description,
      category: d.category,
      heavy: d.heavy,
      make: () => ({ type: "fx", fx: d.id, params: fxDefaults(d) }),
    }),
  ),
];

export const entryByKey = (key: string) => EFFECT_ENTRIES.find((e) => e.key === key);

/** Catalogue label of an effect (the user's name wins). */
export function effectLabel(e: Effect): string {
  if (e.name) return e.name;
  const key = e.type === "fx" ? `fx:${e.fx}` : `builtin:${e.type}`;
  return entryByKey(key)?.label ?? (e.type === "fx" ? e.fx : e.type);
}

/** A fresh effect with the defaults of its kind (keeps LUT path and name). */
export function resetEffect(e: Effect): Effect {
  if (e.type === "lut") return { ...e, intensity: 1 };
  const key = e.type === "fx" ? `fx:${e.fx}` : `builtin:${e.type}`;
  const kind = entryByKey(key)?.make();
  return kind ? ({ id: e.id, enabled: true, ...(e.name ? { name: e.name } : {}), ...kind } as Effect) : e;
}

const newId = () => crypto.randomUUID();

const seqNow = (): Sequence | null => activeSequence(useProject.getState().project);

/** Selected clips on unlocked video tracks. */
export function selectedVideoClips(s: Sequence | null = seqNow()): Clip[] {
  if (!s) return [];
  const sel = new Set(useEditor.getState().selection);
  return s.tracks.filter((t) => t.kind === "video" && !t.locked).flatMap((t) => t.clips.filter((c) => sel.has(c.id)));
}

export async function pickLut(): Promise<string | null> {
  const sel = await open({ multiple: false, directory: false, filters: [{ name: "3D-LUT", extensions: ["cube"] }] });
  return typeof sel === "string" ? sel : null;
}

/** Builds the effect of a browser entry (asks for a LUT file if needed). */
export async function entryEffect(entry: EffectEntry): Promise<Effect | null> {
  let kind = entry.make();
  if (entry.needsFile) {
    const path = await pickLut();
    if (!path) return null;
    kind = { type: "lut", path, intensity: 1 };
  }
  return kind ? ({ id: newId(), enabled: true, ...kind } as Effect) : null;
}

/** Appends effects to clips (default: the selected video clips), one undo step. */
export async function addEffectsTo(effects: Effect[], clips?: Uuid[]): Promise<boolean> {
  const s = seqNow();
  if (!s || !effects.length) return false;
  const ids = clips ?? selectedVideoClips(s).map((c) => c.id);
  if (!ids.length) {
    toast.info("Keine Videoclips ausgewählt", "Clips in der Timeline auswählen oder den Effekt auf einen Clip ziehen.");
    return false;
  }
  return !!(await edit({ type: "addEffects", sequence: s.id, clips: ids, effects }));
}

export async function applyEntry(entry: EffectEntry, clips?: Uuid[]) {
  const e = await entryEffect(entry);
  if (e && (await addEffectsTo([e], clips))) void touchRecent("effect", entry.key);
}

export async function applyPreset(p: Preset, clips?: Uuid[]) {
  if (p.kind !== "effects" || !Array.isArray(p.data)) return;
  const effects = (p.data as Effect[]).map((e) => ({ ...e, id: newId() }));
  if (await addEffectsTo(effects, clips)) void touchRecent("preset", p.id);
}

// --- clipboard -----------------------------------------------------------------------

/** Copies the effect stack of the first selected video clip. */
export function copyEffects(only?: Effect[]) {
  const effects = only ?? selectedVideoClips()[0]?.effects ?? [];
  if (!effects.length) {
    toast.info("Keine Effekte zum Kopieren");
    return;
  }
  useLibrary.getState().set({ effectClipboard: effects.map((e) => ({ ...e })) });
  toast.success(effects.length === 1 ? "Effekt kopiert" : `${effects.length} Effekte kopiert`);
}

/** Appends the copied effects to every selected video clip. */
export async function pasteEffects(clips?: Uuid[]) {
  const effects = useLibrary.getState().effectClipboard;
  if (!effects?.length) return;
  await addEffectsTo(
    effects.map((e) => ({ ...e, id: newId() })),
    clips,
  );
}

/** Turns all effects of the selected clips off or on (clip-level bypass). */
export async function toggleBypass(clips?: Clip[]) {
  const s = seqNow();
  const cs = clips ?? selectedVideoClips(s);
  if (!s || !cs.length) return;
  const on = !cs.every((c) => c.fxBypass);
  await edit({ type: "updateClips", sequence: s.id, clips: cs.map((c) => c.id), patch: { fxBypass: on } });
}

// --- presets -------------------------------------------------------------------------

export async function saveStackAsPreset(effects: Effect[]) {
  if (!effects.length) return;
  const name = await prompt({ title: "Effekt-Preset speichern", label: "Name", value: effects.length === 1 ? effectLabel(effects[0]) : "Mein Look", confirm: "Speichern" });
  if (!name?.trim()) return;
  const p = await savePreset("effects", name.trim(), effects);
  if (p) toast.success("Preset gespeichert", p.name);
}

export async function exportPresets(ids: string[]) {
  if (!ids.length) return;
  const path = await save({ defaultPath: "Kerf-Presets.kerfpreset", filters: [{ name: "Kerf-Preset", extensions: ["kerfpreset"] }] });
  if (!path) return;
  try {
    await api.presetExport(ids, path);
    toast.success("Presets exportiert");
  } catch (e) {
    reportError(e);
  }
}

export async function importPresetFile() {
  const sel = await open({ multiple: false, directory: false, filters: [{ name: "Kerf-Preset", extensions: ["kerfpreset"] }] });
  if (typeof sel !== "string") return;
  const n = await importPresets(sel);
  if (n) toast.success(n === 1 ? "1 Preset importiert" : `${n} Presets importiert`);
}

export const hasEffectClipboard = () => !!useLibrary.getState().effectClipboard?.length;
export const firstSelectedHasEffects = () => (selectedVideoClips()[0]?.effects?.length ?? 0) > 0;
export const findSeqClip = (id: Uuid) => {
  const s = seqNow();
  return s ? findClip(s, id) : null;
};

// --- before/after ----------------------------------------------------------------------

/** Before/after comparison: the preview shows every clip without effects while on. */
export const useFxCompare = create<{ on: boolean }>(() => ({ on: false }));

export function setCompare(on: boolean) {
  useFxCompare.setState({ on });
  engine.setCompareBypass(on);
}
