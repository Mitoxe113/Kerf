// Editing assistants: scene, silence, beat and highlight analysis of the
// selected clip or media, and ducking of music under speech. Analyses only
// read the media; results are listed for review and applied as one undoable
// edit (cuts, markers, keyframes) that stays editable by hand.

import { Loader2, Play, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { batch, clearCategoryCommand, MARKER_COLORS, markerCommands, placeRangesCommands, removeRangesCommands, scenesFromCuts, splitCommands } from "../actions/assist";
import { engine } from "../engine/playback";
import { api, events, isCommandError } from "../lib/ipc";
import type {
  AnalysisRequest,
  AnalysisResult,
  AnalysisTarget,
  BeatOptions,
  DuckOptions,
  DuckPlan,
  EditCommand,
  HighlightOptions,
  MediaAsset,
  NewMarker,
  SceneOptions,
  Sequence,
  SilenceOptions,
} from "../lib/types";
import { useEditor } from "../state/editor";
import { edit, reportError, useActiveSequence, useProject } from "../state/project";
import { source } from "../state/source";
import { toast } from "../state/toasts";
import { Button, cx, NumberField, PanelHeader, Progress, Segmented, Toggle } from "../ui/primitives";

type Tab = "scenes" | "silence" | "beats" | "highlights" | "ducking";

const DEFAULT_SCENES: SceneOptions = { threshold: 0.35, gradual: true, minScene: 0.6, ignoreFlashes: true };
const DEFAULT_SILENCE: SilenceOptions = { thresholdDb: 10, relative: true, minSilence: 0.5, padAfter: 0.15, padBefore: 0.1, ignoreBursts: 0.04 };
const DEFAULT_BEATS: BeatOptions = { minBpm: 60, maxBpm: 200, preferBpm: 120, peakThreshold: 0.5, beatsPerBar: 4 };
const DEFAULT_HIGHLIGHTS: HighlightOptions = { window: 5, count: 8, motion: 1, loudness: 1, cuts: 0.5 };
const DEFAULT_DUCK: DuckOptions = { depthDb: 12, attack: 0.25, hold: 0.3, release: 0.6 };

const fpsOf = (seq: Sequence) => seq.settings.fps.num / seq.settings.fps.den;
const secs = (t: number) => {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, "0")}`;
};

interface Target {
  target: AnalysisTarget;
  label: string;
  asset: MediaAsset;
  /** For clip targets. */
  clipId?: string;
}

/** The clip selected in the timeline, else the media selected in the browser. */
function useTarget(seq: Sequence | null): Target | null {
  const selection = useEditor((s) => s.selection);
  const mediaSelection = useEditor((s) => s.mediaSelection);
  const mediaById = useProject((s) => s.mediaById);
  if (seq && selection.length) {
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === selection[0]);
    const asset = clip && mediaById.get(clip.mediaId);
    if (clip && asset) return { target: { type: "clip", sequence: seq.id, clip: clip.id }, label: `Clip „${clip.name}“`, asset, clipId: clip.id };
  }
  const asset = mediaSelection.length ? mediaById.get(mediaSelection[0]) : undefined;
  if (asset) return { target: { type: "media", media: asset.id }, label: `Medium „${asset.name}“`, asset };
  return null;
}

const keyOf = (t: Target) => t.clipId ?? t.asset.id;

/** Runs analyses with progress and cancel. */
function useRunner() {
  const [job, setJob] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    if (!job) return;
    const off = events.analysisProgress((p) => p.job === job && setProgress(p.total > 0 ? Math.min(1, p.done / p.total) : null));
    return () => void off.then((f) => f());
  }, [job]);
  async function run<T>(f: (job: string) => Promise<T>): Promise<T | null> {
    const id = crypto.randomUUID();
    setJob(id);
    setProgress(null);
    try {
      return await f(id);
    } catch (e) {
      if (isCommandError(e) && e.code === "cancelled") toast.info("Analyse abgebrochen");
      else reportError(e, "Die Analyse ist fehlgeschlagen.");
      return null;
    } finally {
      setJob(null);
      setProgress(null);
    }
  }
  const cancel = () => job && void api.analyzeCancel(job);
  return { running: job !== null, progress, run, cancel };
}

function Num({ label, value, onChange, min, max, step, precision = 2, unit }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; precision?: number; unit?: string }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-fg-2">
      <span>{label}</span>
      <NumberField value={value} onCommit={onChange} min={min} max={max} step={step} precision={precision} unit={unit} width={72} />
    </label>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-fg-2">
      <span>{label}</span>
      <Toggle checked={value} onChange={onChange} />
    </div>
  );
}

/** Jumps to a timeline frame (clip targets) or a source second (media targets). */
function goTo(t: Target, frame: number | null | undefined, seconds: number) {
  if (t.target.type === "clip" && frame != null) engine.seek(frame);
  else source.open(t.asset.id, { at: seconds });
}

function ResultRow({ checked, onToggle, onGo, children }: { checked: boolean; onToggle: () => void; onGo: () => void; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-2 py-1 text-xs hover:bg-surface-2">
      <input type="checkbox" checked={checked} onChange={onToggle} aria-label="Übernehmen" />
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onGo} title="Dorthin springen">
        <Play size={11} className="shrink-0 text-fg-4" />
        {children}
      </button>
    </div>
  );
}

function useChecks(n: number, key: unknown) {
  const [off, setOff] = useState<Set<number>>(new Set());
  useEffect(() => setOff(new Set()), [key]);
  return {
    on: (i: number) => !off.has(i),
    toggle: (i: number) => setOff((s) => { const n2 = new Set(s); if (n2.has(i)) n2.delete(i); else n2.add(i); return n2; }),
    count: n - off.size,
    all: (v: boolean) => setOff(v ? new Set() : new Set(Array.from({ length: n }, (_, i) => i))),
  };
}

async function apply(cmd: EditCommand | null, done: string) {
  if (!cmd) return toast.info("Nichts zu übernehmen", "Keines der ausgewählten Ergebnisse liegt im Clip.");
  if (await edit(cmd)) toast.success(done, "Mit Strg+Z rückgängig machbar.");
}

function ClearMarkers({ seq, category, label }: { seq: Sequence; category: string; label: string }) {
  const n = seq.markers.filter((m) => (m.category ?? "") === category).length;
  if (!n) return null;
  return (
    <Button size="sm" variant="ghost" onClick={() => void apply(clearCategoryCommand(seq, category), "Marker gelöscht")}>
      <Trash2 size={12} /> {n} {label} löschen
    </Button>
  );
}

// --- scenes ---------------------------------------------------------------------------

function ScenesView({ seq, t }: { seq: Sequence; t: Target }) {
  const [o, setO] = useState(DEFAULT_SCENES);
  const [r, setR] = useState<AnalysisResult | null>(null);
  const runner = useRunner();
  const cuts = r?.scenes ?? [];
  const checks = useChecks(cuts.length, r);
  useEffect(() => setR(null), [keyOf(t)]);
  const go = () => void runner.run((job) => api.analyze(job, t.target, { type: "scenes", options: o })).then((x) => x && setR(x));
  const chosen = cuts.map((c, i) => ({ c, i, frame: r?.sceneFrames[i] })).filter((x) => checks.on(x.i));
  const fps = fpsOf(seq);
  return (
    <>
      <Options>
        <Num label="Empfindlichkeit (Schwelle)" value={o.threshold} min={0.05} max={0.95} step={0.05} onChange={(v) => setO({ ...o, threshold: v })} />
        <Num label="Kürzeste Szene" value={o.minScene} min={0} max={10} step={0.1} unit="s" onChange={(v) => setO({ ...o, minScene: v })} />
        <Check label="Überblendungen und Abblenden erkennen" value={o.gradual} onChange={(v) => setO({ ...o, gradual: v })} />
        <Check label="Blitze ignorieren" value={o.ignoreFlashes} onChange={(v) => setO({ ...o, ignoreFlashes: v })} />
      </Options>
      <RunBar runner={runner} onRun={go} />
      {r && (
        <Results count={cuts.length} checks={checks} empty="Keine Szenenwechsel gefunden.">
          {cuts.map((c, i) => (
            <ResultRow key={i} checked={checks.on(i)} onToggle={() => checks.toggle(i)} onGo={() => goTo(t, r.sceneFrames[i], c.time)}>
              <span className="font-mono text-fg-1">{secs(c.time)}</span>
              <span className={cx("rounded-xs px-1", c.kind === "hard" ? "bg-surface-3 text-fg-2" : "bg-blue/20 text-fg-2")}>{c.kind === "hard" ? "Schnitt" : `Übergang ${(c.to - c.from).toFixed(1)} s`}</span>
              {Math.abs(c.lumaChange) > 0.25 && <span className="text-fg-4">{c.lumaChange < 0 ? "dunkler" : "heller"}</span>}
              <span className="ml-auto text-fg-4">{Math.round(c.score * 100)} %</span>
            </ResultRow>
          ))}
        </Results>
      )}
      <Apply>
        {t.clipId ? (
          <>
            <Button size="sm" disabled={!chosen.length} onClick={() => void apply(splitCommands(seq, t.clipId!, chosen.flatMap((x) => (x.frame != null ? [x.frame] : []))), "Clip an den Szenenwechseln geteilt")}>
              Clip teilen ({chosen.length})
            </Button>
            <Button size="sm" variant="ghost" disabled={!chosen.length} onClick={() => void apply(markerCommands(seq, chosen.flatMap(({ c, frame }): NewMarker[] => (frame != null ? [{ frame, name: c.kind === "hard" ? "Szene" : "Übergang", color: MARKER_COLORS.scene, category: "scene" }] : []))), "Szenen-Marker gesetzt")}>
              Als Marker
            </Button>
          </>
        ) : (
          r && (
            <Button
              size="sm"
              disabled={!chosen.length && !cuts.length}
              onClick={() => void apply(placeRangesCommands(seq, t.asset.id, scenesFromCuts(chosen.map((x) => x.c.time), r.sourceStart, r.sourceEnd), Math.round(engine.frame), fps), "Szenen als Clips eingefügt")}
            >
              Szenen am Playhead einfügen
            </Button>
          )
        )}
        <ClearMarkers seq={seq} category="scene" label="Szenen-Marker" />
      </Apply>
    </>
  );
}

// --- silence -----------------------------------------------------------------------------

function SilenceView({ seq, t }: { seq: Sequence; t: Target }) {
  const [o, setO] = useState(DEFAULT_SILENCE);
  const [keep, setKeep] = useState(0);
  const [r, setR] = useState<AnalysisResult | null>(null);
  const runner = useRunner();
  const list = r?.silence?.silences ?? [];
  const checks = useChecks(list.length, r);
  useEffect(() => setR(null), [keyOf(t)]);
  const go = () => void runner.run((job) => api.analyze(job, t.target, { type: "silence", options: o })).then((x) => x && setR(x));
  const fps = fpsOf(seq);
  const ranges = list.map((_, i) => (checks.on(i) ? r!.silenceRanges[i] : null)).filter((x): x is [number, number] => !!x);
  const total = list.reduce((a, s, i) => a + (checks.on(i) ? s.cutEnd - s.cutStart : 0), 0);
  return (
    <>
      <Options>
        <Check label="Schwelle relativ zum Grundrauschen" value={o.relative} onChange={(v) => setO({ ...o, relative: v, thresholdDb: v ? 10 : -40 })} />
        <Num label={o.relative ? "Schwelle über dem Rauschen" : "Schwelle"} value={o.thresholdDb} min={o.relative ? 0 : -90} max={o.relative ? 40 : 0} step={1} precision={0} unit="dB" onChange={(v) => setO({ ...o, thresholdDb: v })} />
        <Num label="Kürzeste Pause" value={o.minSilence} min={0.05} max={10} step={0.05} unit="s" onChange={(v) => setO({ ...o, minSilence: v })} />
        <Num label="Behalten nach Sprache" value={o.padAfter} min={0} max={2} step={0.05} unit="s" onChange={(v) => setO({ ...o, padAfter: v })} />
        <Num label="Behalten vor Sprache" value={o.padBefore} min={0} max={2} step={0.05} unit="s" onChange={(v) => setO({ ...o, padBefore: v })} />
        <Num label="Kurze Geräusche ignorieren" value={o.ignoreBursts} min={0} max={0.5} step={0.01} unit="s" onChange={(v) => setO({ ...o, ignoreBursts: v })} />
      </Options>
      <RunBar runner={runner} onRun={go} />
      {r?.silence && (
        <>
          <div className="px-2 py-1 text-[11px] text-fg-4">
            Grundrauschen {r.silence.noiseFloorDb.toFixed(0)} dBFS · Schwelle {r.silence.thresholdDb.toFixed(0)} dBFS · ausgewählt {total.toFixed(1)} s
          </div>
          <Results count={list.length} checks={checks} empty="Keine Pausen gefunden.">
            {list.map((s, i) => (
              <ResultRow key={i} checked={checks.on(i)} onToggle={() => checks.toggle(i)} onGo={() => goTo(t, r.silenceRanges[i]?.[0], s.start)}>
                <span className="font-mono text-fg-1">{secs(s.start)}</span>
                <span className="text-fg-3">{(s.end - s.start).toFixed(2)} s Pause</span>
                <span className="ml-auto text-fg-4">{s.cutEnd > s.cutStart ? `−${(s.cutEnd - s.cutStart).toFixed(2)} s` : "zu kurz"}</span>
              </ResultRow>
            ))}
          </Results>
        </>
      )}
      <Apply>
        {t.clipId ? (
          <>
            <Num label="Von jeder Pause behalten" value={keep} min={0} max={5} step={0.05} unit="s" onChange={setKeep} />
            <Button size="sm" disabled={!ranges.length} onClick={() => void apply(removeRangesCommands(seq, t.clipId!, ranges, Math.round(keep * fps)), keep > 0 ? "Pausen gekürzt" : "Pausen entfernt")}>
              {keep > 0 ? "Pausen kürzen" : "Pausen entfernen"} ({ranges.length})
            </Button>
            <Button size="sm" variant="ghost" disabled={!ranges.length} onClick={() => void apply(markerCommands(seq, ranges.map(([a, b]) => ({ frame: a, duration: b - a, name: "Pause", color: MARKER_COLORS.silence, category: "silence" }))), "Pausen markiert")}>
              Als Marker
            </Button>
          </>
        ) : (
          r && <span className="text-[11px] text-fg-4">Zum Schneiden einen Clip in der Timeline auswählen und analysieren.</span>
        )}
        <ClearMarkers seq={seq} category="silence" label="Pausen-Marker" />
      </Apply>
    </>
  );
}

// --- beats -----------------------------------------------------------------------------------

function BeatsView({ seq, t }: { seq: Sequence; t: Target }) {
  const [o, setO] = useState(DEFAULT_BEATS);
  const [which, setWhich] = useState<"all" | "bars" | "peaks">("all");
  const [r, setR] = useState<AnalysisResult | null>(null);
  const runner = useRunner();
  useEffect(() => setR(null), [keyOf(t)]);
  const go = () => void runner.run((job) => api.analyze(job, t.target, { type: "beats", options: o })).then((x) => x && setR(x));
  const b = r?.beats;
  const markers = useMemo((): NewMarker[] => {
    if (!b || !r) return [];
    if (which === "peaks") return b.peaks.flatMap(([, v], i) => (r.peakFrames[i] != null ? [{ frame: r.peakFrames[i]!, name: "Akzent", note: `Stärke ${v.toFixed(1)}`, color: MARKER_COLORS.peak, category: "beat" }] : []));
    return b.beats.flatMap((x, i) => {
      const f = r.beatFrames[i];
      if (f == null || (which === "bars" && x.beatInBar !== 1)) return [];
      const down = x.beatInBar === 1;
      return [{ frame: f, name: x.beatInBar ? `Schlag ${x.beatInBar}` : "Beat", color: down ? MARKER_COLORS.downbeat : MARKER_COLORS.beat, category: "beat" }];
    });
  }, [b, r, which]);
  return (
    <>
      <Options>
        <Num label="Tempo von" value={o.minBpm} min={30} max={300} step={5} precision={0} unit="BPM" onChange={(v) => setO({ ...o, minBpm: v })} />
        <Num label="Tempo bis" value={o.maxBpm} min={40} max={400} step={5} precision={0} unit="BPM" onChange={(v) => setO({ ...o, maxBpm: v })} />
        <Num label="Bevorzugtes Tempo" value={o.preferBpm} min={40} max={300} step={5} precision={0} unit="BPM" onChange={(v) => setO({ ...o, preferBpm: v })} />
        <Num label="Schwelle für Akzente" value={o.peakThreshold} min={0} max={1} step={0.05} onChange={(v) => setO({ ...o, peakThreshold: v })} />
        <Num label="Schläge pro Takt (Annahme)" value={o.beatsPerBar} min={2} max={12} step={1} precision={0} onChange={(v) => setO({ ...o, beatsPerBar: v })} />
      </Options>
      <RunBar runner={runner} onRun={go} />
      {b && (
        <div className="space-y-1 px-2 py-2 text-xs text-fg-2">
          <div>
            Tempo: {b.bpm ? <span className="font-mono text-fg-1">{b.bpm.toFixed(1)} BPM</span> : <span className="text-warn">nicht eindeutig</span>}
            <span className="text-fg-4"> · Deutlichkeit {b.tempoConfidence.toFixed(1)}</span>
          </div>
          <div className="text-fg-3">
            {b.beats.length} Beats · {b.peaks.length} Akzente · Takte: {b.bars ? `${o.beatsPerBar}er-Takt angenommen, Taktanfang erkannt` : "Taktanfang nicht eindeutig"}
          </div>
        </div>
      )}
      <Apply>
        {t.clipId ? (
          <>
            <Segmented
              size="sm"
              value={which}
              onChange={setWhich}
              options={[
                { value: "all", label: "Alle Beats" },
                { value: "bars", label: "Taktanfänge", title: b?.bars ? undefined : "Taktanfang nicht erkannt" },
                { value: "peaks", label: "Akzente" },
              ]}
            />
            <Button size="sm" disabled={!markers.length} onClick={() => void apply(markerCommands(seq, markers), "Beat-Marker gesetzt (Einrasten an Markern nutzt sie)")}>
              Marker setzen ({markers.length})
            </Button>
          </>
        ) : (
          r && <span className="text-[11px] text-fg-4">Für Marker den Musikclip in der Timeline auswählen und analysieren.</span>
        )}
        <ClearMarkers seq={seq} category="beat" label="Beat-Marker" />
      </Apply>
    </>
  );
}

// --- highlights ------------------------------------------------------------------------------

const REASONS: Record<string, string> = { motion: "viel Bewegung", loudness: "laut", cuts: "viele Schnitte" };

function HighlightsView({ seq, t }: { seq: Sequence; t: Target }) {
  const [o, setO] = useState(DEFAULT_HIGHLIGHTS);
  const [r, setR] = useState<AnalysisResult | null>(null);
  const runner = useRunner();
  const list = r?.highlights ?? [];
  const checks = useChecks(list.length, r);
  useEffect(() => setR(null), [keyOf(t)]);
  const go = () => void runner.run((job) => api.analyze(job, t.target, { type: "highlights", options: o, scenes: DEFAULT_SCENES } satisfies AnalysisRequest)).then((x) => x && setR(x));
  const chosen = list.map((h, i) => ({ h, i, range: r?.highlightRanges[i] ?? null })).filter((x) => checks.on(x.i));
  return (
    <>
      <Options>
        <Num label="Länge eines Moments" value={o.window} min={1} max={60} step={1} precision={0} unit="s" onChange={(v) => setO({ ...o, window: v })} />
        <Num label="Höchstens" value={o.count} min={1} max={50} step={1} precision={0} onChange={(v) => setO({ ...o, count: v })} />
        <Num label="Gewicht Bewegung" value={o.motion} min={0} max={3} step={0.25} onChange={(v) => setO({ ...o, motion: v })} />
        <Num label="Gewicht Lautstärke" value={o.loudness} min={0} max={3} step={0.25} onChange={(v) => setO({ ...o, loudness: v })} />
        <Num label="Gewicht Schnittdichte" value={o.cuts} min={0} max={3} step={0.25} onChange={(v) => setO({ ...o, cuts: v })} />
      </Options>
      <p className="px-2 pb-1 text-[11px] text-fg-4">Vorschläge nach messbarer Aktivität (Bewegung, Lautstärke, Schnitte). Sie sagen nichts über Qualität oder Bedeutung aus.</p>
      <RunBar runner={runner} onRun={go} />
      {r && (
        <Results count={list.length} checks={checks} empty="Keine Stelle hebt sich deutlich ab.">
          {list.map((h, i) => (
            <ResultRow key={i} checked={checks.on(i)} onToggle={() => checks.toggle(i)} onGo={() => goTo(t, r.highlightRanges[i]?.[0], h.start)}>
              <span className="font-mono text-fg-1">{secs(h.start)}</span>
              <span className="text-fg-3">Vorschlag: {h.reasons.map((x) => REASONS[x]).join(", ") || "auffällig"}</span>
              <span className="ml-auto text-fg-4">{(h.end - h.start).toFixed(0)} s</span>
            </ResultRow>
          ))}
        </Results>
      )}
      <Apply>
        {t.clipId ? (
          <Button
            size="sm"
            disabled={!chosen.some((x) => x.range)}
            onClick={() =>
              void apply(
                markerCommands(seq, chosen.flatMap(({ h, range }): NewMarker[] => (range ? [{ frame: range[0], duration: range[1] - range[0], name: "Vorschlag", note: h.reasons.map((x) => REASONS[x]).join(", "), color: MARKER_COLORS.highlight, category: "highlight" }] : []))),
                "Vorschläge markiert",
              )
            }
          >
            Als Marker
          </Button>
        ) : (
          r && (
            <Button size="sm" disabled={!chosen.length} onClick={() => void apply(placeRangesCommands(seq, t.asset.id, chosen.map((x): [number, number] => [x.h.start, x.h.end]), Math.round(engine.frame), fpsOf(seq), "analysisMarkers"), "Vorschläge am Playhead eingefügt")}>
              Am Playhead einfügen ({chosen.length})
            </Button>
          )
        )}
        <ClearMarkers seq={seq} category="highlight" label="Vorschlags-Marker" />
      </Apply>
    </>
  );
}

// --- ducking ------------------------------------------------------------------------------------

function DuckCurve({ plan, seconds }: { plan: DuckPlan; seconds: number }) {
  const w = 300;
  const h = 48;
  const x = (t: number) => (t / Math.max(seconds, 1)) * w;
  const depth = Math.min(...plan.curve.map((p) => p[1]), -1);
  const y = (db: number) => (db / depth) * (h - 8) + 4;
  const pts = [[0, 0], ...plan.curve, [seconds, 0]].map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-12 w-full rounded-sm bg-surface-2" aria-label="Ducking-Kurve">
      {plan.speech.map(([a, b], i) => <rect key={i} x={x(a)} y={0} width={Math.max(1, x(b) - x(a))} height={h} className="fill-signal/15" />)}
      <polyline points={pts} fill="none" className="stroke-signal" strokeWidth={1.5} />
    </svg>
  );
}

function DuckingView({ seq }: { seq: Sequence }) {
  const audio = seq.tracks.filter((t) => t.kind === "audio");
  const [triggers, setTriggers] = useState<string[]>(() => audio.slice(0, 1).map((t) => t.id));
  const [targets, setTargets] = useState<string[]>(() => audio.slice(1).map((t) => t.id));
  const [speech, setSpeech] = useState(DEFAULT_SILENCE);
  const [o, setO] = useState(DEFAULT_DUCK);
  const [plan, setPlan] = useState<DuckPlan | null>(null);
  const runner = useRunner();
  const flip = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const go = () => void runner.run((job) => api.duckPlan(job, seq.id, triggers, targets, speech, o)).then((p) => p && setPlan(p));
  const changes = plan?.clips.filter((c) => c.keys.length) ?? [];
  const replacing = changes.filter((c) => c.replacesKeys).length;
  const seconds = Math.max(1, ...seq.tracks.flatMap((t) => t.clips.map((c) => (c.start + c.duration) / fpsOf(seq))));
  const applyPlan = () =>
    void apply(batch("ducking", changes.map((c): EditCommand => ({ type: "setKeyframes", sequence: seq.id, clip: c.clip, param: "volume", keys: c.keys }))), "Ducking übernommen (Lautstärke-Keyframes)");
  if (audio.length < 2) return <p className="p-3 text-xs text-fg-4">Ducking braucht mindestens zwei Audiospuren: eine mit Sprache, eine mit Musik.</p>;
  return (
    <>
      <div className="border-b border-line px-2 py-2">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-fg-4">Spur</span>
          <span className="text-fg-4">Sprache</span>
          <span className="text-fg-4">Absenken</span>
          {audio.map((t) => (
            <div key={t.id} className="contents">
              <span className="truncate text-fg-2">{t.name}</span>
              <input type="checkbox" aria-label={`${t.name} als Auslöser`} checked={triggers.includes(t.id)} onChange={() => { setTriggers(flip(triggers, t.id)); setTargets(targets.filter((x) => x !== t.id)); setPlan(null); }} />
              <input type="checkbox" aria-label={`${t.name} absenken`} checked={targets.includes(t.id)} onChange={() => { setTargets(flip(targets, t.id)); setTriggers(triggers.filter((x) => x !== t.id)); setPlan(null); }} />
            </div>
          ))}
        </div>
      </div>
      <Options>
        <Num label="Absenkung" value={o.depthDb} min={1} max={40} step={1} precision={0} unit="dB" onChange={(v) => setO({ ...o, depthDb: v })} />
        <Num label="Attack" value={o.attack} min={0} max={3} step={0.05} unit="s" onChange={(v) => setO({ ...o, attack: v })} />
        <Num label="Halten" value={o.hold} min={0} max={3} step={0.05} unit="s" onChange={(v) => setO({ ...o, hold: v })} />
        <Num label="Release" value={o.release} min={0} max={5} step={0.05} unit="s" onChange={(v) => setO({ ...o, release: v })} />
        <Num label="Sprache ab (über Rauschen)" value={speech.thresholdDb} min={0} max={40} step={1} precision={0} unit="dB" onChange={(v) => setSpeech({ ...speech, thresholdDb: v, relative: true })} />
      </Options>
      <RunBar runner={runner} onRun={go} label="Plan berechnen" disabled={!triggers.length || !targets.length} />
      {plan && (
        <div className="space-y-2 px-2 py-2 text-xs text-fg-2">
          <DuckCurve plan={plan} seconds={seconds} />
          <div>
            {plan.speech.length} Sprachabschnitte · {changes.length === 1 ? "1 Clip bekommt" : `${changes.length} Clips bekommen`} Lautstärke-Keyframes
          </div>
          {replacing > 0 && <div className="text-warn">{replacing === 1 ? "1 Clip hat" : `${replacing} Clips haben`} schon Lautstärke-Keyframes; sie werden ersetzt.</div>}
          {plan.skipped.length > 0 && <div className="text-fg-4">Ausgelassen (rückwärts oder mit Rampen): {plan.skipped.join(", ")}</div>}
          {plan.unreadable.length > 0 && <div className="text-warn">Nicht lesbar (offline, ohne Ton, rückwärts oder mit Rampen): {plan.unreadable.join(", ")}</div>}
        </div>
      )}
      <Apply>
        <Button size="sm" disabled={!changes.length} onClick={applyPlan}>
          Übernehmen
        </Button>
      </Apply>
    </>
  );
}

// --- layout pieces ------------------------------------------------------------------------------

function Options({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-1.5 border-b border-line px-2 py-2">{children}</div>;
}

function RunBar({ runner, onRun, label = "Analysieren", disabled }: { runner: ReturnType<typeof useRunner>; onRun: () => void; label?: string; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-2 py-2">
      {runner.running ? (
        <>
          <Loader2 size={13} className="animate-spin text-fg-3" />
          <div className="flex-1">
            <Progress value={runner.progress ?? undefined} indeterminate={runner.progress == null} />
          </div>
          <Button size="sm" variant="ghost" onClick={runner.cancel}>
            <X size={12} /> Abbrechen
          </Button>
        </>
      ) : (
        <Button size="sm" variant="primary" onClick={onRun} disabled={disabled}>
          {label}
        </Button>
      )}
    </div>
  );
}

function Results({ count, checks, empty, children }: { count: number; checks: ReturnType<typeof useChecks>; empty: string; children: React.ReactNode }) {
  if (!count) return <p className="px-2 py-2 text-xs text-fg-4">{empty}</p>;
  return (
    <div className="border-t border-line">
      <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-fg-4">
        <span>
          {checks.count} von {count} ausgewählt
        </span>
        <button className="ml-auto hover:text-fg-2" onClick={() => checks.all(true)}>
          alle
        </button>
        <button className="hover:text-fg-2" onClick={() => checks.all(false)}>
          keine
        </button>
      </div>
      {children}
    </div>
  );
}

function Apply({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 border-t border-line px-2 py-2">{children}</div>;
}

export function AssistantPanel() {
  const [tab, setTab] = useState<Tab>("scenes");
  const seq = useActiveSequence();
  const t = useTarget(seq);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader>
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: "scenes", label: "Szenen" },
            { value: "silence", label: "Stille" },
            { value: "beats", label: "Beats" },
            { value: "highlights", label: "Momente" },
            { value: "ducking", label: "Ducking" },
          ]}
        />
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {!seq ? null : tab === "ducking" ? (
          <DuckingView seq={seq} />
        ) : !t ? (
          <p className="p-3 text-xs text-fg-4">Wähle einen Clip in der Timeline oder ein Medium in der Medienablage aus.</p>
        ) : (
          <>
            <div className="border-b border-line px-2 py-1.5 text-xs text-fg-3">
              Ziel: <span className="text-fg-1">{t.label}</span>
              {t.target.type === "clip" && <span className="text-fg-4"> · nur der vom Clip verwendete Bereich</span>}
            </div>
            {tab === "scenes" ? <ScenesView seq={seq} t={t} /> : tab === "silence" ? <SilenceView seq={seq} t={t} /> : tab === "beats" ? <BeatsView seq={seq} t={t} /> : <HighlightsView seq={seq} t={t} />}
          </>
        )}
      </div>
    </div>
  );
}
