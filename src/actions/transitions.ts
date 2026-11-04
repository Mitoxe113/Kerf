// Transitions: the default one at cuts, editing and removing them.

import { engine } from "../engine/playback";
import { fpsOf } from "../lib/time";
import type { Sequence, Transition, TransitionAlign, TransitionKind, Uuid } from "../lib/types";
import { expandLinks, locate } from "../timeline/geometry";
import { useEditor } from "../state/editor";
import { activeSequence, edit, reportError, useProject } from "../state/project";
import { toast } from "../state/toasts";

export const TRANSITIONS: { value: TransitionKind; label: string; short: string }[] = [
  { value: "dissolve", label: "Überblendung", short: "Blende" },
  { value: "dipBlack", label: "Über Schwarz", short: "Schwarz" },
  { value: "dipWhite", label: "Über Weiß", short: "Weiß" },
  { value: "wipeLeft", label: "Wischen nach links", short: "Wisch ←" },
  { value: "wipeRight", label: "Wischen nach rechts", short: "Wisch →" },
  { value: "wipeUp", label: "Wischen nach oben", short: "Wisch ↑" },
  { value: "wipeDown", label: "Wischen nach unten", short: "Wisch ↓" },
  { value: "irisRound", label: "Iris rund", short: "Iris ○" },
  { value: "irisBox", label: "Iris eckig", short: "Iris □" },
  { value: "clock", label: "Uhrzeiger", short: "Uhr" },
  { value: "barnDoorH", label: "Tür horizontal öffnen", short: "Tür ↔" },
  { value: "barnDoorV", label: "Tür vertikal öffnen", short: "Tür ↕" },
  { value: "wipeDiagonal", label: "Wischen diagonal", short: "Wisch ↘" },
  { value: "blinds", label: "Jalousie", short: "Jalousie" },
  { value: "pushLeft", label: "Schieben nach links", short: "Schieben ←" },
  { value: "pushRight", label: "Schieben nach rechts", short: "Schieben →" },
  { value: "pushUp", label: "Schieben nach oben", short: "Schieben ↑" },
  { value: "pushDown", label: "Schieben nach unten", short: "Schieben ↓" },
  { value: "slideLeft", label: "Hereingleiten nach links", short: "Gleiten ←" },
  { value: "slideRight", label: "Hereingleiten nach rechts", short: "Gleiten →" },
  { value: "slideUp", label: "Hereingleiten nach oben", short: "Gleiten ↑" },
  { value: "slideDown", label: "Hereingleiten nach unten", short: "Gleiten ↓" },
  { value: "crossfade", label: "Kreuzblende", short: "Kreuzblende" },
];

export const ALIGNS: { value: TransitionAlign; label: string; title: string }[] = [
  { value: "center", label: "Mitte", title: "Mittig über dem Schnitt" },
  { value: "start", label: "Ab Schnitt", title: "Beginnt am Schnitt (verlängert den ersten Clip)" },
  { value: "end", label: "Bis Schnitt", title: "Endet am Schnitt (verlängert den zweiten Clip)" },
];

/** Kinds that fit a track: video transitions or the audio crossfade. */
export const kindsFor = (audio: boolean) => TRANSITIONS.filter((t) => (t.value === "crossfade") === audio);

const seq = (): Sequence | null => activeSequence(useProject.getState().project);

/** One second, centred on the cut. */
export function defaultTransition(s: Sequence, audio: boolean): Transition {
  return { kind: audio ? "crossfade" : "dissolve", duration: Math.max(1, Math.round(fpsOf(s.settings.fps))), align: "center" };
}

/** Clip ids that can take a transition: directly preceded by a clip on an unlocked track. */
function cutAt(s: Sequence, track: number, clip: number): Uuid | null {
  const t = s.tracks[track];
  const [a, b] = [t.clips[clip - 1], t.clips[clip]];
  return !t.locked && a && b && a.start + a.duration === b.start ? b.id : null;
}

async function setTransitions(s: Sequence, items: { clip: Uuid; transition: Transition | null }[]) {
  if (!items.length) return;
  try {
    await edit({ type: "setTransitions", sequence: s.id, items });
  } catch (e) {
    reportError(e);
  }
}

/**
 * The default transition at the cuts of the selected clips (both ends; with
 * linked selection their audio gets a crossfade), or without a selection at
 * the cut nearest the playhead on every track that has one there.
 */
export async function applyDefaultTransitions() {
  const s = seq();
  if (!s) return;
  const ed = useEditor.getState();
  const cuts = new Map<Uuid, boolean>();
  const add = (track: number, clip: number) => {
    const id = cutAt(s, track, clip);
    if (id) cuts.set(id, s.tracks[track].kind === "audio");
  };
  if (ed.selection.length) {
    for (const id of ed.linkedSelection ? expandLinks(s, ed.selection) : ed.selection) {
      const l = locate(s, id);
      if (!l) continue;
      add(l.track, l.clip);
      add(l.track, l.clip + 1);
    }
  } else {
    const at = engine.frame;
    let best = Infinity;
    for (const t of s.tracks) {
      for (const [i, c] of t.clips.entries()) {
        const prev = t.clips[i - 1];
        if (!t.locked && prev && prev.start + prev.duration === c.start && Math.abs(c.start - at) < Math.abs(best - at)) best = c.start;
      }
    }
    for (const [ti, t] of s.tracks.entries()) {
      const ci = t.clips.findIndex((c) => c.start === best);
      if (ci > 0) add(ti, ci);
    }
  }
  if (!cuts.size) {
    toast.info("Kein Schnitt gefunden", "Übergänge liegen zwischen zwei Clips, die direkt aneinander anschließen.");
    return;
  }
  // Existing transitions keep their settings.
  const existing = new Map(s.tracks.flatMap((t) => t.clips.map((c) => [c.id, c.transition] as const)));
  await setTransitions(
    s,
    [...cuts].map(([clip, audio]) => ({ clip, transition: existing.get(clip) ?? defaultTransition(s, audio) })),
  );
}

/** Removes the transitions at both ends of the selected clips. */
export async function removeTransitions() {
  const s = seq();
  if (!s) return;
  const ed = useEditor.getState();
  const items: { clip: Uuid; transition: null }[] = [];
  for (const id of ed.linkedSelection ? expandLinks(s, ed.selection) : ed.selection) {
    const l = locate(s, id);
    if (!l) continue;
    for (const c of [s.tracks[l.track].clips[l.clip], s.tracks[l.track].clips[l.clip + 1]]) {
      if (c?.transition && !items.some((x) => x.clip === c.id)) items.push({ clip: c.id, transition: null });
    }
  }
  await setTransitions(s, items);
}

/** Sets (or with null removes) the transition into `clip`. */
export async function setTransition(clip: Uuid, transition: Transition | null) {
  const s = seq();
  if (s) await setTransitions(s, [{ clip, transition }]);
}
