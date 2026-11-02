// Multicam: groups of camera angles recorded together, kept in sync by their
// offsets on the group's clock. A clip of a group shows one angle; switching
// cuts it at the playhead and puts the other angle in at the same moment.

import { engine } from "../engine/playback";
import { api } from "../lib/ipc";
import { sourceAt } from "../lib/keys";
import { fpsOf } from "../lib/time";
import type { Angle, Clip, Multicam, PlaceMode, Sequence, Uuid } from "../lib/types";
import { useEditor } from "../state/editor";
import { activeSequence, edit, reportError, useProject } from "../state/project";
import { toast } from "../state/toasts";

/** The multicam video clip at `frame`: a selected one, else the topmost. */
export function multicamClipAt(seq: Sequence, frame: number): Clip | null {
  const selected = new Set(useEditor.getState().selection);
  const hits = seq.tracks
    .filter((t) => t.kind === "video" && !t.hidden)
    .flatMap((t) => t.clips.filter((c) => c.multicam && c.start <= frame && frame < c.start + c.duration))
    .reverse();
  return hits.find((c) => selected.has(c.id)) ?? hits[0] ?? null;
}

export const multicamOf = (id: Uuid | null | undefined): Multicam | null =>
  (id && useProject.getState().project?.multicams?.find((m) => m.id === id)) || null;

/** Seconds on the group's clock shown by clip `c` at timeline frame `frame`. */
export function groupTime(seq: Sequence, c: Clip, g: Multicam, frame: number): number | null {
  const angle = g.angles.find((a) => a.media === c.mediaId);
  return angle ? angle.offset + sourceAt(c, frame - c.start) / fpsOf(seq.settings.fps) : null;
}

/** Shows angle `index` from the playhead on, in the multicam clip under it. */
export async function switchAngle(index: number) {
  const seq = activeSequence(useProject.getState().project);
  if (!seq) return;
  const frame = Math.round(engine.frame);
  const clip = multicamClipAt(seq, frame);
  const g = multicamOf(clip?.multicam);
  if (!clip || !g) {
    toast.info("Kein Multicam-Clip am Playhead");
    return;
  }
  if (index >= g.angles.length) return;
  await edit({ type: "switchAngle", sequence: seq.id, clip: clip.id, angle: index, at: frame });
}

export type SyncMethod = "audio" | "start";

/**
 * Creates a group of `media` (in order: angle 1, 2, …), synced by their sound
 * or aligned at their start, and places it at the playhead.
 */
export async function createMulticam(name: string, media: Uuid[], method: SyncMethod, audioAngle: number | null, mode: PlaceMode) {
  let offsets: (number | null)[] = media.map(() => 0);
  if (method === "audio") {
    try {
      offsets = await api.syncAngles(media);
    } catch (e) {
      reportError(e);
      return;
    }
  }
  const { mediaById } = useProject.getState();
  const unsynced = media.filter((_, i) => offsets[i] === null).map((id) => mediaById.get(id)?.name ?? "?");
  const angles: Angle[] = media.map((id, i) => ({ media: id, name: mediaById.get(id)?.name ?? `Kamera ${i + 1}`, offset: offsets[i] ?? 0 }));
  const d = await edit({ type: "createMulticam", multicam: { id: crypto.randomUUID(), name, angles } });
  const id = d?.outcome.created[0];
  const seq = activeSequence(useProject.getState().project);
  if (!id || !seq) return;
  if (unsynced.length) toast.info("Nicht alle Kameras synchronisiert", `Ohne erkennbare Übereinstimmung im Ton, am Anfang ausgerichtet: ${unsynced.join(", ")}`);
  const placed = await edit({ type: "placeMulticam", sequence: seq.id, multicam: id, at: Math.round(engine.frame), mode, videoAngle: 0, audioAngle, videoTrack: null, audioTrack: null });
  if (placed) {
    useEditor.getState().select(placed.outcome.created);
    useEditor.getState().focusPanel("multicam");
  }
}
