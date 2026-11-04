import { describe, expect, it } from "vitest";
import type { MediaAsset, VideoInfo } from "../lib/types";
import { readYcc, taggedYcc, webviewYcc, yccFix, yccFixRows } from "./ycc";

type Tags = [string | null, string | null, string | null];
const video = (codec: string, height: number, [space, primaries, transfer]: Tags = [null, null, null]) =>
  ({ codec, width: Math.round((height * 16) / 9), height, rotation: 0, color: { space, primaries, transfer, range: null } }) as unknown as VideoInfo;
const only = (m: string): Tags => [m, null, null];
const full = (m: string): Tags => [m, m, m];
const asset = (v: VideoInfo, matrix?: MediaAsset["matrix"], previewNative = true) =>
  ({ kind: "video", title: null, matrix, info: { video: v }, derived: { previewNative, proxy: "p.mp4" } }) as unknown as MediaAsset;
const apply = (m: number[], v: number[]) => [0, 1, 2].map((r) => m[3 * r] * v[0] + m[3 * r + 1] * v[1] + m[3 * r + 2] * v[2]);

describe("colour matrix of the preview", () => {
  it("matches the cases measured in Chromium (kerf_core webview_matrix_matches_the_measured_cases)", () => {
    const cases: [VideoInfo, string][] = [
      [video("h264", 720), "bt709"],
      [video("h264", 718), "bt601"],
      [video("h264", 576), "bt601"],
      [video("vp8", 720), "bt709"],
      [video("vp9", 1080), "bt601"],
      [video("av1", 720), "bt601"],
      [video("h264", 720, only("smpte170m")), "bt709"],
      [video("h264", 576, only("bt709")), "bt601"],
      [video("h264", 720, ["smpte170m", "smpte170m", null]), "bt709"],
      [video("h264", 720, full("smpte170m")), "bt601"],
      [video("h264", 576, full("bt709")), "bt709"],
      [video("vp8", 720, only("smpte170m")), "bt709"],
      [video("vp9", 576, only("bt709")), "bt709"],
      [video("av1", 576, only("bt709")), "bt601"],
      [video("av1", 576, full("bt709")), "bt709"],
    ];
    for (const [v, want] of cases) expect(`${v.codec} ${v.height} ${v.color?.space}: ${webviewYcc(v, true)}`).toBe(`${v.codec} ${v.height} ${v.color?.space}: ${want}`);
    expect(webviewYcc(video("vp9", 1080), false)).toBe("bt709");
    expect(webviewYcc(video("h264", 1080, full("bt2020nc")), true)).toBeUndefined();
    expect(taggedYcc(video("h264", 1080, only("bt2020nc")))).toBeUndefined();
    expect(readYcc(video("h264", 1080, full("bt2020nc")), "bt601", true)).toBeUndefined();
    expect(readYcc(video("h264", 1080), "bt601", true)).toBe("bt601");
  });

  it("corrects only where the WebView decodes another matrix than the one read", () => {
    expect(yccFix(asset(video("h264", 1080)), true)).toBeNull();
    expect(yccFix(asset(video("h264", 1080), "bt709"), true)).toBeNull();
    expect(yccFix(asset(video("h264", 480, full("bt470bg")), "bt601"), true)).toBeNull();
    expect(yccFix(asset(video("h264", 1080, full("bt2020nc")), "bt601"), true)).toBeNull();
    expect(yccFix(asset(video("h264", 1080), "bt601"), true)).not.toBeNull();
    // Untagged VP9 in HD: BT.601 natively, BT.709 through the H.264 proxy.
    expect(yccFix(asset(video("vp9", 1080)), true)).toBeNull();
    expect(yccFix(asset(video("vp9", 1080)), false)).not.toBeNull();
    // A codec the WebView cannot decode is read as its proxy shows it.
    expect(yccFix(asset(video("prores", 1080), undefined, false), false)).toBeNull();
  });

  it("keeps greys, inverts itself, and matches FFmpeg's two decodes", () => {
    const f = yccFixRows("bt709", "bt601");
    for (const g of [0, 0.25, 1]) apply(f, [g, g, g]).forEach((x) => expect(x).toBeCloseTo(g, 6));
    const back = yccFixRows("bt601", "bt709");
    apply(back, apply(f, [0.8, 0.2, 0.4])).forEach((x, i) => expect(x).toBeCloseTo([0.8, 0.2, 0.4][i], 6));
    // Mean RGB of one untagged frame decoded by FFmpeg as BT.709 and as BT.601
    // (pipeline test matrix_choice_reads_untagged_video): the correction maps one onto the other.
    const got = apply(f, [205, 50, 95].map((x) => x / 255)).map((x) => x * 255);
    got.forEach((x, i) => expect(Math.abs(x - [192, 31, 95][i])).toBeLessThan(1.5));
  });
});
