import { useShallow } from "zustand/react/shallow";
import { Eye, EyeOff, Lock, Magnet, Plus, Unlock, Link2, Film, Music } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAX_ZOOM, MIN_ZOOM, placeMedia, selectClips, setTimelineViewport, zoomBy, copySelection, deleteSelection, paste, toggleEnabled, linkSelection, applyFades, addTrack, renameSelection, labelSelection, replaceClipMedia, revealInProject, freezeFrame, openNormalize, selectedAudioClips } from "../actions/editing";
import { LABEL_NAMES, LABELS, labelColor } from "../lib/labels";
import { TOOLS } from "../actions/registry";
import { formatCombo, keysFor } from "../actions/keymap";
import { engine, sequenceDuration } from "../engine/playback";
import { formatTimecode, fpsOf } from "../lib/time";
import type { Clip, MarkerColor, Sequence, Track, Uuid } from "../lib/types";
import { useEditor, type ToolId } from "../state/editor";
import { edit, useActiveSequence, useProject } from "../state/project";
import { api } from "../lib/ipc";
import {
  clampRoll,
  clampSlide,
  clampSlip,
  clampTrim,
  EDGE_PX,
  expandLinks,
  HEADER_W,
  kindPosition,
  layoutTracks,
  mediaLength,
  RULER_H,
  rowAt,
  snap,
  snapTargets,
  tracksOfKind,
  type TrackLayout,
  type TrackRow,
} from "../timeline/geometry";
import { COLORS, drawRuler, drawTracks, type View } from "../timeline/render";
import { mediaDragRange, registerDropTarget } from "../ui/dnd";
import { cx, IconButton, openContextMenu, PanelHeader, Tooltip, type MenuItem } from "../ui/primitives";

const SNAP_PX = 9;

/** Shows source frame `sourceFrame` of `clip` in the monitor during trims. */
function showSourceFrame(clip: Clip, sourceFrame: number) {
  engine.setOverride(clip.id, { sourceIn: Math.max(0, sourceFrame) });
  engine.setPreviewFrame(clip.start);
}

type Drag =
  | { kind: "scrub"; snapAt: number | null }
  | { kind: "marker"; id: Uuid; frame0: number; x0: number; delta: number }
  | { kind: "move"; ids: Uuid[]; anchor: Clip; anchorTrack: number; x0: number; y0: number; delta: number; trackDelta: number; snapAt: number | null; moved: boolean }
  | { kind: "trim"; clip: Clip; track: number; ci: number; edge: "start" | "end"; ripple: boolean; x0: number; delta: number; snapAt: number | null }
  | { kind: "roll"; clip: Clip; track: number; ci: number; x0: number; delta: number; snapAt: number | null }
  | { kind: "slip"; clip: Clip; track: number; ci: number; x0: number; delta: number }
  | { kind: "slide"; clip: Clip; track: number; ci: number; x0: number; delta: number; snapAt: number | null }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: "hand"; x0: number; y0: number; sx: number; sy: number }
  | { kind: "drop"; media: Uuid[]; frame: number; video: TrackRow | null; audio: TrackRow | null; length: number; hasVideo: boolean; hasAudio: boolean; insert: boolean; snapAt: number | null };

const EDGE_SCROLL_PX = 28;

interface Hit {
  row: TrackRow;
  clip: Clip;
  ci: number;
  zone: "start" | "end" | "body";
}

const TOOL_ICONS: Record<ToolId, React.ReactNode> = {
  select: <svg viewBox="0 0 16 16" width="15" height="15"><path d="M4 2.5 12.5 9l-4 .6 2.2 4.2-1.6.8-2.2-4.2L4 13z" fill="currentColor" /></svg>,
  razor: <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 1.5v13" strokeDasharray="2 1.6" /><path d="M4.5 4 8 7.5 11.5 4" /></svg>,
  ripple: <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M6 3v10M6 8h8M11 5.5 13.5 8 11 10.5" /><path d="M2 5v6" /></svg>,
  roll: <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 3v10M2 8h4M10 8h4M4 6 2 8l2 2M12 6l2 2-2 2" /></svg>,
  slip: <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3" y="4" width="10" height="8" rx="1" /><path d="M5.5 8h5M7 6.5 5.5 8 7 9.5M9 6.5 10.5 8 9 9.5" /></svg>,
  slide: <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1.5 5v6M14.5 5v6" /><rect x="5" y="5" width="6" height="6" rx="1" /><path d="M2.5 8h2M11.5 8h2" /></svg>,
  hand: <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M5.5 8V3.8a1 1 0 0 1 2 0V7m0-3.7V2.8a1 1 0 0 1 2 0V7m0-3a1 1 0 0 1 2 0v4.5m-6-1L4.6 6.6a1 1 0 0 0-1.5 1.3l2.6 4c.8 1.3 1.9 2.1 3.6 2.1h.2a3.5 3.5 0 0 0 3.5-3.5V5.5a1 1 0 0 0-1.5-.9" /></svg>,
  zoom: <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5M5 7h4M7 5v4" /></svg>,
};

const MARKER_COLORS: { value: MarkerColor; label: string }[] = [
  { value: "signal", label: "Signal" },
  { value: "red", label: "Rot" },
  { value: "amber", label: "Bernstein" },
  { value: "blue", label: "Blau" },
  { value: "violet", label: "Violett" },
];

function SequenceTabs() {
  const project = useProject((s) => s.project);
  const set = useEditor((s) => s.set);
  if (!project) return null;
  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
      {project.sequences.map((s) => (
        <button
          key={s.id}
          onClick={() => {
            if (s.id === project.activeSequence) return;
            void api.setActiveSequence(s.id).then(() => {
              useProject.getState().setActiveSequence(s.id);
              set({ selection: [], scrollX: 0 });
            });
          }}
          onContextMenu={(e) =>
            openContextMenu(e, [
              { label: "Sequenzeinstellungen …", onSelect: () => set({ dialog: { kind: "sequenceSettings", sequence: s.id } }) },
              { label: "Löschen", danger: true, disabled: project.sequences.length < 2, onSelect: () => void edit({ type: "removeSequence", sequence: s.id }) },
            ])
          }
          className={cx(
            "h-6 max-w-40 truncate rounded-sm px-2 text-xs transition-colors",
            s.id === project.activeSequence ? "bg-hover text-fg" : "text-fg-3 hover:text-fg-2",
          )}
        >
          {s.name}
        </button>
      ))}
      <IconButton icon={<Plus size={13} />} size={24} label="Neue Sequenz" onClick={() => set({ dialog: { kind: "newSequence" } })} />
    </div>
  );
}

function ZoomSlider() {
  const zoom = useEditor((s) => s.zoom);
  const ref = useRef<HTMLDivElement>(null);
  const toT = (z: number) => Math.log(z / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM);
  const fromT = (t: number) => MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, t);
  const setAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    zoomBy(fromT(t) / useEditor.getState().zoom);
  };
  return (
    <Tooltip text="Zoom (Strg+Mausrad)">
      <div
        ref={ref}
        className="relative h-5 w-24 cursor-pointer"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setAt(e.clientX);
        }}
        onPointerMove={(e) => e.buttons & 1 && setAt(e.clientX)}
      >
        <div className="absolute top-1/2 h-[3px] w-full -translate-y-1/2 rounded-full bg-press" />
        <div className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg-2" style={{ left: `${toT(zoom) * 100}%` }} />
      </div>
    </Tooltip>
  );
}

function TrackHeader({ row, seq }: { row: TrackRow; seq: Sequence }) {
  const t = row.track;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(t.name);
  const patch = (p: Partial<Track>) => void edit({ type: "updateTrack", sequence: seq.id, track: t.id, patch: p });
  const flag = (on: boolean, label: string, onClick: () => void, children: React.ReactNode, tone: "signal" | "warn" | "danger" = "signal") => (
    <Tooltip text={label}>
      <button
        aria-label={label}
        aria-pressed={on}
        onClick={onClick}
        className={cx(
          "flex h-5 min-w-5 items-center justify-center rounded-xs px-1 text-[10px] font-semibold transition-colors",
          on
            ? tone === "warn"
              ? "bg-warn text-black"
              : tone === "danger"
                ? "bg-danger text-white"
                : "bg-signal text-signal-ink"
            : "bg-field text-fg-3 hover:bg-hover hover:text-fg-2",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
  // Dragging the bottom edge previews the height in the layout; the edit is committed on release.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = row.h;
    let h = h0;
    const move = (ev: PointerEvent) => {
      h = Math.max(24, Math.min(320, Math.round(h0 + ev.clientY - y0)));
      useEditor.getState().set({ trackResize: { track: t.id, h } });
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (h !== h0) await edit({ type: "updateTrack", sequence: seq.id, track: t.id, patch: { height: h } });
      useEditor.getState().set({ trackResize: null });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const heights: [string, number][] = [["Standard", 0], ["Klein", 40], ["Mittel", 64], ["Groß", 96], ["Sehr groß", 144]];
  return (
    <div
      className="relative flex items-center gap-1.5 border-b border-[#1c1c22] pl-2.5 pr-1.5"
      style={{ height: row.h, background: t.kind === "video" ? "#141418" : "#121517" }}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: "Umbenennen", onSelect: () => setRenaming(true) },
          { label: "Farbe", submenu: LABELS.map((l) => ({ label: LABEL_NAMES[l], checked: t.color === l, onSelect: () => patch({ color: l }) })) },
          { label: "Höhe", submenu: heights.map(([label, h]) => ({ label, checked: t.height === h, onSelect: () => patch({ height: h }) })) },
          { separator: true },
          { label: t.kind === "video" ? "Videospur hinzufügen" : "Audiospur hinzufügen", onSelect: () => void addTrack(t.kind) },
          { separator: true },
          { label: "Spur löschen", danger: true, onSelect: () => void edit({ type: "removeTrack", sequence: seq.id, track: t.id }) },
        ])
      }
    >
      <span className="flex h-5 w-1 shrink-0 rounded-full" style={{ background: labelColor(t.color) ?? (t.kind === "video" ? "#4a5d80" : "#3f7a72") }} />
      <div className="absolute inset-x-0 -bottom-px h-1.5 cursor-row-resize hover:bg-signal/40" onPointerDown={startResize} title="Spurhöhe ziehen" />
      {renaming ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            setRenaming(false);
            if (name.trim() && name !== t.name) patch({ name });
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setName(t.name);
              setRenaming(false);
            }
          }}
          className="w-14 rounded-xs border border-signal bg-ground px-1 text-xs outline-none"
        />
      ) : (
        <span className="w-14 truncate text-xs font-semibold text-fg-2" onDoubleClick={() => setRenaming(true)}>
          {t.name}
        </span>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        {t.kind === "video"
          ? flag(t.hidden, t.hidden ? "Spur einblenden" : "Spur ausblenden", () => patch({ hidden: !t.hidden }), t.hidden ? <EyeOff size={11} /> : <Eye size={11} />, "warn")
          : (
            <>
              {flag(t.muted, "Stumm", () => patch({ muted: !t.muted }), "M", "warn")}
              {flag(t.solo, "Solo", () => patch({ solo: !t.solo }), "S")}
            </>
          )}
        {flag(t.locked, t.locked ? "Entsperren" : "Sperren", () => patch({ locked: !t.locked }), t.locked ? <Lock size={10} /> : <Unlock size={10} />, "danger")}
      </div>
    </div>
  );
}

export function Timeline() {
  const seq = useActiveSequence();
  const mediaById = useProject((s) => s.mediaById);
  const ed = useEditor(
    useShallow((s) => ({
      clipboard: s.clipboard,
      linkedSelection: s.linkedSelection,
      scrollX: s.scrollX,
      scrollY: s.scrollY,
      select: s.select,
      selection: s.selection,
      set: s.set,
      setTool: s.setTool,
      snapping: s.snapping,
      tool: s.tool,
      trackSize: s.trackSize,
      zoom: s.zoom,
    })),
  );
  const areaRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const moveRef = useRef<(e: React.PointerEvent) => void>(() => undefined);
  // Alt during a trim/roll edits only the dragged track (J/L cut); the overlay says so.
  const altRef = useRef(false);
  const edgeScroll = useRef<{ speed: number; ev: React.PointerEvent; raf: number } | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 300 });
  const [markerEdit, setMarkerEdit] = useState<{ id: Uuid; x: number; name: string } | null>(null);
  const drawQueued = useRef(false);

  const trackResize = useEditor((s) => s.trackResize);
  const layout: TrackLayout | null = useMemo(() => (seq ? layoutTracks(seq, ed.trackSize, trackResize) : null), [seq, ed.trackSize, trackResize]);
  const selection = useMemo(() => new Set(ed.selection), [ed.selection]);
  const maxScrollY = layout ? Math.max(0, layout.height - (size.h - RULER_H) + 24) : 0;
  const scrollY = Math.min(ed.scrollY, maxScrollY);
  const view: View = { width: size.w, height: size.h, zoom: ed.zoom, scrollX: ed.scrollX, scrollY };
  const viewRef = useRef(view);
  viewRef.current = view;

  // --- sizing ---------------------------------------------------------------------
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      setTimelineViewport(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- drawing -------------------------------------------------------------------------
  const drawBase = useCallback(() => {
    const c = baseRef.current;
    if (!c || !seq || !layout) return;
    const dpr = window.devicePixelRatio || 1;
    const v = viewRef.current;
    if (c.width !== Math.round(v.width * dpr) || c.height !== Math.round(v.height * dpr)) {
      c.width = Math.round(v.width * dpr);
      c.height = Math.round(v.height * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.width, v.height);
    drawTracks(ctx, layout, v, { seq, media: mediaById, selection, redraw: () => requestBase() });
    drawRuler(ctx, seq, v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, layout, mediaById, selection]);

  // The queued frame must draw the latest state, not the closure that queued it.
  const drawBaseRef = useRef(drawBase);
  drawBaseRef.current = drawBase;
  const requestBase = useCallback(() => {
    if (drawQueued.current) return;
    drawQueued.current = true;
    requestAnimationFrame(() => {
      drawQueued.current = false;
      drawBaseRef.current();
    });
  }, []);

  const drawOverlay = useCallback(() => {
    const linkHint = (c: Clip) => (!c.link ? "" : altRef.current ? " · nur diese Spur (J/L-Schnitt)" : " · Alt: nur diese Spur");
    const c = overRef.current;
    if (!c || !seq || !layout) return;
    const dpr = window.devicePixelRatio || 1;
    const v = viewRef.current;
    if (c.width !== Math.round(v.width * dpr) || c.height !== Math.round(v.height * dpr)) {
      c.width = Math.round(v.width * dpr);
      c.height = Math.round(v.height * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.width, v.height);
    const top = RULER_H - v.scrollY;
    const fx = (f: number) => f * v.zoom - v.scrollX;
    const d = dragRef.current;
    const ghost = (x: number, y: number, w: number, h: number, solid = false) => {
      ctx.fillStyle = solid ? "rgba(200,245,66,0.22)" : "rgba(200,245,66,0.12)";
      ctx.fillRect(x, y + 1, w, h - 3);
      ctx.strokeStyle = COLORS.signal;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(solid ? [] : [4, 3]);
      ctx.strokeRect(x + 0.75, y + 1.75, Math.max(1, w - 1.5), h - 4.5);
      ctx.setLineDash([]);
    };
    const rowOf = (trackIndex: number) => layout.rows.find((r) => r.index === trackIndex);
    let label: string | null = null;
    let snapAt: number | null = null;
    if (d) {
      if (d.kind === "move" && d.moved) {
        for (const id of d.ids) {
          const ti = seq.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
          if (ti < 0) continue;
          const c = seq.tracks[ti].clips.find((x) => x.id === id)!;
          let target = ti;
          if (seq.tracks[ti].kind === seq.tracks[d.anchorTrack].kind && d.trackDelta) {
            const of = tracksOfKind(seq, seq.tracks[ti].kind);
            target = of[of.indexOf(ti) + d.trackDelta] ?? ti;
          }
          const r = rowOf(target);
          if (r) ghost(fx(c.start + d.delta), top + r.y, c.duration * v.zoom, r.h);
        }
        label = `${d.delta >= 0 ? "+" : "−"}${formatTimecode(Math.abs(d.delta), seq.settings.fps)}`;
        snapAt = d.snapAt;
      } else if (d.kind === "trim") {
        const r = rowOf(d.track)!;
        const c = d.clip;
        const s = d.edge === "start" && !d.ripple ? c.start + d.delta : c.start;
        const dur = d.edge === "start" ? c.duration - d.delta : c.duration + d.delta;
        ghost(fx(s), top + r.y, dur * v.zoom, r.h, true);
        label = `${d.delta >= 0 ? "+" : "−"}${Math.abs(d.delta)} F · ${formatTimecode(dur, seq.settings.fps)}${linkHint(c)}`;
        snapAt = d.snapAt;
      } else if (d.kind === "roll") {
        const r = rowOf(d.track)!;
        const x = fx(d.clip.start + d.clip.duration + d.delta);
        ctx.fillStyle = COLORS.signal;
        ctx.fillRect(x - 1, top + r.y, 2, r.h);
        label = `Rollen ${d.delta >= 0 ? "+" : "−"}${Math.abs(d.delta)} F${linkHint(d.clip)}`;
        snapAt = d.snapAt;
      } else if (d.kind === "slip") {
        const r = rowOf(d.track)!;
        ghost(fx(d.clip.start), top + r.y, d.clip.duration * v.zoom, r.h, true);
        label = `Slip ${d.delta >= 0 ? "+" : "−"}${Math.abs(d.delta)} F · In ${formatTimecode(d.clip.sourceIn + Math.round(d.delta * d.clip.speed), seq.settings.fps)}`;
      } else if (d.kind === "slide") {
        const r = rowOf(d.track)!;
        ghost(fx(d.clip.start + d.delta), top + r.y, d.clip.duration * v.zoom, r.h, true);
        label = `Slide ${d.delta >= 0 ? "+" : "−"}${Math.abs(d.delta)} F`;
        snapAt = d.snapAt;
      } else if (d.kind === "marquee") {
        ctx.fillStyle = "rgba(200,245,66,0.08)";
        ctx.strokeStyle = "rgba(200,245,66,0.7)";
        ctx.lineWidth = 1;
        const x = Math.min(d.x0, d.x1);
        const y = Math.min(d.y0, d.y1);
        ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
        ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      } else if (d.kind === "drop") {
        if (d.hasVideo && d.video) ghost(fx(d.frame), top + d.video.y, d.length * v.zoom, d.video.h, true);
        if (d.hasAudio && d.audio) ghost(fx(d.frame), top + d.audio.y, d.length * v.zoom, d.audio.h, true);
        label = `${d.insert ? "Einfügen" : "Überschreiben"} · ${formatTimecode(d.frame, seq.settings.fps)}`;
        snapAt = d.snapAt;
      } else if (d.kind === "marker") {
        const x = fx(d.frame0 + d.delta);
        ctx.fillStyle = COLORS.signal;
        ctx.fillRect(x - 0.5, RULER_H, 1, v.height);
        label = formatTimecode(d.frame0 + d.delta, seq.settings.fps);
      } else if (d.kind === "scrub") snapAt = d.snapAt;
    }
    if (snapAt !== null) {
      const x = Math.round(fx(snapAt)) + 0.5;
      ctx.strokeStyle = "rgba(200,245,66,0.9)";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, v.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Playhead
    const ph = Math.round(fx(engine.frame)) + 0.5;
    if (ph >= -8 && ph <= v.width + 8) {
      ctx.strokeStyle = COLORS.signal;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ph, RULER_H - 2);
      ctx.lineTo(ph, v.height);
      ctx.stroke();
      ctx.fillStyle = COLORS.signal;
      ctx.beginPath();
      ctx.moveTo(ph - 6, 2);
      ctx.lineTo(ph + 6, 2);
      ctx.lineTo(ph + 6, RULER_H - 12);
      ctx.lineTo(ph, RULER_H - 4);
      ctx.lineTo(ph - 6, RULER_H - 12);
      ctx.closePath();
      ctx.fill();
    }
    const cur = cursorRef.current;
    if (label && cur) {
      ctx.font = "500 11px 'JetBrains Mono Variable', monospace";
      const w = ctx.measureText(label).width + 12;
      const x = Math.min(cur.x + 14, v.width - w - 4);
      const y = Math.max(RULER_H + 4, cur.y - 30);
      ctx.fillStyle = "rgba(10,10,12,0.92)";
      ctx.fillRect(x, y, w, 20);
      ctx.fillStyle = COLORS.text;
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + 6, y + 10.5);
    }
  }, [seq, layout]);

  useEffect(() => {
    requestBase();
    drawOverlay();
  }, [drawBase, requestBase, drawOverlay, size, ed.zoom, ed.scrollX, scrollY]);

  // Pressing or releasing Alt mid-drag updates the trim hint without a mouse move.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = dragRef.current;
      if (e.key !== "Alt" || (d?.kind !== "trim" && d?.kind !== "roll")) return;
      altRef.current = e.type === "keydown";
      drawOverlay();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [drawOverlay]);

  // Playhead follows playback; page the view when it runs off screen.
  useEffect(
    () =>
      engine.subscribe(() => {
        const v = viewRef.current;
        if (engine.playing) {
          const x = engine.frame * v.zoom - v.scrollX;
          if (x > v.width - 24 || x < 0) useEditor.getState().set({ scrollX: Math.max(0, engine.frame * v.zoom - 40) });
        }
        drawOverlay();
      }),
    [drawOverlay],
  );

  // --- media drop target -------------------------------------------------------------
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    return registerDropTarget({
      el,
      onMove: (cx, cy, media, e) => {
        const s = seqRef.current;
        const lay = layoutRef.current;
        if (!s || !lay) return;
        const r = el.getBoundingClientRect();
        const x = cx - r.left;
        const y = cy - r.top;
        cursorRef.current = { x, y };
        const v = viewRef.current;
        const assets = media.map((id) => useProject.getState().mediaById.get(id)).filter(Boolean);
        const range = mediaDragRange();
        const full = assets.reduce((sum, a) => sum + (mediaLength(a!, s) ?? Math.round(fpsOf(s.settings.fps) * 5)), 0);
        const length = range ? (range.sourceOut ?? full) - range.sourceIn : full;
        const hasVideo = assets.some((a) => a!.kind !== "audio" && a!.info?.video);
        const hasAudio = assets.some((a) => a!.kind !== "image" && a!.info?.audio);
        const row = rowAt(lay, y - RULER_H + v.scrollY);
        const firstOf = (k: "video" | "audio") => {
          const idx = tracksOfKind(s, k)[0];
          return lay.rows.find((rr) => rr.index === idx) ?? null;
        };
        const video = row?.track.kind === "video" ? row : firstOf("video");
        const audio = row?.track.kind === "audio" ? row : firstOf("audio");
        let frame = Math.max(0, Math.round((x + v.scrollX) / v.zoom));
        let snapAt: number | null = null;
        if (useEditor.getState().snapping) {
          const sn = snap([frame, frame + length], snapTargets(s, engine.frame), SNAP_PX / v.zoom);
          if (sn) {
            frame += sn.delta;
            snapAt = sn.at;
          }
        }
        dragRef.current = { kind: "drop", media, frame: Math.max(0, frame), video, audio, length, hasVideo, hasAudio, insert: e.ctrlKey, snapAt };
        drawOverlay();
      },
      onLeave: () => {
        if (dragRef.current?.kind === "drop") dragRef.current = null;
        drawOverlay();
      },
      onDrop: (_x, _y, media, e) => {
        const d = dragRef.current;
        dragRef.current = null;
        drawOverlay();
        if (d?.kind !== "drop") return;
        void placeMedia(
          media,
          e.ctrlKey ? "insert" : "overwrite",
          d.frame,
          { video: d.video?.track.id ?? null, audio: d.audio?.track.id ?? null },
          mediaDragRange() ?? undefined,
        );
      },
    });
    // The drop area only exists once a sequence is shown.
  }, [drawOverlay, !!seq]);

  const seqRef = useRef(seq);
  seqRef.current = seq;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  if (!seq || !layout) return null;

  // --- hit testing ------------------------------------------------------------------------
  const local = (e: { clientX: number; clientY: number }) => {
    const r = areaRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const frameAt = (x: number) => (x + view.scrollX) / view.zoom;

  const hitTest = (x: number, y: number): Hit | null => {
    if (y < RULER_H) return null;
    const row = rowAt(layout, y - RULER_H + view.scrollY);
    if (!row) return null;
    const clips = row.track.clips;
    let best: Hit | null = null;
    for (let ci = 0; ci < clips.length; ci++) {
      const c = clips[ci];
      const xs = c.start * view.zoom - view.scrollX;
      const xe = (c.start + c.duration) * view.zoom - view.scrollX;
      if (x < xs - EDGE_PX || x > xe + EDGE_PX) continue;
      const edgeW = Math.min(EDGE_PX, Math.max(2, (xe - xs) / 3));
      if (x >= xs && x <= xe) {
        if (x - xs <= edgeW) return { row, clip: c, ci, zone: "start" };
        if (xe - x <= edgeW) return { row, clip: c, ci, zone: "end" };
        return { row, clip: c, ci, zone: "body" };
      }
      if (x < xs && xs - x <= edgeW) best = best ?? { row, clip: c, ci, zone: "start" };
      if (x > xe && x - xe <= edgeW) best = { row, clip: c, ci, zone: "end" };
    }
    return best;
  };

  const markerAt = (x: number) => seq.markers.find((m) => Math.abs(m.frame * view.zoom - view.scrollX - x) <= 6) ?? null;
  const lenOf = (c: Clip) => mediaLength(mediaById.get(c.mediaId), seq);
  const targets = (exclude?: Set<Uuid>) => snapTargets(seq, engine.frame, exclude);

  const setCursor = (c: string) => {
    if (overRef.current) overRef.current.style.cursor = c;
  };

  const updateHoverCursor = (x: number, y: number) => {
    const tool = ed.tool;
    if (y < RULER_H) return setCursor(markerAt(x) ? "grab" : "text");
    if (tool === "hand") return setCursor("grab");
    if (tool === "zoom") return setCursor("zoom-in");
    if (tool === "razor") return setCursor(hitTest(x, y) ? "crosshair" : "default");
    const h = hitTest(x, y);
    if (!h || h.row.track.locked) return setCursor("default");
    if (h.zone !== "body" && (tool === "select" || tool === "ripple" || tool === "roll")) return setCursor(tool === "roll" ? "col-resize" : "ew-resize");
    if (h.zone === "body" && (tool === "slip" || tool === "slide")) return setCursor("ew-resize");
    setCursor("default");
  };

  // --- pointer handling ----------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      dragRef.current = { kind: "hand", x0: e.clientX, y0: e.clientY, sx: view.scrollX, sy: view.scrollY };
      overRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const { x, y } = local(e);
    cursorRef.current = { x, y };
    overRef.current!.setPointerCapture(e.pointerId);
    const tool = ed.tool;

    if (y < RULER_H) {
      const m = markerAt(x);
      if (m) {
        if (e.detail === 2) {
          setMarkerEdit({ id: m.id, x, name: m.name });
          return;
        }
        dragRef.current = { kind: "marker", id: m.id, frame0: m.frame, x0: x, delta: 0 };
        return;
      }
      engine.seek(Math.max(0, Math.round(frameAt(x))));
      dragRef.current = { kind: "scrub", snapAt: null };
      drawOverlay();
      return;
    }
    if (tool === "hand") {
      dragRef.current = { kind: "hand", x0: e.clientX, y0: e.clientY, sx: view.scrollX, sy: view.scrollY };
      setCursor("grabbing");
      return;
    }
    if (tool === "zoom") {
      zoomBy(e.altKey ? 1 / 2 : 2, frameAt(x), x);
      return;
    }
    const h = hitTest(x, y);
    if (tool === "razor") {
      if (!h || h.row.track.locked) return;
      let f = Math.round(frameAt(x));
      if (Math.abs(engine.frame - f) * view.zoom <= SNAP_PX) f = Math.round(engine.frame);
      const clips = e.shiftKey ? null : ed.linkedSelection && !e.altKey ? expandLinks(seq, [h.clip.id]) : [h.clip.id];
      void edit({ type: "splitAt", sequence: seq.id, frame: f, clips });
      return;
    }
    if (!h) {
      dragRef.current = { kind: "marquee", x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey || e.ctrlKey };
      if (!e.shiftKey && !e.ctrlKey) ed.select([]);
      return;
    }
    if (h.row.track.locked) return;
    const additive = e.shiftKey || e.ctrlKey;
    const { clip, ci, row } = h;

    // Edge interactions
    if (h.zone !== "body" && (tool === "select" || tool === "ripple" || tool === "roll")) {
      if (tool === "roll") {
        const left = h.zone === "end" ? ci : ci - 1;
        const l = row.track.clips[left];
        const r = row.track.clips[left + 1];
        if (l && r && l.start + l.duration === r.start) {
          dragRef.current = { kind: "roll", clip: l, track: row.index, ci: left, x0: x, delta: 0, snapAt: null };
          return;
        }
      }
      dragRef.current = { kind: "trim", clip, track: row.index, ci, edge: h.zone, ripple: tool === "ripple" || e.ctrlKey, x0: x, delta: 0, snapAt: null };
      return;
    }
    if (tool === "slip") {
      dragRef.current = { kind: "slip", clip, track: row.index, ci, x0: x, delta: 0 };
      return;
    }
    if (tool === "slide") {
      dragRef.current = { kind: "slide", clip, track: row.index, ci, x0: x, delta: 0, snapAt: null };
      return;
    }
    // Body: select + move
    if (!selection.has(clip.id) || additive) selectClips([clip.id], additive, e.altKey);
    const ids = additive
      ? useEditor.getState().selection
      : selection.has(clip.id)
        ? ed.selection
        : useEditor.getState().selection;
    dragRef.current = { kind: "move", ids, anchor: clip, anchorTrack: row.index, x0: x, y0: y, delta: 0, trackDelta: 0, snapAt: null, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    cursorRef.current = { x, y };
    const d = dragRef.current;
    if (!d) {
      updateHoverCursor(x, y);
      return;
    }
    altRef.current = e.altKey;
    const snapping = ed.snapping !== e.shiftKey || d.kind === "scrub";
    const thr = SNAP_PX / view.zoom;
    switch (d.kind) {
      case "scrub": {
        let f = Math.max(0, Math.round(frameAt(x)));
        d.snapAt = null;
        if (e.shiftKey) {
          const sn = snap([f], targets(), thr);
          if (sn) {
            f += sn.delta;
            d.snapAt = sn.at;
          }
        }
        engine.seek(f);
        break;
      }
      case "marker":
        d.delta = Math.max(-d.frame0, Math.round((x - d.x0) / view.zoom));
        break;
      case "hand": {
        const set = useEditor.getState().set;
        set({ scrollX: Math.max(0, d.sx - (e.clientX - d.x0)), scrollY: Math.max(0, Math.min(maxScrollY, d.sy - (e.clientY - d.y0))) });
        break;
      }
      case "marquee":
        d.x1 = x;
        d.y1 = y;
        break;
      case "move": {
        if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return;
        d.moved = true;
        let delta = Math.round((x - d.x0) / view.zoom);
        const moving = d.ids.map((id) => seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)).filter(Boolean) as Clip[];
        d.snapAt = null;
        if (snapping) {
          const cands = moving.flatMap((c) => [c.start + delta, c.start + c.duration + delta]);
          const sn = snap(cands, targets(new Set(d.ids)), thr);
          if (sn) {
            delta += sn.delta;
            d.snapAt = sn.at;
          }
        }
        const minStart = Math.min(...moving.map((c) => c.start));
        d.delta = Math.max(-minStart, delta);
        const row = rowAt(layout, y - RULER_H + view.scrollY);
        const kind = seq.tracks[d.anchorTrack].kind;
        if (row && row.track.kind === kind) {
          const of = tracksOfKind(seq, kind);
          const wanted = kindPosition(seq, row.index) - kindPosition(seq, d.anchorTrack);
          // Clamp so every moved clip of this kind stays on an existing track.
          const positions = moving
            .map((c) => seq.tracks.findIndex((t) => t.clips.includes(c)))
            .filter((ti) => seq.tracks[ti].kind === kind)
            .map((ti) => of.indexOf(ti));
          const lo = -Math.min(...positions);
          const hi = of.length - 1 - Math.max(...positions);
          d.trackDelta = Math.max(lo, Math.min(hi, wanted));
        }
        break;
      }
      case "trim": {
        const track = seq.tracks[d.track];
        let delta = Math.round((x - d.x0) / view.zoom);
        d.snapAt = null;
        if (snapping) {
          const edgeFrame = d.edge === "start" ? d.clip.start : d.clip.start + d.clip.duration;
          const sn = snap([edgeFrame + delta], targets(new Set([d.clip.id])), thr);
          if (sn) {
            delta += sn.delta;
            d.snapAt = sn.at;
          }
        }
        d.delta = clampTrim(track, d.ci, d.edge, delta, d.ripple, lenOf(d.clip));
        const c = d.clip;
        showSourceFrame(c, c.sourceIn + Math.round((d.edge === "start" ? d.delta : c.duration + d.delta - 1) * c.speed));
        break;
      }
      case "roll": {
        const track = seq.tracks[d.track];
        let delta = Math.round((x - d.x0) / view.zoom);
        d.snapAt = null;
        if (snapping) {
          const sn = snap([d.clip.start + d.clip.duration + delta], targets(new Set([d.clip.id, track.clips[d.ci + 1]?.id])), thr);
          if (sn) {
            delta += sn.delta;
            d.snapAt = sn.at;
          }
        }
        d.delta = clampRoll(track, d.ci, delta, lenOf(d.clip), lenOf(track.clips[d.ci + 1]));
        showSourceFrame(d.clip, d.clip.sourceIn + Math.round((d.clip.duration + d.delta - 1) * d.clip.speed));
        break;
      }
      case "slip": {
        d.delta = clampSlip(d.clip, Math.round((d.x0 - x) / view.zoom), lenOf(d.clip));
        showSourceFrame(d.clip, d.clip.sourceIn + Math.round(d.delta * d.clip.speed));
        break;
      }
      case "slide": {
        const track = seq.tracks[d.track];
        let delta = Math.round((x - d.x0) / view.zoom);
        d.snapAt = null;
        if (snapping) {
          const sn = snap([d.clip.start + delta, d.clip.start + d.clip.duration + delta], targets(new Set([d.clip.id])), thr);
          if (sn) {
            delta += sn.delta;
            d.snapAt = sn.at;
          }
        }
        const prev = track.clips[d.ci - 1];
        const next = track.clips[d.ci + 1];
        d.delta = clampSlide(track, d.ci, delta, prev ? lenOf(prev) : null, next ? lenOf(next) : null);
        break;
      }
      case "drop":
        break;
    }
    drawOverlay();
    updateEdgeScroll(e, x);
  };
  moveRef.current = onPointerMove;

  // Dragging near the left/right edge scrolls the timeline; the drag origin
  // shifts with the view so the dragged edit keeps following the pointer.
  function updateEdgeScroll(e: React.PointerEvent, x: number) {
    const d = dragRef.current;
    const w = viewRef.current.width;
    const scrolls = d && d.kind !== "hand" && d.kind !== "drop" && d.kind !== "slip";
    const speed = !scrolls ? 0 : x < EDGE_SCROLL_PX ? x - EDGE_SCROLL_PX : x > w - EDGE_SCROLL_PX ? x - (w - EDGE_SCROLL_PX) : 0;
    const cur = edgeScroll.current;
    if (!speed) {
      if (cur) cancelAnimationFrame(cur.raf);
      edgeScroll.current = null;
      return;
    }
    if (cur) {
      cur.speed = speed;
      cur.ev = e;
      return;
    }
    const tick = () => {
      const s = edgeScroll.current;
      const drag = dragRef.current;
      if (!s || !drag) {
        edgeScroll.current = null;
        return;
      }
      const v = viewRef.current;
      const next = Math.max(0, v.scrollX + s.speed * 0.6);
      const dx = next - v.scrollX;
      if (dx) {
        if ("x0" in drag) drag.x0 -= dx;
        viewRef.current = { ...v, scrollX: next };
        useEditor.getState().set({ scrollX: next });
        moveRef.current(s.ev);
      }
      s.raf = requestAnimationFrame(tick);
    };
    edgeScroll.current = { speed, ev: e, raf: requestAnimationFrame(tick) };
  }

  const finish = async (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (edgeScroll.current) cancelAnimationFrame(edgeScroll.current.raf);
    edgeScroll.current = null;
    // Media drops complete in the drop target's onDrop (window pointerup).
    if (!d || d.kind === "drop") return;
    const done = () => {
      dragRef.current = null;
      engine.setPreviewFrame(null);
      engine.clearOverrides();
      drawOverlay();
      updateHoverCursor(local(e).x, local(e).y);
    };
    switch (d.kind) {
      case "move":
        if (!d.moved) {
          // Plain click on a selected clip narrows the selection to it.
          if (!e.shiftKey && !e.ctrlKey) selectClips([d.anchor.id], false, e.altKey);
          break;
        }
        if (d.delta || d.trackDelta)
          await edit({ type: "moveClips", sequence: seq.id, clips: d.ids, delta: d.delta, trackDelta: d.trackDelta, trackKind: seq.tracks[d.anchorTrack].kind });
        break;
      case "trim":
        if (d.delta) await edit({ type: "trimClip", sequence: seq.id, clip: d.clip.id, edge: d.edge, delta: d.delta, ripple: d.ripple, linked: !e.altKey });
        break;
      case "roll":
        if (d.delta) await edit({ type: "rollEdit", sequence: seq.id, clip: d.clip.id, delta: d.delta, linked: !e.altKey });
        break;
      case "slip":
        if (d.delta) await edit({ type: "slipClip", sequence: seq.id, clip: d.clip.id, delta: d.delta, linked: !e.altKey });
        break;
      case "slide":
        if (d.delta) await edit({ type: "slideClip", sequence: seq.id, clip: d.clip.id, delta: d.delta, linked: !e.altKey });
        break;
      case "marker":
        if (d.delta) await edit({ type: "updateMarker", sequence: seq.id, marker: d.id, patch: { frame: d.frame0 + d.delta } });
        break;
      case "marquee": {
        const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
        const [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
        if (x1 - x0 < 3 && y1 - y0 < 3) break;
        const f0 = frameAt(x0);
        const f1 = frameAt(x1);
        const hit: Uuid[] = [];
        for (const r of layout.rows) {
          const ry = RULER_H - view.scrollY + r.y;
          if (ry + r.h < y0 || ry > y1 || r.track.locked) continue;
          for (const c of r.track.clips) if (c.start < f1 && c.start + c.duration > f0) hit.push(c.id);
        }
        if (d.additive) selectClips([...new Set([...ed.selection, ...hit])], false);
        else selectClips(hit, false);
        break;
      }
      default:
        break;
    }
    done();
  };

  const onWheel = (e: React.WheelEvent) => {
    const { x } = local(e);
    const set = useEditor.getState().set;
    if (e.ctrlKey || e.altKey) {
      zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, frameAt(x), x);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      set({ scrollX: Math.max(0, view.scrollX + (e.deltaX || e.deltaY)) });
    } else {
      set({ scrollY: Math.max(0, Math.min(maxScrollY, view.scrollY + e.deltaY)) });
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    if (y < RULER_H) {
      const m = markerAt(x);
      if (!m) return openContextMenu(e, [{ label: "Marker setzen", onSelect: () => void edit({ type: "addMarker", sequence: seq.id, frame: Math.round(frameAt(x)), name: `Marker ${seq.markers.length + 1}`, color: "signal" }) }]);
      return openContextMenu(e, [
        { label: "Umbenennen", onSelect: () => setMarkerEdit({ id: m.id, x, name: m.name }) },
        { label: "Farbe", submenu: MARKER_COLORS.map((c) => ({ label: c.label, checked: m.color === c.value, onSelect: () => void edit({ type: "updateMarker", sequence: seq.id, marker: m.id, patch: { color: c.value } }) })) },
        { separator: true },
        { label: "Marker löschen", danger: true, onSelect: () => void edit({ type: "removeMarker", sequence: seq.id, marker: m.id }) },
      ]);
    }
    const h = hitTest(x, y);
    const row = rowAt(layout, y - RULER_H + view.scrollY);
    if (!h) {
      const items: MenuItem[] = [
        { label: "Hier einfügen", shortcut: "Strg+V", disabled: !ed.clipboard.length, onSelect: () => { engine.seek(Math.round(frameAt(x))); void paste(); } },
      ];
      if (row) {
        const f = Math.round(frameAt(x));
        const inGap = row.track.clips.some((c) => c.start > f) && !row.track.clips.some((c) => c.start <= f && f < c.start + c.duration);
        items.push({ label: "Lücke schließen", disabled: !inGap || row.track.locked, onSelect: () => void edit({ type: "closeGap", sequence: seq.id, track: row.track.id, frame: f }) });
      }
      items.push({ separator: true }, { label: "Videospur hinzufügen", onSelect: () => void addTrack("video") }, { label: "Audiospur hinzufügen", onSelect: () => void addTrack("audio") });
      return openContextMenu(e, items);
    }
    if (!selection.has(h.clip.id)) selectClips([h.clip.id]);
    const ids = selection.has(h.clip.id) ? ed.selection : useEditor.getState().selection;
    const speed = (s: number) => () => void edit({ type: "updateClips", sequence: seq.id, clips: ids, patch: { speed: s } });
    openContextMenu(e, [
      { label: "Ausschneiden", shortcut: "Strg+X", onSelect: () => copySelection(true) },
      { label: "Kopieren", shortcut: "Strg+C", onSelect: () => copySelection() },
      { label: "Löschen", shortcut: "Entf", onSelect: () => void deleteSelection(false) },
      { label: "Löschen und Lücke schließen", shortcut: "⇧+Entf", onSelect: () => void deleteSelection(true) },
      { separator: true },
      { label: "Am Mauszeiger schneiden", onSelect: () => void edit({ type: "splitAt", sequence: seq.id, frame: Math.round(frameAt(x)), clips: ids }) },
      { label: h.clip.enabled ? "Deaktivieren" : "Aktivieren", shortcut: "⇧+E", onSelect: () => void toggleEnabled() },
      { label: "Verknüpfen", disabled: ids.length < 2, onSelect: () => void linkSelection(true) },
      { label: "Verknüpfung lösen", disabled: !h.clip.link, onSelect: () => void linkSelection(false) },
      { label: "Ein- und Ausblenden (½ s)", onSelect: () => void applyFades() },
      { label: "Geschwindigkeit", submenu: [0.25, 0.5, 1, 1.5, 2, 4].map((s) => ({ label: `${s * 100} %`, checked: h.clip.speed === s, onSelect: speed(s) })) },
      { label: "Standbild am Playhead einfügen (2 s)", shortcut: "⇧+N", onSelect: () => void freezeFrame(2) },
      { label: "Audio normalisieren …", disabled: !selectedAudioClips().length, onSelect: openNormalize },
      { separator: true },
      { label: "Umbenennen …", shortcut: "F2", onSelect: () => void renameSelection() },
      { label: "Beschriftung", submenu: LABELS.map((l) => ({ label: LABEL_NAMES[l], checked: h.clip.label === l, onSelect: () => void labelSelection(l) })) },
      { label: "Durch Medienauswahl ersetzen", disabled: useEditor.getState().mediaSelection.length !== 1, onSelect: () => void replaceClipMedia(h.clip.id) },
      { label: "Im Medienbrowser zeigen", onSelect: () => revealInProject(h.clip.id) },
    ]);
  };

  // Horizontal scrollbar geometry.
  const total = Math.max(sequenceDuration(seq) * view.zoom + view.width * 0.5, view.width);
  const thumbW = Math.max(30, (view.width / total) * view.width);
  const thumbX = (view.scrollX / total) * view.width;

  const toolKey = (id: ToolId) => {
    const k = keysFor(`tool.${id}`)[0];
    return k ? formatCombo(k) : undefined;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        tabs={
          <div className="flex min-w-0 items-center gap-3">
            <span className="panel-title">Timeline</span>
            <SequenceTabs />
          </div>
        }
      >
        <div className="mr-2 flex items-center gap-px rounded-sm bg-ground p-0.5">
          {TOOLS.map((t) => (
            <IconButton key={t.id} size={24} icon={TOOL_ICONS[t.id]} label={`${t.label} – ${t.hint}`} shortcut={toolKey(t.id)} active={ed.tool === t.id} onClick={() => ed.setTool(t.id)} />
          ))}
        </div>
        <IconButton icon={<Magnet size={14} />} size={24} label="Magnetisches Einrasten" shortcut="S" active={ed.snapping} onClick={() => ed.set({ snapping: !ed.snapping })} />
        <IconButton icon={<Link2 size={14} />} size={24} label="Verknüpfte Auswahl" active={ed.linkedSelection} onClick={() => ed.set({ linkedSelection: !ed.linkedSelection })} />
        <div className="mx-1.5 h-4 w-px bg-line-strong" />
        <ZoomSlider />
      </PanelHeader>
      <div className="flex min-h-0 flex-1">
        {/* Track headers */}
        <div className="relative shrink-0 overflow-hidden border-r border-line" style={{ width: HEADER_W }}>
          <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-1 border-b border-line bg-[#121215] px-2.5" style={{ height: RULER_H }}>
            <TimecodeReadout seq={seq} />
            <div className="ml-auto flex">
              <IconButton icon={<Film size={12} />} size={20} label="Videospur hinzufügen" onClick={() => void addTrack("video")} />
              <IconButton icon={<Music size={12} />} size={20} label="Audiospur hinzufügen" onClick={() => void addTrack("audio")} />
            </div>
          </div>
          <div className="absolute inset-x-0" style={{ top: RULER_H - view.scrollY }}>
            {layout.rows.map((r, i) => (
              <div key={r.track.id}>
                {i > 0 && layout.rows[i - 1].track.kind !== r.track.kind && <div className="bg-[#0a0a0c]" style={{ height: 6 }} />}
                <TrackHeader row={r} seq={seq} />
              </div>
            ))}
          </div>
        </div>
        {/* Canvas area */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={areaRef} className="relative min-h-0 flex-1 overflow-hidden" onWheel={onWheel}>
            <canvas ref={baseRef} className="absolute inset-0 h-full w-full" />
            <canvas
              ref={overRef}
              className="absolute inset-0 h-full w-full"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => void finish(e)}
              onPointerCancel={(e) => void finish(e)}
              onPointerLeave={() => {
                if (!dragRef.current) setCursor("default");
              }}
              onContextMenu={onContextMenu}
              onDoubleClick={(e) => {
                const { x, y } = local(e);
                if (y >= RULER_H && !hitTest(x, y)) engine.seek(Math.round(frameAt(x)));
              }}
            />
            {markerEdit && (
              <input
                autoFocus
                className="absolute top-1 z-20 h-6 w-40 rounded-sm border border-signal bg-ground px-1.5 text-xs outline-none"
                style={{ left: Math.min(markerEdit.x + 8, size.w - 170) }}
                value={markerEdit.name}
                onChange={(e) => setMarkerEdit({ ...markerEdit, name: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setMarkerEdit(null);
                }}
                onBlur={() => {
                  if (markerEdit) void edit({ type: "updateMarker", sequence: seq.id, marker: markerEdit.id, patch: { name: markerEdit.name } });
                  setMarkerEdit(null);
                }}
              />
            )}
          </div>
          <div
            className="relative h-2.5 shrink-0 bg-ground"
            onPointerDown={(e) => {
              const el = e.currentTarget;
              el.setPointerCapture(e.pointerId);
              const r = el.getBoundingClientRect();
              const grab = e.clientX - r.left - thumbX;
              const inside = grab >= 0 && grab <= thumbW;
              const offset = inside ? grab : thumbW / 2;
              const move = (ev: PointerEvent) => {
                const px = ev.clientX - r.left - offset;
                useEditor.getState().set({ scrollX: Math.max(0, (px / view.width) * total) });
              };
              move(e.nativeEvent);
              const up = () => {
                el.removeEventListener("pointermove", move);
                el.removeEventListener("pointerup", up);
              };
              el.addEventListener("pointermove", move);
              el.addEventListener("pointerup", up);
            }}
          >
            <div className="absolute inset-y-0.5 rounded-full bg-[#2c2c34] hover:bg-[#3a3a44]" style={{ left: thumbX, width: thumbW }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TimecodeReadout({ seq }: { seq: Sequence }) {
  const [, force] = useState(0);
  useEffect(() => engine.subscribe(() => force((n) => n + 1)), []);
  return <span className="tc text-[12.5px] text-signal">{formatTimecode(Math.round(engine.frame), seq.settings.fps)}</span>;
}
