import { describe, expect, it } from "vitest";
import { IDENTITY_COLOR, IDENTITY_TRANSFORM } from "../engine/math";
import { NO_SUBTITLES } from "../engine/text";
import type { Clip, MediaAsset, Project, Sequence, Track } from "../lib/types";
import { checkProject, describePixFmt, videoGaps } from "./health";

const clip = (id: string, start: number, duration: number, mediaId = "m1", enabled = true): Clip => ({
  id, mediaId, name: id, start, duration, sourceIn: 0, speed: 1, link: null, enabled,
  transform: IDENTITY_TRANSFORM, opacity: 1, volumeDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, color: IDENTITY_COLOR, label: "none", keys: {},
});
const track = (id: string, clips: Clip[], kind: "video" | "audio" = "video"): Track => ({ id, kind, name: id, clips, muted: false, solo: false, locked: false, hidden: false, volumeDb: 0, color: "none", height: 0 });
const seq = (tracks: Track[], over: Partial<Sequence> = {}): Sequence => ({
  id: "s", name: "Haupt", settings: { fps: { num: 25, den: 1 }, width: 1920, height: 1080, sampleRate: 48000 }, subtitles: NO_SUBTITLES, tracks, markers: [], inPoint: null, outPoint: null, ...over,
});
const media = (id: string, state: MediaAsset["status"], fps = 25): MediaAsset => ({
  id, path: `/m/${id}.mp4`, name: `${id}.mp4`, kind: "video", status: state, bin: null, favorite: false, label: "none", tags: [], note: "", importedAt: 0,
  info: { duration: 10, sizeBytes: 1, container: "mp4", bitRate: null, audio: null, video: { codec: "h264", profile: null, width: 1920, height: 1080, fps: { num: fps, den: 1 }, pixFmt: "yuv420p", bitRate: null, rotation: 0 } },
  derived: { poster: null, filmstrip: null, peaks: null, proxy: null, previewNative: true },
} as MediaAsset);
const project = (sequences: Sequence[], m: MediaAsset[]): Project => ({ schemaVersion: 1, id: "p", name: "P", createdAt: 0, modifiedAt: 0, media: m, bins: [], sequences, activeSequence: sequences[0].id });
const ctx = { fontAvailable: (f: string) => f !== "Fehlt Sans" };

describe("project health check", () => {
  it("finds gaps where no visible video covers the timeline", () => {
    expect(videoGaps(seq([track("v1", [clip("a", 10, 10), clip("b", 30, 10)]), track("v2", [clip("c", 15, 20)])]))).toEqual([[0, 10]]);
    expect(videoGaps(seq([track("v1", [clip("a", 0, 10), clip("x", 20, 5, "m1", false)]), track("a1", [clip("s", 0, 40)], "audio")]))).toEqual([[10, 40]]);
    expect(videoGaps(seq([track("a1", [clip("s", 0, 40)], "audio")]))).toEqual([]);
  });

  it("reports missing media, fonts, gaps, odd sizes and frame rates, most severe first", () => {
    const m1 = media("m1", { state: "ready" });
    const gone = media("gone", { state: "missing" });
    const pal = media("film", { state: "ready" }, 24);
    const title = { ...media("t", { state: "ready" }), title: { text: "Hi", style: { font: "Fehlt Sans" } } } as unknown as MediaAsset;
    const s = seq([track("v1", [clip("a", 0, 10), clip("b", 20, 2, "gone"), clip("c", 22, 10, "film")])], { settings: { fps: { num: 25, den: 1 }, width: 1921, height: 1080, sampleRate: 48000 } });
    const issues = checkProject(project([s], [m1, gone, pal, title]), ctx);
    const ids = issues.map((i) => i.id);
    expect(ids.slice(0, 2).sort()).toEqual(["missing-gone", "size-s"]);
    expect(issues.find((i) => i.id === "missing-gone")?.fix).toBe("relink");
    expect(ids).toContain("font-Fehlt Sans");
    const gap = issues.find((i) => i.id === "gap-s-10")!;
    expect(gap.severity).toBe("warning");
    expect([gap.fix, gap.track]).toEqual(["closeGap", "v1"]);
    expect(ids).toContain("short-b");
    expect(ids).toContain("fpsmix-s-film");
    // 50 fps media in 25 fps is a clean ratio: no notice.
    const fifty = media("fifty", { state: "ready" }, 50);
    const ok = checkProject(project([seq([track("v1", [clip("a", 0, 10, "fifty")])])], [fifty]), ctx);
    expect(ok).toEqual([]);
  });

  it("reads subsampling and bit depth from pixel formats", () => {
    expect(describePixFmt("yuv420p")).toEqual({ subsampling: "4:2:0", bitDepth: 8 });
    expect(describePixFmt("yuv422p10le")).toEqual({ subsampling: "4:2:2", bitDepth: 10 });
    expect(describePixFmt("p010le")).toEqual({ subsampling: "4:2:0", bitDepth: 10 });
    expect(describePixFmt("rgb48le")).toEqual({ subsampling: "RGB (ohne Unterabtastung)", bitDepth: null });
    expect(describePixFmt(null)).toEqual({ subsampling: null, bitDepth: null });
  });
});
