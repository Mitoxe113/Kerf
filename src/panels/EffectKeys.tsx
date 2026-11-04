// Keyframes of effect parameters (kerf_core Effect::keys): the value at the
// playhead, edits that set a key there, and the stopwatch / key navigation
// next to a parameter, as the Inspector's KeyNav does for clip properties.

import { ChevronLeft, ChevronRight, Diamond, Timer } from "lucide-react";
import { useSyncExternalStore } from "react";
import { effectHasKeys, effectValue, withEffectValue } from "../engine/effects";
import { engine } from "../engine/playback";
import { EASES, keysValue, localOf, playheadKeyPos, removeKey, sameEase, upsertKey } from "../lib/keys";
import type { Clip, Effect, Keyframe } from "../lib/types";
import { cx, openContextMenu } from "../ui/primitives";

export interface FxStack {
  effects: Effect[];
  commit: (next: Effect[]) => Promise<void>;
  patch: (id: string, p: Partial<Effect>, live?: boolean) => void;
}

/** Playhead frame while `e` is animated on the single clip `c`; −1 otherwise (no per-frame re-render). */
export function useFxFrame(c: Clip | null, e: Effect): number {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => (c && effectHasKeys(e) ? Math.round(engine.frame) : -1),
  );
}

const keysOf = (e: Effect, key: string): Keyframe[] => e.keys?.[key] ?? [];

/** `keys` without empty lists (kerf_core Effect::clean_keys drops them too). */
export function withKeys(e: Effect, keys: Record<string, Keyframe[]>): Effect {
  const clean = Object.fromEntries(Object.entries(keys).filter(([, k]) => k.length > 0));
  const { keys: _old, ...rest } = e;
  return (Object.keys(clean).length ? { ...rest, keys: clean } : rest) as Effect;
}

/**
 * Keyframe-aware editing of effect `e` on clip `c` (null with several clips:
 * static values only). `frame` comes from useFxFrame.
 */
export function fxKeying(stack: FxStack, c: Clip | null, e: Effect, frame: number) {
  const f = frame < 0 ? Math.round(engine.frame) : frame;
  const keyed = (key: string) => c !== null && keysOf(e, key).length > 0;
  const local = c ? Math.min(Math.max(f - c.start, 0), c.duration - 1) : 0;
  return {
    /** Value of `key` (static value `base`) at the playhead. */
    value: (key: string, base: number) => (c && keyed(key) ? keysValue(c, keysOf(e, key), base, local) : base),
    /** Sets a key at the playhead when `key` is animated, the static value (`patch`) otherwise. */
    change: (key: string, v: number, live: boolean, patch: Partial<Effect>) => {
      if (c && keyed(key)) stack.patch(e.id, { keys: { ...e.keys, [key]: upsertKey(keysOf(e, key), playheadKeyPos(c, f), v) } }, live);
      else stack.patch(e.id, patch, live);
    },
  };
}

/** Stopwatch, previous/next key and add/remove key for parameters `params` of `e` (edited together). */
export function FxKeyNav({ stack, clip: c, effect: e, params, frame }: { stack: FxStack; clip: Clip | null; effect: Effect; params: string[]; frame: number }) {
  if (!c) return null;
  const keyed = params.some((k) => keysOf(e, k).length > 0);
  const f = frame < 0 ? Math.round(engine.frame) : frame;
  const inside = f >= c.start && f < c.start + c.duration;
  const at = playheadKeyPos(c, f);
  const positions = [...new Set(params.flatMap((k) => keysOf(e, k).map((x) => x.at)))].sort((a, b) => a - b);
  const onKey = positions.includes(at) && inside;
  const prev = [...positions].reverse().find((x) => x < at);
  const next = positions.find((x) => x > at);
  const put = (n: Effect) => void stack.commit(stack.effects.map((x) => (x.id === e.id ? n : x)));
  const valueAt = (k: string, local: number) => keysValue(c, keysOf(e, k), effectValue(e, k), local);
  const seekKey = (pos: number) => {
    engine.pause();
    engine.seek(Math.round(c.start + localOf(c, pos)));
  };
  const toggleWatch = () => {
    const local = Math.min(Math.max(f - c.start, 0), c.duration - 1);
    const keys = { ...e.keys };
    let n = e;
    for (const k of params) {
      // Stopping the watch keeps the value under the playhead as the static value.
      if (keyed) {
        n = withEffectValue(n, k, valueAt(k, local));
        delete keys[k];
      } else keys[k] = [{ at, value: effectValue(e, k), ease: "linear" }];
    }
    put(withKeys(n, keys));
  };
  const toggleKey = () => {
    const keys = { ...e.keys };
    for (const k of params) keys[k] = onKey ? removeKey(keysOf(e, k), at) : upsertKey(keysOf(e, k), at, valueAt(k, f - c.start));
    put(withKeys(e, keys));
  };
  const keyMenu = (ev: React.MouseEvent) => {
    if (!onKey) return;
    ev.preventDefault();
    const current = keysOf(e, params[0]).find((k) => k.at === at)?.ease;
    openContextMenu(ev, [
      ...EASES.map((x) => ({
        label: x.label,
        checked: sameEase(current, x.value),
        onSelect: () => {
          const keys = { ...e.keys };
          for (const k of params) {
            const key = keysOf(e, k).find((y) => y.at === at);
            if (key) keys[k] = upsertKey(keysOf(e, k), at, key.value, x.value);
          }
          put(withKeys(e, keys));
        },
      })),
      { separator: true },
      { label: "Keyframe löschen", danger: true, onSelect: toggleKey },
    ]);
  };
  const btn = "flex h-5 w-5 items-center justify-center rounded-xs text-fg-3 hover:bg-hover hover:text-fg-2 disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex shrink-0 items-center">
      {keyed && (
        <>
          <button className={btn} aria-label="Vorheriger Keyframe" title="Vorheriger Keyframe" disabled={prev === undefined} onClick={() => prev !== undefined && seekKey(prev)}>
            <ChevronLeft size={12} />
          </button>
          <button
            className={cx(btn, onKey && "text-signal hover:text-signal")}
            aria-label={onKey ? "Keyframe entfernen" : "Keyframe hinzufügen"}
            title={onKey ? "Keyframe entfernen (Rechtsklick: Interpolation)" : "Keyframe hinzufügen"}
            disabled={!inside}
            onClick={toggleKey}
            onContextMenu={keyMenu}
          >
            <Diamond size={10} fill={onKey ? "currentColor" : "none"} />
          </button>
          <button className={btn} aria-label="Nächster Keyframe" title="Nächster Keyframe" disabled={next === undefined} onClick={() => next !== undefined && seekKey(next)}>
            <ChevronRight size={12} />
          </button>
        </>
      )}
      <button
        className={cx(btn, keyed && "text-signal hover:text-signal")}
        aria-label={keyed ? "Animation beenden" : "Animieren"}
        title={keyed ? "Animation beenden (Wert am Playhead bleibt)" : "Animieren: Keyframe am Playhead setzen"}
        aria-pressed={keyed}
        onClick={toggleWatch}
      >
        <Timer size={12} />
      </button>
    </div>
  );
}
