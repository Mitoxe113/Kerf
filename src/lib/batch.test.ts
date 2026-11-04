import { describe, expect, it } from "vitest";
import { batchOutputs, safeFileName } from "./batch";

describe("batch export names", () => {
  it("removes what Windows rejects", () => {
    expect(safeFileName('Film: "Teil 1/2"?')).toBe("Film_ _Teil 1_2__");
    expect(safeFileName("Ende. ")).toBe("Ende");
    expect(safeFileName("con")).toBe("_con");
    expect(safeFileName("  ")).toBe("Export");
    expect(safeFileName("H.264 · Master (hohe Qualität)")).toBe("H.264 · Master (hohe Qualität)");
  });

  it("names one file per preset, unique without case", () => {
    const out = batchOutputs("C:\\Exporte\\", "Sequenz 01", [
      { label: "YouTube 1080p", ext: "mp4" },
      { label: "youtube 1080p", ext: "mp4" },
      { label: "ProRes 422", ext: "mov" },
    ]);
    expect(out).toEqual(["C:\\Exporte\\Sequenz 01 - YouTube 1080p.mp4", "C:\\Exporte\\Sequenz 01 - youtube 1080p (2).mp4", "C:\\Exporte\\Sequenz 01 - ProRes 422.mov"]);
    expect(batchOutputs("/tmp/out", "a", [{ label: "b", ext: "mp4" }])).toEqual(["/tmp/out/a - b.mp4"]);
  });
});
