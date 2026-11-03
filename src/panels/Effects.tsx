// Effect stack of the selected video clips (Inspector "Effekte" tab) plus the
// colour wheels and curves editors that the "Farbe" tab reuses. Edits preview
// live through engine overrides and are committed as one setEffects step.

import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye, FolderOpen, MoreHorizontal, Pipette, Plus, Power, RotateCcw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import {
  CATEGORY_LABELS,
  EFFECT_ENTRIES,
  applyEntry,
  copyEffects,
  effectLabel,
  entryEffect,
  pasteEffects,
  pickLut,
  resetEffect,
  saveStackAsPreset,
  setCompare,
  toggleBypass,
  useFxCompare,
  type BrowserCategory,
} from "../actions/effects";
import { prompt } from "../actions/project";
import { curveIsIdentity, curveTable } from "../engine/effects";
import { fxDef, fxKeys, type FxParamDef } from "../engine/fx";
import { engine } from "../engine/playback";
import type { Clip, CurvePoint, Effect, EffectKind, Rgb, Sequence } from "../lib/types";
import { cancelPick, useEditor } from "../state/editor";
import { useLibrary } from "../state/library";
import { edit } from "../state/project";
import { Button, cx, Field, IconButton, NumberField, openContextMenu, Section, Segmented, Select, Slider, Toggle, type MenuItem } from "../ui/primitives";

type Kind<T extends EffectKind["type"]> = Extract<EffectKind, { type: T }>;

const NEUTRAL_WHEELS: Kind<"colorWheels"> = { type: "colorWheels", lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] };
const newId = () => crypto.randomUUID();

/** Stack of the first clip, edited for all `clips` together. */
export function useStack(seq: Sequence, clips: Clip[]) {
  const effects = clips[0]?.effects ?? [];
  const preview = (next: Effect[]) => clips.forEach((c) => engine.setOverride(c.id, { effects: next }));
  const commit = async (next: Effect[]) => {
    await edit({ type: "setEffects", sequence: seq.id, clips: clips.map((c) => c.id), effects: next });
    clips.forEach((c) => engine.setOverride(c.id, null));
  };
  const patch = (id: string, p: Partial<Effect>, live = false) => {
    const next = effects.map((e) => (e.id === id ? ({ ...e, ...p } as Effect) : e));
    if (live) preview(next);
    else void commit(next);
  };
  return { effects, preview, commit, patch };
}

const CATEGORY_ORDER: BrowserCategory[] = ["color", "blur", "light", "distort", "stylize", "keying", "transform"];

/** The "+" menu: every browser entry, grouped by category. */
export function effectMenu(onPick: (key: string) => void): MenuItem[] {
  return CATEGORY_ORDER.map((c) => ({
    label: CATEGORY_LABELS[c],
    submenu: EFFECT_ENTRIES.filter((e) => e.category === c).map((e) => ({ label: e.needsFile ? `${e.label} …` : e.label, onSelect: () => onPick(e.key) })),
  }));
}

export function EffectsSection({ seq, clips }: { seq: Sequence; clips: Clip[] }) {
  const stack = useStack(seq, clips);
  const { effects, commit } = stack;
  const clipboard = useLibrary((s) => s.effectClipboard);
  const compare = useFxCompare((s) => s.on);
  const bypass = clips.length > 0 && clips.every((c) => c.fxBypass);
  const add = async (key: string) => {
    const entry = EFFECT_ENTRIES.find((e) => e.key === key);
    if (!entry) return;
    // One clip: through the stack (keeps the shared-stack semantics of the
    // Inspector); several: append to each clip's own stack.
    if (clips.length === 1) {
      const e = await entryEffect(entry);
      if (e) await commit([...effects, e]);
    } else await applyEntry(entry, clips.map((c) => c.id));
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...effects];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    void commit(next);
  };
  const more: MenuItem[] = [
    { label: "Effekte kopieren", shortcut: "Strg+Alt+C", disabled: !effects.length, onSelect: () => copyEffects(effects) },
    { label: "Effekte einfügen (anhängen)", shortcut: "Strg+Alt+V", disabled: !clipboard?.length, onSelect: () => void pasteEffects(clips.map((c) => c.id)) },
    { label: "Effekte durch Kopie ersetzen", disabled: !clipboard?.length, onSelect: () => void commit(clipboard!.map((e) => ({ ...e, id: crypto.randomUUID() }))) },
    { separator: true },
    { label: "Als Preset speichern …", disabled: !effects.length, onSelect: () => void saveStackAsPreset(effects) },
    { separator: true },
    { label: "Alle zurücksetzen", disabled: !effects.length, onSelect: () => void commit(effects.map(resetEffect)) },
    { label: "Alle entfernen", danger: true, disabled: !effects.length, onSelect: () => void commit([]) },
  ];
  return (
    <Section
      title="Effekte"
      right={
        <div className="flex items-center gap-0.5">
          <IconButton icon={<Power size={12} />} size={22} label={bypass ? "Effekte wieder einschalten" : "Alle Effekte umgehen (Bypass)"} active={bypass} disabled={!effects.length} onClick={() => void toggleBypass(clips)} />
          <IconButton icon={<Eye size={12} />} size={22} label="Vorher/Nachher: Vorschau ohne Effekte" shortcut="Strg+Alt+B" active={compare} onClick={() => setCompare(!compare)} />
          <IconButton icon={<MoreHorizontal size={13} />} size={22} label="Weitere Aktionen" onClick={(e) => openContextMenu({ clientX: e.clientX, clientY: e.clientY }, more)} />
          <IconButton icon={<Plus size={13} />} size={22} label="Effekt hinzufügen" onClick={(e) => openContextMenu({ clientX: e.clientX, clientY: e.clientY }, effectMenu((k) => void add(k)))} />
        </div>
      }
    >
      {bypass && <p className="mb-1 rounded-xs bg-warn/15 px-1.5 py-1 text-[10.5px] text-warn">Effekte werden umgangen (Vorschau und Export).</p>}
      {compare && <p className="mb-1 rounded-xs bg-signal/15 px-1.5 py-1 text-[10.5px] text-signal">Vorher-Ansicht: der Monitor zeigt alle Clips ohne Effekte. Der Export ist davon nicht betroffen.</p>}
      {!effects.length && <p className="py-1 text-xs text-fg-4">Keine Effekte. Mit + hinzufügen oder aus dem Effekt-Browser auf einen Clip ziehen; sie wirken nach der Farbkorrektur in der Reihenfolge der Liste.</p>}
      {effects.map((e, i) => (
        <EffectCard key={e.id} effect={e} stack={stack} first={i === 0} last={i === effects.length - 1} onMove={(d) => move(i, d)} onRemove={() => void commit(effects.filter((x) => x.id !== e.id))} />
      ))}
      {clips.length > 1 && <p className="pt-1 text-[10.5px] text-fg-4">Änderungen gelten für alle {clips.length} ausgewählten Clips (Liste des ersten Clips).</p>}
    </Section>
  );
}

function EffectCard({ effect: e, stack, first, last, onMove, onRemove }: { effect: Effect; stack: ReturnType<typeof useStack>; first: boolean; last: boolean; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(true);
  const label = effectLabel(e);
  const def = e.type === "fx" ? fxDef(e.fx) : undefined;
  const rename = async () => {
    const name = await prompt({ title: "Effekt umbenennen", label: "Name (leer = Standardname)", value: e.name ?? "", confirm: "Umbenennen" });
    if (name !== null) stack.patch(e.id, { name: name.trim() });
  };
  const menu: MenuItem[] = [
    { label: "Umbenennen …", onSelect: () => void rename() },
    { label: "Zurücksetzen", onSelect: () => void stack.commit(stack.effects.map((x) => (x.id === e.id ? resetEffect(x) : x))) },
    { label: "Duplizieren", onSelect: () => void stack.commit(stack.effects.flatMap((x) => (x.id === e.id ? [x, { ...x, id: crypto.randomUUID() }] : [x]))) },
    { label: "Effekt kopieren", onSelect: () => copyEffects([e]) },
    { label: "Als Preset speichern …", onSelect: () => void saveStackAsPreset([e]) },
  ];
  return (
    <div className="mb-1.5 rounded-sm border border-line bg-raised" onContextMenu={(ev) => openContextMenu(ev, menu)}>
      <div className="flex h-7 items-center gap-1 pl-1 pr-0.5">
        <button className="flex h-5 w-5 items-center justify-center text-fg-3" aria-label={open ? "Zuklappen" : "Aufklappen"} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <Toggle checked={e.enabled} onChange={(v) => stack.patch(e.id, { enabled: v })} label={`${label} aktiv`} />
        <span className={cx("ml-1 min-w-0 flex-1 truncate text-xs font-medium", !e.enabled && "text-fg-4")} title={def ? `${def.label}: ${def.description}${def.heavy ? " (Export rechenintensiv)" : ""}` : label} onDoubleClick={() => void rename()}>
          {label}
        </span>
        <IconButton icon={<RotateCcw size={11} />} size={20} label="Zurücksetzen" onClick={() => void stack.commit(stack.effects.map((x) => (x.id === e.id ? resetEffect(x) : x)))} />
        <IconButton icon={<ArrowUp size={12} />} size={20} label="Nach oben" disabled={first} onClick={() => onMove(-1)} />
        <IconButton icon={<ArrowDown size={12} />} size={20} label="Nach unten" disabled={last} onClick={() => onMove(1)} />
        <IconButton icon={<Trash2 size={12} />} size={20} label="Entfernen" onClick={onRemove} />
      </div>
      {open && (
        <div className="border-t border-line px-2 py-1.5">
          <EffectParams effect={e} stack={stack} />
        </div>
      )}
    </div>
  );
}

export function ParamRow({ label, value, min, max, step = 0.01, scale = 1, unit = "", precision = 2, onChange }: { label: string; value: number; min: number; max: number; step?: number; scale?: number; unit?: string; precision?: number; onChange: (v: number, live: boolean) => void }) {
  // A released slider lands on a value the field can show.
  const snap = (v: number) => Math.round(v * scale * 10 ** precision) / (scale * 10 ** precision);
  return (
    <Field label={label}>
      <Slider label={label} value={value} min={min} max={max} onPreview={(v) => onChange(v, true)} onCommit={(v) => onChange(snap(v), false)} />
      <NumberField label={label} value={value * scale} min={min * scale} max={max * scale} step={step} precision={precision} unit={unit} width={62} onPreview={(v) => onChange(v / scale, true)} onCommit={(v) => onChange(v / scale, false)} />
    </Field>
  );
}

function EffectParams({ effect: e, stack }: { effect: Effect; stack: ReturnType<typeof useStack> }) {
  const set = (p: Partial<EffectKind>, live: boolean) => stack.patch(e.id, p as Partial<Effect>, live);
  switch (e.type) {
    case "fx":
      return <FxParamsEditor effect={e} stack={stack} />;
    case "blur":
      return <ParamRow label="Radius" value={e.radius} min={0} max={60} step={0.5} precision={1} unit=" px" onChange={(v, l) => set({ radius: v }, l)} />;
    case "sharpen":
      return (
        <>
          <ParamRow label="Stärke" value={e.amount} min={0} max={3} scale={100} step={1} precision={0} unit=" %" onChange={(v, l) => set({ amount: v }, l)} />
          <ParamRow label="Radius" value={e.radius} min={0.3} max={10} step={0.1} precision={1} unit=" px" onChange={(v, l) => set({ radius: v }, l)} />
        </>
      );
    case "vignette":
      return <ParamRow label="Stärke" value={e.amount} min={0} max={1} scale={100} step={1} precision={0} unit=" %" onChange={(v, l) => set({ amount: v }, l)} />;
    case "lut":
      return (
        <>
          <Field label="Datei">
            <span className="min-w-0 flex-1 truncate text-xs text-fg-2" title={e.path}>
              {e.path.split(/[\\/]/).pop()}
            </span>
            <IconButton
              icon={<FolderOpen size={12} />}
              size={22}
              label="Andere LUT wählen"
              onClick={async () => {
                const path = await pickLut();
                if (path) set({ path }, false);
              }}
            />
          </Field>
          <ParamRow label="Intensität" value={e.intensity} min={0} max={1} scale={100} step={1} precision={0} unit=" %" onChange={(v, l) => set({ intensity: v }, l)} />
        </>
      );
    case "chromaKey":
      return <ChromaParams effect={e} stack={stack} />;
    case "colorWheels":
      return <WheelsEditor value={e} onChange={(v, live) => set(v, live)} />;
    case "curves":
      return <CurvesEditor value={e} onChange={(v, live) => set(v, live)} />;
  }
}

/** Parameters of a catalogue effect, generated from its definition. */
function FxParamsEditor({ effect: e, stack }: { effect: Effect & Kind<"fx">; stack: ReturnType<typeof useStack> }) {
  const def = fxDef(e.fx);
  const picking = useEditor((s) => s.picker !== null);
  if (!def) return <p className="text-xs text-danger">Unbekannter Effekt „{e.fx}“. Er wird beim Export ignoriert.</p>;
  const get = (k: string, p: FxParamDef) => e.params[k] ?? p.default;
  const set = (values: Record<string, number>, live: boolean) => stack.patch(e.id, { params: { ...e.params, ...values } } as Partial<Effect>, live);
  const pickColor = (p: FxParamDef) => {
    const [r, g, b] = fxKeys(p);
    stack.preview(stack.effects.map((x) => (x.id === e.id ? { ...x, enabled: false } : x)));
    useEditor.getState().set({
      picker: (rgb) => {
        if (rgb) set({ [r]: rgb[0], [g]: rgb[1], [b]: rgb[2] }, false);
        else stack.preview(stack.effects);
      },
    });
  };
  return (
    <>
      {def.params.map((p) => {
        const keys = fxKeys(p);
        switch (p.kind) {
          case "toggle":
            return (
              <Field key={p.id} label={p.label}>
                <Toggle checked={get(p.id, p) >= 0.5} onChange={(v) => set({ [p.id]: v ? 1 : 0 }, false)} label={p.label} />
              </Field>
            );
          case "choice": {
            const opts = (p.options ?? []).map((label, i) => ({ value: String(i), label }));
            return (
              <Field key={p.id} label={p.label}>
                {opts.length <= 3 ? (
                  <Segmented size="sm" value={String(Math.round(get(p.id, p)))} options={opts} onChange={(v) => set({ [p.id]: Number(v) }, false)} />
                ) : (
                  <Select value={String(Math.round(get(p.id, p)))} options={opts} onChange={(v) => set({ [p.id]: Number(v) }, false)} />
                )}
              </Field>
            );
          }
          case "color": {
            const rgb = keys.map((k) => get(k, p)) as Rgb;
            return (
              <Field key={p.id} label={p.label}>
                <input type="color" aria-label={p.label} className="h-6 w-10 cursor-pointer rounded-xs border border-line bg-field" value={toHex(rgb)} onChange={(ev) => { const c = fromHex(ev.target.value); set({ [keys[0]]: c[0], [keys[1]]: c[1], [keys[2]]: c[2] }, false); }} />
                <Button size="sm" variant={picking ? "primary" : undefined} onClick={picking ? cancelPick : () => pickColor(p)}>
                  <Pipette size={12} className="mr-1" />
                  {picking ? "Im Monitor klicken …" : "Aus Bild wählen"}
                </Button>
              </Field>
            );
          }
          case "point":
            return (
              <div key={p.id}>
                <ParamRow label={`${p.label} X`} value={get(keys[0], p)} min={p.min} max={p.max} scale={100} step={1} precision={0} unit=" %" onChange={(v, l) => set({ [keys[0]]: v }, l)} />
                <ParamRow label={`${p.label} Y`} value={get(keys[1], p)} min={p.min} max={p.max} scale={100} step={1} precision={0} unit=" %" onChange={(v, l) => set({ [keys[1]]: v }, l)} />
              </div>
            );
          case "int":
            return <ParamRow key={p.id} label={p.label} value={get(p.id, p)} min={p.min} max={p.max} step={1} precision={0} unit={p.unit ?? ""} onChange={(v, l) => set({ [p.id]: Math.round(v) }, l)} />;
          case "angle":
            return <ParamRow key={p.id} label={p.label} value={get(p.id, p)} min={p.min} max={p.max} step={1} precision={0} unit={p.unit ?? " °"} scale={p.scale ?? 1} onChange={(v, l) => set({ [p.id]: v }, l)} />;
          default: {
            const scale = p.scale ?? 1;
            const span = (p.max - p.min) * scale;
            const precision = span > 50 ? 0 : span > 5 ? 1 : 2;
            return <ParamRow key={p.id} label={p.label} value={get(p.id, p)} min={p.min} max={p.max} scale={scale} step={10 ** -precision} precision={precision} unit={p.unit ?? ""} onChange={(v, l) => set({ [p.id]: v }, l)} />;
          }
        }
      })}
    </>
  );
}

export const toHex = (c: Rgb) => "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;

function ChromaParams({ effect: e, stack }: { effect: Effect & Kind<"chromaKey">; stack: ReturnType<typeof useStack> }) {
  const set = (p: Partial<Kind<"chromaKey">>, live: boolean) => stack.patch(e.id, p as Partial<Effect>, live);
  const picking = useEditor((s) => s.picker !== null);
  const pick = () => {
    // Show the unkeyed picture while picking, then sample the program monitor.
    stack.preview(stack.effects.map((x) => (x.id === e.id ? { ...x, enabled: false } : x)));
    useEditor.getState().set({
      picker: (rgb) => {
        if (rgb) set({ color: rgb }, false);
        else stack.preview(stack.effects);
      },
    });
  };
  return (
    <>
      <Field label="Farbe">
        <input type="color" aria-label="Schlüsselfarbe" className="h-6 w-10 cursor-pointer rounded-xs border border-line bg-field" value={toHex(e.color)} onChange={(ev) => set({ color: fromHex(ev.target.value) }, false)} />
        <Button size="sm" variant={picking ? "primary" : undefined} onClick={picking ? cancelPick : pick}>
          <Pipette size={12} className="mr-1" />
          {picking ? "Im Monitor klicken …" : "Aus Bild wählen"}
        </Button>
      </Field>
      <ParamRow label="Toleranz" value={e.similarity} min={0.001} max={0.5} scale={100} step={0.5} precision={1} unit=" %" onChange={(v, l) => set({ similarity: v }, l)} />
      <ParamRow label="Weiche Kante" value={e.blend} min={0} max={0.5} scale={100} step={0.5} precision={1} unit=" %" onChange={(v, l) => set({ blend: v }, l)} />
      <ParamRow label="Farbsaum entfernen" value={e.spill} min={0} max={1} scale={100} step={1} precision={0} unit=" %" onChange={(v, l) => set({ spill: v }, l)} />
    </>
  );
}

// --- colour wheels ------------------------------------------------------------------

// Hue directions of R, G, B on the wheel (radians, counter-clockwise from the right).
const PHASE = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];

interface WheelSpec {
  key: "lift" | "gamma" | "gain";
  label: string;
  /** Per-channel value -> working domain (where the wheel offset is added). */
  to: (v: number) => number;
  from: (w: number) => number;
  /** Offset per channel at the rim, in the working domain. */
  reach: number;
  master: { min: number; max: number; neutral: number };
  format: (master: number) => string;
}

const WHEELS: WheelSpec[] = [
  { key: "lift", label: "Tiefen", to: (v) => v, from: (w) => w, reach: 0.2, master: { min: -0.5, max: 0.5, neutral: 0 }, format: (m) => (m >= 0 ? "+" : "") + m.toFixed(2) },
  { key: "gamma", label: "Mitten", to: Math.log2, from: (w) => 2 ** w, reach: 0.6, master: { min: -2, max: 2, neutral: 0 }, format: (m) => (2 ** m).toFixed(2) },
  { key: "gain", label: "Lichter", to: Math.log2, from: (w) => 2 ** w, reach: 0.6, master: { min: -2, max: 2, neutral: 0 }, format: (m) => (2 ** m).toFixed(2) },
];

/** Splits per-channel values into master and wheel position (x, y in the unit disc). */
function decompose(spec: WheelSpec, v: Rgb) {
  const w = v.map(spec.to);
  const master = (w[0] + w[1] + w[2]) / 3;
  let x = 0;
  let y = 0;
  for (let c = 0; c < 3; c++) {
    x += (2 / 3) * (w[c] - master) * Math.cos(PHASE[c]);
    y += (2 / 3) * (w[c] - master) * Math.sin(PHASE[c]);
  }
  return { master, x: x / spec.reach, y: y / spec.reach };
}

function compose(spec: WheelSpec, master: number, x: number, y: number): Rgb {
  const r = Math.min(1, Math.hypot(x, y));
  const th = Math.atan2(y, x);
  return PHASE.map((p) => +spec.from(master + spec.reach * r * Math.cos(th - p)).toFixed(4)) as Rgb;
}

// Conic gradient matching PHASE: CSS angles run clockwise from the top.
const WHEEL_BG = `radial-gradient(circle, rgb(40 40 46) 0%, rgb(40 40 46 / 0) 72%), conic-gradient(${Array.from({ length: 13 }, (_, i) => `hsl(${(((90 - i * 30) % 360) + 360) % 360} 55% 45%) ${i * 30}deg`).join(", ")})`;

export function WheelsEditor({ value, onChange }: { value: Kind<"colorWheels">; onChange: (v: Partial<Kind<"colorWheels">>, live: boolean) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1">
      {WHEELS.map((spec) => (
        <Wheel key={spec.key} spec={spec} value={value[spec.key]} onChange={(v, live) => onChange({ [spec.key]: v }, live)} />
      ))}
    </div>
  );
}

function Wheel({ spec, value, onChange }: { spec: WheelSpec; value: Rgb; onChange: (v: Rgb, live: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { master, x, y } = decompose(spec, value);
  const at = (ev: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    let px = ((ev.clientX - r.left) / r.width) * 2 - 1;
    let py = -(((ev.clientY - r.top) / r.height) * 2 - 1);
    const len = Math.hypot(px, py);
    if (len > 1) [px, py] = [px / len, py / len];
    return compose(spec, master, px, py);
  };
  const neutral = () => onChange(compose(spec, spec.master.neutral, 0, 0), false);
  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      <div className="text-[10.5px] text-fg-3">{spec.label}</div>
      <div
        ref={ref}
        className="relative aspect-square w-full max-w-[96px] cursor-crosshair touch-none rounded-full border border-line-strong"
        style={{ background: WHEEL_BG }}
        title="Ziehen: Farbe verschieben · Doppelklick: zurücksetzen"
        onPointerDown={(ev) => {
          (ev.target as Element).setPointerCapture(ev.pointerId);
          onChange(at(ev), true);
        }}
        onPointerMove={(ev) => ev.buttons && onChange(at(ev), true)}
        onPointerUp={(ev) => onChange(at(ev), false)}
        onDoubleClick={() => onChange(compose(spec, master, 0, 0), false)}
      >
        <div className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-fg bg-transparent" style={{ left: `${50 + x * 50}%`, top: `${50 - y * 50}%` }} />
      </div>
      <Slider label={`${spec.label} gesamt`} value={master} min={spec.master.min} max={spec.master.max} center={spec.master.neutral} onPreview={(m) => onChange(compose(spec, m, x, y), true)} onCommit={(m) => onChange(compose(spec, m, x, y), false)} onReset={neutral} />
      <div className="font-mono text-[10px] text-fg-3">{spec.format(master)}</div>
    </div>
  );
}

// --- curves --------------------------------------------------------------------------

const CHANNELS = [
  { key: "master", label: "Alle", color: "var(--color-fg)" },
  { key: "red", label: "R", color: "#ff6b6b" },
  { key: "green", label: "G", color: "#5fd27a" },
  { key: "blue", label: "B", color: "#6fa8ff" },
] as const;
type Channel = (typeof CHANNELS)[number]["key"];
const CW = 200;

export function CurvesEditor({ value, onChange }: { value: Kind<"curves">; onChange: (v: Partial<Kind<"curves">>, live: boolean) => void }) {
  const [ch, setCh] = useState<Channel>("master");
  const [drag, setDrag] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  // Points of the running drag; the props may not have re-rendered by pointer-up.
  const latest = useRef<CurvePoint[] | null>(null);
  const pts: CurvePoint[] = value[ch].length >= 2 ? value[ch] : [
    [0, 0],
    [1, 1],
  ];
  const color = CHANNELS.find((c) => c.key === ch)!.color;
  const toPt = (ev: React.PointerEvent): CurvePoint => {
    const r = svg.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));
    return [clamp((ev.clientX - r.left) / r.width), clamp(1 - (ev.clientY - r.top) / r.height)];
  };
  const emit = (next: CurvePoint[], live: boolean) => {
    latest.current = live ? next : null;
    onChange({ [ch]: next }, live);
  };
  const table = curveTable(pts);
  const path = Array.from(table, (v, i) => `${i ? "L" : "M"}${((i / 255) * CW).toFixed(1)},${(CW - (v / 255) * CW).toFixed(1)}`).join(" ");
  const sorted = (list: CurvePoint[]) => [...list].sort((a, b) => a[0] - b[0]);
  return (
    <div className="space-y-1.5 py-1">
      <div className="flex items-center justify-between">
        <Segmented size="sm" value={ch} onChange={setCh} options={CHANNELS.map((c) => ({ value: c.key, label: c.label }))} />
        <IconButton icon={<RotateCcw size={12} />} size={22} label="Kanal zurücksetzen" disabled={curveIsIdentity(value[ch])} onClick={() => emit([], false)} />
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${CW} ${CW}`}
        className="aspect-square w-full max-w-[240px] touch-none rounded-sm bg-ground"
        onPointerDown={(ev) => {
          if (drag !== null) return;
          // Click on empty space adds a point and starts dragging it.
          const p = toPt(ev);
          if (pts.length >= 16) return;
          const next = sorted([...pts, p]);
          (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
          setDrag(next.findIndex((q) => q === p));
          emit(next, true);
        }}
        onPointerMove={(ev) => {
          if (drag === null) return;
          const p = toPt(ev);
          const next = pts.map((q, i) => (i === drag ? p : q));
          // Keep the order: a point cannot pass its neighbours.
          const lo = drag > 0 ? next[drag - 1][0] + 0.01 : 0;
          const hi = drag < next.length - 1 ? next[drag + 1][0] - 0.01 : 1;
          next[drag] = [Math.min(hi, Math.max(lo, p[0])), p[1]];
          emit(next, true);
        }}
        onPointerUp={() => {
          if (drag === null) return;
          setDrag(null);
          emit(latest.current ?? pts, false);
        }}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="var(--color-line)">
            <line x1={g * CW} x2={g * CW} y1={0} y2={CW} />
            <line x1={0} x2={CW} y1={g * CW} y2={g * CW} />
          </g>
        ))}
        <line x1={0} y1={CW} x2={CW} y2={0} stroke="var(--color-line-strong)" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p[0] * CW}
            cy={CW - p[1] * CW}
            r={4.5}
            fill={drag === i ? color : "var(--color-panel)"}
            stroke={color}
            strokeWidth={1.5}
            className="cursor-grab"
            onPointerDown={(ev) => {
              ev.stopPropagation();
              (ev.currentTarget.ownerSVGElement as Element).setPointerCapture(ev.pointerId);
              setDrag(i);
            }}
            onDoubleClick={() => pts.length > 2 && emit(pts.filter((_, j) => j !== i), false)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              if (pts.length > 2) emit(pts.filter((_, j) => j !== i), false);
            }}
          />
        ))}
      </svg>
      <p className="text-[10.5px] text-fg-4">Klicken fügt einen Punkt hinzu, Ziehen verschiebt, Doppel- oder Rechtsklick entfernt.</p>
    </div>
  );
}

// --- grading shortcuts in the "Farbe" tab ---------------------------------------------

/** Wheels and curves of the stack (the first of each kind), created on first use. */
export function GradeSections({ seq, clips }: { seq: Sequence; clips: Clip[] }) {
  const stack = useStack(seq, clips);
  const find = <T extends "colorWheels" | "curves">(t: T) => stack.effects.find((e) => e.type === t) as (Effect & Kind<T>) | undefined;
  const upsert = <T extends "colorWheels" | "curves">(t: T, base: Kind<T>, p: Partial<Kind<T>>, live: boolean) => {
    const id = (find(t) as Effect | undefined)?.id;
    const next = id ? stack.effects.map((e) => (e.id === id ? ({ ...e, ...p } as Effect) : e)) : [...stack.effects, { id: newId(), enabled: true, ...base, ...p } as Effect];
    if (live) stack.preview(next);
    else void stack.commit(next);
  };
  const wheels = find("colorWheels");
  const curves = find("curves");
  const emptyCurves: Kind<"curves"> = { type: "curves", master: [], red: [], green: [], blue: [] };
  const off = (e: Effect | undefined) => e && !e.enabled && <span className="text-[10.5px] text-warn">deaktiviert</span>;
  return (
    <>
      <Section title="Farbräder" right={<div className="flex items-center gap-1">{off(wheels)}<IconButton icon={<RotateCcw size={12} />} size={22} label="Zurücksetzen" disabled={!wheels} onClick={() => wheels && void stack.commit(stack.effects.filter((e) => e.id !== wheels.id))} /></div>}>
        <WheelsEditor value={wheels ?? NEUTRAL_WHEELS} onChange={(p, live) => upsert("colorWheels", NEUTRAL_WHEELS, p, live)} />
      </Section>
      <Section title="Kurven" right={<div className="flex items-center gap-1">{off(curves)}<IconButton icon={<RotateCcw size={12} />} size={22} label="Zurücksetzen" disabled={!curves} onClick={() => curves && void stack.commit(stack.effects.filter((e) => e.id !== curves.id))} /></div>}>
        <CurvesEditor value={curves ?? emptyCurves} onChange={(p, live) => upsert("curves", emptyCurves, p, live)} />
      </Section>
    </>
  );
}
