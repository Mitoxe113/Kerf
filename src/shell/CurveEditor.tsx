// Custom keyframe interpolation: a cubic Bezier between two keys, edited by
// dragging its two control points (like CSS cubic-bezier()). x is time and
// stays in 0..1; y may overshoot so the value can swing past the next key.

import { useEffect, useRef, useState } from "react";
import { bezier, DEFAULT_BEZIER, isBezier, keysOf, upsertKey } from "../lib/keys";
import type { KeyParam, Uuid } from "../lib/types";
import { edit, useProject } from "../state/project";
import { Button, cx, Field, Modal, NumberField } from "../ui/primitives";

type Pts = { x1: number; y1: number; x2: number; y2: number };

const PRESETS: { label: string; v: Pts }[] = [
  { label: "Weich", v: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } },
  { label: "Langsam rein", v: { x1: 0.42, y1: 0, x2: 1, y2: 1 } },
  { label: "Langsam raus", v: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
  { label: "Beides", v: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
  { label: "Stark", v: { x1: 0.85, y1: 0, x2: 0.15, y2: 1 } },
  { label: "Überschwingen", v: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } },
  { label: "Ausholen", v: { x1: 0.36, y1: -0.6, x2: 0.66, y2: 1 } },
];

// Plot: x 0..1 across, y -0.75..1.75 so overshoot stays visible.
const W = 260;
const H = 260;
const PAD = 14;
const Y_LO = -0.75;
const Y_HI = 1.75;
const sx = (x: number) => PAD + x * (W - 2 * PAD);
const sy = (y: number) => PAD + ((Y_HI - y) / (Y_HI - Y_LO)) * (H - 2 * PAD);
const fromScreen = (px: number, py: number) => ({
  x: Math.min(1, Math.max(0, (px - PAD) / (W - 2 * PAD))),
  y: Math.min(2, Math.max(-1, Y_HI - ((py - PAD) / (H - 2 * PAD)) * (Y_HI - Y_LO))),
});
const round = (v: number) => Math.round(v * 1000) / 1000;

export function CurveDialog({ sequence, clip, params, at, onClose }: { sequence: Uuid; clip: Uuid; params: KeyParam[]; at: number; onClose: () => void }) {
  const c = useProject((s) => s.project?.sequences.find((q) => q.id === sequence)?.tracks.flatMap((t) => t.clips).find((x) => x.id === clip));
  const start = c ? keysOf(c, params[0]).find((k) => k.at === at)?.ease : undefined;
  const [pts, setPts] = useState<Pts>(isBezier(start) ? start.bezier : DEFAULT_BEZIER);
  const [drag, setDrag] = useState<1 | 2 | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const move = (e: React.PointerEvent) => {
    if (!drag || !svg.current) return;
    const r = svg.current.getBoundingClientRect();
    const p = fromScreen(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H);
    setPts((o) => (drag === 1 ? { ...o, x1: round(p.x), y1: round(p.y) } : { ...o, x2: round(p.x), y2: round(p.y) }));
  };

  const apply = async () => {
    const now = useProject.getState().project?.sequences.find((q) => q.id === sequence)?.tracks.flatMap((t) => t.clips).find((x) => x.id === clip);
    if (!now) return onClose();
    for (const p of params) {
      const k = keysOf(now, p).find((k) => k.at === at);
      if (k) await edit({ type: "setKeyframes", sequence, clip, param: p, keys: upsertKey(keysOf(now, p), at, k.value, { bezier: pts }) });
    }
    onClose();
  };

  const path = Array.from({ length: 65 }, (_, i) => {
    const u = i / 64;
    return `${i ? "L" : "M"}${sx(u).toFixed(1)},${sy(bezier(pts.x1, pts.y1, pts.x2, pts.y2, u)).toFixed(1)}`;
  }).join(" ");
  const field = (k: keyof Pts, lo: number, hi: number) => (
    <NumberField label={k} value={pts[k]} min={lo} max={hi} step={0.01} precision={2} width={58} onCommit={(v) => setPts((o) => ({ ...o, [k]: v }))} />
  );

  return (
    <Modal
      title="Eigene Kurve"
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={() => void apply()}>
            Übernehmen
          </Button>
        </>
      }
    >
      <div className="flex gap-4">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          className="shrink-0 touch-none rounded-sm bg-ground"
          onPointerMove={move}
          onPointerUp={() => setDrag(null)}
          onPointerLeave={() => setDrag(null)}
        >
          <rect x={sx(0)} y={sy(1)} width={sx(1) - sx(0)} height={sy(0) - sy(1)} fill="none" stroke="var(--color-line-strong)" />
          {[0.25, 0.5, 0.75].map((g) => (
            <g key={g} stroke="var(--color-line)">
              <line x1={sx(g)} x2={sx(g)} y1={sy(Y_HI)} y2={sy(Y_LO)} />
              <line x1={sx(0)} x2={sx(1)} y1={sy(g)} y2={sy(g)} />
            </g>
          ))}
          <line x1={sx(0)} y1={sy(0)} x2={sx(pts.x1)} y2={sy(pts.y1)} stroke="var(--color-fg-3)" />
          <line x1={sx(1)} y1={sy(1)} x2={sx(pts.x2)} y2={sy(pts.y2)} stroke="var(--color-fg-3)" />
          <path d={path} fill="none" stroke="var(--color-signal)" strokeWidth={2} />
          {([1, 2] as const).map((h) => (
            <circle
              key={h}
              cx={sx(h === 1 ? pts.x1 : pts.x2)}
              cy={sy(h === 1 ? pts.y1 : pts.y2)}
              r={6}
              className="cursor-grab"
              fill={drag === h ? "var(--color-signal)" : "var(--color-panel)"}
              stroke="var(--color-signal)"
              strokeWidth={2}
              onPointerDown={(e) => {
                (e.target as Element).setPointerCapture(e.pointerId);
                setDrag(h);
              }}
            />
          ))}
        </svg>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className={cx("h-6 rounded-xs px-2 text-xs", JSON.stringify(p.v) === JSON.stringify(pts) ? "bg-signal text-signal-ink" : "bg-field text-fg-2 hover:bg-hover")}
                onClick={() => setPts(p.v)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Field label="Punkt 1">
            {field("x1", 0, 1)}
            {field("y1", -1, 2)}
          </Field>
          <Field label="Punkt 2">
            {field("x2", 0, 1)}
            {field("y2", -1, 2)}
          </Field>
          <MotionPreview pts={pts} />
          <p className="text-[10.5px] leading-relaxed text-fg-4">
            Waagerecht ist die Zeit bis zum nächsten Keyframe, senkrecht der Weg zum nächsten Wert. Werte über 1 oder unter 0 schwingen über das Ziel hinaus.
          </p>
        </div>
      </div>
    </Modal>
  );
}

/** A dot travelling with the curve, looping. */
function MotionPreview({ pts }: { pts: Pts }) {
  const dot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const phase = ((now - t0) / 1400) % 1.4;
      const u = Math.min(1, phase);
      const y = bezier(pts.x1, pts.y1, pts.x2, pts.y2, u);
      if (dot.current) dot.current.style.left = `calc(${(y * 100).toFixed(2)}% - 5px)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pts]);
  return (
    <div className="relative mx-[5px] h-5 rounded-xs bg-ground">
      <div className="absolute top-1/2 h-px w-full bg-line-strong" />
      <div ref={dot} className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-signal" />
    </div>
  );
}
