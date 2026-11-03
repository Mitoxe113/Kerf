// Audio effects of the preview. Each stage computes what the FFmpeg filter
// the export uses computes, sample for sample: the RBJ biquads of
// af_biquads.c (direct form I), acompressor and agate (RMS detection,
// channels averaged) and alimiter (5 ms look-ahead), ported from FFmpeg.
// Runs inside the AudioWorklet (audio-worklet.ts) and in tests against
// FFmpeg's output (dsp.test.ts).
//
// Derived from FFmpeg's libavfilter (af_biquads.c, af_sidechaincompress.c,
// af_agate.c, af_alimiter.c), LGPL-2.1-or-later, here under Kerf's
// GPL-3.0-or-later (LGPL 2.1, section 3):
//   Copyright (c) 2013 Paul B Mahol
//   Copyright (c) 2006-2008 Rob Sykes
//   Copyright (C) 2001-2010 Krzysztof Foltman, Markus Schmidt, Thor Harald
//     Johansen, Damien Zammit and others
//   Copyright (c) 2015 Paul B Mahol

import type { AudioEffect, AudioEffectKind, ChannelMap, EqBand } from "../lib/types";

/** Processes a block of two channels in place. */
export interface Stage {
  process(l: Float32Array, r: Float32Array): void;
  /** Takes over the running state of `old` (same class), so a changed setting does not click. */
  adopt?(old: Stage): void;
}

const lin = (db: number) => Math.pow(10, db / 20);

/** Look-ahead of the limiter (FFmpeg's default attack), ms. */
export const LIMITER_ATTACK_MS = 5;
/** Knee of the gate (FFmpeg's default). */
const GATE_KNEE = 2.828427125;

// --- equaliser ---------------------------------------------------------------------

/** Normalised coefficients [b0, b1, b2, a1, a2] of one band, null when it cannot run at `sr`. */
export function biquadCoefficients(b: EqBand, sr: number): [number, number, number, number, number] | null {
  const A = Math.pow(10, b.gainDb / 40);
  const w0 = (2 * Math.PI * b.freq) / sr;
  if (w0 > Math.PI || w0 <= 0 || b.q <= 0) return null;
  const shelf = b.shape === "lowShelf" || b.shape === "highShelf";
  // Shelves: slope 1 (WebAudio's and FFmpeg's t=s:w=1); the rest: Q.
  const alpha = shelf ? (Math.sin(w0) / 2) * Math.sqrt(2) : Math.sin(w0) / (2 * b.q);
  const beta = 2 * Math.sqrt(A);
  const c = Math.cos(w0);
  let k: [number, number, number, number, number, number];
  switch (b.shape) {
    case "peak":
      k = [1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A];
      break;
    case "lowShelf":
      k = [
        A * (A + 1 - (A - 1) * c + beta * alpha),
        2 * A * (A - 1 - (A + 1) * c),
        A * (A + 1 - (A - 1) * c - beta * alpha),
        A + 1 + (A - 1) * c + beta * alpha,
        -2 * (A - 1 + (A + 1) * c),
        A + 1 + (A - 1) * c - beta * alpha,
      ];
      break;
    case "highShelf":
      k = [
        A * (A + 1 + (A - 1) * c + beta * alpha),
        -2 * A * (A - 1 + (A + 1) * c),
        A * (A + 1 + (A - 1) * c - beta * alpha),
        A + 1 - (A - 1) * c + beta * alpha,
        2 * (A - 1 - (A + 1) * c),
        A + 1 - (A - 1) * c - beta * alpha,
      ];
      break;
    case "lowPass":
      k = [(1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha];
      break;
    case "highPass":
      k = [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha];
      break;
  }
  const [b0, b1, b2, a0, a1, a2] = k;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

class Biquad implements Stage {
  // x1, x2, y1, y2 per channel
  private s = [new Float64Array(4), new Float64Array(4)];
  adopt(old: Stage) {
    if (old instanceof Biquad) this.s = old.s;
  }
  constructor(private k: [number, number, number, number, number]) {}

  process(l: Float32Array, r: Float32Array) {
    const [b0, b1, b2, a1, a2] = this.k;
    [l, r].forEach((x, ch) => {
      const s = this.s[ch];
      for (let i = 0; i < x.length; i++) {
        const v = x[i];
        const y = b0 * v + b1 * s[0] + b2 * s[1] - a1 * s[2] - a2 * s[3];
        s[1] = s[0];
        s[0] = v;
        s[3] = s[2];
        s[2] = y;
        x[i] = y;
      }
    });
  }
}

// --- dynamics ------------------------------------------------------------------------

function hermite(x: number, x0: number, x1: number, p0: number, p1: number, m0: number, m1: number): number {
  const width = x1 - x0;
  const t = (x - x0) / width;
  m0 *= width;
  m1 *= width;
  const t2 = t * t;
  const t3 = t2 * t;
  const ct2 = -3 * p0 - 2 * m0 + 3 * p1 - m1;
  const ct3 = 2 * p0 + m0 - 2 * p1 + m1;
  return ct3 * t3 + ct2 * t2 + m0 * t + p0;
}

const coeff = (ms: number, sr: number) => Math.min(1, 1 / ((ms * sr) / 4000));

/** acompressor, downward, RMS detection, link average. */
class Compressor implements Stage {
  private slope = 0;
  adopt(old: Stage) {
    if (old instanceof Compressor) this.slope = old.slope;
  }
  private readonly thres: number;
  private readonly kneeStart: number;
  private readonly kneeStop: number;
  private readonly adjKneeStart: number;
  private readonly compressedKneeStop: number;
  private readonly makeup: number;
  private readonly knee: number;
  private readonly attack: number;
  private readonly release: number;

  constructor(
    e: Extract<AudioEffectKind, { type: "compressor" }>,
    sr: number,
    private ratio = e.ratio,
  ) {
    const threshold = Math.max(0.000976563, lin(e.thresholdDb));
    this.knee = Math.min(8, Math.max(1, lin(e.kneeDb)));
    this.makeup = lin(e.makeupDb);
    this.thres = Math.log(threshold);
    const linKneeStart = threshold / Math.sqrt(this.knee);
    const linKneeStop = threshold * Math.sqrt(this.knee);
    this.adjKneeStart = linKneeStart * linKneeStart;
    this.kneeStart = Math.log(linKneeStart);
    this.kneeStop = Math.log(linKneeStop);
    this.compressedKneeStop = (this.kneeStop - this.thres) / this.ratio + this.thres;
    this.attack = coeff(e.attackMs, sr);
    this.release = coeff(e.releaseMs, sr);
  }

  private gain(linSlope: number): number {
    const slope = Math.log(linSlope) * 0.5;
    let gain = (slope - this.thres) / this.ratio + this.thres;
    if (this.knee > 1 && slope < this.kneeStop) gain = hermite(slope, this.kneeStart, this.kneeStop, this.kneeStart, this.compressedKneeStop, 1, 1 / this.ratio);
    return Math.exp(gain - slope);
  }

  process(l: Float32Array, r: Float32Array) {
    for (let i = 0; i < l.length; i++) {
      let a = (Math.abs(l[i]) + Math.abs(r[i])) / 2;
      a *= a;
      this.slope += (a - this.slope) * (a > this.slope ? this.attack : this.release);
      const g = (this.slope > 0 && this.slope > this.adjKneeStart ? this.gain(this.slope) : 1) * this.makeup;
      l[i] *= g;
      r[i] *= g;
    }
  }
}

/** agate, downward, RMS detection, link average. */
class Gate implements Stage {
  private slope = 0;
  adopt(old: Stage) {
    if (old instanceof Gate) this.slope = old.slope;
  }
  private readonly thres: number;
  private readonly kneeStart: number;
  private readonly kneeStop: number;
  private readonly linKneeStop: number;
  private readonly range: number;
  private readonly attack: number;
  private readonly release: number;

  constructor(
    e: Extract<AudioEffectKind, { type: "gate" }>,
    sr: number,
    private ratio = e.ratio,
  ) {
    const t = lin(e.thresholdDb);
    const linThreshold = t * t;
    const k = Math.sqrt(GATE_KNEE);
    this.linKneeStop = linThreshold * k;
    this.thres = Math.log(linThreshold);
    this.kneeStart = Math.log(linThreshold / k);
    this.kneeStop = Math.log(this.linKneeStop);
    this.range = lin(e.rangeDb);
    this.attack = coeff(e.attackMs, sr);
    this.release = coeff(e.releaseMs, sr);
  }

  private gain(linSlope: number): number {
    const slope = Math.log(linSlope);
    const r = this.ratio;
    let gain = (slope - this.thres) * r + this.thres;
    if (slope > this.kneeStart) gain = hermite(slope, this.kneeStart, this.kneeStop, (this.kneeStart - this.thres) * r + this.thres, this.kneeStop, r, 1);
    return Math.max(this.range, Math.exp(gain - slope));
  }

  process(l: Float32Array, r: Float32Array) {
    for (let i = 0; i < l.length; i++) {
      let a = (Math.abs(l[i]) + Math.abs(r[i])) / 2;
      a *= a;
      this.slope += (a - this.slope) * (a > this.slope ? this.attack : this.release);
      const g = this.slope > 0 && this.slope < this.linKneeStop ? this.gain(this.slope) : 1;
      l[i] *= g;
      r[i] *= g;
    }
  }
}

/** alimiter without automatic release and level, two channels (the output lags by the look-ahead). */
class Limiter implements Stage {
  private readonly limit: number;
  private readonly release: number;
  private readonly size: number;
  private readonly buffer: Float64Array;
  private readonly nextdelta: Float64Array;
  private readonly nextpos: Int32Array;
  private pos = 0;
  private att = 1;
  private delta = 0;
  private nextiter = 0;
  private nextlen = 0;
  adopt(old: Stage) {
    if (!(old instanceof Limiter) || old.size !== this.size) return;
    this.buffer.set(old.buffer);
    this.nextdelta.set(old.nextdelta);
    this.nextpos.set(old.nextpos);
    [this.pos, this.att, this.delta, this.nextiter, this.nextlen] = [old.pos, old.att, old.delta, old.nextiter, old.nextlen];
  }

  constructor(
    e: Extract<AudioEffectKind, { type: "limiter" }>,
    private sr: number,
  ) {
    this.limit = Math.min(1, Math.max(0.0625, lin(e.ceilingDb)));
    this.release = e.releaseMs / 1000;
    const ch = 2;
    const max = Math.floor((sr * ch * 100) / 1000 + ch);
    this.buffer = new Float64Array(max);
    this.nextdelta = new Float64Array(max);
    this.nextpos = new Int32Array(max).fill(-1);
    let size = Math.floor(sr * (LIMITER_ATTACK_MS / 1000) * ch);
    size -= size % ch;
    this.size = size;
  }

  process(l: Float32Array, r: Float32Array) {
    const { buffer, nextpos, nextdelta, size, limit, release, sr } = this;
    const ch = 2;
    for (let n = 0; n < l.length; n++) {
      buffer[this.pos] = l[n];
      buffer[this.pos + 1] = r[n];
      let peak = Math.max(Math.abs(l[n]), Math.abs(r[n]));
      if (peak > limit) {
        const patt = Math.min(limit / peak, 1);
        const rdelta = (1 - patt) / (sr * release);
        const delta = ((limit / peak - this.att) / size) * ch;
        if (delta < this.delta) {
          this.delta = delta;
          nextpos[0] = this.pos;
          nextpos[1] = -1;
          nextdelta[0] = rdelta;
          this.nextlen = 1;
          this.nextiter = 0;
        } else {
          let found = false;
          let i = this.nextiter;
          for (; i < this.nextiter + this.nextlen; i++) {
            const j = i % size;
            let ppeak = 0;
            if (nextpos[j] >= 0) ppeak = Math.max(Math.abs(buffer[nextpos[j]]), Math.abs(buffer[nextpos[j] + 1]));
            const pdelta = (limit / peak - limit / ppeak) / Math.trunc(((size - nextpos[j] + this.pos) % size) / ch);
            if (pdelta < nextdelta[j]) {
              nextdelta[j] = pdelta;
              found = true;
              break;
            }
          }
          if (found) {
            this.nextlen = i - this.nextiter + 1;
            nextpos[(this.nextiter + this.nextlen) % size] = this.pos;
            nextdelta[(this.nextiter + this.nextlen) % size] = rdelta;
            nextpos[(this.nextiter + this.nextlen + 1) % size] = -1;
            this.nextlen++;
          }
        }
      }
      const at = (this.pos + ch) % size;
      const bl = buffer[at];
      const br = buffer[at + 1];
      peak = Math.max(Math.abs(bl), Math.abs(br));
      this.att += this.delta;
      let ol = bl * this.att;
      let or = br * this.att;
      if (at === nextpos[this.nextiter]) {
        this.delta = nextdelta[this.nextiter];
        this.att = limit / peak;
        this.nextlen -= 1;
        nextpos[this.nextiter] = -1;
        this.nextiter = (this.nextiter + 1) % size;
      }
      if (this.att > 1) {
        this.att = 1;
        this.delta = 0;
        this.nextiter = 0;
        this.nextlen = 0;
        nextpos[0] = -1;
      }
      if (this.att <= 0) {
        this.att = 0.0000000000001;
        this.delta = (1 - this.att) / (sr * release);
      }
      if (this.att !== 1 && 1 - this.att < 0.0000000000001) this.att = 1;
      if (this.delta !== 0 && Math.abs(this.delta) < 0.00000000000001) this.delta = 0;
      ol = Math.min(limit, Math.max(-limit, ol));
      or = Math.min(limit, Math.max(-limit, or));
      l[n] = ol;
      r[n] = or;
      this.pos = (this.pos + ch) % size;
    }
  }
}

// --- routing --------------------------------------------------------------------------

/** Output gains [[l<-l, l<-r], [r<-l, r<-r]] (kerf-core ChannelMap::matrix). */
export function channelMatrix(m: ChannelMap | undefined): [[number, number], [number, number]] {
  switch (m) {
    case "mono":
      return [[0.5, 0.5], [0.5, 0.5]];
    case "left":
      return [[1, 0], [1, 0]];
    case "right":
      return [[0, 1], [0, 1]];
    case "swap":
      return [[0, 1], [1, 0]];
    default:
      return [[1, 0], [0, 1]];
  }
}

class Matrix implements Stage {
  constructor(private m: [[number, number], [number, number]]) {}
  process(l: Float32Array, r: Float32Array) {
    const [[ll, lr], [rl, rr]] = this.m;
    for (let i = 0; i < l.length; i++) {
      const [a, b] = [l[i], r[i]];
      l[i] = ll * a + lr * b;
      r[i] = rl * a + rr * b;
    }
  }
}

/** True when the effect changes the signal (kerf-core is_identity). */
export function isActive(e: AudioEffectKind & { enabled?: boolean }): boolean {
  if (e.enabled === false) return false;
  switch (e.type) {
    case "eq":
      return e.bands.some((b) => b.enabled && (b.shape === "highPass" || b.shape === "lowPass" || b.gainDb !== 0));
    case "compressor":
      return e.ratio > 1 || e.makeupDb !== 0;
    case "gate":
      return e.rangeDb < 0 && e.ratio > 1;
    case "limiter":
      return true;
  }
}

/** The effects of `list` that change the signal, without id and switch. */
export function activeKinds(list: AudioEffect[] | undefined): AudioEffectKind[] {
  return (list ?? []).filter(isActive).map(({ id: _id, enabled: _on, ...kind }) => kind as AudioEffectKind);
}

/** Stages for a channel map and effects, in the export's order. */
export function buildChain(effects: AudioEffectKind[], channels: ChannelMap | undefined, sr: number): Stage[] {
  const out: Stage[] = [];
  if (channels && channels !== "stereo") out.push(new Matrix(channelMatrix(channels)));
  for (const e of effects) {
    switch (e.type) {
      case "eq":
        for (const b of e.bands) {
          const k = b.enabled ? biquadCoefficients(b, sr) : null;
          if (k) out.push(new Biquad(k));
        }
        break;
      case "compressor":
        out.push(new Compressor(e, sr));
        break;
      case "gate":
        out.push(new Gate(e, sr));
        break;
      case "limiter":
        out.push(new Limiter(e, sr));
        break;
    }
  }
  return out;
}

// --- loudness ---------------------------------------------------------------------------

/** BS.1770 K-weighting (pre-filter and RLB high-pass) for `sr`, as libebur128 derives it. */
export function kWeighting(sr: number): [number, number, number, number, number][] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const pre: [number, number, number, number, number] = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const rlb: [number, number, number, number, number] = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [pre, rlb];
}

export interface LoudnessReading {
  /** Momentary (400 ms), short-term (3 s) and integrated loudness, LUFS (-Infinity when silent). */
  momentary: number;
  shortTerm: number;
  integrated: number;
}

const toLufs = (ms: number) => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);

/** EBU R128 loudness of a running stereo signal, in 100 ms steps. */
export class LoudnessMeter {
  private filters: Biquad[];
  private readonly step: number;
  private acc = 0;
  private count = 0;
  /** Mean squares of the last 30 steps (100 ms each). */
  private steps: number[] = [];
  /** Mean squares of every 400 ms block so far (75 % overlap), for gating. */
  private blocks: number[] = [];
  private l = new Float32Array(128);
  private r = new Float32Array(128);

  constructor(sr: number) {
    this.filters = kWeighting(sr).map((k) => new Biquad(k));
    this.step = Math.round(sr / 10);
  }

  reset() {
    this.steps = [];
    this.blocks = [];
    this.acc = 0;
    this.count = 0;
  }

  /** Adds samples; returns a reading each time a 100 ms step completes. */
  push(l: Float32Array, r: Float32Array): LoudnessReading | null {
    if (this.l.length < l.length) [this.l, this.r] = [new Float32Array(l.length), new Float32Array(l.length)];
    const [fl, fr] = [this.l.subarray(0, l.length), this.r.subarray(0, r.length)];
    fl.set(l);
    fr.set(r);
    for (const f of this.filters) f.process(fl, fr);
    let reading: LoudnessReading | null = null;
    for (let i = 0; i < fl.length; i++) {
      this.acc += fl[i] * fl[i] + fr[i] * fr[i];
      if (++this.count === this.step) {
        this.steps.push(this.acc / this.step);
        if (this.steps.length > 30) this.steps.shift();
        this.acc = 0;
        this.count = 0;
        const mean = (n: number) => this.steps.slice(-n).reduce((a, b) => a + b, 0) / Math.min(n, this.steps.length);
        if (this.steps.length >= 4) this.blocks.push(mean(4));
        reading = { momentary: toLufs(mean(4)), shortTerm: toLufs(mean(30)), integrated: this.integrated() };
      }
    }
    return reading;
  }

  /** Gated: blocks above -70 LUFS, then above 10 LU under their mean. */
  integrated(): number {
    const abs = this.blocks.filter((b) => toLufs(b) > -70);
    if (!abs.length) return -Infinity;
    const gate = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const rel = abs.filter((b) => toLufs(b) > gate);
    return rel.length ? toLufs(rel.reduce((a, b) => a + b, 0) / rel.length) : -Infinity;
  }
}
