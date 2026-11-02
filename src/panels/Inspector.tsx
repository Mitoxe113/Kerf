import { ChevronLeft, ChevronRight, Diamond, RotateCcw, Timer } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { baseValue, COLOR_PARAMS, EASES, hasKeys, isAnimated, isBezier, keysOf, localOf, MOTION_PARAMS, paramAt, playheadKeyPos, removeKey, sameEase, upsertKey } from "../lib/keys";
import { engine } from "../engine/playback";
import { IDENTITY_COLOR, IDENTITY_TRANSFORM } from "../engine/math";
import { codecLabel, formatBytes } from "../lib/media";
import { formatRate, formatTimecode, parseTimecode } from "../lib/time";
import type { Clip, ClipPatch, ColorAdjust, ColorParam, Keyframe, KeyParam, Sequence, Transform } from "../lib/types";
import { findClip, locate } from "../timeline/geometry";
import { useEditor } from "../state/editor";
import { edit, useActiveSequence, useProject } from "../state/project";
import { Button, cx, Field, IconButton, NumberField, openContextMenu, PanelHeader, Section, Segmented, Slider, Toggle } from "../ui/primitives";


function useTargets(seq: Sequence | null) {
  const selection = useEditor((s) => s.selection);
  if (!seq) return { clips: [] as Clip[], video: [] as Clip[], audio: [] as Clip[] };
  const clips = selection.map((id) => findClip(seq, id)).filter(Boolean) as Clip[];
  const kindOf = (c: Clip) => seq.tracks[locate(seq, c.id)!.track].kind;
  return { clips, video: clips.filter((c) => kindOf(c) === "video"), audio: clips.filter((c) => kindOf(c) === "audio") };
}

function SequenceInfo({ seq }: { seq: Sequence }) {
  const set = useEditor((s) => s.set);
  const clips = seq.tracks.reduce((n, t) => n + t.clips.length, 0);
  return (
    <div className="space-y-3 p-3">
      <div>
        <div className="text-sm font-semibold">{seq.name}</div>
        <div className="text-xs text-fg-3">Keine Clips ausgewählt</div>
      </div>
      <div className="space-y-1 rounded-md bg-raised p-2.5 text-xs">
        <Row k="Auflösung" v={`${seq.settings.width} × ${seq.settings.height}`} />
        <Row k="Bildrate" v={`${formatRate(seq.settings.fps)} fps`} />
        <Row k="Audio" v={`${seq.settings.sampleRate / 1000} kHz · Stereo`} />
        <Row k="Dauer" v={formatTimecode(engine.duration, seq.settings.fps)} mono />
        <Row k="Spuren" v={`${seq.tracks.filter((t) => t.kind === "video").length} Video · ${seq.tracks.filter((t) => t.kind === "audio").length} Audio`} />
        <Row k="Clips" v={String(clips)} />
      </div>
      <Button size="sm" onClick={() => set({ dialog: { kind: "sequenceSettings", sequence: seq.id } })}>
        Sequenzeinstellungen …
      </Button>
      <p className="text-xs leading-relaxed text-fg-4">Wähle einen Clip in der Timeline oder im Programmmonitor, um Bewegung, Deckkraft, Farbe, Lautstärke und Timing zu bearbeiten.</p>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-fg-3">{k}</span>
      <span className={cx("truncate text-right text-fg-2", mono && "tc")}>{v}</span>
    </div>
  );
}

export function Inspector() {
  const seq = useActiveSequence();
  const { clips, video, audio } = useTargets(seq);
  const tab = useEditor((s) => s.inspectorTab);
  const set = useEditor((s) => s.set);
  const media = useProject((s) => s.mediaById);

  if (!seq) return null;
  if (!clips.length)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeader title="Inspector" />
        <div className="min-h-0 flex-1 overflow-auto">
          <SequenceInfo seq={seq} />
        </div>
      </div>
    );

  const ref = clips[0];
  const asset = media.get(ref.mediaId);
  const preview = (targets: Clip[], patch: ClipPatch) => targets.forEach((c) => engine.setOverride(c.id, patch));
  const commit = async (targets: Clip[], patch: ClipPatch) => {
    if (!targets.length) return;
    await edit({ type: "updateClips", sequence: seq.id, clips: targets.map((c) => c.id), patch });
    targets.forEach((c) => engine.setOverride(c.id, null));
  };
  const tabs = [
    ...(video.length ? [{ value: "clip" as const, label: "Video" }] : []),
    ...(video.length ? [{ value: "color" as const, label: "Farbe" }] : []),
    ...(audio.length ? [{ value: "audio" as const, label: "Audio" }] : []),
  ];
  const active = tabs.some((t) => t.value === tab) ? tab : tabs[0]?.value;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Inspector">{tabs.length > 1 && <Segmented size="sm" value={active} onChange={(v) => set({ inspectorTab: v })} options={tabs} />}</PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="border-b border-line px-3 py-2.5">
          <div className="truncate text-sm font-semibold">{clips.length > 1 ? `${clips.length} Clips` : ref.name}</div>
          {asset && (
            <div className="truncate text-xs text-fg-3" title={asset.path}>
              {[asset.info?.video && `${asset.info.video.width}×${asset.info.video.height}`, asset.info?.video && asset.kind === "video" && `${formatRate(asset.info.video.fps)} fps`, codecLabel(asset.info?.video?.codec ?? asset.info?.audio?.codec), asset.info && formatBytes(asset.info.sizeBytes)]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </div>
        {active === "clip" && <VideoSection seq={seq} clips={video} commit={commit} />}
        {active === "color" && <ColorSection seq={seq} clips={video} commit={commit} />}
        {active === "audio" && <AudioSection seq={seq} clips={audio} preview={preview} commit={commit} />}
        <TimingSection seq={seq} clips={clips} commit={commit} />
      </div>
    </div>
  );
}

type Preview = (targets: Clip[], patch: ClipPatch) => void;
type Commit = (targets: Clip[], patch: ClipPatch) => Promise<void>;

// --- keyframes -------------------------------------------------------------------

/** Playhead frame while `c` is animated; a constant otherwise (no per-frame re-render). */
function useKeyFrame(c: Clip): number {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => (hasKeys(c) ? Math.round(engine.frame) : -1),
  );
}

/** Static-value patch for one property. */
const basePatch = (x: Clip, p: KeyParam, v: number): ClipPatch =>
  p === "opacity"
    ? { opacity: v }
    : p === "volume"
      ? { volumeDb: v }
      : (COLOR_PARAMS as KeyParam[]).includes(p)
        ? { color: { ...x.color, [p]: v } }
        : { transform: { ...x.transform, [p]: v } };

const setKeys = (seq: Sequence, c: Clip, p: KeyParam, keys: Keyframe[]) => edit({ type: "setKeyframes", sequence: seq.id, clip: c.id, param: p, keys });

/**
 * Keyframe-aware editing of property `p`: with keys (single clip) the value
 * at the playhead is shown and edits set a key there; otherwise edits change
 * the static value of every selected clip.
 */
function useParam(seq: Sequence, clips: Clip[], p: KeyParam, frame: number) {
  const c = clips[0];
  const keyed = clips.length === 1 && isAnimated(c, p);
  const at = playheadKeyPos(c, Math.round(engine.frame));
  const local = Math.min(Math.max((frame < 0 ? engine.frame : frame) - c.start, 0), c.duration - 1);
  return {
    value: keyed ? paramAt(c, p, local) : baseValue(c, p),
    onPreview: (v: number) => {
      if (keyed) engine.setOverride(c.id, { keys: { ...c.keys, [p]: upsertKey(keysOf(c, p), at, v) } });
      else clips.forEach((x) => engine.setOverride(x.id, basePatch(x, p, v) as Partial<Clip>));
    },
    onCommit: async (v: number) => {
      if (keyed) await setKeys(seq, c, p, upsertKey(keysOf(c, p), at, v));
      else for (const x of clips) await edit({ type: "updateClips", sequence: seq.id, clips: [x.id], patch: basePatch(x, p, v) });
      clips.forEach((x) => engine.setOverride(x.id, null));
    },
  };
}

/** Stopwatch, previous/next key and add/remove key for `params` (edited together). */
function KeyNav({ seq, clips, params, frame }: { seq: Sequence; clips: Clip[]; params: KeyParam[]; frame: number }) {
  const c = clips[0];
  if (clips.length !== 1) return null;
  const keyed = params.some((p) => isAnimated(c, p));
  const f = frame < 0 ? Math.round(engine.frame) : frame;
  const inside = f >= c.start && f < c.start + c.duration;
  const at = playheadKeyPos(c, f);
  const positions = [...new Set(params.flatMap((p) => keysOf(c, p).map((k) => k.at)))].sort((a, b) => a - b);
  const onKey = positions.includes(at) && inside;
  const seekKey = (pos: number) => {
    engine.pause();
    engine.seek(Math.round(c.start + localOf(c, pos)));
  };
  const prev = [...positions].reverse().find((x) => x < at);
  const next = positions.find((x) => x > at);
  const toggleWatch = async () => {
    const local = Math.min(Math.max(f - c.start, 0), c.duration - 1);
    for (const p of params) {
      if (keyed) {
        // Stopping the watch keeps the value under the playhead as the static value.
        const v = paramAt(c, p, local);
        await setKeys(seq, c, p, []);
        await edit({ type: "updateClips", sequence: seq.id, clips: [c.id], patch: basePatch(c, p, v) });
      } else await setKeys(seq, c, p, [{ at, value: baseValue(c, p), ease: "linear" }]);
    }
  };
  const toggleKey = async () => {
    const local = f - c.start;
    for (const p of params) {
      const keys = keysOf(c, p);
      await setKeys(seq, c, p, onKey ? removeKey(keys, at) : upsertKey(keys, at, paramAt(c, p, local)));
    }
  };
  const keyMenu = (e: React.MouseEvent) => {
    if (!onKey) return;
    e.preventDefault();
    const current = keysOf(c, params[0]).find((k) => k.at === at)?.ease;
    openContextMenu(e, [
      ...EASES.map((x) => ({
        label: x.label,
        checked: sameEase(current, x.value),
        onSelect: async () => {
          for (const p of params) {
            const k = keysOf(c, p).find((k) => k.at === at);
            if (k) await setKeys(seq, c, p, upsertKey(keysOf(c, p), at, k.value, x.value));
          }
        },
      })),
      {
        label: "Eigene Kurve …",
        checked: isBezier(current),
        onSelect: () => useEditor.getState().set({ dialog: { kind: "curve", sequence: seq.id, clip: c.id, params, at } }),
      },
      { separator: true },
      { label: "Keyframe löschen", danger: true, onSelect: () => void toggleKey() },
    ]);
  };
  const btn = "flex h-5 w-5 items-center justify-center rounded-xs text-fg-3 hover:bg-hover hover:text-fg-2 disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="ml-auto flex shrink-0 items-center">
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
            onClick={() => void toggleKey()}
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
        onClick={() => void toggleWatch()}
      >
        <Timer size={12} />
      </button>
    </div>
  );
}

function VideoSection({ seq, clips, commit }: { seq: Sequence; clips: Clip[]; commit: Commit }) {
  const c = clips[0];
  const t = c.transform;
  const frame = useKeyFrame(c);
  const px = useParam(seq, clips, "x", frame);
  const py = useParam(seq, clips, "y", frame);
  const ps = useParam(seq, clips, "scale", frame);
  const pr = useParam(seq, clips, "rotation", frame);
  const po = useParam(seq, clips, "opacity", frame);
  const pct = (h: typeof ps) => ({ onPreview: (v: number) => h.onPreview(v / 100), onCommit: (v: number) => h.onCommit(v / 100) });
  // Applies one field to every selected clip, keeping their other values.
  const tf = (field: keyof Transform, scale = 1) => ({
    onPreview: (v: number) => clips.forEach((x) => engine.setOverride(x.id, { transform: { ...x.transform, [field]: v / scale } })),
    onCommit: async (v: number) => {
      for (const x of clips) await edit({ type: "updateClips", sequence: seq.id, clips: [x.id], patch: { transform: { ...x.transform, [field]: v / scale } } });
      clips.forEach((x) => engine.setOverride(x.id, null));
    },
  });
  const changed = JSON.stringify(t) !== JSON.stringify(IDENTITY_TRANSFORM) || c.opacity !== 1 || clips.some((x) => MOTION_PARAMS.some((p) => isAnimated(x, p)));
  const reset = async () => {
    await commit(clips, { transform: IDENTITY_TRANSFORM, opacity: 1 });
    for (const x of clips) for (const p of MOTION_PARAMS) if (isAnimated(x, p)) await setKeys(seq, x, p, []);
  };
  return (
    <Section
      title="Bewegung"
      right={<IconButton icon={<RotateCcw size={12} />} size={22} label="Zurücksetzen" disabled={!changed} onClick={() => void reset()} />}
    >
      <Field label="Position">
        <NumberField label="Position X" step={1} unit=" x" {...px} width={76} />
        <NumberField label="Position Y" step={1} unit=" y" {...py} width={76} />
        <KeyNav seq={seq} clips={clips} params={["x", "y"]} frame={frame} />
      </Field>
      <Field label="Skalierung">
        <NumberField label="Skalierung" value={ps.value * 100} step={0.5} min={0} max={10000} precision={1} unit=" %" {...pct(ps)} width={76} />
        <KeyNav seq={seq} clips={clips} params={["scale"]} frame={frame} />
      </Field>
      <Field label="Rotation">
        <NumberField label="Rotation" step={0.5} precision={1} unit="°" {...pr} width={76} />
        <KeyNav seq={seq} clips={clips} params={["rotation"]} frame={frame} />
      </Field>
      <Field label="Ankerpunkt">
        <NumberField label="Anker X" value={t.anchorX * 100} step={0.5} precision={1} unit=" %" {...tf("anchorX", 100)} width={76} />
        <NumberField label="Anker Y" value={t.anchorY * 100} step={0.5} precision={1} unit=" %" {...tf("anchorY", 100)} width={76} />
      </Field>
      <Field label="Deckkraft">
        <Slider label="Deckkraft" value={po.value} min={0} max={1} onPreview={po.onPreview} onCommit={(v) => void po.onCommit(v)} onReset={() => void po.onCommit(1)} />
        <NumberField label="Deckkraft" value={po.value * 100} min={0} max={100} step={0.5} unit=" %" width={58} {...pct(po)} />
        <KeyNav seq={seq} clips={clips} params={["opacity"]} frame={frame} />
      </Field>
      <div className="pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-fg-4">Zuschneiden</div>
      <Field label="Links / Rechts">
        <NumberField label="Links" value={t.cropLeft * 100} min={0} max={99} step={0.2} precision={1} unit=" %" {...tf("cropLeft", 100)} width={66} />
        <NumberField label="Rechts" value={t.cropRight * 100} min={0} max={99} step={0.2} precision={1} unit=" %" {...tf("cropRight", 100)} width={66} />
      </Field>
      <Field label="Oben / Unten">
        <NumberField label="Oben" value={t.cropTop * 100} min={0} max={99} step={0.2} precision={1} unit=" %" {...tf("cropTop", 100)} width={66} />
        <NumberField label="Unten" value={t.cropBottom * 100} min={0} max={99} step={0.2} precision={1} unit=" %" {...tf("cropBottom", 100)} width={66} />
      </Field>
    </Section>
  );
}

const COLOR_FIELDS: { key: keyof ColorAdjust & ColorParam; label: string; min: number; max: number; center: number; unit: string; scale: number; precision: number }[] = [
  { key: "exposure", label: "Belichtung", min: -4, max: 4, center: 0, unit: " EV", scale: 1, precision: 2 },
  { key: "contrast", label: "Kontrast", min: -1, max: 1, center: 0, unit: "", scale: 100, precision: 0 },
  { key: "saturation", label: "Sättigung", min: 0, max: 2, center: 1, unit: " %", scale: 100, precision: 0 },
  { key: "temperature", label: "Temperatur", min: -1, max: 1, center: 0, unit: "", scale: 100, precision: 0 },
  { key: "tint", label: "Tönung", min: -1, max: 1, center: 0, unit: "", scale: 100, precision: 0 },
];

function ColorSection({ seq, clips, commit }: { seq: Sequence; clips: Clip[]; commit: Commit }) {
  const c = clips[0].color;
  const frame = useKeyFrame(clips[0]);
  const [bypass, setBypass] = useState(false);
  const keyed = clips.some((x) => COLOR_PARAMS.some((p) => isAnimated(x, p)));
  const changed = JSON.stringify(c) !== JSON.stringify(IDENTITY_COLOR) || keyed;
  // "Before" also hides animated colour: the override drops the colour keys.
  const withoutColorKeys = (x: Clip) => Object.fromEntries(Object.entries(x.keys ?? {}).filter(([p]) => !(COLOR_PARAMS as string[]).includes(p)));
  const showBefore = () => clips.forEach((x) => engine.setOverride(x.id, { color: IDENTITY_COLOR, keys: withoutColorKeys(x) }));
  const reset = async () => {
    await commit(clips, { color: IDENTITY_COLOR });
    for (const x of clips) for (const p of COLOR_PARAMS) if (isAnimated(x, p)) await setKeys(seq, x, p, []);
  };
  return (
    <Section
      title="Farbkorrektur"
      right={
        <div className="flex items-center gap-1">
          <button
            className={cx("h-5 rounded-xs px-1.5 text-[10.5px]", bypass ? "bg-signal text-signal-ink" : "bg-field text-fg-3 hover:text-fg-2")}
            onPointerDown={() => {
              setBypass(true);
              showBefore();
            }}
            onPointerUp={() => {
              setBypass(false);
              clips.forEach((x) => engine.setOverride(x.id, null));
            }}
            onPointerLeave={() => {
              if (!bypass) return;
              setBypass(false);
              clips.forEach((x) => engine.setOverride(x.id, null));
            }}
            title="Gedrückt halten für den Vorher-Zustand"
          >
            Vorher
          </button>
          <IconButton icon={<RotateCcw size={12} />} size={22} label="Zurücksetzen" disabled={!changed} onClick={() => void reset()} />
        </div>
      }
    >
      {COLOR_FIELDS.map((f) => {
        const p = useParam(seq, clips, f.key, frame);
        return (
          <Field key={f.key} label={f.label}>
            <Slider label={f.label} value={p.value} min={f.min} max={f.max} center={f.center} onPreview={p.onPreview} onCommit={(v) => void p.onCommit(v)} onReset={() => void p.onCommit(f.center)} />
            <NumberField
              label={f.label}
              value={p.value * f.scale}
              min={f.min * f.scale}
              max={f.max * f.scale}
              step={f.scale === 1 ? 0.01 : 0.5}
              precision={f.precision}
              unit={f.unit}
              width={62}
              onPreview={(v) => p.onPreview(v / f.scale)}
              onCommit={(v) => p.onCommit(v / f.scale)}
            />
            <KeyNav seq={seq} clips={clips} params={[f.key]} frame={frame} />
          </Field>
        );
      })}
      <p className="pt-1 text-[10.5px] leading-relaxed text-fg-4">Vorschau und Export verwenden dieselbe Farbmatrix (Rec.709-Luma), Kontrast um 50 % Grau.</p>
    </Section>
  );
}

function AudioSection({ seq, clips, preview, commit }: { seq: Sequence; clips: Clip[]; preview: Preview; commit: Commit }) {
  const c = clips[0];
  const frame = useKeyFrame(c);
  const pv = useParam(seq, clips, "volume", frame);
  return (
    <Section title="Audio" right={<IconButton icon={<RotateCcw size={12} />} size={22} label="Zurücksetzen" disabled={c.volumeDb === 0 && c.pan === 0 && !isAnimated(c, "volume")} onClick={async () => { await commit(clips, { volumeDb: 0, pan: 0 }); for (const x of clips) if (isAnimated(x, "volume")) await setKeys(seq, x, "volume", []); }} />}>
      <Field label="Lautstärke">
        <Slider label="Lautstärke" value={Math.max(-60, pv.value)} min={-60} max={12} center={0} onPreview={pv.onPreview} onCommit={(v) => void pv.onCommit(+v.toFixed(1))} onReset={() => void pv.onCommit(0)} />
        <NumberField label="Lautstärke" value={pv.value} min={-96} max={24} step={0.1} precision={1} unit=" dB" width={66} onPreview={pv.onPreview} onCommit={pv.onCommit} />
        <KeyNav seq={seq} clips={clips} params={["volume"]} frame={frame} />
      </Field>
      <Field label="Balance">
        <Slider label="Balance" value={c.pan} min={-1} max={1} center={0} onPreview={(v) => preview(clips, { pan: v })} onCommit={(v) => void commit(clips, { pan: +v.toFixed(2) })} onReset={() => void commit(clips, { pan: 0 })} />
        <NumberField label="Balance" value={c.pan * 100} min={-100} max={100} step={1} width={66} format={(v) => (Math.round(v) === 0 ? "C" : v < 0 ? `L ${Math.round(-v)}` : `R ${Math.round(v)}`)} onPreview={(v) => preview(clips, { pan: v / 100 })} onCommit={(v) => void commit(clips, { pan: v / 100 })} />
      </Field>
      <Field label="Pegel">
        <Button size="sm" onClick={() => useEditor.getState().set({ dialog: { kind: "normalize", clips: clips.map((x) => x.id) } })}>
          Normalisieren …
        </Button>
      </Field>
    </Section>
  );
}

function TimingSection({ seq, clips, commit }: { seq: Sequence; clips: Clip[]; commit: Commit }) {
  const c = clips[0];
  const fps = seq.settings.fps;
  const single = clips.length === 1;
  return (
    <Section title="Zeit">
      <Field label="Aktiviert">
        <Toggle label="Aktiviert" checked={c.enabled} onChange={(v) => void commit(clips, { enabled: v })} />
      </Field>
      {single && (
        <>
          <Field label="Start">
            <NumberField
              label="Start"
              value={c.start}
              min={0}
              step={1}
              width={110}
              format={(v) => formatTimecode(Math.round(v), fps)}
              parse={(s) => parseTimecode(s, fps, c.start)}
              onCommit={(v) => void edit({ type: "moveClips", sequence: seq.id, clips: [c.id], delta: Math.round(v) - c.start })}
            />
          </Field>
          <Field label="Dauer">
            <NumberField
              label="Dauer"
              value={c.duration}
              min={1}
              step={1}
              width={110}
              format={(v) => formatTimecode(Math.round(v), fps)}
              parse={(s) => parseTimecode(s, fps, c.duration)}
              onCommit={(v) => void edit({ type: "trimClip", sequence: seq.id, clip: c.id, edge: "end", delta: Math.round(v) - c.duration, ripple: false, linked: true })}
            />
          </Field>
        </>
      )}
      <Field label="Geschwindigkeit">
        <NumberField label="Geschwindigkeit" value={c.speed * 100} min={10} max={1600} step={1} unit=" %" width={76} onCommit={(v) => void commit(clips, { speed: v / 100 })} />
      </Field>
      <Field label="Einblenden">
        <NumberField label="Einblenden" value={c.fadeIn} min={0} step={1} unit=" F" width={66} onCommit={(v) => void commit(clips, { fadeIn: Math.round(v) })} />
        <span className="text-xs text-fg-4">Ausblenden</span>
        <NumberField label="Ausblenden" value={c.fadeOut} min={0} step={1} unit=" F" width={66} onCommit={(v) => void commit(clips, { fadeOut: Math.round(v) })} />
      </Field>
    </Section>
  );
}
