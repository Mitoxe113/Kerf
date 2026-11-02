// Timeline operations triggered from menus, shortcuts and panels.

import { IDENTITY_COLOR, IDENTITY_TRANSFORM } from "../engine/math";
import { engine } from "../engine/playback";
import { displaySize } from "../lib/media";
import { formatRate, formatTimecode } from "../lib/time";
import type { Clip, ClipPatch, LabelColor, MarkerColor, PlaceMode, Sequence, TrackKind, Uuid } from "../lib/types";
import { editPoints, expandLinks, findClip, locate } from "../timeline/geometry";
import { useEditor } from "../state/editor";
import { activeSequence, edit, reportError, useProject } from "../state/project";
import { api } from "../lib/ipc";
import { toast } from "../state/toasts";
import { prompt } from "./project";

export const seq = (): Sequence | null => activeSequence(useProject.getState().project);
const playhead = () => Math.round(engine.frame);

function selection(): Uuid[] {
  const s = seq();
  if (!s) return [];
  const ids = useEditor.getState().selection;
  return ids.filter((id) => findClip(s, id));
}

export function selectClips(ids: Uuid[], additive = false, ignoreLinks = false) {
  const s = seq();
  if (!s) return;
  const ed = useEditor.getState();
  const expanded = ed.linkedSelection && !ignoreLinks ? expandLinks(s, ids) : ids;
  if (!additive) return ed.select(expanded);
  const cur = new Set(ed.selection);
  const allSelected = expanded.every((id) => cur.has(id));
  for (const id of expanded) allSelected ? cur.delete(id) : cur.add(id);
  ed.select([...cur]);
}

export function selectAll() {
  const s = seq();
  if (s) useEditor.getState().select(s.tracks.flatMap((t) => (t.locked ? [] : t.clips.map((c) => c.id))));
}

export async function deleteSelection(ripple: boolean) {
  const s = seq();
  const ids = selection();
  if (!s || !ids.length) return;
  const d = await edit({ type: "deleteClips", sequence: s.id, clips: ids, ripple });
  if (d) useEditor.getState().select([]);
}

/** Razor at the playhead: through the selection if any, else all tracks. */
export async function splitAtPlayhead(allTracks: boolean) {
  const s = seq();
  if (!s) return;
  const ids = selection();
  const at = playhead();
  const clips = allTracks || !ids.length ? null : ids.filter((id) => {
    const c = findClip(s, id)!;
    return c.start < at && at < c.start + c.duration;
  });
  if (clips && !clips.length) return;
  await edit({ type: "splitAt", sequence: s.id, frame: at, clips });
}

export function copySelection(cut = false) {
  const s = seq();
  const ids = selection();
  if (!s || !ids.length) return;
  const items = ids.map((id) => {
    const l = locate(s, id)!;
    const t = s.tracks[l.track];
    return { clip: t.clips[l.clip], track: t.id, kind: t.kind };
  });
  useEditor.getState().set({ clipboard: items });
  if (cut) void deleteSelection(false);
}

export async function paste() {
  const s = seq();
  const items = useEditor.getState().clipboard;
  if (!s || !items.length) return;
  const d = await edit({ type: "pasteClips", sequence: s.id, items, at: playhead() });
  if (d) useEditor.getState().select(d.outcome.created);
}

export async function duplicateSelection() {
  const s = seq();
  const ids = selection();
  if (!s || !ids.length) return;
  const d = await edit({ type: "duplicateClips", sequence: s.id, clips: ids });
  if (d) useEditor.getState().select(d.outcome.created);
}

export async function nudgeSelection(frames: number) {
  const s = seq();
  const ids = selection();
  if (!s || !ids.length) return;
  await edit({ type: "moveClips", sequence: s.id, clips: ids, delta: frames });
}

export async function toggleEnabled() {
  const s = seq();
  const ids = selection();
  if (!s || !ids.length) return;
  const anyEnabled = ids.some((id) => findClip(s, id)?.enabled);
  await edit({ type: "updateClips", sequence: s.id, clips: ids, patch: { enabled: !anyEnabled } });
}

export async function linkSelection(link: boolean) {
  const s = seq();
  const ids = selection();
  if (!s || ids.length < (link ? 2 : 1)) return;
  await edit({ type: link ? "linkClips" : "unlinkClips", sequence: s.id, clips: ids });
}

/** Half-second fades on the selection; "none" removes them. */
export async function applyFades(which: "both" | "in" | "out" | "none" = "both") {
  const s = seq();
  const ids = selection();
  if (!s || !ids.length) return;
  const f = which === "none" ? 0 : Math.round((s.settings.fps.num / s.settings.fps.den) * 0.5);
  const patch: ClipPatch = which === "in" ? { fadeIn: f } : which === "out" ? { fadeOut: f } : { fadeIn: f, fadeOut: f };
  await edit({ type: "updateClips", sequence: s.id, clips: ids, patch });
}

/** Selected clips on tracks of `kind`. */
function selectionOf(s: Sequence, kind: TrackKind): Uuid[] {
  return selection().filter((id) => {
    const l = locate(s, id);
    return l && s.tracks[l.track].kind === kind;
  });
}

/**
 * Applies a per-clip patch to the selected clips of `kind`. Clips whose patch
 * is identical share one edit (and one undo step).
 */
async function mapSelection(kind: TrackKind, fn: (clip: Clip) => ClipPatch | null) {
  const s = seq();
  if (!s) return;
  const groups = new Map<string, Uuid[]>();
  for (const id of selectionOf(s, kind)) {
    const patch = fn(findClip(s, id)!);
    if (!patch) continue;
    const key = JSON.stringify(patch);
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  for (const [key, ids] of groups) await edit({ type: "updateClips", sequence: s.id, clips: ids, patch: JSON.parse(key) as ClipPatch });
}

/** Scales the selected visuals so they fill (crop) or fit (letterbox) the frame. */
export function frameVisuals(mode: "fill" | "fit") {
  const s = seq();
  const { mediaById } = useProject.getState();
  return mapSelection("video", (clip) => {
    const dims = displaySize(mediaById.get(clip.mediaId));
    if (!s || !dims) return null;
    const t = clip.transform;
    const cw = dims[0] * (1 - t.cropLeft - t.cropRight);
    const ch = dims[1] * (1 - t.cropTop - t.cropBottom);
    const { width: W, height: H } = s.settings;
    const scale = mode === "fit" ? 1 : +(Math.max(W / cw, H / ch) / Math.min(W / cw, H / ch)).toFixed(5);
    return { transform: { ...t, scale, x: 0, y: 0 } };
  });
}

export const resetMotion = () => mapSelection("video", () => ({ transform: IDENTITY_TRANSFORM, opacity: 1 }));
export const resetColor = () => mapSelection("video", () => ({ color: IDENTITY_COLOR }));
export const monochrome = () => mapSelection("video", (c) => ({ color: { ...c.color, saturation: 0 } }));
export const resetAudio = () => mapSelection("audio", () => ({ volumeDb: 0, pan: 0 }));

/**
 * Places media at `at` (default: playhead) on the first matching tracks;
 * `range` limits the source (source monitor In/Out, in sequence frames).
 * Resolves to the frame after the last placed clip, or null if nothing was placed.
 */
export async function placeMedia(
  media: Uuid[],
  mode: PlaceMode,
  at?: number,
  tracks?: { video?: Uuid | null; audio?: Uuid | null },
  range?: { sourceIn: number; sourceOut: number | null },
): Promise<number | null> {
  const s = seq();
  if (!s || !media.length) return null;
  const { mediaById } = useProject.getState();
  let pos = at ?? playhead();
  const created: Uuid[] = [];
  for (const id of media) {
    const a = mediaById.get(id);
    if (!a) continue;
    if (a.status.state !== "ready") {
      toast.info(`„${a.name}“ ist noch nicht bereit`, a.status.state === "missing" ? "Datei offline" : "Analyse läuft …");
      continue;
    }
    const current = seq()!;
    const empty = !current.tracks.some((t) => t.clips.length);
    const d = await edit({
      type: "placeMedia",
      sequence: current.id,
      media: id,
      videoTrack: tracks?.video ?? null,
      audioTrack: tracks?.audio ?? null,
      at: pos,
      mode,
      sourceIn: range?.sourceIn ?? null,
      sourceOut: range?.sourceOut ?? null,
      matchSequence: empty,
    });
    if (!d) break;
    if (empty && d.outcome.sequencesChanged) {
      const ns = seq()!;
      toast.info(
        "Sequenz an Clip angepasst",
        `${ns.settings.width} × ${ns.settings.height} · ${formatRate(ns.settings.fps)} fps`,
      );
    }
    created.push(...d.outcome.created);
    const placed = d.outcome.created.map((cid) => findClip(seq()!, cid)).find(Boolean);
    if (placed) pos = placed.start + placed.duration;
  }
  if (created.length) useEditor.getState().select(created);
  return created.length ? pos : null;
}

export async function addTrack(kind: TrackKind) {
  const s = seq();
  if (s) await edit({ type: "addTrack", sequence: s.id, kind });
}

export async function setIn(frame: number | null = playhead()) {
  const s = seq();
  if (!s) return;
  const out = s.outPoint !== null && frame !== null && s.outPoint <= frame ? null : s.outPoint;
  await edit({ type: "setInOut", sequence: s.id, inPoint: frame, outPoint: out });
}

export async function setOut(frame: number | null = playhead()) {
  const s = seq();
  if (!s) return;
  const f = frame === null ? null : frame + 1;
  const inn = s.inPoint !== null && f !== null && s.inPoint >= f ? null : s.inPoint;
  await edit({ type: "setInOut", sequence: s.id, inPoint: inn, outPoint: f });
}

export async function clearInOut() {
  const s = seq();
  if (s && (s.inPoint !== null || s.outPoint !== null)) await edit({ type: "setInOut", sequence: s.id, inPoint: null, outPoint: null });
}

export async function addMarker(color: MarkerColor = "signal") {
  const s = seq();
  if (!s) return;
  const n = s.markers.length + 1;
  await edit({ type: "addMarker", sequence: s.id, frame: playhead(), name: `Marker ${n}`, color });
}

export function gotoMarker(dir: 1 | -1) {
  const s = seq();
  if (!s) return;
  const f = playhead();
  const list = s.markers.map((m) => m.frame);
  const target = dir > 0 ? list.find((x) => x > f) : [...list].reverse().find((x) => x < f);
  if (target !== undefined) engine.seek(target);
}

export function gotoEdit(dir: 1 | -1) {
  const s = seq();
  if (!s) return;
  engine.pause();
  const f = playhead();
  const pts = editPoints(s);
  const target = dir > 0 ? pts.find((x) => x > f) : [...pts].reverse().find((x) => x < f);
  if (target !== undefined) engine.seek(target);
}

export function playInOut() {
  const s = seq();
  if (!s) return;
  const lo = s.inPoint ?? 0;
  const hi = s.outPoint ?? engine.duration;
  if (hi > lo) void engine.play(1, [lo, hi]);
}

// --- shuttle (J/K/L) --------------------------------------------------------------

export function shuttle(dir: 1 | -1) {
  const cur = engine.playing ? engine.rate : 0;
  let rate: number;
  if (dir > 0) rate = cur > 0 ? Math.min(cur * 2, 8) : 1;
  else rate = cur < 0 ? Math.max(cur * 2, -8) : -1;
  void engine.play(rate);
}

// --- zoom -----------------------------------------------------------------------

export const MIN_ZOOM = 0.004;
export const MAX_ZOOM = 64;

export function zoomBy(factor: number, anchorFrame = engine.frame, anchorX?: number) {
  const ed = useEditor.getState();
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, ed.zoom * factor));
  const ax = anchorX ?? anchorFrame * ed.zoom - ed.scrollX;
  ed.set({ zoom, scrollX: Math.max(0, anchorFrame * zoom - ax) });
}

let viewportWidth = 1200;
export const setTimelineViewport = (w: number) => (viewportWidth = w);

/** Scrolls the timeline so `frame` is in view (keeps the zoom). */
export function revealFrame(frame: number) {
  const ed = useEditor.getState();
  const x = frame * ed.zoom - ed.scrollX;
  if (x >= 40 && x <= viewportWidth - 40) return;
  ed.set({ scrollX: Math.max(0, frame * ed.zoom - viewportWidth / 3) });
}

export function zoomToFit() {
  const s = seq();
  const ed = useEditor.getState();
  const dur = s ? Math.max(engine.duration, Math.round((s.settings.fps.num / s.settings.fps.den) * 10)) : 250;
  ed.set({ zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (viewportWidth - 40) / dur)), scrollX: 0 });
}

// --- range, selection and clip helpers -------------------------------------------

/** Lift (the gap stays) or extract (ripple) the In/Out range on all unlocked tracks. */
export async function removeInOut(ripple: boolean) {
  const s = seq();
  if (!s) return;
  if (s.inPoint === null || s.outPoint === null) {
    toast.info("Kein Bereich markiert", "Zuerst In-Point (I) und Out-Point (O) setzen.");
    return;
  }
  const at = s.inPoint;
  if (await edit({ type: "removeRange", sequence: s.id, start: s.inPoint, end: s.outPoint, ripple })) engine.seek(at);
}

/** Selects every clip from the playhead on (forward) or before it (backward). */
export function selectFromPlayhead(dir: 1 | -1) {
  const s = seq();
  if (!s) return;
  const f = playhead();
  const hit = (c: Clip) => (dir > 0 ? c.start + c.duration > f : c.start < f);
  useEditor.getState().select(s.tracks.flatMap((t) => (t.locked ? [] : t.clips.filter(hit).map((c) => c.id))));
}

const selectedClips = (s: Sequence) => selection().flatMap((id) => findClip(s, id) ?? []);

/** Zooms the timeline to the selected clips, else to In/Out, else to the whole sequence. */
export function zoomToSelection() {
  const s = seq();
  if (!s) return;
  const clips = selectedClips(s);
  let lo: number;
  let hi: number;
  if (clips.length) {
    lo = Math.min(...clips.map((c) => c.start));
    hi = Math.max(...clips.map((c) => c.start + c.duration));
  } else if (s.inPoint !== null && s.outPoint !== null) {
    [lo, hi] = [s.inPoint, s.outPoint];
  } else return zoomToFit();
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (viewportWidth - 80) / Math.max(1, hi - lo)));
  useEditor.getState().set({ zoom, scrollX: Math.max(0, lo * zoom - 40) });
}

/** Playhead to the first or last frame of the selection (or of the clips under the playhead). */
export function gotoClipEdge(edge: "start" | "end") {
  const s = seq();
  if (!s) return;
  const f = playhead();
  const sel = selectedClips(s);
  const pool = sel.length ? sel : s.tracks.flatMap((t) => t.clips.filter((c) => c.start <= f && f < c.start + c.duration));
  if (!pool.length) return;
  engine.pause();
  engine.seek(edge === "start" ? Math.min(...pool.map((c) => c.start)) : Math.max(...pool.map((c) => c.start + c.duration)) - 1);
}

export async function renameSelection() {
  const s = seq();
  const clips = s ? selectedClips(s) : [];
  if (!s || !clips.length) return;
  const name = await prompt({ title: clips.length > 1 ? `${clips.length} Clips umbenennen` : "Clip umbenennen", label: "Name", value: clips[0].name, confirm: "Umbenennen" });
  if (name?.trim()) await edit({ type: "updateClips", sequence: s.id, clips: clips.map((c) => c.id), patch: { name: name.trim() } });
}

export async function labelSelection(label: LabelColor) {
  const s = seq();
  const ids = selection();
  if (s && ids.length) await edit({ type: "updateClips", sequence: s.id, clips: ids, patch: { label } });
}

/** Puts the (single) selected media into `clip`, keeping its place in the timeline. */
export async function replaceClipMedia(clip: Uuid) {
  const s = seq();
  const media = useEditor.getState().mediaSelection;
  if (!s) return;
  if (media.length !== 1) {
    toast.info("Genau ein Medium auswählen", "Im Medienbrowser das Medium markieren, das den Clip ersetzen soll.");
    return;
  }
  await edit({ type: "replaceMedia", sequence: s.id, clip, media: media[0] });
}

/** Shows the clip's media in the media browser (bin, selection, panel focus). */
export function revealInProject(clip?: Uuid) {
  const s = seq();
  const c = s && (clip ? findClip(s, clip) : selectedClips(s)[0]);
  if (!c) return;
  const bin = useProject.getState().mediaById.get(c.mediaId)?.bin ?? null;
  const ed = useEditor.getState();
  ed.set({ mediaSelection: [c.mediaId], currentBin: bin, mediaSearch: "", mediaFilter: "all" });
  ed.focusPanel("media");
}

/**
 * Freeze frame: inserts the frame under the playhead as a still of `seconds`
 * (from the selected video clip there, else the topmost visible one).
 */
export async function freezeFrame(seconds = 2) {
  const s = seq();
  if (!s) return;
  const f = playhead();
  const media = useProject.getState().mediaById;
  const usable = (c: Clip) => c.start <= f && f < c.start + c.duration && media.get(c.mediaId)?.kind === "video";
  const videoTracks = [...s.tracks].reverse().filter((t) => t.kind === "video" && !t.hidden);
  const selected = new Set(selection());
  const all = videoTracks.flatMap((t) => t.clips.filter(usable));
  const clip = all.find((c) => selected.has(c.id)) ?? all[0];
  if (!clip) {
    toast.info("Kein Videoclip am Playhead", "Den Playhead auf einen Videoclip setzen.");
    return;
  }
  try {
    useProject.getState().applyDelta(await api.freezeFrame(s.id, clip.id, f, seconds));
    toast.success("Standbild eingefügt", `${seconds} s ab ${formatTimecode(f, s.settings.fps)}`);
  } catch (e) {
    reportError(e);
  }
}

/** Audio clips of the selection, including the audio linked to selected video. */
export function selectedAudioClips(): Uuid[] {
  const s = seq();
  if (!s) return [];
  const ids = new Set(expandLinks(s, selection()));
  return s.tracks.filter((t) => t.kind === "audio" && !t.locked).flatMap((t) => t.clips.filter((c) => ids.has(c.id)).map((c) => c.id));
}

export function openNormalize() {
  const clips = selectedAudioClips();
  if (!clips.length) {
    toast.info("Keine Audioclips ausgewählt", "Audioclips (oder Videoclips mit verknüpftem Ton) auf entsperrten Spuren auswählen.");
    return;
  }
  useEditor.getState().set({ dialog: { kind: "normalize", clips } });
}
