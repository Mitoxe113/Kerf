// Title editor (inspector) and subtitles panel. Edits show live through engine
// overrides and are committed shortly after the last change, one undo step per
// pause in typing or dragging.

import { AlignCenter, AlignLeft, AlignRight, Bold, Download, Italic, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { addCue, exportSubtitles, importSubtitles, setCues, updateTitle } from "../actions/text";
import { usePlayhead } from "../engine/hooks";
import { engine } from "../engine/playback";
import { FONTS } from "../engine/text";
import { formatTimecode, parseTimecode } from "../lib/time";
import type { Cue, MediaAsset, Sequence, Subtitles, TextStyle, TitleSpec } from "../lib/types";
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

/** Font, size, colour, outline, shadow and box of a text block. */
export function TextStyleFields({ style: s, onChange }: { style: TextStyle; onChange: (p: Partial<TextStyle>, live: boolean) => void }) {
  const fonts = FONTS.some((f) => f.css === s.font) ? FONTS : [...FONTS, { label: s.font, css: s.font }];
  return (
    <>
      <Field label="Schrift">
        <Select label="Schrift" value={s.font} options={fonts.map((f) => ({ value: f.css, label: f.label }))} onChange={(font) => onChange({ font }, false)} className="flex-1" />
      </Field>
      <ParamRow label="Größe" value={s.size} min={8} max={300} step={1} precision={0} unit=" px" onChange={(size, l) => onChange({ size }, l)} />
      <Field label="Stil">
        <IconButton icon={<Bold size={13} />} size={24} label="Fett" active={s.bold} onClick={() => onChange({ bold: !s.bold }, false)} />
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
      <ParamRow label="Zeilenabstand" value={s.lineHeight} min={0.8} max={2.5} step={0.05} precision={2} onChange={(lineHeight, l) => onChange({ lineHeight }, l)} />
      <ParamRow label="Zeilenbreite" value={s.wrap} min={0.2} max={1} scale={100} step={1} precision={0} unit=" %" onChange={(wrap, l) => onChange({ wrap }, l)} />
      <Field label="Kontur">
        <ParamInline value={s.outline} max={20} unit=" px" label="Kontur" onChange={(outline, l) => onChange({ outline }, l)} />
        <ColorInput label="Konturfarbe" value={s.outlineColor} onChange={(outlineColor) => onChange({ outlineColor }, false)} />
      </Field>
      <ParamRow label="Schatten" value={s.shadow} min={0} max={40} step={1} precision={0} unit=" px" onChange={(shadow, l) => onChange({ shadow }, l)} />
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

const PRESETS: { label: string; apply: (t: TitleSpec) => TitleSpec }[] = [
  { label: "Mitte", apply: (t) => ({ ...t, x: 0.5, y: 0.5, style: { ...t.style, align: "center", size: 96, boxOpacity: 0 } }) },
  { label: "Bauchbinde", apply: (t) => ({ ...t, x: 0.08, y: 0.82, style: { ...t.style, align: "left", size: 54, bold: true, boxOpacity: 0.65, boxPadding: 18, wrap: 0.5 } }) },
  { label: "Oben", apply: (t) => ({ ...t, x: 0.5, y: 0.12, style: { ...t.style, align: "center", size: 64, boxOpacity: 0 } }) },
];

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
        <Field label="Vorlage">
          <div className="flex gap-1">
            {PRESETS.map((p) => (
              <Button key={p.label} size="sm" onClick={() => change(p.apply(spec), true)}>
                {p.label}
              </Button>
            ))}
          </div>
        </Field>
        <ParamRow label="Position X" value={spec.x} min={0} max={1} scale={100} step={0.5} precision={1} unit=" %" onChange={(x, l) => change({ ...spec, x }, !l)} />
        <ParamRow label="Position Y" value={spec.y} min={0} max={1} scale={100} step={0.5} precision={1} unit=" %" onChange={(y, l) => change({ ...spec, y }, !l)} />
      </Section>
      <Section title="Schrift">
        <TextStyleFields style={spec.style} onChange={(p, l) => change({ ...spec, style: { ...spec.style, ...p } }, !l)} />
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
