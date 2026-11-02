import { useSyncExternalStore } from "react";
import { engine } from "./playback";

const subscribe = (cb: () => void) => engine.subscribe(cb);

/** Current playhead frame (re-renders on every engine tick). */
export function usePlayhead(): number {
  return useSyncExternalStore(subscribe, () => Math.round(engine.frame));
}

export function usePlaying(): boolean {
  return useSyncExternalStore(subscribe, () => engine.playing);
}

export function useRate(): number {
  return useSyncExternalStore(subscribe, () => (engine.playing ? engine.rate : 0));
}
