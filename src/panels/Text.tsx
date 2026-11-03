// Title editor (inspector) and subtitles panel. Edits show live through engine
// overrides and are committed shortly after the last change, one undo step per
// pause in typing or dragging.

import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, AlignCenter, AlignLeft, AlignRight, Bold, Download, Info, Italic, Plus, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { addCue, exportSubtitles, importSubtitles, setCues, updateTitle } from "../actions/text";
import { usePlayhead } from "../engine/hooks";
import { engine } from "../engine/playback";
import { TITLE_STYLE } from "../engine/text";
import { prompt } from "../actions/project";
import { formatTimecode, parseTimecode } from "../lib/time";
import type { AnimKind, AnimPhase, Cue, Ease, FontFaceInfo, MediaAsset, Sequence, Subtitles, TextAnimation, TextStyle, TitleSpec } from "../lib/types";
import { EMBEDDING_LABELS, families, fontAvailable, importFonts, loadFonts, removeFont, useFonts } from "../state/fonts";
import { deletePreset, loadLibrary, savePreset, useLibrary } from "../state/library";
import { toast } from "../state/toasts";
import { useEditor } from "../state/editor";
import { activeSequence, edit, useActiveSequence, useProject } from "../state/project";
import { Button, cx, Field, IconButton, NumberField, PanelHeader, Section, Segmented, Select, Slider, Toggle } from "../ui/primitives";
import { fromHex, ParamRow, toHex } from "./Effects";

/** Runs `fn` once no call came for `ms`; `flush` runs a pending call now. */
function useDebounced<T>(fn: (v: T) => void, ms: number) {
  const timer = useRef<number | undefined>(undefined);
  const last = useRef<{ v: T } | null>(null);
  const run = useRef(fn);
  run.current = fn;
  const flush = () => {
    window.clearTimeout(timer.current);
    const l = last.current;
    last.current = null;
    if (l) run.current(l.v);
  };
  useEffect(() => flush, []); // commit what is pending when the editor closes
  return {
    call: (v: T) => {
      last.current = { v };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, ms);
    },
    flush,
  };
}

function ColorInput({ label, value, onChange }: { label: string; value: [number, number, number]; onChange: (v: [number, number, number]) => void }) {
  return (
    <input
      type="color"
      aria-label={label}
      className="h-6 w-10 shrink-0 cursor-pointer rounded-xs border border-line bg-field"
      value={toHex(value)}
      onChange={(e) => onChange(fromHex(e.target.value))}
    />
  );
}

const SOURCE_LABELS: Record<FontFaceInfo["source"], string> = { imported: "Importiert", bundled: "Mitgeliefert", system: "System" };

/** Family picker over the bundled, imported and system fonts, with the font's own license data. */
function FontPicker({ value, onChange }: { value: string; onChange: (font: string) => void }) {
  const st = useFonts();
  useEffect(() => {
    if (!st.loaded && !st.loading) void loadFonts();
  }, [st.loaded, st.loading]);
  const fams = families(st.faces);
  const seen = new Set<string>();
  const options: { value: string; label: string; group?: string }[] = [];
  for (const f of fams) {
    if (seen.has(f.family.toLowerCase())) continue;
    seen.add(f.family.toLowerCase());
    options.push({ value: f.family, label: f.family, group: SOURCE_LABELS[f.source] });
  }
  const available = fontAvailable(value, st);
  if (!seen.has(value.toLowerCase())) options.unshift({ value, label: available === false ? `${value} (fehlt)` : value, group: "Im Titel" });
  const fam = fams.find((f) => f.family.toLowerCase() === value.toLowerCase());
  const face = fam?.faces.find((f) => !f.italic && (f.weight === 400 || f.variable)) ?? fam?.faces[0];
  const [info, setInfo] = useState(false);
  const pick = async () => {
    const sel = await open({ multiple: true, directory: false, filters: [{ name: "Schriften (TrueType, OpenType)", extensions: ["ttf", "otf"] }] });
    const paths = Array.isArray(sel) ? sel : typeof sel === "string" ? [sel] : [];
    if (!paths.length) return;
    const got = await importFonts(paths);
    if (got.length) {
      toast.success(got.length === 1 ? "1 Schriftschnitt importiert" : `${got.length} Schriftschnitte importiert`, "Nur für Kerf, nicht systemweit installiert.");
      onChange(got[0].family);
    }
  };
  return (
    <>
      <Field label="Schrift">
        <Select label="Schrift" value={value} options={options} onChange={onChange} className="flex-1" />
        <IconButton icon={<Info size={13} />} size={24} label="Schriftinformationen" active={info} onClick={() => setInfo(!info)} />
        <IconButton icon={<Upload size={13} />} size={24} label="Schrift importieren" onClick={() => void pick()} />
      </Field>
      {available === false && (
        <p className="flex gap-1.5 rounded-xs bg-warn/10 px-2 py-1 text-[11px] text-warn">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            Die Schrift „{value}“ ist auf diesem Rechner nicht vorhanden. Vorschau und Export zeichnen den Text mit der Ersatzschrift Inter Variable, bis die Schrift importiert oder
            installiert ist.
          </span>
        </p>
      )}
      {st.error && <p className="text-[11px] text-warn">Schriftliste nicht lesbar: {st.error}</p>}
      {info && face && (
        <div className="space-y-0.5 rounded-xs border border-line bg-ground px-2 py-1.5 text-[11px] text-fg-3">
          <div>
            <span className="text-fg-2">{face.family}</span> · {SOURCE_LABELS[face.source]}
            {fam && fam.faces.length > 1 ? ` · ${fam.faces.length} Schnitte` : ""}
            {face.variable ? " · variabel" : ""}
          </div>
          {face.designer && <div>Gestaltung: {face.designer}</div>}
          <div>Einbetten laut Datei: {EMBEDDING_LABELS[face.embedding]}</div>
          <div className="line-clamp-4 whitespace-pre-line">Lizenz laut Datei: {face.license || "keine Angabe"}</div>
          {face.licenseUrl && <div className="truncate">Lizenz-URL: {face.licenseUrl}</div>}
          <div className="pt-0.5 text-fg-4">
            Die Angaben stammen aus der Schriftdatei und sind keine rechtliche Prüfung. Kerf gibt keine Schriftdateien weiter; Titel werden als Bilder in den Export gerastert.
          </div>
          <div className="flex gap-1 pt-1">
            <Button size="sm" onClick={() => void loadFonts(true)}>
              <RefreshCw size={12} /> Neu einlesen
            </Button>
            {face.source === "imported" && (
              <Button size="sm" onClick={() => void removeFont(face.path)}>
                <Trash2 size={12} /> Aus Kerf entfernen
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const WEIGHTS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];

/** Font, size, colour, outline, shadow, glow and box of a text block. */
export function TextStyleFields({ style: s, onChange }: { style: TextStyle; onChange: (p: Partial<TextStyle>, live: boolean) => void }) {
  const offset = s.shadowOffset ?? [0, (s.shadow || 0) * 0.4];
  return (
    <>
      <FontPicker value={s.font} onChange={(font) => onChange({ font }, false)} />
      <ParamRow label="Größe" value={s.size} min={8} max={300} step={1} precision={0} unit=" px" onChange={(size, l) => onChange({ size }, l)} />
      <Field label="Stil">
        <IconButton icon={<Bold size={13} />} size={24} label="Fett" active={s.bold} onClick={() => onChange({ bold: !s.bold, weight: 0 }, false)} />
        <IconButton icon={<Italic size={13} />} size={24} label="Kursiv" active={s.italic} onClick={() => onChange({ italic: !s.italic }, false)} />
        <div className="flex-1" />
        <Segmented
          size="sm"
          value={s.align}
          onChange={(align) => onChange({ align }, false)}
          options={[
            { value: "left", label: <AlignLeft size={13} />, title: "Links" },
            { value: "center", label: <AlignCenter size={13} />, title: "Mitte" },
            { value: "right", label: <AlignRight size={13} />, title: "Rechts" },
          ]}
        />
        <ColorInput label="Textfarbe" value={s.color} onChange={(color) => onChange({ color }, false)} />
      </Field>
      <Field label="Stärke">
        <Select
          label="Schriftstärke"
          value={s.weight ?? 0}
          options={WEIGHTS.map((w) => ({ value: w, label: w ? String(w) : s.bold ? "Aus „Fett“ (700)" : "Aus „Fett“ (400)" }))}
          onChange={(weight) => onChange({ weight }, false)}
          className="flex-1"
        />
        <Segmented
          size="sm"
          value={s.case ?? "asTyped"}
          onChange={(c) => onChange({ case: c }, false)}
          options={[
            { value: "asTyped", label: "Aa", title: "Wie eingegeben" },
            { value: "upper", label: "AA", title: "Großbuchstaben" },
            { value: "lower", label: "aa", title: "Kleinbuchstaben" },
          ]}
        />
      </Field>
      <ParamRow label="Laufweite" value={s.tracking ?? 0} min={-20} max={200} step={1} precision={0} unit=" px" onChange={(tracking, l) => onChange({ tracking }, l)} />
      <ParamRow label="Zeilenabstand" value={s.lineHeight} min={0.8} max={2.5} step={0.05} precision={2} onChange={(lineHeight, l) => onChange({ lineHeight }, l)} />
      <ParamRow label="Zeilenbreite" value={s.wrap} min={0.2} max={1} scale={100} step={1} precision={0} unit=" %" onChange={(wrap, l) => onChange({ wrap }, l)} />
      <Field label="Verlauf">
        <Toggle label="Farbverlauf" checked={!!s.gradient} onChange={(on) => onChange({ gradient: on ? (s.gradient ?? [1, 0.55, 0.1]) : null }, false)} />
        {s.gradient && (
          <>
            <ColorInput label="Zweite Verlaufsfarbe" value={s.gradient} onChange={(gradient) => onChange({ gradient }, false)} />
            <Slider label="Verlaufswinkel" value={s.gradientAngle ?? 90} min={-180} max={180} onPreview={(v) => onChange({ gradientAngle: v }, true)} onCommit={(v) => onChange({ gradientAngle: v }, false)} />
            <NumberField label="Verlaufswinkel" value={s.gradientAngle ?? 90} min={-180} max={180} step={1} precision={0} unit="°" width={52} onPreview={(v) => onChange({ gradientAngle: v }, true)} onCommit={(v) => onChange({ gradientAngle: v }, false)} />
          </>
        )}
      </Field>
      <Field label="Kontur">
        <ParamInline value={s.outline} max={20} unit=" px" label="Kontur" onChange={(outline, l) => onChange({ outline }, l)} />
        <ColorInput label="Konturfarbe" value={s.outlineColor} onChange={(outlineColor) => onChange({ outlineColor }, false)} />
      </Field>
      <Field label="Schatten">
        <ParamInline value={s.shadow} max={40} unit=" px" label="Schattenweichheit" onChange={(shadow, l) => onChange({ shadow }, l)} />
        <ColorInput label="Schattenfarbe" value={s.shadowColor ?? [0, 0, 0]} onChange={(shadowColor) => onChange({ shadowColor }, false)} />
      </Field>
      {(s.shadow > 0 || s.shadowOffset) && (
        <>
          <ParamRow label="Schatten-Deckkr." value={s.shadowOpacity ?? 0.75} min={0} max={1} scale={100} step={1} precision={0} unit=" %" onChange={(shadowOpacity, l) => onChange({ shadowOpacity }, l)} />
          <ParamRow label="Versatz X" value={offset[0]} min={-60} max={60} step={1} precision={0} unit=" px" onChange={(x, l) => onChange({ shadowOffset: [x, offset[1]] }, l)} />
          <ParamRow label="Versatz Y" value={offset[1]} min={-60} max={60} step={1} precision={0} unit=" px" onChange={(y, l) => onChange({ shadowOffset: [offset[0], y] }, l)} />
        </>
      )}
      <Field label="Leuchten">
        <ParamInline value={s.glow ?? 0} max={60} unit=" px" label="Leuchten" onChange={(glow, l) => onChange({ glow }, l)} />
        <ColorInput label="Leuchtfarbe" value={s.glowColor ?? [1, 1, 1]} onChange={(glowColor) => onChange({ glowColor }, false)} />
      </Field>
      <Field label="Hintergrund">
        <ParamInline value={s.boxOpacity} max={1} scale={100} unit=" %" label="Hintergrund-Deckkraft" onChange={(boxOpacity, l) => onChange({ boxOpacity }, l)} />
        <ColorInput label="Hintergrundfarbe" value={s.boxColor} onChange={(boxColor) => onChange({ boxColor }, false)} />
      </Field>
      {s.boxOpacity > 0 && <ParamRow label="Innenabstand" value={s.boxPadding} min={0} max={80} step={1} precision={0} unit=" px" onChange={(boxPadding, l) => onChange({ boxPadding }, l)} />}
    </>
  );
}

/** Slider and number for a row that also holds a colour. */
function ParamInline({ value, max, scale = 1, unit, label, onChange }: { value: number; max: number; scale?: number; unit: string; label: string; onChange: (v: number, live: boolean) => void }) {
  return (
    <>
      <Slider label={label} value={value} min={0} max={max} onPreview={(v) => onChange(v, true)} onCommit={(v) => onChange(v, false)} />
      <NumberField label={label} value={value * scale} min={0} max={max * scale} step={1} precision={0} unit={unit} width={52} onPreview={(v) => onChange(v / scale, true)} onCommit={(v) => onChange(v / scale, false)} />
    </>
  );
}

// --- titles --------------------------------------------------------------------------

type Tpl = { label: string; apply: (t: TitleSpec) => TitleSpec };
const st = (t: TitleSpec, p: Partial<TextStyle>) => ({ ...TITLE_STYLE, font: t.style.font, color: t.style.color, ...p });
const phase = (kind: AnimKind, frames = 12, stagger = 0, e: Ease = "easeOut"): AnimPhase => ({ kind, frames, stagger, ease: e });
const NO_ANIM: TextAnimation = { unit: "char", intro: phase("none"), outro: phase("none") };

/** Built-in layouts; they keep the title's text, font and colour. */
const TEMPLATES: Tpl[] = [
  { label: "Mitte", apply: (t) => ({ ...t, x: 0.5, y: 0.5, style: st(t, { align: "center", size: 96 }), animation: { ...NO_ANIM, intro: phase("fade", 15) } }) },
  {
    label: "Bauchbinde",
    apply: (t) => ({ ...t, x: 0.08, y: 0.82, style: st(t, { align: "left", size: 54, boxOpacity: 0.65, boxPadding: 18, wrap: 0.5 }), animation: { unit: "line", intro: phase("slideRight", 14, 4), outro: phase("fade", 10) } }),
  },
  { label: "Oben", apply: (t) => ({ ...t, x: 0.5, y: 0.12, style: st(t, { align: "center", size: 64, bold: false }), animation: NO_ANIM }) },
  {
    label: "Kino",
    apply: (t) => ({ ...t, x: 0.5, y: 0.5, style: st(t, { align: "center", size: 110, weight: 300, bold: false, case: "upper", tracking: 40 }), animation: { unit: "line", intro: phase("spread", 40, 0, "easeInOut"), outro: phase("fade", 20) } }),
  },
  { label: "Schreibmaschine", apply: (t) => ({ ...t, x: 0.1, y: 0.5, style: st(t, { font: "JetBrains Mono Variable", align: "left", size: 64, bold: false }), animation: { unit: "char", intro: phase("typewriter", 30), outro: phase("none") } }) },
  {
    label: "Neon",
    apply: (t) => ({ ...t, x: 0.5, y: 0.5, style: st(t, { align: "center", size: 120, color: [1, 0.35, 0.85], glow: 28, glowColor: [1, 0.2, 0.8] }), animation: { unit: "char", intro: phase("fade", 8, 2), outro: phase("fade", 8, 1) } }),
  },
  {
    label: "Verlauf",
    apply: (t) => ({ ...t, x: 0.5, y: 0.5, style: st(t, { align: "center", size: 130, weight: 800, color: [1, 0.8, 0.2], gradient: [1, 0.3, 0.2], gradientAngle: 90, shadow: 12, shadowOpacity: 0.5 }), animation: { unit: "word", intro: phase("slideUp", 16, 4), outro: phase("fade", 10) } }),
  },
];

/** Applies a saved template: its layout, style and animation; its text only when the title is empty. */
const fromSaved = (t: TitleSpec, d: TitleSpec): TitleSpec => ({ ...t, x: d.x, y: d.y, style: { ...d.style }, animation: d.animation ?? NO_ANIM, text: t.text.trim() ? t.text : d.text });

const ANIM_KINDS: { value: AnimKind; label: string }[] = [
  { value: "none", label: "Keine" },
  { value: "fade", label: "Einblenden" },
  { value: "slideUp", label: "Von unten" },
  { value: "slideDown", label: "Von oben" },
  { value: "slideLeft", label: "Von rechts" },
  { value: "slideRight", label: "Von links" },
  { value: "scale", label: "Skalieren" },
  { value: "typewriter", label: "Schreibmaschine" },
  { value: "spread", label: "Auseinanderlaufen" },
];
const EASES: { value: string; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "easeIn", label: "Beschleunigen" },
  { value: "easeOut", label: "Abbremsen" },
  { value: "easeInOut", label: "Beides" },
];

function PhaseFields({ label, value, onChange }: { label: string; value: AnimPhase; onChange: (p: AnimPhase, live: boolean) => void }) {
  const easeKey = typeof value.ease === "string" ? value.ease : "easeOut";
  return (
    <>
      <Field label={label}>
        <Select label={label} value={value.kind} options={ANIM_KINDS} onChange={(kind) => onChange({ ...value, kind }, false)} className="flex-1" />
        {value.kind !== "none" && value.kind !== "typewriter" && (
          <Select label={`${label}: Verlauf`} value={easeKey} options={EASES} onChange={(e) => onChange({ ...value, ease: e as Ease }, false)} width={110} />
        )}
      </Field>
      {value.kind !== "none" && (
        <>
          <ParamRow label="Dauer" value={value.frames} min={1} max={120} step={1} precision={0} unit=" B" onChange={(frames, l) => onChange({ ...value, frames: Math.round(frames) }, l)} />
          {value.kind !== "typewriter" && (
            <ParamRow label="Versatz je Teil" value={value.stagger} min={0} max={20} step={0.5} precision={1} unit=" B" onChange={(stagger, l) => onChange({ ...value, stagger }, l)} />
          )}
        </>
      )}
    </>
  );
}

function TemplateBar({ spec, onApply }: { spec: TitleSpec; onApply: (t: TitleSpec) => void }) {
  const presets = useLibrary((s) => s.presets).filter((p) => p.kind === "titleTemplate");
  useEffect(() => void loadLibrary(), []);
  const saveTpl = async () => {
    const name = await prompt({ title: "Titelvorlage speichern", label: "Name", value: "Meine Vorlage", confirm: "Speichern" });
    if (!name?.trim()) return;
    const p = await savePreset("titleTemplate", name.trim(), spec, "title");
    if (p) toast.success("Vorlage gespeichert", p.name);
  };
  return (
    <>
      <Field label="Vorlage">
        <div className="flex flex-wrap gap-1">
          {TEMPLATES.map((p) => (
            <Button key={p.label} size="sm" onClick={() => onApply(p.apply(spec))}>
              {p.label}
            </Button>
          ))}
        </div>
      </Field>
      <Field label="Eigene">
        <div className="flex flex-1 flex-wrap items-center gap-1">
          {presets.map((p) => (
            <span key={p.id} className="group inline-flex items-center">
              <Button size="sm" onClick={() => onApply(fromSaved(spec, p.data as TitleSpec))}>
                {p.name}
              </Button>
              <IconButton icon={<Trash2 size={11} />} size={20} label={`Vorlage „${p.name}“ löschen`} onClick={() => void deletePreset(p.id)} />
            </span>
          ))}
          <IconButton icon={<Save size={13} />} size={24} label="Als Vorlage speichern" onClick={() => void saveTpl()} />
        </div>
      </Field>
    </>
  );
}

export function TitleSection({ asset }: { asset: MediaAsset & { title: TitleSpec } }) {
  const [spec, setSpec] = useState(asset.title);
  const pending = useRef(0);
  // A stored change (undo, another editor) replaces the local copy unless typing is in progress.
  useEffect(() => {
    if (!pending.current) setSpec(asset.title);
  }, [asset.title]);
  const commit = useDebounced((next: TitleSpec) => {
    const n = ++pending.current;
    void updateTitle(asset.id, next).finally(() => {
      if (n !== pending.current) return;
      pending.current = 0;
      engine.setTitleOverride(asset.id, null);
    });
  }, 350);
  const change = (next: TitleSpec, now = false) => {
    pending.current = pending.current || -1;
    setSpec(next);
    engine.setTitleOverride(asset.id, next);
    commit.call(next);
    if (now) commit.flush();
  };
  const anim = spec.animation ?? NO_ANIM;
  const setAnim = (a: TextAnimation, live: boolean) => change({ ...spec, animation: a }, !live);
  return (
    <>
      <Section title="Text">
        <textarea
          aria-label="Titeltext"
          className="min-h-[72px] w-full resize-y rounded-sm border border-line bg-field px-2 py-1.5 text-sm text-fg outline-none focus:border-signal"
          value={spec.text}
          onChange={(e) => change({ ...spec, text: e.target.value })}
          onBlur={() => commit.flush()}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <TemplateBar spec={spec} onApply={(t) => change(t, true)} />
        <ParamRow label="Position X" value={spec.x} min={0} max={1} scale={100} step={0.5} precision={1} unit=" %" onChange={(x, l) => change({ ...spec, x }, !l)} />
        <ParamRow label="Position Y" value={spec.y} min={0} max={1} scale={100} step={0.5} precision={1} unit=" %" onChange={(y, l) => change({ ...spec, y }, !l)} />
      </Section>
      <Section title="Schrift">
        <TextStyleFields style={spec.style} onChange={(p, l) => change({ ...spec, style: { ...spec.style, ...p } }, !l)} />
      </Section>
      <Section title="Animation">
        <Field label="Einheit">
          <Segmented
            size="sm"
            value={anim.unit}
            onChange={(unit) => setAnim({ ...anim, unit }, false)}
            options={[
              { value: "char", label: "Zeichen" },
              { value: "word", label: "Wörter" },
              { value: "line", label: "Zeilen" },
            ]}
          />
        </Field>
        <PhaseFields label="Eingang" value={anim.intro} onChange={(intro, l) => setAnim({ ...anim, intro }, l)} />
        <PhaseFields label="Ausgang" value={anim.outro} onChange={(outro, l) => setAnim({ ...anim, outro }, l)} />
        <p className="text-[11px] text-fg-4">Eingang ab Clipbeginn, Ausgang bis Clipende, in Bildern der Sequenz. Export rendert dieselben Bilder wie die Vorschau.</p>
      </Section>
    </>
  );
}

// --- subtitles -----------------------------------------------------------------------

function CueRow({ seq, cue, active, current }: { seq: Sequence; cue: Cue; active: boolean; current: boolean }) {
  const fps = seq.settings.fps;
  const [text, setText] = useState(cue.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(cue.text), [cue.text]);
  useEffect(() => {
    if (active) ref.current?.focus();
  }, [active]);
  const save = (patch: Partial<Cue>) => {
    const s = activeSequence(useProject.getState().project) ?? seq;
    void setCues(s, s.subtitles.cues.map((c) => (c.id === cue.id ? { ...c, ...patch } : c)));
  };
  const time = (v: number, key: "start" | "end") => (
    <input
      aria-label={key === "start" ? "Beginn" : "Ende"}
      key={v}
      defaultValue={formatTimecode(v, fps)}
      className="h-6 w-[88px] rounded-xs border border-transparent bg-transparent px-1 font-mono text-[11px] tabular-nums text-fg-2 outline-none hover:border-line focus:border-signal focus:bg-field"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onBlur={(e) => {
        const f = parseTimecode(e.currentTarget.value, fps, v);
        if (f === null || f === v) e.currentTarget.value = formatTimecode(v, fps);
        else save({ [key]: f });
      }}
    />
  );
  return (
    <div
      className={cx("group border-b border-line px-2 py-1.5", current && "bg-signal/5", active && "bg-raised")}
      onPointerDown={() => useEditor.getState().set({ activeCue: cue.id })}
    >
      <div className="flex items-center gap-1">
        <button className="h-5 w-1.5 rounded-full bg-line-strong data-[on=true]:bg-signal" data-on={current} aria-label="Zum Untertitel springen" onClick={() => engine.seek(cue.start)} />
        {time(cue.start, "start")}
        <span className="text-fg-4">–</span>
        {time(cue.end, "end")}
        <div className="flex-1" />
        <IconButton
          icon={<Trash2 size={12} />}
          size={22}
          label="Untertitel löschen"
          className="opacity-0 group-hover:opacity-100"
          onClick={() => void setCues(seq, seq.subtitles.cues.filter((c) => c.id !== cue.id))}
        />
      </div>
      <textarea
        ref={ref}
        aria-label="Untertiteltext"
        rows={Math.min(4, Math.max(1, text.split("\n").length))}
        className="mt-1 w-full resize-none rounded-xs border border-transparent bg-transparent px-1 py-0.5 text-sm text-fg outline-none hover:border-line focus:border-signal focus:bg-field"
        value={text}
        placeholder="Text eingeben …"
        onFocus={() => engine.seek(cue.start)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== cue.text && save({ text })}
        onKeyDown={(e) => {
          e.stopPropagation();
          // Enter commits, Shift+Enter makes a line break.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function SubtitleStyle({ seq }: { seq: Sequence }) {
  const [subs, setSubs] = useState(seq.subtitles);
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current) setSubs(seq.subtitles);
  }, [seq.subtitles]);
  const commit = useDebounced((next: Subtitles) => {
    void edit({ type: "setSubtitleStyle", sequence: seq.id, style: next.style, margin: next.margin, visible: next.visible }).finally(() => {
      pending.current = false;
      engine.setSubtitleOverride(null);
    });
  }, 350);
  const change = (next: Subtitles, now: boolean) => {
    pending.current = true;
    setSubs(next);
    engine.setSubtitleOverride(next);
    commit.call(next);
    if (now) commit.flush();
  };
  return (
    <Section title="Darstellung">
      <Field label="Im Monitor">
        <Toggle checked={subs.visible} onChange={(visible) => change({ ...subs, visible }, true)} label="Untertitel im Programm-Monitor zeigen" />
      </Field>
      <ParamRow label="Abstand unten" value={subs.margin} min={0} max={0.5} scale={100} step={0.5} precision={1} unit=" %" onChange={(margin, l) => change({ ...subs, margin }, !l)} />
      <TextStyleFields style={subs.style} onChange={(p, l) => change({ ...subs, style: { ...subs.style, ...p } }, !l)} />
    </Section>
  );
}

export function SubtitlesPanel() {
  const seq = useActiveSequence();
  const frame = usePlayhead();
  const active = useEditor((s) => s.activeCue);
  if (!seq) return null;
  const cues = seq.subtitles.cues;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Untertitel">
        <div className="flex-1" />
        <IconButton icon={<Plus size={14} />} label="Untertitel am Playhead" shortcut="Strg+⇧+T" onClick={() => void addCue()} />
        <IconButton icon={<Download size={14} />} label="SRT/VTT importieren …" onClick={() => void importSubtitles()} />
        <IconButton icon={<Upload size={14} />} label="SRT/VTT exportieren …" disabled={!cues.length} onClick={() => void exportSubtitles()} />
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {cues.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs leading-relaxed text-fg-3">
            Noch keine Untertitel.
            <br />
            <span className="text-fg-4">Mit + am Playhead anlegen oder eine SRT-/VTT-Datei importieren. Beim Export lassen sie sich einbrennen, einbetten oder als Datei schreiben.</span>
          </div>
        ) : (
          cues.map((c) => <CueRow key={c.id} seq={seq} cue={c} active={c.id === active} current={c.start <= frame && frame < c.end} />)
        )}
        <SubtitleStyle seq={seq} />
      </div>
    </div>
  );
}
