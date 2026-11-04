// Titles and subtitles: creating, importing and exporting.

import { open, save } from "@tauri-apps/plugin-dialog";
import { engine } from "../engine/playback";
import { storeTitle, TITLE_STYLE } from "../engine/text";
import { api } from "../lib/ipc";
import { fpsOf } from "../lib/time";
import type { Cue, MediaAsset, Sequence, TitleSpec, Uuid } from "../lib/types";
import { useEditor } from "../state/editor";
import { holdingBin } from "../lib/smart";
import { activeSequence, edit, reportError, useProject } from "../state/project";
import { toast } from "../state/toasts";
import { confirm } from "./project";

const seq = (): Sequence | null => activeSequence(useProject.getState().project);
const playhead = () => Math.round(engine.frame);
const free = (s: Sequence, track: number, from: number, to: number) => {
  const t = s.tracks[track];
  return !t.locked && t.clips.every((c) => c.start + c.duration <= from || c.start >= to);
};

/** Media entry of a title: a generated image of the sequence size. */
function titleAsset(spec: TitleSpec, path: string, s: Sequence): MediaAsset {
  return {
    id: crypto.randomUUID(),
    path,
    name: "Titel",
    kind: "image",
    status: { state: "ready" },
    info: {
      duration: 0,
      sizeBytes: 0,
      container: "png",
      bitRate: null,
      video: { codec: "png", profile: null, width: spec.width, height: spec.height, fps: s.settings.fps, pixFmt: "rgba", bitRate: null, rotation: 0 },
      audio: null,
    },
    bin: holdingBin(useProject.getState().project?.bins ?? [], useEditor.getState().currentBin),
    favorite: false,
    label: "none",
    tags: [],
    note: "",
    importedAt: Date.now(),
    derived: { poster: null, filmstrip: null, peaks: null, proxy: null, previewNative: true },
    title: spec,
  };
}

/**
 * Adds a 5 s title at the playhead on the lowest free video track above V1
 * (a new track when none is free) and opens it in the inspector.
 */
export async function addTitle() {
  const s = seq();
  if (!s) return;
  const at = playhead();
  const duration = Math.max(1, Math.round(5 * fpsOf(s.settings.fps)));
  const video = s.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === "video");
  const above = video.slice(1).find(({ i }) => free(s, i, at, at + duration));
  let track: Uuid | undefined = above?.t.id ?? (video.length === 1 && free(s, video[0].i, at, at + duration) ? video[0].t.id : undefined);
  try {
    if (!track) {
      const d = await edit({ type: "addTrack", sequence: s.id, kind: "video" });
      track = d?.outcome.created[0];
      if (!track) return;
    }
    const spec: TitleSpec = { text: "Titel", style: TITLE_STYLE, x: 0.5, y: 0.5, width: s.settings.width, height: s.settings.height };
    const asset = titleAsset(spec, await storeTitle(spec), s);
    const d = await edit({ type: "addTitle", sequence: s.id, asset, track, at, duration });
    const clip = d?.outcome.created[0];
    if (clip) {
      const ed = useEditor.getState();
      ed.select([clip]);
      ed.set({ inspectorTab: "title" });
      ed.focusPanel("inspector");
    }
  } catch (e) {
    reportError(e);
  }
}

/** Media entry of an adjustment layer (mirrors MediaAsset::adjustment_layer in kerf-core). */
export function adjustmentAsset(s: Sequence): MediaAsset {
  return {
    id: crypto.randomUUID(),
    path: "",
    name: "Einstellungsebene",
    kind: "image",
    status: { state: "ready" },
    info: {
      duration: 0,
      sizeBytes: 0,
      container: "adjustment",
      bitRate: null,
      video: { codec: "adjustment", profile: null, width: s.settings.width, height: s.settings.height, fps: s.settings.fps, pixFmt: "rgba", bitRate: null, rotation: 0 },
      audio: null,
    },
    bin: holdingBin(useProject.getState().project?.bins ?? [], useEditor.getState().currentBin),
    favorite: false,
    label: "none",
    tags: [],
    note: "",
    importedAt: Date.now(),
    derived: { poster: null, filmstrip: null, peaks: null, proxy: null, previewNative: true },
    adjustment: true,
  };
}

/**
 * Adds a 5 s adjustment layer at the playhead on the first free video track
 * above every track with a clip there (a new track when none is free) and
 * opens its colour settings in the inspector.
 */
export async function addAdjustmentLayer() {
  const s = seq();
  if (!s) return;
  const at = playhead();
  const duration = Math.max(1, Math.round(5 * fpsOf(s.settings.fps)));
  const video = s.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === "video");
  const shown = (i: number) => s.tracks[i].clips.some((c) => c.start < at + duration && c.start + c.duration > at);
  const highest = video.reduce((h, v, k) => (shown(v.i) ? k : h), -1);
  let track: Uuid | undefined = video.slice(highest + 1).find(({ i }) => free(s, i, at, at + duration))?.t.id;
  try {
    if (!track) {
      const d = await edit({ type: "addTrack", sequence: s.id, kind: "video" });
      track = d?.outcome.created[0];
      if (!track) return;
    }
    const d = await edit({ type: "addAdjustment", sequence: s.id, asset: adjustmentAsset(s), track, at, duration });
    const clip = d?.outcome.created[0];
    if (clip) {
      const ed = useEditor.getState();
      ed.select([clip]);
      ed.set({ inspectorTab: "color" });
      ed.focusPanel("inspector");
    }
  } catch (e) {
    reportError(e);
  }
}

/** Commits an edited title: draws its PNG, then records the change. */
export async function updateTitle(media: Uuid, spec: TitleSpec) {
  try {
    await edit({ type: "updateTitle", media, title: spec, path: await storeTitle(spec) });
  } catch (e) {
    reportError(e);
  }
}

// --- subtitles -------------------------------------------------------------------------

export async function setCues(s: Sequence, cues: Cue[]) {
  await edit({ type: "setSubtitles", sequence: s.id, cues });
}

/** New cue at the playhead (3 s, or up to the next cue), selected for typing. */
export async function addCue() {
  const s = seq();
  if (!s) return;
  const at = playhead();
  const cues = s.subtitles.cues;
  if (cues.some((c) => c.start <= at && at < c.end)) {
    toast.info("Am Playhead steht schon ein Untertitel", "Den Playhead in eine Lücke setzen.");
    return;
  }
  const next = cues.find((c) => c.start > at)?.start ?? Infinity;
  const end = Math.min(at + Math.round(3 * fpsOf(s.settings.fps)), next);
  const cue: Cue = { id: crypto.randomUUID(), start: at, end, text: "" };
  await setCues(s, [...cues, cue]);
  useEditor.getState().set({ activeCue: cue.id });
  useEditor.getState().focusPanel("subtitles");
}

export async function importSubtitles() {
  const s = seq();
  if (!s) return;
  const file = await open({ multiple: false, directory: false, filters: [{ name: "Untertitel", extensions: ["srt", "vtt"] }] });
  if (typeof file !== "string") return;
  try {
    const timed = await api.subtitlesParse(file);
    const fps = fpsOf(s.settings.fps);
    const read: Cue[] = timed.map((t) => ({ id: crypto.randomUUID(), start: Math.round(t.start * fps), end: Math.round(t.end * fps), text: t.text }));
    let cues = read;
    if (s.subtitles.cues.length) {
      const replace = await confirm({
        title: "Untertitel importieren",
        body: `Die Sequenz hat schon ${s.subtitles.cues.length} Untertitel. Ersetzen oder die neuen dazunehmen?`,
        confirm: "Ersetzen",
        discard: "Dazunehmen",
      });
      if (!replace) return;
      if (replace === "discard") cues = [...s.subtitles.cues, ...read];
    }
    await setCues(s, cues);
    toast.success("Untertitel importiert", `${read.length} aus ${file.split(/[\\/]/).pop()}`);
    useEditor.getState().focusPanel("subtitles");
  } catch (e) {
    reportError(e);
  }
}

export async function exportSubtitles() {
  const s = seq();
  if (!s || !s.subtitles.cues.length) return;
  const file = await save({ filters: [{ name: "SubRip", extensions: ["srt"] }, { name: "WebVTT", extensions: ["vtt"] }], defaultPath: `${s.name}.srt` });
  if (!file) return;
  try {
    await api.subtitlesWrite(file, s.id);
    toast.success("Untertitel gespeichert", file.split(/[\\/]/).pop() ?? file);
  } catch (e) {
    reportError(e);
  }
}
