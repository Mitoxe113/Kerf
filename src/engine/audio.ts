// Preview audio graph:
//   media element -> [clip effects] -> clip gain (volume x fades) -> clip pan
//     -> track input -> [track effects] -> track gain -> master -> meters, loudness -> out
// The tracks of a nested sequence have buses of their own (keyed by the path of
// nested clips) that feed the nested clip's input instead of the master.
// Effects run in an AudioWorklet (audio-worklet.ts) once it has loaded; until
// then the clips play dry. The AudioContext clock is the master clock for playback.

import type { AudioEffect, Uuid } from "../lib/types";
import workletUrl from "./audio-worklet.ts?worker&url";
import type { EffectsMessage } from "./audio-worklet";
import { activeKinds, type LoudnessReading } from "./dsp";

export interface MeterReading {
  peak: [number, number];
  rms: [number, number];
}

interface Bus {
  /** Where the clips of the track meet. */
  input: GainNode;
  fx: AudioWorkletNode | null;
  /** Effects the track should run, and the ones sent to `fx`. */
  want: EffectsMessage;
  sent: string;
  gain: GainNode;
  /** Where the bus goes (the master, or a nested clip's input). */
  dest: AudioNode;
  analysers: [AnalyserNode, AnalyserNode];
}

/** Message for an effects node, or null when it would change nothing. */
export function effectsMessage(effects: AudioEffect[] | undefined, channels: EffectsMessage["channels"]): EffectsMessage | null {
  const kinds = activeKinds(effects);
  return kinds.length || (channels && channels !== "stereo") ? { effects: kinds, channels } : null;
}

export class AudioMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterAnalysers: [AnalyserNode, AnalyserNode] | null = null;
  private buses = new Map<Uuid, Bus>();
  private scratch = new Float32Array(2048);
  private fxLoaded = false;
  private loudnessNode: AudioWorkletNode | null = null;
  /** Latest EBU R128 reading of the master, null before the first. */
  loudness: LoudnessReading | null = null;
  /** Called once the effect processors are ready (voices then get their effects). */
  onEffectsReady: (() => void) | null = null;

  context(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.master = ctx.createGain();
      this.masterAnalysers = this.meter(ctx, this.master);
      this.master.connect(ctx.destination);
      this.ctx = ctx;
      ctx.audioWorklet
        .addModule(workletUrl)
        .then(() => {
          this.fxLoaded = true;
          // Without outputs the meter is pulled by the context on its own.
          const meter = new AudioWorkletNode(ctx, "kerf-loudness", { numberOfInputs: 1, numberOfOutputs: 0 });
          meter.port.onmessage = (e: MessageEvent<LoudnessReading>) => (this.loudness = e.data);
          this.master!.connect(meter);
          this.loudnessNode = meter;
          for (const b of this.buses.values()) this.wireBus(b);
          this.onEffectsReady?.();
        })
        .catch((e) => console.warn("audio effects unavailable", e));
    }
    return this.ctx;
  }

  /** A node running a clip's effects (always two channels out), or null while loading. */
  effectsNode(): AudioWorkletNode | null {
    if (!this.fxLoaded || !this.ctx) return null;
    return new AudioWorkletNode(this.ctx, "kerf-effects", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  }

  /** Starts the integrated loudness over. */
  resetLoudness() {
    this.loudnessNode?.port.postMessage("reset");
    this.loudness = null;
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

  /** Bus `key` (a track id, prefixed for nested sequences) going to `dest` (null = master). */
  private busOf(key: string, dest: AudioNode | null = null): Bus {
    this.context();
    const to = dest ?? this.master!;
    let b = this.buses.get(key);
    if (!b) {
      const ctx = this.context();
      const input = ctx.createGain();
      const gain = ctx.createGain();
      input.connect(gain);
      gain.connect(to);
      b = { input, fx: null, want: { effects: [] }, sent: "", gain, dest: to, analysers: this.meter(ctx, gain) };
      this.buses.set(key, b);
    } else if (b.dest !== to) {
      b.gain.disconnect(b.dest);
      b.gain.connect(to);
      b.dest = to;
    }
    return b;
  }

  /** Input of a track's bus, where its clips connect. */
  bus(key: string, dest: AudioNode | null = null): AudioNode {
    return this.busOf(key, dest).input;
  }

  setBusGain(key: string, gain: number, dest: AudioNode | null = null) {
    const g = this.busOf(key, dest).gain;
    g.gain.setTargetAtTime(gain, this.context().currentTime, 0.015);
  }

  /** Track effects, after the sum of its clips (mono folds it first), before its volume. */
  setBusEffects(key: string, effects: AudioEffect[] | undefined, mono: boolean, dest: AudioNode | null = null) {
    const b = this.busOf(key, dest);
    b.want = effectsMessage(effects, mono ? "mono" : undefined) ?? { effects: [] };
    this.wireBus(b);
  }

  private wireBus(b: Bus) {
    const key = JSON.stringify(b.want);
    if (key === b.sent) return;
    const needed = b.want.effects.length > 0 || b.want.channels === "mono";
    if (needed && !b.fx) {
      const fx = this.effectsNode();
      if (!fx) return;
      b.input.disconnect();
      b.input.connect(fx).connect(b.gain);
      b.fx = fx;
    } else if (!needed && b.fx) {
      b.input.disconnect();
      b.fx.disconnect();
      b.fx = null;
      b.input.connect(b.gain);
    }
    b.fx?.port.postMessage(b.want);
    b.sent = key;
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
