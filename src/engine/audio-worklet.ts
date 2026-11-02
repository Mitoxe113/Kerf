// AudioWorklet processors (loaded by AudioMixer):
//   "kerf-effects"  runs the effect chain of a clip or a track (dsp.ts)
//   "kerf-loudness" measures the master (EBU R128) and posts readings.

import type { AudioEffectKind, ChannelMap } from "../lib/types";
import { buildChain, LoudnessMeter, type Stage } from "./dsp";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export interface EffectsMessage {
  effects: AudioEffectKind[];
  channels?: ChannelMap;
}

class EffectsProcessor extends AudioWorkletProcessor {
  private chain: Stage[] = [];

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<EffectsMessage>) => {
      const next = buildChain(e.data.effects, e.data.channels, sampleRate);
      // Same stages in the same order (a setting changed): keep filter memory and envelopes.
      const old = this.chain;
      if (next.length === old.length && next.every((s, i) => s.constructor === old[i].constructor)) next.forEach((s, i) => s.adopt?.(old[i]));
      this.chain = next;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [l, r] = outputs[0];
    const input = inputs[0];
    if (!input.length) {
      l.fill(0);
      r.fill(0);
    } else {
      l.set(input[0]);
      r.set(input[1] ?? input[0]);
    }
    for (const s of this.chain) s.process(l, r);
    return true;
  }
}

class LoudnessProcessor extends AudioWorkletProcessor {
  private meter = new LoudnessMeter(sampleRate);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<"reset">) => {
      if (e.data === "reset") this.meter.reset();
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (input.length) {
      const reading = this.meter.push(input[0], input[1] ?? input[0]);
      if (reading) this.port.postMessage(reading);
    }
    return true;
  }
}

registerProcessor("kerf-effects", EffectsProcessor);
registerProcessor("kerf-loudness", LoudnessProcessor);
