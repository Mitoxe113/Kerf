import { describe, expect, it } from "vitest";
import { formatTimecode, parseTimecode } from "./time";

const PAL = { num: 25, den: 1 };
const NTSC = { num: 30000, den: 1001 };

describe("timecode", () => {
  it("matches the engine's formatting", () => {
    expect(formatTimecode(0, PAL)).toBe("00:00:00:00");
    expect(formatTimecode(25 * 3661 + 7, PAL)).toBe("01:01:01:07");
    expect(formatTimecode(1799, NTSC)).toBe("00:00:59;29");
    expect(formatTimecode(1800, NTSC)).toBe("00:01:00;02");
    expect(formatTimecode(17982, NTSC)).toBe("00:10:00;00");
  });

  it("parses full, compact and relative input", () => {
    expect(parseTimecode("00:00:01:12", PAL)).toBe(37);
    expect(parseTimecode("112", PAL)).toBe(37);
    expect(parseTimecode("1:00", PAL)).toBe(25);
    expect(parseTimecode("+10", PAL, 100)).toBe(110);
    expect(parseTimecode("-1:00", PAL, 100)).toBe(75);
    expect(parseTimecode("abc", PAL)).toBeNull();
  });
});
