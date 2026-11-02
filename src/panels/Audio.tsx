// Level meters and the track mixer. Meters read the WebAudio analysers at
// display rate; faders preview on the bus immediately and commit on release.

import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { engine } from "../engine/playback";
import type { MeterReading } from "../engine/audio";
import { activeKinds, type LoudnessReading } from "../engine/dsp";
import type { Track } from "../lib/types";
import { useEditor } from "../state/editor";
import { edit, useActiveSequence } from "../state/project";
import { cx, IconButton, PanelHeader } from "../ui/primitives";

const FLOOR_DB = -60;
const toDb = (v: number) => (v <= 0 ? -Infinity : 20 * Math.log10(v));
const toFrac = (db: number) => Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
/** Height of the clip LED above each bar. */
const LED_H = 5;
/** A sample at (or over) full scale. */
const CLIP_LEVEL = 0.9999;
const CLIP_HINT = "Rote Anzeige oben = Übersteuerung (0 dBFS erreicht). Klicken setzt sie zurück.";

function useMeter(read: () => MeterReading | null) {
  const ref = useRef<HTMLCanvasElement>(null);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let raf = 0;
    const hold = [-Infinity, -Infinity];
    const holdAt = [0, 0];
    // Latched until clicked, like a hardware clip LED.
    const clipped = [false, false];
    const canvas = ref.current;
    const reset = () => clipped.fill(false);
    canvas?.addEventListener("pointerdown", reset);
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
      if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const r = engine.playing ? readRef.current() : null;
      const top = LED_H + 2;
      const bh = h - top;
      const bw = (w - 3) / 2;
      const now = performance.now();
      for (let ch = 0; ch < 2; ch++) {
        const x = ch * (bw + 3);
        if (r && r.peak[ch] >= CLIP_LEVEL) clipped[ch] = true;
        ctx.fillStyle = clipped[ch] ? "#ff4d40" : "#2a2a31";
        ctx.fillRect(x, 0, bw, LED_H);
        ctx.fillStyle = "#1a1a1f";
        ctx.fillRect(x, top, bw, bh);
        const peak = r ? toDb(r.peak[ch]) : -Infinity;
        const rms = r ? toDb(r.rms[ch]) : -Infinity;
        if (peak > hold[ch] || now - holdAt[ch] > 1200) {
          hold[ch] = peak;
          holdAt[ch] = now;
        }
        const grad = ctx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, "#5fbf95");
        grad.addColorStop(toFrac(-12), "#a9e05a");
        grad.addColorStop(toFrac(-6), "#f5b544");
        grad.addColorStop(toFrac(-1), "#ff6b5e");
        const ph = toFrac(peak) * bh;
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = grad;
        ctx.fillRect(x, h - ph, bw, ph);
        ctx.globalAlpha = 1;
        const rh = toFrac(rms) * bh;
        ctx.fillRect(x, h - rh, bw, rh);
        if (hold[ch] > FLOOR_DB) {
          ctx.fillStyle = hold[ch] >= -0.1 ? "#ff6b5e" : "#ededf0";
          ctx.fillRect(x, h - toFrac(hold[ch]) * bh, bw, 1.5);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      canvas?.removeEventListener("pointerdown", reset);
    };
  }, []);
  return ref;
}

function Scale({ height }: { height: number }) {
  return (
    <div className="relative w-6 shrink-0" style={{ height }}>
      {[0, -6, -12, -18, -24, -36, -48].map((db) => (
        <span key={db} className="tc absolute right-0 -translate-y-1/2 text-[9px] text-fg-4" style={{ top: `calc(${LED_H + 2}px + (100% - ${LED_H + 2}px) * ${1 - toFrac(db)})` }}>
          {db}
        </span>
      ))}
    </div>
  );
}

/** Narrow master meter next to the timeline. */
export function Meters() {
  const ref = useMeter(() => engine.mixer.masterLevels());
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-center border-b border-line">
        <span className="panel-title">dB</span>
      </div>
      <div className="flex min-h-0 flex-1 gap-1 px-1.5 py-2">
        <canvas ref={ref} className="h-full min-w-0 flex-1" title={CLIP_HINT} />
      </div>
      <div className="tc flex h-5 shrink-0 justify-around text-[9px] text-fg-4">
        <span>L</span>
        <span>R</span>
      </div>
    </div>
  );
}

function Fader({ track, seqId }: { track: Track; seqId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<number | null>(null);
  const meter = useMeter(() => engine.mixer.trackLevels(track.id));
  const db = live ?? track.volumeDb;
  const MIN = -60;
  const MAX = 12;
  const frac = (Math.max(MIN, db) - MIN) / (MAX - MIN);
  const setAt = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    const f = 1 - Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    let v = MIN + f * (MAX - MIN);
    if (Math.abs(v) < 0.6) v = 0;
    v = Math.round(v * 10) / 10;
    setLive(v);
    engine.setTrackOverride(track.id, { volumeDb: v });
    return v;
  };
  const patch = async (p: Partial<Track>) => {
    await edit({ type: "updateTrack", sequence: seqId, track: track.id, patch: p });
    engine.setTrackOverride(track.id, null);
  };
  const fx = activeKinds(track.effects).length;
  return (
    <div className="flex w-[76px] shrink-0 flex-col items-center gap-2 rounded-md bg-raised px-2 py-2.5">
      <span className="w-full truncate text-center text-xs font-semibold text-fg-2">{track.name}</span>
      <div className="flex min-h-0 flex-1 gap-1.5">
        <div
          ref={ref}
          className="relative w-6 cursor-ns-resize"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setAt(e.clientY);
          }}
          onPointerMove={(e) => {
            if (live !== null) setAt(e.clientY);
          }}
          onPointerUp={() => {
            if (live !== null) void patch({ volumeDb: live });
            setLive(null);
          }}
          onDoubleClick={() => void patch({ volumeDb: 0 })}
        >
          <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-ground" />
          <div className="absolute left-0 right-0 h-px bg-fg-4" style={{ bottom: `${((0 - MIN) / (MAX - MIN)) * 100}%` }} />
          <div className="absolute left-1/2 h-4 w-6 -translate-x-1/2 translate-y-1/2 rounded-xs border border-line-strong bg-fg-2 shadow" style={{ bottom: `${frac * 100}%` }}>
            <div className="mx-auto mt-[7px] h-px w-4 bg-ground" />
          </div>
        </div>
        <canvas ref={meter} className="h-full w-3" title={CLIP_HINT} />
      </div>
      <span className="tc text-[10.5px] text-fg-2">{db <= -60 ? "−∞" : `${db > 0 ? "+" : ""}${db.toFixed(1).replace(".", ",")}`} dB</span>
      <div className="flex gap-1">
        <button onClick={() => void patch({ muted: !track.muted })} className={cx("h-5 w-6 rounded-xs text-[10px] font-semibold", track.muted ? "bg-warn text-black" : "bg-field text-fg-3 hover:text-fg-2")}>
          M
        </button>
        <button onClick={() => void patch({ solo: !track.solo })} className={cx("h-5 w-6 rounded-xs text-[10px] font-semibold", track.solo ? "bg-signal text-signal-ink" : "bg-field text-fg-3 hover:text-fg-2")}>
          S
        </button>
      </div>
      <div className="flex gap-1">
        <button
          title="Spur in Mono zusammenfassen (L+R)/2"
          aria-pressed={!!track.mono}
          onClick={() => void patch({ mono: !track.mono })}
          className={cx("h-5 w-8 rounded-xs text-[9.5px] font-semibold", track.mono ? "bg-signal text-signal-ink" : "bg-field text-fg-3 hover:text-fg-2")}
        >
          Mono
        </button>
        <button
          title="Spureffekte (nach der Summe der Clips, vor dem Regler)"
          onClick={() => useEditor.getState().set({ dialog: { kind: "trackEffects", sequence: seqId, track: track.id } })}
          className={cx("h-5 w-6 rounded-xs text-[10px] font-semibold", fx ? "bg-signal text-signal-ink" : "bg-field text-fg-3 hover:text-fg-2")}
        >
          FX
        </button>
      </div>
    </div>
  );
}

export function Mixer() {
  const seq = useActiveSequence();
  const master = useMeter(() => engine.mixer.masterLevels());
  const [height, setHeight] = useState(200);
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!seq) return null;
  const tracks = seq.tracks.filter((t) => t.kind === "audio");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Audio-Mixer" />
      <div ref={hostRef} className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-2">
        {tracks.map((t) => (
          <Fader key={t.id} track={t} seqId={seq.id} />
        ))}
        <div className="ml-auto flex w-[92px] shrink-0 flex-col items-center gap-2 rounded-md bg-raised px-2 py-2.5">
          <span className="text-xs font-semibold text-fg">Master</span>
          <div className="flex min-h-0 flex-1 gap-1">
            <Scale height={Math.max(60, height - 70)} />
            <canvas ref={master} className="h-full w-6" title={CLIP_HINT} />
          </div>
          <span className="text-[10.5px] text-fg-4">Peak / RMS</span>
        </div>
        <LoudnessPanel />
      </div>
    </div>
  );
}

const fmtLufs = (v: number | undefined) => (v === undefined || !isFinite(v) ? "—" : v.toFixed(1).replace(".", ",").replace("-", "−"));

/** EBU R128 loudness of the master (momentary, short-term, integrated since the reset). */
function LoudnessPanel() {
  const [r, setR] = useState<LoudnessReading | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => setR(engine.mixer.loudness), 200);
    return () => window.clearInterval(id);
  }, []);
  const row = (label: string, v: number | undefined, title: string) => (
    <div className="flex items-baseline justify-between gap-2" title={title}>
      <span className="text-[10.5px] text-fg-3">{label}</span>
      <span className="tc text-sm text-fg">{fmtLufs(v)}</span>
    </div>
  );
  return (
    <div className="flex w-[112px] shrink-0 flex-col gap-1.5 rounded-md bg-raised px-2.5 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-fg">LUFS</span>
        <IconButton
          icon={<RotateCcw size={11} />}
          size={20}
          label="Integrierte Lautheit zurücksetzen"
          onClick={() => {
            engine.mixer.resetLoudness();
            setR(null);
          }}
        />
      </div>
      {row("Momentan", r?.momentary, "Über 400 ms")}
      {row("Kurzzeit", r?.shortTerm, "Über 3 s")}
      {row("Integriert", r?.integrated, "Seit dem Zurücksetzen, mit Gating nach EBU R128")}
      <p className="mt-auto text-[10px] leading-snug text-fg-4">Misst die Vorschau am Master (nach Spur- und Clipeffekten).</p>
    </div>
  );
}
