import { CheckCircle2, Cpu, Info, Loader2, XCircle } from "lucide-react";
import { formatRate } from "../lib/time";
import { useEditor } from "../state/editor";
import { useActiveSequence, useProject } from "../state/project";
import { useToasts } from "../state/toasts";
import { useDragGhost, usePayloadGhost } from "../ui/dnd";
import { cx } from "../ui/primitives";

export function StatusBar() {
  const analyzing = useProject((s) => s.project?.media.filter((m) => m.status.state === "analyzing").length ?? 0);
  const proxyJobs = useProject((s) => s.proxyJobs);
  const exports = useProject((s) => s.exports);
  const info = useProject((s) => s.appInfo);
  const seq = useActiveSequence();
  const useProxies = useEditor((s) => s.useProxies);
  const proxies = Object.values(proxyJobs);
  const running = exports.find((j) => j.status === "running");
  const queued = exports.filter((j) => j.status === "queued").length;
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-ground px-3 text-[10.5px] text-fg-3">
      <span className={cx("flex items-center gap-1.5", !info?.ffmpeg && "text-danger")} title={info?.ffmpeg ?? undefined}>
        <span className={cx("h-1.5 w-1.5 rounded-full", info?.ffmpeg ? "bg-signal" : "bg-danger")} />
        {info?.ffmpeg ? `FFmpeg ${info.ffmpeg.match(/version (\S+)/)?.[1]?.split("-")[0] ?? ""}` : "FFmpeg fehlt"}
      </span>
      {info?.hwEncoders && info.hwEncoders.length > 0 && (
        <span className="flex items-center gap-1">
          <Cpu size={11} /> {info.hwEncoders.some((e) => e.includes("nvenc")) ? "NVENC" : info.hwEncoders.some((e) => e.includes("qsv")) ? "Quick Sync" : "AMF"}
        </span>
      )}
      {analyzing > 0 && (
        <span className="flex items-center gap-1.5 text-fg-2">
          <Loader2 size={11} className="animate-spin" /> {analyzing} {analyzing === 1 ? "Datei wird" : "Dateien werden"} analysiert
        </span>
      )}
      {proxies.length > 0 && (
        <span className="flex items-center gap-1.5 text-fg-2">
          <Loader2 size={11} className="animate-spin" /> Proxy {Math.round(Math.max(...proxies) * 100)} %{proxies.length > 1 && ` (+${proxies.length - 1})`}
        </span>
      )}
      {running && (
        <span className="flex items-center gap-1.5 text-signal">
          <Loader2 size={11} className="animate-spin" /> Export {Math.round(running.progress.fraction * 100)} %{queued > 0 && ` · ${queued} in Warteschlange`}
        </span>
      )}
      <span className="ml-auto flex items-center gap-3">
        {useProxies && <span className="text-warn">Proxy-Vorschau</span>}
        <SaveStatus />
        {seq && (
          <span className="tc">
            {seq.settings.width}×{seq.settings.height} · {formatRate(seq.settings.fps)} fps · {seq.settings.sampleRate / 1000} kHz
          </span>
        )}
      </span>
    </footer>
  );
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

/** Saved / unsaved, plus when the last recovery snapshot was written. */
function SaveStatus() {
  const dirty = useProject((s) => s.dirty);
  const path = useProject((s) => s.path);
  const savedAt = useProject((s) => s.savedAt);
  const autosavedAt = useProject((s) => s.autosavedAt);
  if (!dirty) return path ? <span title={path}>Gespeichert{savedAt && ` ${clock(savedAt)}`}</span> : null;
  return (
    <span className="flex items-center gap-1.5" title="Wiederherstellungs-Snapshots schützen vor Datenverlust bei einem Absturz; sie ersetzen nicht das Speichern.">
      <span className="h-1.5 w-1.5 rounded-full bg-warn" />
      {path ? "Ungespeicherte Änderungen" : "Nicht gespeichert"}
      {autosavedAt && <span className="text-fg-4">· gesichert {clock(autosavedAt)}</span>}
    </span>
  );
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-9 right-3 z-[950] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="anim-toast pointer-events-auto flex gap-2.5 rounded-md bg-raised p-3 shadow-pop" onClick={() => dismiss(t.id)}>
          {t.kind === "error" ? <XCircle size={15} className="mt-px shrink-0 text-danger" /> : t.kind === "success" ? <CheckCircle2 size={15} className="mt-px shrink-0 text-signal" /> : <Info size={15} className="mt-px shrink-0 text-info" />}
          <div className="min-w-0">
            <div className="text-sm text-fg">{t.title}</div>
            {t.detail && <div className="mt-0.5 break-words text-xs text-fg-3">{t.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DragGhost() {
  const drag = useDragGhost((s) => s.drag);
  const payload = usePayloadGhost((s) => s.drag);
  const media = useProject((s) => s.mediaById);
  const sequences = useProject((s) => s.project?.sequences);
  if (payload)
    return (
      <div className="pointer-events-none fixed z-[990] rounded-sm bg-raised px-2 py-1 text-xs text-fg shadow-pop ring-1 ring-signal" style={{ left: payload.x + 12, top: payload.y + 12 }}>
        {payload.label}
        {payload.hint && <span className="text-fg-3"> · {payload.hint}</span>}
      </div>
    );
  if (!drag) return null;
  const first = media.get(drag.media[0]) ?? sequences?.find((q) => q.id === drag.media[0]);
  return (
    <div className="pointer-events-none fixed z-[990] rounded-sm bg-raised px-2 py-1 text-xs text-fg shadow-pop ring-1 ring-signal" style={{ left: drag.x + 12, top: drag.y + 12 }}>
      {first?.name}
      {drag.media.length > 1 && <span className="text-fg-3"> +{drag.media.length - 1}</span>}
    </div>
  );
}
