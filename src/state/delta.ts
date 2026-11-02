// Applies engine deltas to the mirrored project. Unchanged tracks keep their
// clip arrays (and changed tracks rebuild only from the changed clips), so the
// cost of an edit follows the size of the change, not of the project.

import type { Clip, Delta, Project, Sequence, SequenceDelta, Track } from "../lib/types";

export function applySequenceDelta(prev: Sequence | undefined, d: SequenceDelta): Sequence {
  const tracks: Track[] = d.tracks.map((td) => {
    const old = td.new ? undefined : prev?.tracks.find((t) => t.id === td.track.id);
    let clips: Clip[];
    if (old && !td.removed.length && !td.upserted.length) clips = old.clips;
    else {
      const byId = new Map((old?.clips ?? []).map((c) => [c.id, c]));
      for (const id of td.removed) byId.delete(id);
      for (const c of td.upserted) byId.set(c.id, c);
      clips = [...byId.values()].sort((a, b) => a.start - b.start);
    }
    return { ...td.track, clips };
  });
  return { ...d.sequence, tracks };
}

export function applyDeltaToProject(p: Project, d: Delta): Project {
  const next: Project = { ...p, activeSequence: d.activeSequence };
  if (d.sequences) next.sequences = d.sequences;
  else if (d.patches.length) {
    const patches = new Map(d.patches.map((s) => [s.sequence.id, s]));
    next.sequences = p.sequences.map((s) => {
      const sd = patches.get(s.id);
      return sd ? applySequenceDelta(s, sd) : s;
    });
  }
  if (d.media) next.media = d.media;
  if (d.bins) next.bins = d.bins;
  if (d.multicams) next.multicams = d.multicams;
  return next;
}
