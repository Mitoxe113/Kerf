// Video scopes computed from a 256×144 readback of the composited frame:
// luma waveform, RGB parade, vectorscope and histogram.

import { useEffect, useRef, useState } from "react";
import { SCOPE_H, SCOPE_W } from "../engine/compositor";
import { engine } from "../engine/playback";
import { PanelHeader, Segmented } from "../ui/primitives";

type ScopeKind = "waveform" | "parade" | "vector" | "histogram";

function render(kind: ScopeKind, px: Uint8Array, ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = "#0a0a0c";
  ctx.fillRect(0, 0, w, h);
  const img = ctx.createImageData(w, h);
  const out = img.data;
  const add = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = ((y | 0) * w + (x | 0)) * 4;
    out[i] = Math.min(255, out[i] + r);
    out[i + 1] = Math.min(255, out[i + 1] + g);
    out[i + 2] = Math.min(255, out[i + 2] + b);
    out[i + 3] = 255;
  };
  const n = SCOPE_W * SCOPE_H;
  const gainW = Math.max(6, Math.round(2200 / SCOPE_H));
  if (kind === "waveform" || kind === "parade") {
    for (let i = 0; i < n; i++) {
      const x = i % SCOPE_W;
      const r = px[i * 4];
      const g = px[i * 4 + 1];
      const b = px[i * 4 + 2];
      if (kind === "waveform") {
        const yl = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        add((x / SCOPE_W) * w, h - 1 - (yl / 255) * (h - 1), gainW * 0.6, gainW, gainW * 0.8);
      } else {
        const third = w / 3;
        const xs = (x / SCOPE_W) * (third - 4);
        add(xs, h - 1 - (r / 255) * (h - 1), gainW * 1.4, gainW * 0.2, gainW * 0.2);
        add(third + xs, h - 1 - (g / 255) * (h - 1), gainW * 0.2, gainW * 1.4, gainW * 0.3);
        add(2 * third + xs, h - 1 - (b / 255) * (h - 1), gainW * 0.3, gainW * 0.4, gainW * 1.5);
      }
    }
  } else if (kind === "vector") {
    const cx = w / 2;
    const cy = h / 2;
    const rad = Math.min(w, h) / 2 - 6;
    for (let i = 0; i < n; i++) {
      const r = px[i * 4] / 255;
      const g = px[i * 4 + 1] / 255;
      const b = px[i * 4 + 2] / 255;
      // Rec.709 colour difference.
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const cb = (b - y) / 1.8556;
      const cr = (r - y) / 1.5748;
      add(cx + cb * 2 * rad, cy - cr * 2 * rad, 28, 44, 30);
    }
  } else {
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) bins[c][px[i * 4 + c]]++;
    const max = Math.max(1, ...bins.flatMap((b) => Array.from(b).slice(1, 255)));
    const colors = [
      [255, 90, 80],
      [110, 230, 120],
      [90, 150, 255],
    ];
    for (let c = 0; c < 3; c++)
      for (let v = 0; v < 256; v++) {
        const bh = Math.min(1, bins[c][v] / max) * (h - 2);
        const x = (v / 255) * (w - 1);
        for (let y = 0; y < bh; y++) add(x, h - 1 - y, colors[c][0] * 0.5, colors[c][1] * 0.5, colors[c][2] * 0.5);
      }
  }
  ctx.putImageData(img, 0, 0);
  // Graticule
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = "9px 'JetBrains Mono Variable', monospace";
  ctx.lineWidth = 1;
  if (kind === "vector") {
    const rad = Math.min(w, h) / 2 - 6;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, rad, 0, Math.PI * 2);
    ctx.moveTo(w / 2 - rad, h / 2);
    ctx.lineTo(w / 2 + rad, h / 2);
    ctx.moveTo(w / 2, h / 2 - rad);
    ctx.lineTo(w / 2, h / 2 + rad);
    ctx.stroke();
    // Skin tone line (~123°).
    ctx.strokeStyle = "rgba(245,181,68,0.35)";
    ctx.beginPath();
    ctx.moveTo(w / 2, h / 2);
    const a = (-123 * Math.PI) / 180;
    ctx.lineTo(w / 2 + Math.cos(a) * rad, h / 2 + Math.sin(a) * rad);
    ctx.stroke();
  } else if (kind !== "histogram") {
    for (const v of [0, 25, 50, 75, 100]) {
      const y = Math.round(h - 1 - (v / 100) * (h - 1)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(String(v), 3, Math.max(9, y - 2));
    }
  }
}

export function Scopes() {
  const [kind, setKind] = useState<ScopeKind>("waveform");
  const ref = useRef<HTMLCanvasElement>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const last = useRef<Uint8Array | null>(null);

  useEffect(() => {
    const draw = (px: Uint8Array) => {
      const c = ref.current;
      if (!c) return;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      render(kindRef.current, px, c.getContext("2d")!, w, h);
    };
    engine.scopesEnabled = true;
    engine.scopesListener = (px) => {
      last.current = px;
      draw(px);
    };
    engine.requestRender();
    const ro = new ResizeObserver(() => last.current && draw(last.current));
    if (ref.current) ro.observe(ref.current);
    return () => {
      engine.scopesEnabled = false;
      engine.scopesListener = null;
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    engine.requestRender();
  }, [kind]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Scopes">
        <Segmented
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: "waveform", label: "Luma" },
            { value: "parade", label: "RGB" },
            { value: "vector", label: "Vektor" },
            { value: "histogram", label: "Histogramm" },
          ]}
        />
      </PanelHeader>
      <div className="min-h-0 flex-1 p-2">
        <canvas ref={ref} className="h-full w-full rounded-sm" />
      </div>
    </div>
  );
}
