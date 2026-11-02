// Preview audio graph:
//   media element -> clip gain (volume x fades) -> clip pan -> track bus -> master -> meters -> out
// The AudioContext clock is the master clock for playback.

import type { Uuid } from "../lib/types";

export interface MeterReading {
  peak: [number, number];
  rms: [number, number];
}

interface Bus {
  gain: GainNode;
  analysers: [AnalyserNode, AnalyserNode];
}

export class AudioMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterAnalysers: [AnalyserNode, AnalyserNode] | null = null;
  private buses = new Map<Uuid, Bus>();
  private scratch = new Float32Array(2048);

  context(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.master = ctx.createGain();
      this.masterAnalysers = this.meter(ctx, this.master);
      this.master.connect(ctx.destination);
      this.ctx = ctx;
    }
    return this.ctx;
  }

  /** Seconds on the audio hardware clock. */
  now(): number {
    return this.ctx ? this.ctx.currentTime : performance.now() / 1000;
  }

  async resume() {
    const ctx = this.context();
    if (ctx.state !== "running") await ctx.resume();
  }

  private meter(ctx: AudioContext, node: AudioNode): [AnalyserNode, AnalyserNode] {
    const split = ctx.createChannelSplitter(2);
    node.connect(split);
    const mk = (ch: number) => {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      split.connect(a, ch);
      return a;
    };
    return [mk(0), mk(1)];
  }

  bus(track: Uuid): GainNode {
    let b = this.buses.get(track);
    if (!b) {
      const ctx = this.context();
      const gain = ctx.createGain();
      gain.connect(this.master!);
      b = { gain, analysers: this.meter(ctx, gain) };
      this.buses.set(track, b);
    }
    return b.gain;
  }

  setBusGain(track: Uuid, gain: number) {
    const g = this.bus(track);
    g.gain.setTargetAtTime(gain, this.context().currentTime, 0.015);
  }

  setMasterGain(gain: number) {
    this.context();
    this.master!.gain.setTargetAtTime(gain, this.ctx!.currentTime, 0.015);
  }

  private read(pair: [AnalyserNode, AnalyserNode]): MeterReading {
    const peak: [number, number] = [0, 0];
    const rms: [number, number] = [0, 0];
    pair.forEach((a, i) => {
      const buf = this.scratch.subarray(0, a.fftSize);
      a.getFloatTimeDomainData(buf);
      let p = 0;
      let sum = 0;
      for (let k = 0; k < buf.length; k++) {
        const v = Math.abs(buf[k]);
        if (v > p) p = v;
        sum += v * v;
      }
      peak[i] = p;
      rms[i] = Math.sqrt(sum / buf.length);
    });
    return { peak, rms };
  }

  masterLevels(): MeterReading | null {
    return this.masterAnalysers ? this.read(this.masterAnalysers) : null;
  }

  trackLevels(track: Uuid): MeterReading | null {
    const b = this.buses.get(track);
    return b ? this.read(b.analysers) : null;
  }
}
