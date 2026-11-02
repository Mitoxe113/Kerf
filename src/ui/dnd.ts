// Pointer-driven drag and drop for media (the native HTML5 DnD API is not
// available on Windows while the window accepts OS file drops).

import type { Uuid } from "../lib/types";
import { create } from "zustand";

export interface DropTarget {
  el: HTMLElement;
  onMove?: (x: number, y: number, media: Uuid[], e: PointerEvent) => void;
  onLeave?: () => void;
  onDrop: (x: number, y: number, media: Uuid[], e: PointerEvent) => void;
}

/** Drag ghost position. Kept out of the editor store: it changes on every pointer move. */
export interface MediaDrag {
  media: Uuid[];
  x: number;
  y: number;
}
export const useDragGhost = create<{ drag: MediaDrag | null }>(() => ({ drag: null }));

const targets = new Set<DropTarget>();

/** Source range (sequence frames) of a drag started in the source monitor. */
let dragRange: { sourceIn: number; sourceOut: number | null } | null = null;
export const setMediaDragRange = (r: typeof dragRange) => (dragRange = r);
export const mediaDragRange = () => dragRange;

export function registerDropTarget(t: DropTarget): () => void {
  targets.add(t);
  return () => targets.delete(t);
}

function targetAt(x: number, y: number): DropTarget | null {
  let best: DropTarget | null = null;
  for (const t of targets) {
    const r = t.el.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
      // Prefer the innermost element (e.g. a bin inside the media browser).
      if (!best || best.el.contains(t.el)) best = t;
    }
  }
  return best;
}

/** `onEnd` runs after the drop (or cancel) has been handled. */
export function startMediaDrag(down: React.PointerEvent, media: Uuid[], onEnd?: () => void) {
  if (down.button !== 0 || !media.length) return onEnd?.();
  const sx = down.clientX;
  const sy = down.clientY;
  let active = false;
  let over: DropTarget | null = null;
  const move = (e: PointerEvent) => {
    if (!active) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
      active = true;
    }
    useDragGhost.setState({ drag: { media, x: e.clientX, y: e.clientY } });
    const t = targetAt(e.clientX, e.clientY);
    if (t !== over) over?.onLeave?.();
    over = t;
    t?.onMove?.(e.clientX, e.clientY, media, e);
  };
  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key);
    useDragGhost.setState({ drag: null });
  };
  const up = (e: PointerEvent) => {
    finish();
    if (!active) return onEnd?.();
    const t = targetAt(e.clientX, e.clientY);
    // The target under the pointer receives the drop (and clears its own
    // preview); only a target that was left without dropping gets onLeave.
    if (over && over !== t) over.onLeave?.();
    t?.onDrop(e.clientX, e.clientY, media, e);
    onEnd?.();
  };
  const cancel = () => {
    finish();
    over?.onLeave?.();
    onEnd?.();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") cancel();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key);
}
