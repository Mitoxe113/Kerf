// Audio effect chain editor: equaliser, compressor, gate and limiter. Used for
// clips (Inspector "Audio" tab) and tracks (mixer). The preview runs the same
// filters as the export (engine/dsp.ts); edits preview live and commit as one step.

import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { biquadCoefficients } from "../engine/dsp";
import type { AudioEffect, AudioEffectKind, EqBand, EqShape } from "../lib/types";
import { cx, IconButton, NumberField, openContextMenu, Select, Toggle } from "../ui/primitives";
import { ParamRow } from "./Effects";

type Kind<T extends AudioEffectKind["type"]> = Extract<AudioEffectKind, { type: T }>;

/** Most bands of one equaliser (kerf-core MAX_EQ_BANDS). */
const MAX_BANDS = 8;

export const AUDIO_EFFECT_TYPES: { type: AudioEffectKind["type"]; label: string; make: () => AudioEffectKind }[] = [
  {
    type: "eq",
    label: "Equalizer",
    make: () => ({
      type: "eq",
      bands: [
        { shape: "highPass", freq: 80, gainDb: 0, q: 0.707, enabled: false },
        { shape: "lowShelf", freq: 150, gainDb: 0, q: 0.707, enabled: true },
        { shape: "peak", freq: 1000, gainDb: 0, q: 1, enabled: true },
        { shape: "highShelf", freq: 8000, gainDb: 0, q: 0.707, enabled: true },
      ],
    }),
  },
  { type: "compressor", label: "Kompressor", make: () => ({ type: "compressor", thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, kneeDb: 6, makeupDb: 0 }) },
  { type: "gate", label: "Noise-Gate", make: () => ({ type: "gate", thresholdDb: -45, rangeDb: -40, ratio: 10, attackMs: 2, releaseMs: 150 }) },
  { type: "limiter", label: "Limiter", make: () => ({ type: "limiter", ceilingDb: -1, releaseMs: 50 }) },
];

const SHAPES: { value: EqShape; label: string }[] = [
  { value: "highPass", label: "Hochpass" },
  { value: "lowShelf", label: "Low-Shelf" },
  { value: "peak", label: "Glocke" },
  { value: "highShelf", label: "High-Shelf" },
  { value: "lowPass", label: "Tiefpass" },
];

const labelOf = (t: AudioEffectKind["type"]) => AUDIO_EFFECT_TYPES.find((x) => x.type === t)!.label;
const newId = () => crypto.randomUUID();

/** Change of the chain; `live` while dragging (preview only), otherwise to commit. */
export type ChainChange = (next: AudioEffect[], live: boolean) => void;

export function AudioEffectsEditor({ effects, onChange, empty }: { effects: AudioEffect[]; onChange: ChainChange; empty: string }) {
  const patch = (id: string, p: Partial<AudioEffectKind> | { enabled: boolean }, live = false) =>
    onChange(effects.map((e) => (e.id === id ? ({ ...e, ...p } as AudioEffect) : e)), live);
  const move = (i: number, d: -1 | 1) => {
    const next = [...effects];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next, false);
  };
  return (
    <div>
      {!effects.length && <p className="py-1 text-xs text-fg-4">{empty}</p>}
      {effects.map((e, i) => (
        <div key={e.id} className="mb-1.5 rounded-sm border border-line bg-raised">
          <CardHeader effect={e} first={i === 0} last={i === effects.length - 1} onToggle={(v) => patch(e.id, { enabled: v })} onMove={(d) => move(i, d)} onRemove={() => onChange(effects.filter((x) => x.id !== e.id), false)}>
            <EffectParams effect={e} set={(p, live) => patch(e.id, p, live)} />
          </CardHeader>
        </div>
      ))}
    </div>
  );
}

/** "+" button with the effect menu. */
export function AddAudioEffect({ effects, onChange }: { effects: AudioEffect[]; onChange: ChainChange }) {
  return (
    <IconButton
      icon={<Plus size={13} />}
      size={22}
      label="Audioeffekt hinzufügen"
      onClick={(e) =>
        openContextMenu(
          { clientX: e.clientX, clientY: e.clientY },
          AUDIO_EFFECT_TYPES.map((t) => ({ label: t.label, onSelect: () => onChange([...effects, { id: newId(), enabled: true, ...t.make() } as AudioEffect], false) })),
        )
      }
    />
  );
}

function CardHeader({ effect: e, first, last, onToggle, onMove, onRemove, children }: { effect: AudioEffect; first: boolean; last: boolean; onToggle: (v: boolean) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div className="flex h-7 items-center gap-1 pl-1 pr-0.5">
        <button className="flex h-5 w-5 items-center justify-center text-fg-3" aria-label={open ? "Zuklappen" : "Aufklappen"} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <Toggle checked={e.enabled} onChange={onToggle} label={`${labelOf(e.type)} aktiv`} />
        <span className={cx("ml-1 min-w-0 flex-1 truncate text-xs font-medium", !e.enabled && "text-fg-4")}>{labelOf(e.type)}</span>
        <IconButton icon={<ArrowUp size={12} />} size={20} label="Nach oben" disabled={first} onClick={() => onMove(-1)} />
        <IconButton icon={<ArrowDown size={12} />} size={20} label="Nach unten" disabled={last} onClick={() => onMove(1)} />
        <IconButton icon={<Trash2 size={12} />} size={20} label="Entfernen" onClick={onRemove} />
      </div>
      {open && <div className="border-t border-line px-2 py-1.5">{children}</div>}
    </>
  );
}

function EffectParams({ effect: e, set }: { effect: AudioEffect; set: (p: Partial<AudioEffectKind>, live: boolean) => void }) {
  switch (e.type) {
    case "eq":
      return <EqEditor value={e} onChange={(bands, live) => set({ bands }, live)} />;
    case "compressor":
      return (
        <>
          <ParamRow label="Schwelle" value={e.thresholdDb} min={-60} max={0} step={0.5} precision={1} unit=" dB" onChange={(v, l) => set({ thresholdDb: v }, l)} />
          <ParamRow label="Verhältnis" value={e.ratio} min={1} max={20} step={0.1} precision={1} unit=":1" onChange={(v, l) => set({ ratio: v }, l)} />
          <ParamRow label="Ansprechzeit" value={e.attackMs} min={0.1} max={200} step={0.5} precision={1} unit=" ms" onChange={(v, l) => set({ attackMs: v }, l)} />
          <ParamRow label="Abklingzeit" value={e.releaseMs} min={1} max={2000} step={5} precision={0} unit=" ms" onChange={(v, l) => set({ releaseMs: v }, l)} />
          <ParamRow label="Knie" value={e.kneeDb} min={0} max={18} step={0.5} precision={1} unit=" dB" onChange={(v, l) => set({ kneeDb: v }, l)} />
          <ParamRow label="Aufholen" value={e.makeupDb} min={0} max={36} step={0.5} precision={1} unit=" dB" onChange={(v, l) => set({ makeupDb: v }, l)} />
        </>
      );
    case "gate":
      return (
        <>
          <ParamRow label="Schwelle" value={e.thresholdDb} min={-80} max={0} step={0.5} precision={1} unit=" dB" onChange={(v, l) => set({ thresholdDb: v }, l)} />
          <ParamRow label="Absenkung" value={e.rangeDb} min={-90} max={0} step={1} precision={0} unit=" dB" onChange={(v, l) => set({ rangeDb: v }, l)} />
          <ParamRow label="Verhältnis" value={e.ratio} min={1} max={100} step={0.5} precision={1} unit=":1" onChange={(v, l) => set({ ratio: v }, l)} />
          <ParamRow label="Ansprechzeit" value={e.attackMs} min={0.1} max={200} step={0.5} precision={1} unit=" ms" onChange={(v, l) => set({ attackMs: v }, l)} />
          <ParamRow label="Abklingzeit" value={e.releaseMs} min={1} max={2000} step={5} precision={0} unit=" ms" onChange={(v, l) => set({ releaseMs: v }, l)} />
        </>
      );
    case "limiter":
      return (
        <>
          <ParamRow label="Obergrenze" value={e.ceilingDb} min={-24} max={0} step={0.1} precision={1} unit=" dB" onChange={(v, l) => set({ ceilingDb: v }, l)} />
          <ParamRow label="Abklingzeit" value={e.releaseMs} min={1} max={2000} step={5} precision={0} unit=" ms" onChange={(v, l) => set({ releaseMs: v }, l)} />
          <p className="pt-0.5 text-[10.5px] text-fg-4">Vorausschau 5 ms: Spitzen bleiben unter der Obergrenze.</p>
        </>
      );
  }
}

// --- equaliser -------------------------------------------------------------------------

const EQ_W = 240;
const EQ_H = 90;
const EQ_DB = 24;
const F_LO = 20;
const F_HI = 20000;
const xOf = (f: number) => (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * EQ_W;
const yOf = (db: number) => EQ_H / 2 - (Math.max(-EQ_DB, Math.min(EQ_DB, db)) / EQ_DB) * (EQ_H / 2);

/** Magnitude response of the enabled bands at 48 kHz, dB at each of `n` log-spaced frequencies. */
function response(bands: EqBand[], n = 120): number[] {
  const sr = 48000;
  const ks = bands.filter((b) => b.enabled).map((b) => biquadCoefficients(b, sr)).filter(Boolean) as number[][];
  return Array.from({ length: n }, (_, i) => {
    const f = F_LO * Math.pow(F_HI / F_LO, i / (n - 1));
    const w = (2 * Math.PI * f) / sr;
    const [c1, s1, c2, s2] = [Math.cos(w), Math.sin(w), Math.cos(2 * w), Math.sin(2 * w)];
    let db = 0;
    for (const [b0, b1, b2, a1, a2] of ks) {
      const num = Math.hypot(b0 + b1 * c1 + b2 * c2, b1 * s1 + b2 * s2);
      const den = Math.hypot(1 + a1 * c1 + a2 * c2, a1 * s1 + a2 * s2);
      db += 20 * Math.log10(num / den);
    }
    return db;
  });
}

const fmtHz = (f: number) => (f >= 1000 ? `${String(+(f / 1000).toFixed(f >= 10000 ? 1 : 2)).replace(".", ",")} k` : `${Math.round(f)} `);
/** "2,5k", "2500", "2.5 kHz" -> Hz. */
const parseHz = (s: string) => {
  const t = s.trim().toLowerCase().replace(",", ".").replace(/hz$/, "").trim();
  const v = t.endsWith("k") ? Number(t.slice(0, -1)) * 1000 : Number(t);
  return isFinite(v) ? v : null;
};

function EqEditor({ value, onChange }: { value: Kind<"eq">; onChange: (bands: EqBand[], live: boolean) => void }) {
  const bands = value.bands;
  const put = (i: number, p: Partial<EqBand>, live = false) => onChange(bands.map((b, j) => (j === i ? { ...b, ...p } : b)), live);
  const curve = response(bands);
  const path = curve.map((db, i) => `${i ? "L" : "M"}${((i / (curve.length - 1)) * EQ_W).toFixed(1)},${yOf(db).toFixed(1)}`).join(" ");
  return (
    <div className="space-y-1.5 py-0.5">
      <svg viewBox={`0 0 ${EQ_W} ${EQ_H}`} className="w-full rounded-sm bg-ground" aria-label="Frequenzgang">
        {[100, 1000, 10000].map((f) => (
          <line key={f} x1={xOf(f)} x2={xOf(f)} y1={0} y2={EQ_H} stroke="var(--color-line)" />
        ))}
        {[-12, 12].map((db) => (
          <line key={db} x1={0} x2={EQ_W} y1={yOf(db)} y2={yOf(db)} stroke="var(--color-line)" strokeDasharray="2 3" />
        ))}
        <line x1={0} x2={EQ_W} y1={EQ_H / 2} y2={EQ_H / 2} stroke="var(--color-line-strong)" />
        <path d={path} fill="none" stroke="var(--color-signal)" strokeWidth={1.5} />
        {bands.map((b, i) =>
          b.enabled ? <circle key={i} cx={xOf(b.freq)} cy={yOf(b.shape === "highPass" || b.shape === "lowPass" ? 0 : b.gainDb)} r={3} fill="var(--color-panel)" stroke="var(--color-signal)" /> : null,
        )}
        {[
          [100, "100"],
          [1000, "1k"],
          [10000, "10k"],
        ].map(([f, l]) => (
          <text key={l} x={xOf(f as number) + 2} y={EQ_H - 3} fontSize={8} fill="var(--color-fg-4)">
            {l}
          </text>
        ))}
      </svg>
      {bands.map((b, i) => {
        const pass = b.shape === "highPass" || b.shape === "lowPass";
        return (
          <div key={i} className={cx("flex items-center gap-1", !b.enabled && "opacity-50")}>
            <Toggle checked={b.enabled} onChange={(v) => put(i, { enabled: v })} label={`Band ${i + 1} aktiv`} />
            <Select width={94} label={`Band ${i + 1} Form`} value={b.shape} options={SHAPES} onChange={(v) => put(i, { shape: v })} />
            <NumberField label={`Band ${i + 1} Frequenz`} value={b.freq} min={20} max={20000} step={b.freq >= 1000 ? 50 : 5} precision={0} unit="Hz" width={70} format={fmtHz} parse={parseHz} onPreview={(v) => put(i, { freq: v }, true)} onCommit={(v) => put(i, { freq: v })} />
            <NumberField label={`Band ${i + 1} Verstärkung`} value={b.gainDb} min={-24} max={24} step={0.5} precision={1} unit=" dB" width={56} disabled={pass} onPreview={(v) => put(i, { gainDb: v }, true)} onCommit={(v) => put(i, { gainDb: v })} />
            <NumberField label={`Band ${i + 1} Güte`} value={b.q} min={0.1} max={18} step={0.05} precision={2} unit="" width={44} disabled={b.shape === "lowShelf" || b.shape === "highShelf"} onPreview={(v) => put(i, { q: v }, true)} onCommit={(v) => put(i, { q: v })} />
            <IconButton icon={<Trash2 size={11} />} size={18} label={`Band ${i + 1} entfernen`} onClick={() => onChange(bands.filter((_, j) => j !== i), false)} />
          </div>
        );
      })}
      <div className="flex items-center justify-between pt-0.5">
        <span className="text-[10.5px] text-fg-4">Frequenz · Verstärkung · Güte (Q)</span>
        <IconButton
          icon={<Plus size={12} />}
          size={20}
          label="Band hinzufügen"
          disabled={bands.length >= MAX_BANDS}
          onClick={() => onChange([...bands, { shape: "peak", freq: 2500, gainDb: 0, q: 1, enabled: true }], false)}
        />
      </div>
    </div>
  );
}
