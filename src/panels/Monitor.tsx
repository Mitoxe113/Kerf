import { useShallow } from "zustand/react/shallow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronFirst,
  ChevronLast,
  Expand,
  Grid2x2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { gotoEdit, setIn, setOut } from "../actions/editing";
import { usePlayhead, usePlaying, useRate } from "../engine/hooks";
import { corners, place, pointInPlacement, type Placement } from "../engine/math";
import { clipAt, engine, type PlaybackStats } from "../engine/playback";
import { animate, isAnimated, keysOf, playheadKeyPos, upsertKey } from "../lib/keys";
import { displaySize } from "../lib/media";
import { formatTimecode, parseTimecode } from "../lib/time";
import type { Clip, Sequence, Transform } from "../lib/types";
import { cancelPick, NO_GUIDES, useEditor, type Guides } from "../state/editor";
import { edit, useActiveSequence, useProject } from "../state/project";
import { cx, IconButton, openContextMenu, PanelHeader, Select, type MenuItem } from "../ui/primitives";

function TimecodeInput({ seq, frame }: { seq: Sequence; frame: number }) {
  const [text, setText] = useState<string | null>(null);
  const tc = formatTimecode(frame, seq.settings.fps);
  if (text !== null)
    return (
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => setText(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            const f = parseTimecode(text, seq.settings.fps, frame);
            if (f !== null) engine.seek(Math.max(0, f));
            setText(null);
          } else if (e.key === "Escape") setText(null);
        }}
        className="tc h-7 w-[120px] rounded-sm border border-signal bg-ground px-2 text-[15px] text-signal outline-none"
      />
    );
  return (
    <button title="Klicken, um einen Timecode einzugeben" onClick={() => setText(tc)} className="tc h-7 w-[120px] rounded-sm px-2 text-left text-[15px] text-signal hover:bg-hover">
      {tc}
    </button>
  );
}

/** The selected video clip under the playhead, for direct manipulation. */
function useActiveVisual(seq: Sequence | null, frame: number): Clip | null {
  const selection = useEditor((s) => s.selection);
  if (!seq) return null;
  for (let i = seq.tracks.length - 1; i >= 0; i--) {
    const t = seq.tracks[i];
    if (t.kind !== "video" || t.hidden || t.locked) continue;
    const c = clipAt(t, frame);
    if (c && selection.includes(c.id)) return c;
  }
  return null;
}

type Handle = "move" | "scale" | "rotate";

function Gizmo({ clip, seq, view, frame }: { clip: Clip; seq: Sequence; view: { x: number; y: number; s: number }; frame: number }) {
  const media = useProject((s) => s.mediaById.get(clip.mediaId));
  const [live, setLive] = useState<Transform | null>(null);
  const dims = engine.sourceSize(clip.id) ?? displaySize(media);
  useEffect(() => setLive(null), [clip.transform, clip.keys]);
  if (!dims) return null;
  // Animated clips show (and edit) their placement at the playhead.
  const current = animate(clip, frame).transform;
  const t = live ?? current;
  const { width: W, height: H } = seq.settings;
  const p = place(t, dims[0], dims[1], W, H);
  const toScreen = ([x, y]: [number, number]) => [view.x + x * view.s, view.y + y * view.s];
  const pts = corners(p).map(toScreen);
  const [cx, cy] = toScreen([p.cx, p.cy]);
  const top = toScreen([
    p.cx + Math.sin(p.theta) * (p.height / 2 + 28 / view.s),
    p.cy - Math.cos(p.theta) * (p.height / 2 + 28 / view.s),
  ]);

  const begin = (e: React.PointerEvent, handle: Handle) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = { clientX: e.clientX, clientY: e.clientY };
    const t0 = current;
    const at = playheadKeyPos(clip, frame);
    // Animated properties get a key at the playhead, the others change their static value.
    const split = (n: Transform) => {
      const keys = { ...clip.keys };
      let transform = clip.transform;
      for (const p of ["x", "y", "scale", "rotation"] as const) {
        if (n[p] === t0[p]) continue;
        if (isAnimated(clip, p)) keys[p] = upsertKey(keysOf(clip, p), at, n[p]);
        else transform = { ...transform, [p]: n[p] };
      }
      return { keys, transform };
    };
    const host = (e.currentTarget as Element).closest("[data-monitor]")!.getBoundingClientRect();
    const local = (ev: { clientX: number; clientY: number }) => [(ev.clientX - host.left - view.x) / view.s, (ev.clientY - host.top - view.y) / view.s];
    const [sx, sy] = local(start);
    const d0 = Math.hypot(sx - p.cx, sy - p.cy) || 1;
    const a0 = Math.atan2(sy - p.cy, sx - p.cx);
    let next = t0;
    const move = (ev: PointerEvent) => {
      const [x, y] = local(ev);
      if (handle === "move") next = { ...t0, x: Math.round(t0.x + (x - sx)), y: Math.round(t0.y + (y - sy)) };
      else if (handle === "scale") next = { ...t0, scale: Math.max(0.01, +(t0.scale * (Math.hypot(x - p.cx, y - p.cy) / d0)).toFixed(4)) };
      else {
        let deg = t0.rotation + ((Math.atan2(y - p.cy, x - p.cx) - a0) * 180) / Math.PI;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        next = { ...t0, rotation: +deg.toFixed(2) };
      }
      setLive(next);
      engine.setOverride(clip.id, split(next));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (next !== t0) {
        const { keys, transform } = split(next);
        void (async () => {
          if (transform !== clip.transform) await edit({ type: "updateClips", sequence: seq.id, clips: [clip.id], patch: { transform } });
          for (const p of ["x", "y", "scale", "rotation"] as const)
            if (keys[p] !== clip.keys[p]) await edit({ type: "setKeyframes", sequence: seq.id, clip: clip.id, param: p, keys: keys[p] ?? [] });
          engine.setOverride(clip.id, null);
        })();
      } else engine.setOverride(clip.id, null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      <polygon points={pts.map((q) => q.join(",")).join(" ")} fill="transparent" stroke="var(--color-signal)" strokeWidth={1.25} className="pointer-events-auto cursor-move" onPointerDown={(e) => begin(e, "move")} />
      <line x1={(pts[0][0] + pts[1][0]) / 2} y1={(pts[0][1] + pts[1][1]) / 2} x2={top[0]} y2={top[1]} stroke="var(--color-signal)" strokeWidth={1} />
      <circle cx={top[0]} cy={top[1]} r={5} fill="var(--color-panel)" stroke="var(--color-signal)" strokeWidth={1.5} className="pointer-events-auto cursor-grab" onPointerDown={(e) => begin(e, "rotate")} />
      {pts.map(([x, y], i) => (
        <rect key={i} x={x - 4} y={y - 4} width={8} height={8} fill="var(--color-panel)" stroke="var(--color-signal)" strokeWidth={1.5} className="pointer-events-auto cursor-nwse-resize" onPointerDown={(e) => begin(e, "scale")} />
      ))}
      <circle cx={cx} cy={cy} r={3} fill="var(--color-signal)" />
    </svg>
  );
}

const ASPECTS: { value: number; label: string }[] = [
  { value: 2.39, label: "2,39:1 (Kino)" },
  { value: 1.85, label: "1,85:1" },
  { value: 16 / 9, label: "16:9" },
  { value: 4 / 5, label: "4:5 (Instagram)" },
  { value: 1, label: "1:1" },
  { value: 9 / 16, label: "9:16 (Hochformat)" },
];

function guideMenu(g: Guides): MenuItem[] {
  const set = (patch: Partial<Guides>) => useEditor.getState().set({ guides: { ...useEditor.getState().guides, ...patch } });
  const any = g.safe || g.thirds || g.center || g.aspect !== null || g.stats;
  return [
    { label: "Sichere Bereiche (90 % / 80 %)", shortcut: "Strg+'", checked: g.safe, onSelect: () => set({ safe: !g.safe }) },
    { label: "Drittel-Raster", checked: g.thirds, onSelect: () => set({ thirds: !g.thirds }) },
    { label: "Mittelkreuz", checked: g.center, onSelect: () => set({ center: !g.center }) },
    {
      label: "Seitenverhältnis-Maske",
      submenu: [
        { label: "Keine", checked: g.aspect === null, onSelect: () => set({ aspect: null }) },
        { separator: true },
        ...ASPECTS.map((a) => ({ label: a.label, checked: g.aspect !== null && Math.abs(g.aspect - a.value) < 1e-3, onSelect: () => set({ aspect: a.value }) })),
      ],
    },
    { separator: true },
    { label: "Wiedergabe-Statistik", checked: g.stats, onSelect: () => set({ stats: !g.stats }) },
    { separator: true },
    { label: "Alle ausblenden", disabled: !any, onSelect: () => useEditor.getState().set({ guides: NO_GUIDES }) },
  ];
}

/** Guides drawn over the picture, in monitor pixels. */
function GuideLayer({ g, w, h, aspect }: { g: Guides; w: number; h: number; aspect: number }) {
  // The part of the frame the target aspect keeps; the rest is masked.
  let box = { x: 0, y: 0, w, h };
  if (g.aspect !== null && g.aspect > aspect + 1e-3) box = { x: 0, y: (h - w / g.aspect) / 2, w, h: w / g.aspect };
  else if (g.aspect !== null && g.aspect < aspect - 1e-3) box = { x: (w - h * g.aspect) / 2, y: 0, w: h * g.aspect, h };
  const masked = box.w < w - 0.5 || box.h < h - 0.5;
  const inset = (f: number) => ({ x: box.x + (box.w * (1 - f)) / 2, y: box.y + (box.h * (1 - f)) / 2, width: box.w * f, height: box.h * f });
  const mx = box.x + box.w / 2;
  const my = box.y + box.h / 2;
  return (
    <svg className="pointer-events-none absolute inset-0" width={w} height={h}>
      {masked && (
        <>
          <path fill="rgb(0 0 0 / 0.62)" fillRule="evenodd" d={`M0 0H${w}V${h}H0Z M${box.x} ${box.y}h${box.w}v${box.h}h${-box.w}Z`} />
          <rect x={box.x + 0.5} y={box.y + 0.5} width={box.w - 1} height={box.h - 1} fill="none" stroke="rgb(200 245 66 / 0.6)" />
        </>
      )}
      {g.safe && (
        <>
          <rect {...inset(0.9)} fill="none" stroke="rgb(255 255 255 / 0.35)" strokeDasharray="4 4" />
          <rect {...inset(0.8)} fill="none" stroke="rgb(255 255 255 / 0.25)" strokeDasharray="2 4" />
        </>
      )}
      {g.thirds &&
        [1, 2].map((i) => (
          <g key={i} stroke="rgb(255 255 255 / 0.3)">
            <line x1={box.x + (box.w * i) / 3} y1={box.y} x2={box.x + (box.w * i) / 3} y2={box.y + box.h} />
            <line x1={box.x} y1={box.y + (box.h * i) / 3} x2={box.x + box.w} y2={box.y + (box.h * i) / 3} />
          </g>
        ))}
      {(g.center || g.safe) && (
        <g stroke="rgb(255 255 255 / 0.45)">
          <line x1={mx - 10} y1={my} x2={mx + 10} y2={my} />
          <line x1={mx} y1={my - 10} x2={mx} y2={my + 10} />
        </g>
      )}
    </svg>
  );
}

/** Polls the engine while playing; keeps the last playback's numbers after it stops. */
function usePlaybackStats(playing: boolean): PlaybackStats | null {
  const [st, setSt] = useState<PlaybackStats | null>(null);
  useEffect(() => {
    if (!playing) {
      setSt((prev) => (prev ? { ...engine.stats(), fps: 0 } : prev));
      return;
    }
    setSt(engine.stats());
    const id = setInterval(() => setSt(engine.stats()), 250);
    return () => clearInterval(id);
  }, [playing]);
  return st;
}

const fmtFps = (v: number) => v.toFixed(Number.isInteger(v) ? 0 : 2).replace(".", ",");

export function Monitor() {
  const seq = useActiveSequence();
  const frame = usePlayhead();
  const playing = usePlaying();
  const rate = useRate();
  const ed = useEditor(
    useShallow((s) => ({ fullscreen: s.fullscreen, monitorZoom: s.monitorZoom, quality: s.quality, guides: s.guides, select: s.select, set: s.set, picking: s.picker !== null })),
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, w: 0, h: 0, s: 1, W: 800 });
  const [loop, setLoop] = useState(engine.loop);
  const active = useActiveVisual(seq, frame);
  useEffect(() => {
    if (!ed.picking) return;
    // Escape cancels the eyedropper before any other shortcut sees the key.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      cancelPick();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ed.picking]);
  const pending = useProject((s) => {
    const sq = seq;
    if (!sq) return false;
    return sq.tracks.some((t) => {
      const c = clipAt(t, frame);
      const m = c && s.mediaById.get(c.mediaId);
      return !!m && m.status.state === "ready" && !m.derived.previewNative && !m.derived.proxy && m.kind !== "audio" && !m.title;
    });
  });
  const proxyJobs = useProject((s) => s.proxyJobs);
  const stats = usePlaybackStats(playing);
  const dropped = stats ? stats.skipped + stats.decoder : 0;
  const g = ed.guides;
  const anyGuide = g.safe || g.thirds || g.center || g.aspect !== null || g.stats;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    engine.attach(c);
    return () => engine.detach(c);
  }, []);

  // Fit the sequence frame into the panel (or show at a fixed zoom).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !seq) return;
    const fit = () => {
      const W = host.clientWidth;
      const H = host.clientHeight;
      const { width, height } = seq.settings;
      const s = ed.monitorZoom === "fit" ? Math.min((W - 16) / width, (H - 16) / height) : ed.monitorZoom;
      const w = width * s;
      const h = height * s;
      setView({ x: (W - w) / 2, y: (H - h) / 2, w, h, s, W });
      const c = canvasRef.current!;
      // Never render more pixels than the sequence has or the screen shows.
      const scale = Math.min(1, s * (window.devicePixelRatio || 1)) * ed.quality;
      c.width = Math.max(2, Math.round(width * scale));
      c.height = Math.max(2, Math.round(height * scale));
      engine.requestRender();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [seq?.settings.width, seq?.settings.height, ed.monitorZoom, ed.quality, seq]);

  const duration = engine.duration;
  const toggleFullscreen = async () => {
    const on = !ed.fullscreen;
    ed.set({ fullscreen: on });
    await getCurrentWindow().setFullscreen(on).catch(() => undefined);
  };

  if (!seq) return null;
  // Narrow panels drop the secondary transport buttons.
  const compact = view.W < 470;
  const fps = seq.settings.fps;
  const inP = seq.inPoint;
  const outP = seq.outPoint;

  return (
    <div className={cx("flex min-h-0 flex-1 flex-col", ed.fullscreen && "fixed inset-0 z-[700] bg-black")}>
      {!ed.fullscreen && (
        <PanelHeader title={<span>Programm · <span className="normal-case tracking-normal text-fg-2">{seq.name}</span></span>}>
          <Select
            label="Zoom"
            width={92}
            value={ed.monitorZoom === "fit" ? "fit" : String(ed.monitorZoom)}
            onChange={(v) => ed.set({ monitorZoom: v === "fit" ? "fit" : Number(v) })}
            options={[
              { value: "fit", label: "Einpassen" },
              { value: "0.25", label: "25 %" },
              { value: "0.5", label: "50 %" },
              { value: "1", label: "100 %" },
            ]}
          />
          <Select
            label="Vorschauqualität"
            width={70}
            value={String(ed.quality)}
            onChange={(v) => ed.set({ quality: Number(v) })}
            options={[
              { value: "1", label: "Voll" },
              { value: "0.5", label: "½" },
              { value: "0.25", label: "¼" },
            ]}
          />
          <IconButton
            icon={<Grid2x2 size={14} />}
            label="Überlagerungen"
            active={anyGuide}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openContextMenu({ clientX: r.left, clientY: r.bottom + 4 }, guideMenu(g));
            }}
          />
          <IconButton icon={<Expand size={14} />} label="Vollbild" shortcut="⇧+F" onClick={() => void toggleFullscreen()} />
        </PanelHeader>
      )}
      <div
        ref={hostRef}
        data-monitor
        className={cx("relative min-h-0 flex-1 overflow-hidden bg-[#08080a]", ed.picking && "cursor-crosshair")}
        onPointerDown={(e) => {
          const pick = useEditor.getState().picker;
          if (pick) {
            // Eyedropper: sample the composited picture under the pointer.
            const c = canvasRef.current!.getBoundingClientRect();
            const rgb = e.button === 0 ? engine.pickColor((e.clientX - c.left) / c.width, (e.clientY - c.top) / c.height) : null;
            useEditor.getState().set({ picker: null });
            pick(rgb);
            return;
          }
          // Click on the picture selects the topmost clip there.
          if (!seq || e.button !== 0) return;
          const r = e.currentTarget.getBoundingClientRect();
          const x = (e.clientX - r.left - view.x) / view.s;
          const y = (e.clientY - r.top - view.y) / view.s;
          for (let i = seq.tracks.length - 1; i >= 0; i--) {
            const t = seq.tracks[i];
            if (t.kind !== "video" || t.hidden) continue;
            const c = clipAt(t, frame);
            if (!c) continue;
            const dims = engine.sourceSize(c.id);
            if (!dims) continue;
            const p: Placement = place(animate(c, frame).transform, dims[0], dims[1], seq.settings.width, seq.settings.height);
            if (pointInPlacement(p, x, y)) {
              ed.select([c.id]);
              return;
            }
          }
          ed.select([]);
        }}
        onDoubleClick={() => ed.fullscreen && void toggleFullscreen()}
      >
        <canvas ref={canvasRef} className="absolute" style={{ left: view.x, top: view.y, width: view.w, height: view.h }} />
        {(g.safe || g.thirds || g.center || g.aspect !== null) && view.w > 0 && (
          <div className="pointer-events-none absolute" style={{ left: view.x, top: view.y, width: view.w, height: view.h }}>
            <GuideLayer g={g} w={view.w} h={view.h} aspect={seq.settings.width / seq.settings.height} />
          </div>
        )}
        {g.stats && (
          <div className="tc pointer-events-none absolute bottom-3 left-3 space-y-0.5 rounded-sm bg-black/75 px-2 py-1 text-[11px] leading-4 text-fg-2">
            <div>
              <span className={cx(stats && playing && stats.fps < stats.target * 0.9 ? "text-warn" : "text-fg")}>{playing && stats ? fmtFps(stats.fps) : "–"}</span> / {fmtFps(engine.fps * (playing ? Math.abs(rate) || 1 : 1))} fps
            </div>
            <div className={cx(dropped > 0 && "text-warn")}>
              {dropped} verworfen{stats && stats.decoder > 0 ? ` (Decoder ${stats.decoder})` : ""}
            </div>
            <div className="text-fg-4">
              {seq.settings.width}×{seq.settings.height} · Vorschau {Math.round(ed.quality * 100)} %
            </div>
          </div>
        )}
        {active && !playing && !ed.picking && (
          <div className="absolute inset-0">
            <Gizmo clip={active} seq={seq} view={view} frame={frame} />
          </div>
        )}
        {duration === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
            <span className="text-sm text-fg-3">Die Sequenz ist leer</span>
            <span className="text-xs text-fg-4">Medien aus dem Browser in die Timeline ziehen</span>
          </div>
        )}
        {pending && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-sm bg-black/70 px-2 py-1 text-xs text-warn">
            Proxy wird erstellt {Object.keys(proxyJobs).length > 0 && `· ${Math.round(Math.max(...Object.values(proxyJobs)) * 100)} %`}
          </div>
        )}
        {rate !== 0 && rate !== 1 && (
          <div className="tc pointer-events-none absolute right-3 top-3 rounded-sm bg-black/70 px-2 py-0.5 text-xs text-signal">
            {rate > 0 ? "▶" : "◀"} {Math.abs(rate)}×
          </div>
        )}
      </div>

      {/* Mini scrubber */}
      <div
        className="relative h-2.5 shrink-0 cursor-pointer bg-ground"
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const seekAt = (x: number) => {
            const r = el.getBoundingClientRect();
            engine.seek(((x - r.left) / r.width) * Math.max(1, duration));
          };
          seekAt(e.clientX);
          const move = (ev: PointerEvent) => seekAt(ev.clientX);
          const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
          };
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
        }}
      >
        {(inP !== null || outP !== null) && duration > 0 && (
          <div
            className="absolute inset-y-0 bg-signal/20"
            style={{ left: `${((inP ?? 0) / duration) * 100}%`, width: `${(((outP ?? duration) - (inP ?? 0)) / duration) * 100}%` }}
          />
        )}
        <div className="absolute inset-y-0 w-0.5 bg-signal" style={{ left: `${duration ? Math.min(100, (frame / duration) * 100) : 0}%` }} />
      </div>

      <div className="flex h-10 shrink-0 items-center gap-2 border-t border-line px-2">
        <TimecodeInput seq={seq} frame={frame} />
        <div className="flex flex-1 items-center justify-center gap-0.5">
          <IconButton icon={<span className="tc text-[11px] font-semibold">{"{"}</span>} label="In-Point setzen" shortcut="I" onClick={() => void setIn()} />
          {!compact && <IconButton icon={<ChevronFirst size={16} />} label="Zum Anfang" shortcut="Pos1" onClick={() => { engine.pause(); engine.seek(0); }} />}
          {!compact && <IconButton icon={<SkipBack size={15} />} label="Vorheriger Schnittpunkt" shortcut="↑" onClick={() => gotoEdit(-1)} />}
          <IconButton icon={<StepBack size={15} />} label="1 Frame zurück" shortcut="←" onClick={() => engine.step(-1)} />
          <button
            aria-label={playing ? "Pause" : "Wiedergabe"}
            onClick={() => engine.toggle()}
            className="mx-1 flex h-8 w-8 items-center justify-center rounded-full bg-fg text-ground transition-transform hover:scale-105 active:scale-95"
          >
            {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="translate-x-px" />}
          </button>
          <IconButton icon={<StepForward size={15} />} label="1 Frame vor" shortcut="→" onClick={() => engine.step(1)} />
          {!compact && <IconButton icon={<SkipForward size={15} />} label="Nächster Schnittpunkt" shortcut="↓" onClick={() => gotoEdit(1)} />}
          {!compact && <IconButton icon={<ChevronLast size={16} />} label="Zum Ende" shortcut="Ende" onClick={() => { engine.pause(); engine.seek(Math.max(0, duration - 1)); }} />}
          <IconButton icon={<span className="tc text-[11px] font-semibold">{"}"}</span>} label="Out-Point setzen" shortcut="O" onClick={() => void setOut()} />
          <IconButton
            icon={<Repeat size={14} />}
            label="Endlosschleife"
            active={loop}
            onClick={() => {
              engine.loop = !engine.loop;
              setLoop(engine.loop);
            }}
          />
        </div>
        {stats && (playing || dropped > 0) && (
          <span
            className={cx("h-2 w-2 shrink-0 rounded-full", dropped > 0 ? "bg-warn" : "bg-signal")}
            title={
              dropped > 0
                ? `${dropped} Frame${dropped === 1 ? "" : "s"} ${playing ? "bisher" : "bei der letzten Wiedergabe"} verworfen – Vorschauqualität senken oder Proxys verwenden`
                : "Wiedergabe ohne verworfene Frames"
            }
          />
        )}
        {view.W >= 600 && (
          <span className="tc w-[120px] text-right text-[13px] text-fg-3" title="Dauer der Sequenz">
            {formatTimecode(duration, fps)}
          </span>
        )}
      </div>
    </div>
  );
}
