// Source monitor: view a media item, mark In/Out and cut it into the
// sequence (Insert / Overwrite, or drag the picture onto the timeline).

import { ArrowDownToLine, ChevronFirst, ChevronLast, Pause, Play, Replace, StepBack, StepForward, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cachedPeaks, fileUrl, previewSource } from "../lib/media";
import { formatTimecode } from "../lib/time";
import type { MediaAsset } from "../lib/types";
import { useEditor } from "../state/editor";
import { useProject } from "../state/project";
import { attachPlayer, NO_MARKS, source, sourceDuration, sourceFps, useSource } from "../state/source";
import { setMediaDragRange, startMediaDrag } from "../ui/dnd";
import { cx, IconButton, PanelHeader, Select } from "../ui/primitives";
import { useYccFilter } from "../ui/YccFilter";

const tc = (seconds: number, fps: number) => formatTimecode(Math.round(seconds * fps), { num: Math.round(fps * 1000), den: 1000 });

function Waveform({ asset }: { asset: MediaAsset }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [, redraw] = useState(0);
  useEffect(() => {
    const c = ref.current;
    const p = asset.derived.peaks;
    if (!c || !p) return;
    const data = cachedPeaks(p.path, () => redraw((n) => n + 1));
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = c.clientHeight * devicePixelRatio);
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    if (!data) return;
    ctx.fillStyle = "#5fb3a6";
    const per = data.length / w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let i = Math.floor(x * per); i < Math.min(data.length, Math.ceil((x + 1) * per)); i++) m = Math.max(m, data[i]);
      const amp = Math.sqrt(m / 255) * (h / 2 - 2);
      ctx.fillRect(x, h / 2 - amp, 1, Math.max(1, amp * 2));
    }
  });
  return <canvas ref={ref} className="absolute inset-x-4 inset-y-8 h-[calc(100%-4rem)] w-[calc(100%-2rem)]" />;
}

export function SourceMonitor() {
  const { media, time, rate, recent } = useSource();
  const asset = useProject((s) => (media ? s.mediaById.get(media) : undefined)) ?? null;
  const marks = asset?.marks ?? NO_MARKS;
  const names = useProject((s) => s.mediaById);
  const useProxies = useEditor((s) => s.useProxies);
  const ycc = useYccFilter(asset, useProxies);
  const playerRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  // Narrow panels (e.g. a tab next to the media browser) drop secondary controls.
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compact = width < 470;

  const src = asset && asset.kind !== "image" ? previewSource(asset, useProxies) : null;
  useEffect(() => {
    attachPlayer(playerRef.current);
    return () => attachPlayer(null);
  }, [src]);

  // Follow the element while it plays.
  useEffect(() => {
    if (rate <= 0) return;
    let raf = 0;
    const tick = () => {
      if (playerRef.current) source.sync(playerRef.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rate]);

  const fps = sourceFps(asset);
  const duration = sourceDuration(asset);
  const pct = (t: number) => `${duration ? Math.min(100, (t / duration) * 100) : 0}%`;
  const markIn = marks.in ?? 0;
  const markOut = marks.out ?? duration;

  const options = recent.filter((id) => names.has(id)).map((id) => ({ value: id, label: names.get(id)!.name }));

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={<span>Quelle{asset && <span className="normal-case tracking-normal text-fg-2"> · {asset.name}</span>}</span>}>
        {options.length > 1 && <Select label="Zuletzt geöffnet" width={150} value={media ?? ""} onChange={(v) => source.open(v)} options={options} />}
        {asset && <IconButton icon={<X size={14} />} label="Quelle schließen" onClick={source.close} />}
      </PanelHeader>
      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-[#08080a]"
        title={asset ? "Ziehen, um den markierten Bereich in die Timeline zu legen" : undefined}
        onPointerDown={(e) => {
          if (!asset) return;
          setMediaDragRange(source.range());
          startMediaDrag(e, [asset.id], () => setMediaDragRange(null));
        }}
      >
        {!asset && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
            <span className="text-sm text-fg-3">Kein Medium geladen</span>
            <span className="text-xs text-fg-4">Doppelklick auf ein Medium im Medienbrowser öffnet es hier. F lädt den Clip am Playhead (Match Frame).</span>
          </div>
        )}
        {asset?.kind === "image" && <img src={fileUrl(asset.path)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-contain" />}
        {asset?.kind === "video" && src && ycc.svg}
        {asset?.kind === "video" && src && (
          <video
            key={src}
            style={{ filter: ycc.filter }}
            ref={playerRef as React.RefObject<HTMLVideoElement>}
            src={src}
            preload="auto"
            playsInline
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            onLoadedMetadata={(e) => (e.currentTarget.currentTime = useSource.getState().time)}
            onEnded={() => source.pause()}
          />
        )}
        {asset?.kind === "audio" && (
          <>
            <Waveform asset={asset} />
            {src && <audio key={src} ref={playerRef as React.RefObject<HTMLAudioElement>} src={src} preload="auto" onEnded={() => source.pause()} />}
          </>
        )}
        {asset && asset.kind !== "image" && !src && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-sm bg-black/70 px-2 py-1 text-xs text-warn">Proxy wird erstellt …</div>
        )}
        {rate !== 0 && rate !== 1 && (
          <div className="tc pointer-events-none absolute right-3 top-3 rounded-sm bg-black/70 px-2 py-0.5 text-xs text-signal">
            {rate > 0 ? "▶" : "◀"} {Math.abs(rate)}×
          </div>
        )}
      </div>

      {/* Scrubber with the marked range */}
      <div
        className={cx("relative h-2.5 shrink-0 bg-ground", duration > 0 && "cursor-pointer")}
        onPointerDown={(e) => {
          if (!duration) return;
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          source.pause();
          const seekAt = (x: number) => {
            const r = el.getBoundingClientRect();
            source.seek(((x - r.left) / r.width) * duration);
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
        {(marks.in !== null || marks.out !== null) && duration > 0 && (
          <div className="absolute inset-y-0 bg-signal/25" style={{ left: pct(markIn), width: `calc(${pct(markOut)} - ${pct(markIn)})` }} />
        )}
        {duration > 0 && <div className="absolute inset-y-0 w-0.5 bg-signal" style={{ left: pct(time) }} />}
      </div>

      <div className="flex h-10 shrink-0 items-center gap-2 border-t border-line px-2">
        <span className={cx("tc shrink-0 text-signal", compact ? "text-[13px]" : "w-[104px] text-[15px]")}>{asset ? tc(time, fps) : "--:--:--:--"}</span>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-0.5">
          <IconButton icon={<span className="tc text-[11px] font-semibold">{"{"}</span>} label="In-Point setzen" shortcut="I" disabled={!duration} onClick={() => source.setIn()} />
          {!compact && (
          <IconButton icon={<ChevronFirst size={16} />} label="Zum In-Point" shortcut="⇧+I" disabled={!duration} onClick={source.gotoIn} />
          )}
          <IconButton icon={<StepBack size={15} />} label="1 Frame zurück" shortcut="←" disabled={!duration} onClick={() => source.step(-1)} />
          <button
            aria-label={rate ? "Pause" : "Wiedergabe"}
            disabled={!duration}
            onClick={source.toggle}
            className="mx-1 flex h-8 w-8 items-center justify-center rounded-full bg-fg text-ground transition-transform hover:scale-105 disabled:opacity-40"
          >
            {rate ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
          </button>
          <IconButton icon={<StepForward size={15} />} label="1 Frame vor" shortcut="→" disabled={!duration} onClick={() => source.step(1)} />
          {!compact && (
          <IconButton icon={<ChevronLast size={16} />} label="Zum Out-Point" shortcut="⇧+O" disabled={!duration} onClick={source.gotoOut} />
          )}
          <IconButton icon={<span className="tc text-[11px] font-semibold">{"}"}</span>} label="Out-Point setzen" shortcut="O" disabled={!duration} onClick={() => source.setOut()} />
          <span className="mx-1 h-5 w-px bg-line" />
          <IconButton icon={<ArrowDownToLine size={15} />} label="Einfügen (Insert)" shortcut="," disabled={!asset} onClick={() => void source.place("insert")} />
          <IconButton icon={<Replace size={15} />} label="Überschreiben (Overwrite)" shortcut="." disabled={!asset} onClick={() => void source.place("overwrite")} />
        </div>
        {width >= 560 && (
          <span className="tc w-[104px] text-right text-xs text-fg-3" title="Länge des markierten Bereichs">
            {asset && duration > 0 ? tc(markOut - markIn, fps) : ""}
          </span>
        )}
      </div>
    </div>
  );
}

