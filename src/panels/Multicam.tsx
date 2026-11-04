// Multicam viewer: every angle of the multicam clip under the playhead, in
// sync. A click on an angle (or keys 1–9) switches to it from the playhead on;
// while playing, that cuts live.

import { useEffect, useRef } from "react";
import { groupTime, multicamClipAt, multicamOf, switchAngle } from "../actions/multicam";
import { usePlayhead, useRate } from "../engine/hooks";
import { engine } from "../engine/playback";
import { previewSource } from "../lib/media";
import type { Angle, MediaAsset } from "../lib/types";
import { useEditor } from "../state/editor";
import { useActiveSequence, useProject } from "../state/project";
import { cx, PanelHeader } from "../ui/primitives";
import { useYccFilter } from "../ui/YccFilter";

/** Seconds a playing angle may drift from the playhead before it is sought. */
const MAX_DRIFT_S = 0.25;

function AngleTile({ index, angle, asset, time, rate, active }: { index: number; angle: Angle; asset: MediaAsset | undefined; time: number; rate: number; active: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const useProxies = useEditor((s) => s.useProxies);
  const src = asset ? previewSource(asset, useProxies) : null;
  const length = asset?.info?.duration ?? 0;
  const ycc = useYccFilter(asset, useProxies);
  const inside = time >= 0 && time < length;
  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;
    const t = Math.min(Math.max(time, 0), Math.max(0, length - 0.001));
    if (rate > 0 && rate <= 4 && inside) {
      if (el.paused || Math.abs(el.currentTime - t) > MAX_DRIFT_S) el.currentTime = t;
      el.playbackRate = rate;
      if (el.paused) void el.play().catch(() => undefined);
    } else {
      if (!el.paused) el.pause();
      // Inside the frame, so rounding never shows the previous one.
      if (Math.abs(el.currentTime - t) > 0.02) el.currentTime = t + 0.01;
    }
  }, [time, rate, src, inside, length]);
  return (
    <button
      className={cx("relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-sm bg-black ring-1", active ? "ring-2 ring-signal" : "ring-line hover:ring-line-strong")}
      title={`Kamera ${index + 1}: ${angle.name} (Taste ${index + 1})`}
      onClick={() => void switchAngle(index)}
    >
      {src && ycc.svg}
      {src ? <video ref={ref} src={src} muted playsInline preload="auto" style={{ filter: ycc.filter }} className={cx("h-full w-full object-contain", !inside && "opacity-20")} /> : <span className="text-xs text-fg-4">Wird vorbereitet …</span>}
      {!inside && <span className="absolute text-xs text-fg-3">Kein Bild</span>}
      <span className={cx("absolute left-1 top-1 rounded-xs px-1 font-mono text-[11px]", active ? "bg-signal text-black" : "bg-black/70 text-fg-2")}>{index + 1}</span>
      <span className="absolute bottom-1 left-1 max-w-[90%] truncate rounded-xs bg-black/70 px-1 text-[11px] text-fg-2">{angle.name}</span>
    </button>
  );
}

export function MulticamPanel() {
  const seq = useActiveSequence();
  const frame = usePlayhead();
  const rate = useRate();
  useProject((s) => s.project?.multicams);
  const mediaById = useProject((s) => s.mediaById);
  useEditor((s) => s.selection);
  const clip = seq ? multicamClipAt(seq, Math.round(engine.frame)) : null;
  const g = multicamOf(clip?.multicam);
  const at = seq && clip && g ? groupTime(seq, clip, g, engine.playing ? engine.frame : frame) : null;
  const cols = g ? Math.ceil(Math.sqrt(g.angles.length)) : 1;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={g ? `Multicam · ${g.name}` : "Multicam"} />
      {!g || at === null ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-xs leading-relaxed text-fg-4">
          Kein Multicam-Clip am Playhead.
          <br />
          Kameras im Medienbrowser auswählen und im Kontextmenü „Multicam-Clip erstellen …“ wählen.
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-1 p-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "minmax(0, 1fr)" }}>
          {g.angles.map((a, i) => (
            <AngleTile key={a.media} index={i} angle={a} asset={mediaById.get(a.media)} time={at - a.offset} rate={rate} active={a.media === clip!.mediaId} />
          ))}
        </div>
      )}
    </div>
  );
}
