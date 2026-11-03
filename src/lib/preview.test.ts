import { describe, expect, it } from "vitest";
import { missingPreviewCodecs, previewCodecRemedy, probePreviewCodecs } from "./preview";

describe("preview codec probe", () => {
  it("reports what canPlayType rejects", () => {
    // WebKitGTK without gstreamer1.0-libav answers "" for H.264 and AAC, "probably" for VP9.
    const linuxWithoutLibav = (mime: string) => (mime.includes("avc1") || mime.includes("mp4a") ? "" : "probably");
    const c = probePreviewCodecs(linuxWithoutLibav);
    expect(c).toEqual({ h264: false, aac: false });
    expect(missingPreviewCodecs(c)).toEqual(["H.264", "AAC"]);
  });

  it("accepts maybe as playable", () => {
    const c = probePreviewCodecs(() => "maybe");
    expect(missingPreviewCodecs(c)).toEqual([]);
  });

  it("names the Linux package only on Linux", () => {
    expect(previewCodecRemedy("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toContain("gstreamer1.0-libav");
    expect(previewCodecRemedy("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130")).not.toContain("gstreamer");
  });
});
