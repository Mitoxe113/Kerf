// Project management: health check, relinking moved media, archiving the
// project with its media, Kerf's cache of derived files, watch folders, and
// the metadata of media (editable project fields plus the technical data of
// the file).
// Nothing here changes the project without an explicit action; relinking and
// metadata changes are undoable edits.

import { open } from "@tauri-apps/plugin-dialog";
import { AlertCircle, AlertTriangle, Eye, FolderSearch, Info, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { checkProject, describePixFmt, type Issue } from "../actions/health";
import { openSequence } from "../actions/editing";
import { engine } from "../engine/playback";
import { api, events, isCommandError } from "../lib/ipc";
import { formatBytes } from "../lib/media";
import type { ArchivePlan, ArchiveReport, CacheInfo, CacheKind, EditCommand, MediaAsset, RelinkSearch } from "../lib/types";
import { useEditor } from "../state/editor";
import { fontAvailable, useFonts } from "../state/fonts";
import { edit, reportError, useProject } from "../state/project";
import { toast } from "../state/toasts";
import { folderName, syncWatchFolder, useWatch } from "../state/watch";
import { MediaFields } from "./MediaFields";
import { Button, cx, PanelHeader, Progress, Segmented, Toggle } from "../ui/primitives";

type Tab = "check" | "relink" | "archive" | "cache" | "watch" | "meta";

const SEVERITY = {
  error: { icon: <AlertCircle size={13} className="text-danger" />, label: "Fehler" },
  warning: { icon: <AlertTriangle size={13} className="text-warn" />, label: "Warnung" },
  info: { icon: <Info size={13} className="text-fg-3" />, label: "Hinweis" },
};

// --- health check --------------------------------------------------------------------------

function CheckView({ goRelink }: { goRelink: () => void }) {
  const project = useProject((s) => s.project);
  const fonts = useFonts();
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const issues = useMemo(() => (project ? checkProject(project, { fontAvailable: (f) => fontAvailable(f, fonts) }) : []), [project, fonts]);
  const shown = issues.filter((i) => !ignored.has(i.id));
  const fix = async (i: Issue) => {
    if (i.fix === "relink") return goRelink();
    if (i.sequence) await openSequence(i.sequence);
    if (i.frame != null) engine.seek(i.frame);
    if (i.fix === "closeGap" && i.sequence && i.track && i.frame != null) await edit({ type: "closeGap", sequence: i.sequence, track: i.track, frame: i.frame });
  };
  const counts = { error: 0, warning: 0, info: 0 };
  shown.forEach((i) => counts[i.severity]++);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex items-center gap-3 border-b border-line px-2 py-1.5 text-xs text-fg-3">
        <span>{counts.error} Fehler</span>
        <span>{counts.warning} Warnungen</span>
        <span>{counts.info} Hinweise</span>
        {ignored.size > 0 && (
          <button className="ml-auto hover:text-fg-1" onClick={() => setIgnored(new Set())}>
            {ignored.size} ignorierte zeigen
          </button>
        )}
      </div>
      {!shown.length && <p className="p-3 text-xs text-fg-3">Keine Auffälligkeiten gefunden. Geprüft werden fehlende Medien und Schriften, leere Bereiche, Bildraten, Abmessungen, sehr kurze und deaktivierte Clips. Übersteuerung und Schwarzbilder werden hier nicht gemessen.</p>}
      {shown.map((i) => (
        <div key={i.id} className="flex items-start gap-2 border-b border-line px-2 py-1.5 text-xs">
          <span className="mt-0.5" title={SEVERITY[i.severity].label}>
            {SEVERITY[i.severity].icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-fg-1">{i.title}</div>
            <div className="whitespace-pre-line break-all text-[11px] text-fg-4">{i.detail}</div>
            <div className="mt-1 flex gap-2">
              {i.fix === "relink" && <Button size="sm" onClick={() => void fix(i)}>Neu verknüpfen …</Button>}
              {i.fix === "closeGap" && <Button size="sm" onClick={() => void fix(i)}>Lücke schließen</Button>}
              {(i.fix === "seek" || i.fix === "closeGap") && (
                <Button size="sm" variant="ghost" onClick={() => void (async () => { if (i.sequence) await openSequence(i.sequence); if (i.frame != null) engine.seek(i.frame); })()}>
                  Anzeigen
                </Button>
              )}
            </div>
          </div>
          <button className="text-fg-4 hover:text-fg-1" title="Ignorieren" onClick={() => setIgnored(new Set([...ignored, i.id]))}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

// --- relink ------------------------------------------------------------------------------------

const MATCH: Record<string, string> = { nameAndSize: "Name und Größe", name: "gleicher Name", stem: "anderes Format" };

function RelinkView() {
  const media = useProject((s) => s.project?.media ?? []);
  const missing = media.filter((m) => !m.title && m.status.state === "missing");
  const [dirs, setDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RelinkSearch | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const addDirs = async () => {
    const picked = await open({ directory: true, multiple: true, title: "Ordner zum Durchsuchen" });
    if (picked) setDirs([...new Set([...dirs, ...(Array.isArray(picked) ? picked : [picked])])]);
  };
  const search = async () => {
    setBusy(true);
    try {
      const r = await api.relinkSearch(missing.map((m) => m.id), dirs);
      setResult(r);
      // Preselect only unambiguous, verified matches.
      const pre: Record<string, string> = {};
      for (const s of r.suggestions) {
        const best = s.candidates.filter((c) => c.kind === "nameAndSize" && c.sameDuration !== false);
        if (best.length === 1) pre[s.media] = best[0].path;
      }
      setChoice(pre);
    } catch (e) {
      reportError(e, "Die Suche ist fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    const commands: EditCommand[] = Object.entries(choice).map(([id, path]) => ({ type: "relinkMedia", media: id, path }));
    if (!commands.length) return;
    if (await edit({ type: "batch", label: "relinkMedia", commands })) {
      toast.success(`${commands.length} Medien neu verknüpft`, "Mit Strg+Z rückgängig machbar.");
      setResult(null);
      setChoice({});
    }
  };
  if (!missing.length) return <p className="p-3 text-xs text-fg-3">Alle Medien sind erreichbar.</p>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="space-y-2 border-b border-line px-2 py-2 text-xs">
        <div className="text-fg-2">{missing.length === 1 ? "1 Medium fehlt" : `${missing.length} Medien fehlen`}. Wähle Ordner, in denen Kerf nach gleichnamigen Dateien sucht.</div>
        {dirs.map((d) => (
          <div key={d} className="flex items-center gap-2 text-fg-3">
            <span className="min-w-0 flex-1 truncate">{d}</span>
            <button className="hover:text-fg-1" onClick={() => setDirs(dirs.filter((x) => x !== d))} title="Entfernen">
              <X size={12} />
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void addDirs()}>
            <FolderSearch size={12} /> Ordner hinzufügen …
          </Button>
          <Button size="sm" variant="primary" disabled={!dirs.length || busy} onClick={() => void search()}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : null} Suchen
          </Button>
        </div>
      </div>
      {result && (
        <>
          <div className="px-2 py-1 text-[11px] text-fg-4">
            {result.scanned.toLocaleString("de-DE")} Dateien durchsucht{result.truncated ? " (Grenze erreicht, Suche eingrenzen)" : ""}. Kerfs eigener Cache wird nie vorgeschlagen.
          </div>
          {result.suggestions.map((s) => (
            <div key={s.media} className="border-b border-line px-2 py-1.5 text-xs">
              <div className="text-fg-1">{s.name}</div>
              <div className="truncate text-[11px] text-fg-4" title={s.oldPath}>
                war: {s.oldPath}
              </div>
              {!s.candidates.length && <div className="text-fg-4">Nichts gefunden.</div>}
              {s.candidates.map((c) => (
                <label key={c.path} className="mt-0.5 flex items-center gap-2 text-fg-2">
                  <input type="radio" name={s.media} checked={choice[s.media] === c.path} onChange={() => setChoice({ ...choice, [s.media]: c.path })} />
                  <span className="min-w-0 flex-1 truncate" title={c.path}>
                    {c.path}
                  </span>
                  <span className={cx("shrink-0 text-[11px]", c.kind === "nameAndSize" ? "text-signal" : "text-warn")}>{MATCH[c.kind]}</span>
                  {c.sameDuration != null && <span className={cx("shrink-0 text-[11px]", c.sameDuration ? "text-signal" : "text-danger")}>{c.sameDuration ? "Dauer gleich" : "Dauer anders"}</span>}
                </label>
              ))}
              {choice[s.media] && (
                <button className="mt-0.5 text-[11px] text-fg-4 hover:text-fg-1" onClick={() => setChoice(Object.fromEntries(Object.entries(choice).filter(([k]) => k !== s.media)))}>
                  Auswahl aufheben
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center gap-2 px-2 py-2">
            <Button size="sm" variant="primary" disabled={!Object.keys(choice).length} onClick={() => void apply()}>
              {Object.keys(choice).length === 1 ? "1 Medium" : `${Object.keys(choice).length} Medien`} neu verknüpfen
            </Button>
            <span className="text-[11px] text-fg-4">Vorausgewählt sind nur eindeutige Treffer mit gleichem Namen und gleicher Größe.</span>
          </div>
        </>
      )}
    </div>
  );
}

// --- archive -------------------------------------------------------------------------------------

function ArchiveView() {
  const [includeUnused, setIncludeUnused] = useState(false);
  const [plan, setPlan] = useState<ArchivePlan | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState<ArchiveReport | null>(null);
  const revision = useProject((s) => s.revision);
  useEffect(() => void api.archivePlan({ includeUnused }).then(setPlan).catch((e) => reportError(e)), [includeUnused, revision]);
  useEffect(() => {
    if (!job) return;
    const off = events.archiveProgress((p) => p.job === job && setProgress(p.total ? p.done / p.total : 1));
    return () => void off.then((f) => f());
  }, [job]);
  const run = async () => {
    const dest = await open({ directory: true, title: "Leeren Zielordner für das Archiv wählen" });
    if (!dest || Array.isArray(dest)) return;
    const id = crypto.randomUUID();
    setJob(id);
    setProgress(0);
    setReport(null);
    try {
      setReport(await api.archiveWrite(id, dest, { includeUnused }));
    } catch (e) {
      if (isCommandError(e) && e.code === "cancelled") toast.info("Archivieren abgebrochen", "Bereits kopierte Dateien liegen im Zielordner; die Projektdatei wurde nicht geschrieben.");
      else if (isCommandError(e) && e.code === "folderNotEmpty") toast.error("Der Zielordner ist nicht leer.", "Wähle einen neuen oder leeren Ordner.");
      else if (isCommandError(e) && e.code === "diskFull") toast.error("Nicht genug Speicherplatz am Ziel.", e.message);
      else reportError(e, "Das Archivieren ist fehlgeschlagen.");
    } finally {
      setJob(null);
    }
  };
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto px-2 py-2 text-xs text-fg-2">
      <p className="text-fg-3">Kopiert die verwendeten Medien und LUTs in einen Ordner und legt dort eine Projektdatei mit relativen Pfaden ab. Das geöffnete Projekt bleibt unverändert. Vorschaubilder und Proxys werden am Ziel neu erzeugt.</p>
      <div className="flex items-center justify-between">
        <span>Auch nicht verwendete Medien</span>
        <Toggle checked={includeUnused} onChange={setIncludeUnused} />
      </div>
      {plan && (
        <div className="space-y-1 rounded-sm bg-surface-2 p-2">
          <div>
            {plan.files.length} Dateien, {formatBytes(plan.totalBytes)}
            {plan.unused > 0 && !includeUnused && <span className="text-fg-4"> · {plan.unused} nicht verwendete ausgelassen</span>}
          </div>
          {plan.missing.length > 0 && <div className="text-warn">{plan.missing.length} Dateien fehlen und können nicht kopiert werden.</div>}
          {plan.fonts.length > 0 && <div className="text-fg-3">Schriften (werden nicht kopiert, Weitergabe regelt ihre Lizenz): {plan.fonts.join(", ")}</div>}
        </div>
      )}
      {job ? (
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Progress value={progress} />
          </div>
          <Button size="sm" variant="ghost" onClick={() => void api.analyzeCancel(job)}>
            Abbrechen
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="primary" disabled={!plan} onClick={() => void run()}>
          Archiv erstellen …
        </Button>
      )}
      {report && (
        <div className={cx("rounded-sm p-2", report.verified ? "bg-signal/10" : "bg-danger/10")}>
          <div className="text-fg-1">{report.verified ? "Archiv erstellt und geprüft" : "Archiv erstellt, die Prüfung fand Abweichungen"}</div>
          <div className="break-all text-fg-3">{report.projectFile}</div>
          <div className="text-fg-4">
            {report.copied} Dateien, {formatBytes(report.bytes)}
            {report.missing.length > 0 && ` · ${report.missing.length} fehlende Dateien verweisen weiter auf den alten Ort`}
          </div>
          <Button size="sm" variant="ghost" onClick={() => void api.revealPath(report.projectFile)}>
            Im Ordner zeigen
          </Button>
        </div>
      )}
    </div>
  );
}

// --- cache -------------------------------------------------------------------------------------------

const KIND_NAMES: Record<CacheKind, string> = { proxies: "Proxys", thumbnails: "Vorschaubilder und Filmstreifen", waveforms: "Wellenformen", other: "Sonstiges (rückwärts abgespielter Ton)" };

function WatchView() {
  const folders = useProject((s) => s.project?.watchFolders ?? []);
  const bins = useProject((s) => s.project?.bins ?? []);
  const status = useWatch((s) => s.status);
  const [busy, setBusy] = useState<string | null>(null);
  const currentBin = useEditor((s) => s.currentBin);
  const add = () => {
    const b = bins.find((x) => x.id === currentBin);
    useEditor.getState().set({ dialog: { kind: "watchFolder", bin: b && !b.smart ? b.id : null } });
  };
  const sync = async (id: string) => {
    setBusy(id);
    try {
      const n = await syncWatchFolder(id);
      if (n === null) toast.error("Ordner nicht erreichbar");
      else toast.success(n === 1 ? "1 Medium importiert" : `${n} Medien importiert`);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto px-2 py-2 text-xs text-fg-2">
      <div className="flex items-center gap-2">
        <span className="text-fg-3">Neue Mediendateien in diesen Ordnern werden importiert, solange das Projekt geöffnet ist.</span>
        <Button size="sm" className="ml-auto shrink-0" onClick={add}>
          Ordner überwachen …
        </Button>
      </div>
      {!folders.length && <p className="text-fg-4">Kein Ordner wird überwacht.</p>}
      {folders.map((w) => {
        const st = status[w.id];
        const bin = w.bin ? bins.find((b) => b.id === w.bin)?.name : null;
        return (
          <div key={w.id} className="space-y-1 rounded-sm bg-ground px-2 py-1.5">
            <div className="flex items-center gap-2">
              <Eye size={13} className={st?.missing ? "text-warn" : "text-fg-3"} />
              <span className="min-w-0 flex-1 truncate font-medium text-fg" title={w.path}>
                {folderName(w.path)}
              </span>
              <Button size="sm" disabled={busy === w.id || !!st?.missing} onClick={() => void sync(w.id)} title="Dateien des Ordners importieren, die nicht im Projekt sind">
                Abgleichen
              </Button>
              <button className="text-fg-4 hover:text-danger" title="Überwachung beenden (importierte Medien bleiben)" aria-label={`Überwachung von ${folderName(w.path)} beenden`} onClick={() => void edit({ type: "removeWatchFolder", id: w.id })}>
                <X size={13} />
              </button>
            </div>
            <div className="truncate text-fg-4" title={w.path}>
              {w.path}
            </div>
            <div className="text-fg-3">
              In {bin ? `„${bin}“` : "die oberste Ebene"}
              {w.subfolders ? " · mit Unterordnern" : ""}
              {" · "}
              {!st ? "wird gelesen …" : st.missing ? <span className="text-warn">Ordner nicht erreichbar</span> : st.outside ? `${st.outside} ${st.outside === 1 ? "Datei" : "Dateien"} nicht im Projekt` : "alles im Projekt"}
              {st?.imported ? ` · ${st.imported} in dieser Sitzung importiert` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CacheView() {
  const [info, setInfo] = useState<CacheInfo | null>(null);
  const [kinds, setKinds] = useState<CacheKind[]>(["proxies"]);
  const [includeOpen, setIncludeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => void api.cacheInfo().then(setInfo).catch((e) => reportError(e));
  useEffect(load, []);
  const clear = async () => {
    setBusy(true);
    try {
      const freed = await api.cacheClear(kinds, includeOpen);
      toast.success(`${formatBytes(freed)} freigegeben`, includeOpen ? "Fehlende Dateien des geöffneten Projekts werden neu erzeugt." : undefined);
      load();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!info) return null;
  const selected = info.kinds.filter((k) => kinds.includes(k.kind)).reduce((a, k) => a + (includeOpen ? k.bytes : k.unusedBytes), 0);
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto px-2 py-2 text-xs text-fg-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-fg-4" title={info.root}>
          {info.root}
        </span>
        <button className="text-fg-4 hover:text-fg-1" onClick={load} title="Neu einlesen">
          <RefreshCw size={12} />
        </button>
      </div>
      <div>
        Insgesamt {formatBytes(info.totalBytes)}
        {info.freeBytes != null && <span className={cx(info.freeBytes < 5e9 ? "text-warn" : "text-fg-4")}> · frei auf dem Laufwerk: {formatBytes(info.freeBytes)}</span>}
      </div>
      {info.kinds.map((k) => (
        <label key={k.kind} className="flex items-center gap-2">
          <input type="checkbox" checked={kinds.includes(k.kind)} onChange={() => setKinds(kinds.includes(k.kind) ? kinds.filter((x) => x !== k.kind) : [...kinds, k.kind])} />
          <span className="flex-1">{KIND_NAMES[k.kind]}</span>
          <span className="font-mono text-fg-3">{formatBytes(k.bytes)}</span>
          <span className="w-24 text-right text-[11px] text-fg-4">{formatBytes(k.unusedBytes)} ungenutzt</span>
        </label>
      ))}
      <div className="flex items-center justify-between">
        <span>Auch Dateien des geöffneten Projekts (werden neu erzeugt)</span>
        <Toggle checked={includeOpen} onChange={setIncludeOpen} />
      </div>
      <Button size="sm" variant="primary" disabled={!kinds.length || busy || !selected} onClick={() => void clear()}>
        {formatBytes(selected)} löschen
      </Button>
      <p className="text-[11px] text-fg-4">Gelöscht werden nur Dateien in Kerfs Cache-Ordner, nie Originalmedien oder Projektdateien. Andere Projekte erzeugen fehlende Dateien beim nächsten Öffnen neu.</p>
    </div>
  );
}

// --- metadata ------------------------------------------------------------------------------------------

function MetaRow({ k, v }: { k: string; v: React.ReactNode }) {
  if (v == null || v === "") return null;
  return (
    <div className="flex gap-2 border-b border-line px-2 py-0.5 text-xs">
      <span className="w-36 shrink-0 text-fg-4">{k}</span>
      <span className="min-w-0 flex-1 break-all text-fg-1">{v}</span>
    </div>
  );
}

type Probe = { format?: { format_long_name?: string; bit_rate?: string; tags?: Record<string, string> }; streams?: { codec_type?: string; codec_long_name?: string; tags?: Record<string, string>; [k: string]: unknown }[] };

function MetaView() {
  const selection = useEditor((s) => s.mediaSelection);
  const mediaById = useProject((s) => s.mediaById);
  const selected = useMemo(() => selection.map((id) => mediaById.get(id)).filter((m): m is MediaAsset => !!m), [selection, mediaById]);
  const asset: MediaAsset | undefined = selected[0];
  const [raw, setRaw] = useState<Probe | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setRaw(null);
    setErr(null);
    if (asset && !asset.title) api.mediaMetadata(asset.id).then((r) => setRaw(r as Probe)).catch((e) => setErr(isCommandError(e) ? e.message : String(e)));
  }, [asset?.id, asset?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!asset) return <p className="p-3 text-xs text-fg-4">Wähle ein Medium in der Medienablage aus.</p>;
  const i = asset.info;
  const v = i?.video;
  const a = i?.audio;
  const px = describePixFmt(v?.pixFmt);
  const tags = { ...(raw?.format?.tags ?? {}), ...Object.fromEntries((raw?.streams ?? []).flatMap((s, n) => Object.entries(s.tags ?? {}).map(([k, val]) => [`${s.codec_type ?? "stream"} ${n}: ${k}`, val]))) };
  const timecode = Object.entries(tags).find(([k]) => k.toLowerCase().endsWith("timecode"))?.[1];
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <MediaFields media={selected} />
      {selected.length > 1 && <div className="px-2 pb-1 pt-2 text-[11px] uppercase tracking-wide text-fg-4">Technische Angaben: {asset.name}</div>}
      <MetaRow k="Datei" v={asset.path} />
      <MetaRow k="Container" v={raw?.format?.format_long_name ?? i?.container} />
      <MetaRow k="Dauer" v={i ? `${i.duration.toFixed(3)} s` : null} />
      <MetaRow k="Größe" v={i ? formatBytes(i.sizeBytes) : null} />
      <MetaRow k="Gesamtbitrate" v={i?.bitRate ? `${(i.bitRate / 1e6).toFixed(2)} Mbit/s` : null} />
      {v && (
        <>
          <MetaRow k="Videocodec" v={`${v.codec}${v.profile ? ` (${v.profile})` : ""}`} />
          <MetaRow k="Auflösung" v={`${v.width} × ${v.height}${v.rotation ? `, gedreht ${v.rotation}°` : ""}`} />
          <MetaRow k="Bildrate" v={`${(v.fps.num / v.fps.den).toFixed(3)} fps (${v.fps.num}/${v.fps.den})`} />
          <MetaRow k="Pixelformat" v={v.pixFmt} />
          <MetaRow k="Farbunterabtastung" v={px.subsampling} />
          <MetaRow k="Bittiefe" v={px.bitDepth ? `${px.bitDepth} Bit` : null} />
          <MetaRow k="Farbraum (Matrix)" v={v.color?.space ?? "nicht angegeben"} />
          <MetaRow k="Primärfarben" v={v.color?.primaries ?? "nicht angegeben"} />
          <MetaRow k="Übertragung" v={v.color?.transfer ?? "nicht angegeben"} />
          <MetaRow k="Wertebereich" v={v.color?.range ?? "nicht angegeben"} />
          <MetaRow k="Videobitrate" v={v.bitRate ? `${(v.bitRate / 1e6).toFixed(2)} Mbit/s` : null} />
        </>
      )}
      {a && (
        <>
          <MetaRow k="Audiocodec" v={a.codec} />
          <MetaRow k="Abtastrate" v={`${a.sampleRate} Hz`} />
          <MetaRow k="Kanäle" v={`${a.channels}${a.channelLayout ? ` (${a.channelLayout})` : ""}`} />
          <MetaRow k="Audiobitrate" v={a.bitRate ? `${Math.round(a.bitRate / 1000)} kbit/s` : null} />
        </>
      )}
      <MetaRow k="Timecode" v={timecode ?? "nicht angegeben"} />
      {err && <p className="p-2 text-xs text-warn">{err}</p>}
      {Object.keys(tags).length > 0 && <div className="px-2 pb-1 pt-2 text-[11px] uppercase tracking-wide text-fg-4">Weitere Angaben der Datei</div>}
      {Object.entries(tags).map(([k, val]) => (
        <MetaRow key={k} k={k} v={String(val)} />
      ))}
    </div>
  );
}

export function ProjectPanel() {
  const [tab, setTab] = useState<Tab>("check");
  const metaRequest = useEditor((s) => s.projectMeta);
  useEffect(() => {
    if (!metaRequest) return;
    setTab("meta");
    useEditor.getState().set({ projectMeta: false });
  }, [metaRequest]);
  const missing = useProject((s) => s.project?.media.filter((m) => !m.title && m.status.state === "missing").length ?? 0);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader>
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: "check", label: "Prüfung" },
            { value: "relink", label: missing ? `Verknüpfen (${missing})` : "Verknüpfen" },
            { value: "archive", label: "Archiv" },
            { value: "cache", label: "Cache" },
            { value: "watch", label: "Ordner" },
            { value: "meta", label: "Metadaten" },
          ]}
        />
      </PanelHeader>
      {tab === "check" ? <CheckView goRelink={() => setTab("relink")} /> : tab === "relink" ? <RelinkView /> : tab === "archive" ? <ArchiveView /> : tab === "cache" ? <CacheView /> : tab === "watch" ? <WatchView /> : <MetaView />}
    </div>
  );
}
