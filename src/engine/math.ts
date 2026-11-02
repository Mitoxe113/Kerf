// Geometry and colour math shared by the preview compositor and the monitor's
// direct-manipulation overlay. Mirrors crates/kerf-media/src/render.rs and
// kerf_core::model::ColorAdjust so preview and export agree.

import type { ColorAdjust, Transform } from "../lib/types";

export type Mat3 = Float32Array; // column-major

export interface Placement {
  /** Scaled (pre-rotation) size in sequence pixels. */
  width: number;
  height: number;
  /** Centre in sequence pixels. */
  cx: number;
  cy: number;
  /** Radians, clockwise on screen. */
  theta: number;
}

/** crop -> fit -> scale/rotate about anchor -> anchor at frame centre + offset. */
export function place(t: Transform, srcW: number, srcH: number, seqW: number, seqH: number): Placement {
  const cw = srcW * (1 - t.cropLeft - t.cropRight);
  const ch = srcH * (1 - t.cropTop - t.cropBottom);
  const fit = Math.min(seqW / cw, seqH / ch);
  const width = cw * fit * t.scale;
  const height = ch * fit * t.scale;
  const theta = (t.rotation * Math.PI) / 180;
  const ax = (t.anchorX - 0.5) * width;
  const ay = (t.anchorY - 0.5) * height;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    width,
    height,
    theta,
    cx: seqW / 2 + t.x - (ax * cos - ay * sin),
    cy: seqH / 2 + t.y - (ax * sin + ay * cos),
  };
}

/** Matrix mapping the unit quad (u,v in 0..1) to WebGL clip space. */
export function quadMatrix(p: Placement, seqW: number, seqH: number): Mat3 {
  const cos = Math.cos(p.theta);
  const sin = Math.sin(p.theta);
  // pixel = C + R * S * (uv - 0.5)
  const a = cos * p.width;
  const b = sin * p.width;
  const c = -sin * p.height;
  const d = cos * p.height;
  const tx = p.cx - 0.5 * a - 0.5 * c;
  const ty = p.cy - 0.5 * b - 0.5 * d;
  // clip = [2/W, 0, -1; 0, -2/H, 1] * pixel
  const sx = 2 / seqW;
  const sy = -2 / seqH;
  return new Float32Array([a * sx, b * sy, 0, c * sx, d * sy, 0, tx * sx - 1, ty * sy + 1, 1]);
}

/** Corners of a placement in sequence pixels (TL, TR, BR, BL). */
export function corners(p: Placement): [number, number][] {
  const cos = Math.cos(p.theta);
  const sin = Math.sin(p.theta);
  return [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ].map(([u, v]) => {
    const x = u * p.width;
    const y = v * p.height;
    return [p.cx + x * cos - y * sin, p.cy + x * sin + y * cos] as [number, number];
  });
}

export function pointInPlacement(p: Placement, x: number, y: number): boolean {
  const cos = Math.cos(-p.theta);
  const sin = Math.sin(-p.theta);
  const dx = x - p.cx;
  const dy = y - p.cy;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return Math.abs(lx) <= p.width / 2 && Math.abs(ly) <= p.height / 2;
}

export const IDENTITY_COLOR: ColorAdjust = { exposure: 0, contrast: 0, saturation: 1, temperature: 0, tint: 0 };
export const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };

export const isIdentityColor = (c: ColorAdjust) =>
  c.exposure === 0 && c.contrast === 0 && c.saturation === 1 && c.temperature === 0 && c.tint === 0;

/** Column-major 3x3 for GLSL, same values as ColorAdjust::matrix (row-major there). */
export function colorMatrix(c: ColorAdjust): Mat3 {
  const gain = Math.pow(2, c.exposure);
  const wb = [
    gain * (1 + 0.25 * c.temperature) * (1 + 0.1 * c.tint),
    gain * (1 - 0.2 * c.tint),
    gain * (1 - 0.25 * c.temperature) * (1 + 0.1 * c.tint),
  ];
  const [lr, lg, lb] = [0.2126, 0.7152, 0.0722];
  const s = c.saturation;
  const sat = [
    [lr * (1 - s) + s, lg * (1 - s), lb * (1 - s)],
    [lr * (1 - s), lg * (1 - s) + s, lb * (1 - s)],
    [lr * (1 - s), lg * (1 - s), lb * (1 - s) + s],
  ];
  const m = new Float32Array(9);
  for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) m[col * 3 + r] = sat[r][col] * wb[col];
  return m;
}

export const contrastSlope = (c: ColorAdjust) => Math.max(0, 1 + c.contrast);

export const dbToGain = (db: number) => (db <= -96 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));
