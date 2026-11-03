// Turns analysis results into ordinary edit commands. Every result is applied
// as one `batch`, so it is a single undo step and leaves nothing that could not
// be edited by hand afterwards (cuts, markers, keyframes).

import type { BatchLabel, Clip, EditCommand, Frame, MarkerColor, NewMarker, Sequence, Uuid } from "../lib/types";

/** The clip and the clips linked to it (its audio or video partner). */
export function withPartners(seq: Sequence, clipId: Uuid): { clip: Clip; track: Uuid }[] {
  const all = seq.tracks.flatMap((t) => t.clips.map((clip) => ({ clip, track: t.id })));
  const self = all.find((x) => x.clip.id === clipId);
  if (!self) return [];
  return self.clip.link ? all.filter((x) => x.clip.link === self.clip.link) : [self];
}

export const batch = (label: BatchLabel, commands: EditCommand[]): EditCommand | null => (commands.length ? { type: "batch", label, commands } : null);

/** Splits the clip (and its partners) at each frame strictly inside it. */
export function splitCommands(seq: Sequence, clipId: Uuid, frames: Frame[]): EditCommand | null {
  const parts = withPartners(seq, clipId);
  const main = parts.find((p) => p.clip.id === clipId)?.clip;
  if (!main) return null;
  const clips = parts.map((p) => p.clip.id);
  const inside = [...new Set(frames)].filter((f) => f > main.start && f < main.start + main.duration).sort((a, b) => a - b);
  return batch("sceneCuts", inside.map((frame) => ({ type: "splitAt", sequence: seq.id, frame, clips })));
}

/**
 * Removes the timeline ranges from the clip's tracks (and its partners'),
 * closing the gaps. `keep` frames of each pause stay (centred in it), so a
 * pause can be shortened instead of removed. Ranges are removed from the last
 * to the first so earlier positions stay valid.
 */
export function removeRangesCommands(seq: Sequence, clipId: Uuid, ranges: [Frame, Frame][], keep: Frame = 0): EditCommand | null {
  const tracks = [...new Set(withPartners(seq, clipId).map((p) => p.track))];
  if (!tracks.length) return null;
  const cuts = ranges
    .map(([a, b]): [Frame, Frame] => {
      const extra = Math.max(0, keep);
      const len = b - a - extra;
      const start = a + Math.floor(extra / 2);
      return [start, start + len];
    })
    .filter(([a, b]) => b > a)
    .sort((x, y) => y[0] - x[0]);
  return batch(
    "removeSilence",
    cuts.map(([start, end]) => ({ type: "removeRange", sequence: seq.id, start, end, ripple: true, tracks })),
  );
}

export function markerCommands(seq: Sequence, markers: NewMarker[]): EditCommand | null {
  return markers.length ? batch("analysisMarkers", [{ type: "addMarkers", sequence: seq.id, markers }]) : null;
}

/** Removes the markers of `category` (e.g. to redo an analysis). */
export function clearCategoryCommand(seq: Sequence, category: string): EditCommand | null {
  const ids = seq.markers.filter((m) => (m.category ?? "") === category).map((m) => m.id);
  return ids.length ? { type: "removeMarkers", sequence: seq.id, markers: ids } : null;
}

/**
 * Places each source range (seconds) of a media file one after another from
 * `at` (insert, so nothing on the timeline is overwritten).
 */
export function placeRangesCommands(seq: Sequence, media: Uuid, ranges: [number, number][], at: Frame, fps: number, label: BatchLabel = "sceneCuts"): EditCommand | null {
  let pos = at;
  const commands: EditCommand[] = [];
  for (const [a, b] of ranges) {
    const sourceIn = Math.round(a * fps);
    const sourceOut = Math.round(b * fps);
    if (sourceOut <= sourceIn) continue;
    commands.push({ type: "placeMedia", sequence: seq.id, media, at: pos, mode: "insert", sourceIn, sourceOut });
    pos += sourceOut - sourceIn;
  }
  return batch(label, commands);
}

/** Scene ranges of a file from its cut times. */
export function scenesFromCuts(cuts: number[], start: number, end: number): [number, number][] {
  const edges = [start, ...cuts.filter((c) => c > start && c < end).sort((a, b) => a - b), end];
  return edges.slice(1).map((b, i): [number, number] => [edges[i], b]).filter(([a, b]) => b > a);
}

export const MARKER_COLORS: Record<string, MarkerColor> = { scene: "blue", silence: "amber", beat: "violet", downbeat: "red", peak: "red", highlight: "signal" };
