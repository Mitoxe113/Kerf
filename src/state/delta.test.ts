import { describe, expect, it } from "vitest";
import { IDENTITY_COLOR, IDENTITY_TRANSFORM } from "../engine/math";
import type { Clip, Sequence, Track } from "../lib/types";
import { applySequenceDelta } from "./delta";
import { NO_SUBTITLES } from "../engine/text";

const clip = (id: string, start: number): Clip => ({
  id,
  mediaId: "m",
  name: id,
  start,
  duration: 10,
  sourceIn: 0,
  speed: 1,
  link: null,
  enabled: true,
  transform: IDENTITY_TRANSFORM,
  opacity: 1,
  volumeDb: 0,
  pan: 0,
  fadeIn: 0,
  fadeOut: 0,
  color: IDENTITY_COLOR,
  label: "none",
  keys: {},
});

const track = (id: string, clips: Clip[]): Track => ({
  id,
  kind: "video",
  name: id,
  clips,
  muted: false,
  solo: false,
  locked: false,
  hidden: false,
  volumeDb: 0,
  color: "none",
  height: 0,
});

const seq = (tracks: Track[]): Sequence => ({
  id: "s",
  name: "S",
  settings: { fps: { num: 25, den: 1 }, width: 1920, height: 1080, sampleRate: 48000 },
    subtitles: NO_SUBTITLES,
  tracks,
  markers: [],
  inPoint: null,
  outPoint: null,
});

describe("applySequenceDelta", () => {
  const v1 = track("v1", [clip("a", 0), clip("b", 10), clip("c", 20)]);
  const v2 = track("v2", [clip("x", 0)]);
  const prev = seq([v1, v2]);
  const shell = (t: Track) => ({ ...t, clips: [] });

  it("keeps unchanged clip arrays by reference", () => {
    const next = applySequenceDelta(prev, {
      sequence: { ...prev, tracks: [] },
      tracks: [
        { track: shell(v1), new: false, removed: ["b"], upserted: [{ ...clip("c", 5) }] },
        { track: { ...shell(v2), name: "Titel" }, new: false, removed: [], upserted: [] },
      ],
    });
    expect(next.tracks[0].clips.map((c) => `${c.id}@${c.start}`)).toEqual(["a@0", "c@5"]);
    expect(next.tracks[1].clips).toBe(v2.clips);
    expect(next.tracks[1].name).toBe("Titel");
  });

  it("builds new tracks from upserted clips and follows the new track order", () => {
    const next = applySequenceDelta(prev, {
      sequence: { ...prev, name: "Neu", tracks: [] },
      tracks: [
        { track: shell(v2), new: false, removed: [], upserted: [] },
        { track: shell(track("v3", [])), new: true, removed: [], upserted: [clip("n2", 30), clip("n1", 0)] },
      ],
    });
    expect(next.name).toBe("Neu");
    expect(next.tracks.map((t) => t.id)).toEqual(["v2", "v3"]);
    expect(next.tracks[1].clips.map((c) => c.id)).toEqual(["n1", "n2"]);
  });
});
