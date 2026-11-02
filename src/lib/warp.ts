// Time warp of a clip with keyframed speed, mirroring kerf_core::timemap:
// source positions (sequence frames at speed 1) <-> timeline positions.
// Between two speed keys the speed changes linearly over timeline time
// (constant acceleration); a Hold key keeps its speed to the next key;
// before the first and after the last key the speed is constant.

import type { Keyframe } from "./types";

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 16;

interface Piece {
  s0: number;
  w0: number;
  v0: number;
  acc: number;
}

const clampSpeed = (v: number) => Math.min(MAX_SPEED, Math.max(MIN_SPEED, v));

export class Warp {
  /** Ordered by s0 (and w0); the first also covers everything before it. */
  private pieces: Piece[];

  constructor(keys: Keyframe[], base: number) {
    if (!keys.length) {
      this.pieces = [{ s0: 0, w0: 0, v0: clampSpeed(base), acc: 0 }];
      return;
    }
    const pieces: Piece[] = [{ s0: keys[0].at, w0: 0, v0: clampSpeed(keys[0].value), acc: 0 }];
    let w = 0;
    for (let i = 0; i + 1 < keys.length; i++) {
      const [a, b] = [keys[i], keys[i + 1]];
      const ds = Math.max(0, b.at - a.at);
      const [va, vb] = [clampSpeed(a.value), clampSpeed(b.value)];
      let dw: number;
      let acc = 0;
      if (a.ease === "hold" || ds === 0) dw = ds / va;
      else {
        dw = (2 * ds) / (va + vb);
        acc = (vb - va) / dw;
      }
      pieces.push({ s0: a.at, w0: w, v0: va, acc });
      w += dw;
    }
    const last = keys[keys.length - 1];
    pieces.push({ s0: last.at, w0: w, v0: clampSpeed(last.value), acc: 0 });
    this.pieces = pieces;
  }

  private by(key: "s0" | "w0", x: number): Piece {
    let lo = 0;
    let hi = this.pieces.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pieces[mid][key] <= x) lo = mid + 1;
      else hi = mid;
    }
    return this.pieces[Math.max(0, lo - 1)];
  }

  /** Timeline position of source position `s`. */
  w(s: number): number {
    const p = this.by("s0", s);
    const ds = s - p.s0;
    return p.w0 + (2 * ds) / (p.v0 + Math.sqrt(Math.max(0, p.v0 * p.v0 + 2 * p.acc * ds)));
  }

  /** Source position at timeline position `w`. */
  s(w: number): number {
    const p = this.by("w0", w);
    const dw = w - p.w0;
    return p.s0 + p.v0 * dw + 0.5 * p.acc * dw * dw;
  }

  /** Speed at timeline position `w`. */
  speed(w: number): number {
    const p = this.by("w0", w);
    return clampSpeed(p.v0 + p.acc * (w - p.w0));
  }
}
