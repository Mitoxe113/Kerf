import { describe, expect, it } from "vitest";
import { IDENTITY_COLOR, IDENTITY_TRANSFORM } from "../engine/math";
import { NO_SUBTITLES } from "../engine/text";
import type { Clip, EditCommand, Sequence, Track } from "../lib/types";
import { clearCategoryCommand, placeRangesCommands, removeRangesCommands, scenesFromCuts, splitCommands } from "./assist";

const clip = (id: string, start: number, duration: number, link: string | null = null): Clip => ({
  id, mediaId: "m", name: id, start, duration, sourceIn: 0, speed: 1, link, enabled: true,
  transform: IDENTITY_TRANSFORM, opacity: 1, volumeDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, color: IDENTITY_COLOR, label: "none", keys: {},
});
const track = (id: string, kind: "video" | "audio", clips: Clip[]): Track => ({ id, kind, name: id, clips, muted: false, solo: false, locked: false, hidden: false, volumeDb: 0, color: "none", height: 0 });
const seq = (tracks: Track[]): Sequence => ({
  id: "s", name: "S", settings: { fps: { num: 25, den: 1 }, width: 1920, height: 1080, sampleRate: 48000 }, subtitles: NO_SUBTITLES, tracks,
  markers: [{ id: "m1", frame: 3, name: "a", note: "", color: "blue", category: "scene" }, { id: "m2", frame: 4, name: "b", note: "", color: "red" }],
  inPoint: null, outPoint: null,
});

const s = seq([track("v1", "video", [clip("v", 10, 100, "L")]), track("a1", "audio", [clip("a", 10, 100, "L")]), track("a2", "audio", [clip("music", 0, 300)])]);
const inner = (c: EditCommand | null) => (c && c.type === "batch" ? c.commands : []);

describe("assistant edits", () => {
  it("splits a clip and its linked partner at the frames inside it, once each", () => {
    const cmd = splitCommands(s, "v", [50, 5, 30, 50, 110]);
    expect(cmd?.type === "batch" && cmd.label).toBe("sceneCuts");
    expect(inner(cmd)).toEqual([
      { type: "splitAt", sequence: "s", frame: 30, clips: ["v", "a"] },
      { type: "splitAt", sequence: "s", frame: 50, clips: ["v", "a"] },
    ]);
    expect(splitCommands(s, "v", [5])).toBeNull();
  });

  it("removes pauses from the last to the first on the clip's tracks, keeping some if asked", () => {
    const cmd = removeRangesCommands(s, "a", [[20, 30], [60, 80]]);
    expect(inner(cmd).map((c) => c.type === "removeRange" && [c.start, c.end, c.tracks])).toEqual([[60, 80, ["v1", "a1"]], [20, 30, ["v1", "a1"]]]);
    // Keeping 6 frames: centred, and pauses shorter than that stay.
    const short = removeRangesCommands(s, "a", [[20, 24], [60, 80]], 6);
    expect(inner(short).map((c) => c.type === "removeRange" && [c.start, c.end])).toEqual([[63, 77]]);
    // The music track is not touched.
    expect(inner(removeRangesCommands(s, "music", [[0, 5]])).map((c) => c.type === "removeRange" && c.tracks)).toEqual([["a2"]]);
  });

  it("places scene ranges one after another", () => {
    expect(scenesFromCuts([2, 0.5, 7], 0, 5)).toEqual([[0, 0.5], [0.5, 2], [2, 5]]);
    const cmd = placeRangesCommands(s, "media", [[0, 2], [2, 2], [4, 5]], 100, 25);
    expect(inner(cmd).map((c) => c.type === "placeMedia" && [c.at, c.sourceIn, c.sourceOut, c.mode])).toEqual([[100, 0, 50, "insert"], [150, 100, 125, "insert"]]);
  });

  it("clears markers of one category", () => {
    expect(clearCategoryCommand(s, "scene")).toEqual({ type: "removeMarkers", sequence: "s", markers: ["m1"] });
    expect(clearCategoryCommand(s, "beat")).toBeNull();
  });
});
