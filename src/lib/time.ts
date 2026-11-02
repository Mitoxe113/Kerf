import type { Frame, Rational } from "./types";

export const fpsOf = (r: Rational) => r.num / r.den;
export const framesToSeconds = (f: Frame, r: Rational) => (f * r.den) / r.num;
export const secondsToFrames = (s: number, r: Rational) => Math.floor((s * r.num) / r.den + 1e-6);

export const timecodeBase = (r: Rational) => Math.max(1, Math.round(fpsOf(r)));
export const supportsDropFrame = (r: Rational) => r.den === 1001 && (r.num === 30000 || r.num === 60000);

/** SMPTE timecode, identical to kerf_core::time::format_timecode. */
export function formatTimecode(frame: Frame, rate: Rational, dropFrame = supportsDropFrame(rate)): string {
  const sign = frame < 0 ? "-" : "";
  let f = Math.abs(Math.round(frame));
  const base = timecodeBase(rate);
  const drop = dropFrame && supportsDropFrame(rate);
  if (drop) {
    const dropped = base === 30 ? 2 : 4;
    const per10 = base * 600 - dropped * 9;
    const perMin = base * 60 - dropped;
    const tens = Math.floor(f / per10);
    const rem = f % per10;
    f += dropped * 9 * tens;
    if (rem > dropped) f += dropped * Math.floor((rem - dropped) / perMin);
  }
  const ff = f % base;
  const total = Math.floor(f / base);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${sign}${p(Math.floor(total / 3600))}:${p(Math.floor(total / 60) % 60)}:${p(total % 60)}${drop ? ";" : ":"}${p(ff)}`;
}

/**
 * Parses user timecode input. Accepts "HH:MM:SS:FF", partial forms typed
 * right-to-left like editors expect ("1:00" = 1 s, "112" = 1 s 12 f), and
 * relative input "+10" / "-1:00" against `relativeTo`.
 */
export function parseTimecode(input: string, rate: Rational, relativeTo?: Frame): Frame | null {
  const s = input.trim();
  if (!s) return null;
  const rel = s[0] === "+" || s[0] === "-" ? s[0] : null;
  const body = rel ? s.slice(1) : s;
  if (!/^[\d:;.]+$/.test(body)) return null;
  let parts: number[];
  if (/[:;.]/.test(body)) {
    parts = body.split(/[:;.]/).map((p) => (p === "" ? 0 : Number(p)));
  } else {
    const digits = body.padStart(8, "0").slice(-8);
    parts = [0, 2, 4, 6].map((i) => Number(digits.slice(i, i + 2)));
  }
  while (parts.length < 4) parts.unshift(0);
  const [h, m, sec, ff] = parts.slice(-4);
  const base = timecodeBase(rate);
  // Nominal counting; drop-frame inputs are interpreted as real time.
  let frames = ((h * 60 + m) * 60 + sec) * base + ff;
  if (supportsDropFrame(rate)) frames = Math.round(frames * (fpsOf(rate) / base));
  if (rel && relativeTo !== undefined) return relativeTo + (rel === "+" ? frames : -frames);
  return frames;
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "–";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

export function formatRate(r: Rational): string {
  const f = fpsOf(r);
  return Number.isInteger(f) ? `${f}` : f.toFixed(3).replace(/0+$/, "").replace(".", ",");
}

export const STANDARD_RATES: { label: string; rate: Rational }[] = [
  { label: "23,976", rate: { num: 24000, den: 1001 } },
  { label: "24", rate: { num: 24, den: 1 } },
  { label: "25", rate: { num: 25, den: 1 } },
  { label: "29,97", rate: { num: 30000, den: 1001 } },
  { label: "30", rate: { num: 30, den: 1 } },
  { label: "50", rate: { num: 50, den: 1 } },
  { label: "59,94", rate: { num: 60000, den: 1001 } },
  { label: "60", rate: { num: 60, den: 1 } },
];
