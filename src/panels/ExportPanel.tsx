import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, CircleSlash, FolderOpen, Loader2, Play, RotateCcw, Save, ScrollText, Trash2, TriangleAlert, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { HDR_NOTE, hdrMediaIn } from "../actions/health";
import { confirm, prompt } from "../actions/project";
import { batchOutputs } from "../lib/batch";
import { api } from "../lib/ipc";
import { formatBytes } from "../lib/media";
import { formatDuration, formatRate, fpsOf, framesToSeconds, STANDARD_RATES } from "../lib/time";
import type { AudioCodec, ExportJob, ExportSettings, Rational, RateControl, Sequence, SubtitleOutput, VideoCodec } from "../lib/types";
import { useEditor } from "../state/editor";
import { reportError, useActiveSequence, useProject } from "../state/project";
import { burnInFiles, titleFiles, titleSequences } from "../engine/text";
import { fontAvailable, loadFonts, useFonts } from "../state/fonts";
import { toast } from "../state/toasts";
import { engine } from "../engine/playback";
import { Button, cx, Field, IconButton, PanelHeader, Progress, Section, Segmented, Select, Toggle, NumberField } from "../ui/primitives";

interface Preset {
  id: string;
  label: string;
  group: string;
  codec: VideoCodec;
  /** Fixed, or chosen from the sequence frame rate. */
  rate: RateControl | ((fps: number) => RateControl);
  audio: AudioCodec;
  audioKbps?: number;
  /** Shorter frame edge in pixels; the sequence aspect is kept. */
  shortEdge?: number;
  /** Also scale smaller sequences up to `shortEdge` (YouTube serves 4K uploads at higher quality). */
  upscale?: boolean;
  maxFps?: number;
  hint?: string;
  /** Saved by the user: complete settings without the file. */
  custom?: Omit<ExportSettings, "output" | "useInOut">;
}

const SOCIAL_HINT = "Für Reels und TikTok am besten eine Hochformat-Sequenz (9:16) anlegen; andere Formate werden mit Balken eingepasst.";

const PRESETS: Preset[] = [
  { id: "master", group: "Allgemein", label: "H.264 · Master (hohe Qualität)", codec: "h264", rate: { mode: "quality", crf: 16 }, audio: "aac" },
  { id: "web", group: "Allgemein", label: "H.264 · Web 1080p", codec: "h264", rate: { mode: "bitrate", kbps: 12000 }, audio: "aac", shortEdge: 1080 },
  { id: "social", group: "Allgemein", label: "H.264 · Kompakt 720p", codec: "h264", rate: { mode: "bitrate", kbps: 5000 }, audio: "aac", shortEdge: 720 },
  { id: "hevc", group: "Allgemein", label: "HEVC · Hohe Qualität", codec: "hevc", rate: { mode: "quality", crf: 20 }, audio: "aac" },
  { id: "av1", group: "Allgemein", label: "AV1 · Hohe Qualität", codec: "av1", rate: { mode: "quality", crf: 30 }, audio: "aac" },
  { id: "youtube", group: "Plattformen", label: "YouTube 1080p", codec: "h264", rate: (fps) => ({ mode: "bitrate", kbps: fps > 30 ? 12000 : 8000 }), audio: "aac", shortEdge: 1080 },
  {
    id: "youtube4k",
    group: "Plattformen",
    label: "YouTube 4K (UHD)",
    codec: "h264",
    rate: (fps) => ({ mode: "bitrate", kbps: fps > 30 ? 68000 : 45000 }),
    audio: "aac",
    shortEdge: 2160,
    upscale: true,
    hint: "Kleinere Sequenzen werden auf 2160 Pixel hochskaliert – YouTube liefert 4K-Uploads mit besserer Bildqualität aus.",
  },
  { id: "instagram", group: "Plattformen", label: "Instagram Reels / Feed", codec: "h264", rate: { mode: "bitrate", kbps: 8000 }, audio: "aac", audioKbps: 256, shortEdge: 1080, maxFps: 60, hint: SOCIAL_HINT },
  { id: "tiktok", group: "Plattformen", label: "TikTok", codec: "h264", rate: { mode: "bitrate", kbps: 10000 }, audio: "aac", audioKbps: 256, shortEdge: 1080, maxFps: 60, hint: SOCIAL_HINT },
  { id: "prores", group: "Mezzanine", label: "ProRes 422", codec: "proRes422", rate: { mode: "quality", crf: 0 }, audio: "pcm" },
  { id: "proreshq", group: "Mezzanine", label: "ProRes 422 HQ", codec: "proRes422Hq", rate: { mode: "quality", crf: 0 }, audio: "pcm" },
  { id: "dnxhrhq", group: "Mezzanine", label: "DNxHR HQ", codec: "dnxhrHq", rate: { mode: "quality", crf: 0 }, audio: "pcm" },
  { id: "dnxhrhqx", group: "Mezzanine", label: "DNxHR HQX (10 Bit)", codec: "dnxhrHqx", rate: { mode: "quality", crf: 0 }, audio: "pcm" },
];

const CODECS: { value: VideoCodec; label: string }[] = [
  { value: "h264", label: "H.264 / AVC" },
  { value: "hevc", label: "H.265 / HEVC" },
  { value: "proRes422", label: "Apple ProRes 422" },
  { value: "proRes422Hq", label: "Apple ProRes 422 HQ" },
  { value: "dnxhrHq", label: "Avid DNxHR HQ" },
  { value: "dnxhrHqx", label: "Avid DNxHR HQX (10 Bit)" },
  { value: "av1", label: "AV1 (SVT-AV1)" },
];

/** Intra-frame codecs with a fixed rate per profile, written into .mov. */
const isMezzanine = (c: VideoCodec) => c === "proRes422" || c === "proRes422Hq" || c === "dnxhrHq" || c === "dnxhrHqx";
const isDnxhr = (c: VideoCodec) => c === "dnxhrHq" || c === "dnxhrHqx";
const extFor = (s: Pick<ExportSettings, "videoCodec" | "audioCodec">) => (isMezzanine(s.videoCodec) || s.audioCodec === "pcm" ? "mov" : "mp4");
const AV1_ENCODER = "libsvtav1";

/** Why these settings cannot be exported with this FFmpeg, or null. */
function blockedBy(s: ExportSettings, swEncoders: string[] | null | undefined): string | null {
  if (s.videoCodec === "av1" && !swEncoders?.includes(AV1_ENCODER)) {
    return swEncoders === null || swEncoders === undefined ? "Die Encoder von FFmpeg werden noch erkannt …" : `Das installierte FFmpeg enthält keinen AV1-Encoder (${AV1_ENCODER}). Für AV1 wird ein FFmpeg-Build mit SVT-AV1 gebraucht.`;
  }
  if (isDnxhr(s.videoCodec) && (s.width < 256 || s.height < 120)) return "DNxHR braucht mindestens 256 × 120 Pixel.";
  return null;
}
const LAST_DIR_KEY = "kerf.export.dir";
const CUSTOM_KEY = "kerf.export.presets";

function loadCustom(): Preset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]") as { id: string; label: string; settings: Preset["custom"] }[];
    return raw.map((p) => ({ id: p.id, label: p.label, group: "Eigene", codec: p.settings!.videoCodec, rate: p.settings!.rate, audio: p.settings!.audioCodec, custom: p.settings }));
  } catch {
    return [];
  }
}

function storeCustom(list: Preset[]) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list.map((p) => ({ id: p.id, label: p.label, settings: p.custom }))));
  } catch {
    // Storage unavailable: the preset lasts for this session only.
  }
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

function defaultSettings(seq: Sequence, preset: Preset, output: string): ExportSettings {
  if (preset.custom) return { ...preset.custom, output, useInOut: false };
  let { width: w, height: h } = seq.settings;
  const short = Math.min(w, h);
  if (preset.shortEdge && (short > preset.shortEdge || preset.upscale)) {
    const k = preset.shortEdge / short;
    w = even(w * k);
    h = even(h * k);
  }
  const fps = fpsOf(seq.settings.fps);
  return {
    output,
    videoCodec: preset.codec,
    hardware: false,
    width: w,
    height: h,
    fps: preset.maxFps && fps > preset.maxFps + 0.01 ? { num: preset.maxFps, den: 1 } : seq.settings.fps,
    rate: typeof preset.rate === "function" ? preset.rate(fps) : preset.rate,
    audioCodec: preset.audio,
    audioBitrateKbps: preset.audioKbps ?? 320,
    sampleRate: seq.settings.sampleRate,
    audioChannels: 2,
    useInOut: false,
    segmented: false,
  };
}

/**
 * Expected file size in bytes. Exact for bitrate modes; for quality modes a
 * rough bits-per-pixel guess (content decides the real size).
 */
function estimateBytes(s: ExportSettings, seconds: number): { bytes: number; exact: boolean } {
  const audio = s.audioCodec === "pcm" ? s.sampleRate * 16 * s.audioChannels : s.audioBitrateKbps * 1000;
  const pixels = s.width * s.height * fpsOf(s.fps);
  let video: number;
  let exact = true;
  if (isMezzanine(s.videoCodec)) {
    // DNxHR HQ and HQX measured with FFmpeg's encoder: 3.54 bits per pixel at 360p to 1080p.
    video = pixels * (s.videoCodec === "proRes422" ? 2.37 : 3.54);
    exact = false;
  } else if (s.rate.mode !== "quality") {
    video = s.rate.kbps * 1000;
  } else if (s.videoCodec === "av1") {
    // SVT-AV1 preset 8 on two synthetic 720p sources: 0.12 and 0.20 bits per pixel at CRF 30, about half per 12 CRF more.
    video = pixels * 0.1 * Math.pow(2, (30 - s.rate.crf) / 12);
    exact = false;
  } else {
    video = pixels * (s.videoCodec === "hevc" ? 0.06 : 0.1) * Math.pow(2, (18 - s.rate.crf) / 6);
    exact = false;
  }
  return { bytes: ((video + audio) * seconds) / 8, exact };
}

const LOUDNESS_PRESETS = [
  { value: -14, label: "−14 LUFS · Streaming" },
  { value: -16, label: "−16 LUFS · Podcast" },
  { value: -23, label: "−23 LUFS · EBU R128" },
  { value: -24, label: "−24 LUFS · ATSC A/85" },
];

const hwFor = (codec: VideoCodec, encoders: string[] | null) =>
  (encoders ?? []).filter((e) => e.startsWith(codec === "hevc" ? "hevc_" : codec === "h264" ? "h264_" : "none"));

const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

export function ExportPanel() {
  const seq = useActiveSequence();
  const appInfo = useProject((s) => s.appInfo);
  const jobs = useProject((s) => s.exports);
  const [custom, setCustom] = useState(loadCustom);
  const presets = useMemo(() => [...PRESETS, ...custom], [custom]);
  const [presetId, setPresetId] = useState("master");
  const preset = presets.find((p) => p.id === presetId) ?? PRESETS[0];
  const [s, setS] = useState<ExportSettings | null>(null);
  const [free, setFree] = useState<number | null>(null);
  const [subs, setSubs] = useState<{ burn: boolean; sidecar: "srt" | "vtt" | null; embed: boolean }>({ burn: true, sidecar: null, embed: false });
  const [batch, setBatch] = useState<string[]>([]);
  const [batchDir, setBatchDir] = useState(() => {
    try {
      return localStorage.getItem(LAST_DIR_KEY) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    if (!seq) return;
    setS((cur) => {
      let output = cur?.output ?? "";
      if (!output) {
        try {
          const dir = localStorage.getItem(LAST_DIR_KEY);
          if (dir) output = `${dir}\\${seq.name}.mp4`;
        } catch {
          // ignore
        }
      }
      return defaultSettings(seq, preset, output);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq?.id, presetId]);

  // Free space on the target drive (re-checked when the folder changes).
  const outDir = s?.output ? dirOf(s.output) : "";
  useEffect(() => {
    if (!outDir) return setFree(null);
    let live = true;
    void api.diskFree(outDir).then((b) => live && setFree(b), () => live && setFree(null));
    return () => {
      live = false;
    };
  }, [outDir]);

  const hw = useMemo(() => (s ? hwFor(s.videoCodec, appInfo?.hwEncoders ?? null) : []), [s, appInfo]);
  if (!seq || !s) return null;
  const upd = (p: Partial<ExportSettings>) => setS({ ...s, ...p });
  const range = s.useInOut ? [seq.inPoint ?? 0, seq.outPoint ?? engine.duration] : [0, engine.duration];
  const seconds = framesToSeconds(Math.max(0, range[1] - range[0]), seq.settings.fps);
  const size = estimateBytes(s, seconds);
  const tight = free !== null && size.bytes > free * 0.95;
  const ext = extFor(s);
  const blocked = blockedBy(s, appInfo?.swEncoders);
  const kbps = s.rate.mode === "quality" ? 16000 : s.rate.kbps;

  const chooseOutput = async () => {
    const path = await save({
      defaultPath: s.output || `${seq.name}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return;
    upd({ output: path });
    try {
      localStorage.setItem(LAST_DIR_KEY, dirOf(path));
    } catch {
      // ignore
    }
  };

  // Checks before rendering: free space, missing fonts, licence hints. False = the user stopped.
  const preflight = async (dir: string, bytes: number, exact: boolean): Promise<boolean> => {
    const room = await api.diskFree(dir).catch(() => null);
    if (room !== null && bytes > room * 0.95) {
      const go = await confirm({
        title: "Wenig Speicherplatz",
        body: `Der Export braucht ${exact ? "" : "etwa "}${formatBytes(bytes)}, auf dem Ziellaufwerk sind nur ${formatBytes(room)} frei. Ein voller Datenträger bricht den Export ab.`,
        confirm: "Trotzdem starten",
        danger: true,
      });
      if (go !== true) return false;
    }
    // Never substitute fonts silently: list titles whose font is not available.
    await loadFonts();
    const fontState = useFonts.getState();
    const missing = new Set<string>();
    for (const a of useProject.getState().mediaById.values()) if (a.title && fontAvailable(a.title.style.font, fontState) === false) missing.add(a.title.style.font);
    if (seq.subtitles.cues.length && subs.burn && fontAvailable(seq.subtitles.style.font, fontState) === false) missing.add(seq.subtitles.style.font);
    if (missing.size) {
      const go = await confirm({
        title: "Schriften fehlen",
        body: `Nicht vorhanden: ${[...missing].join(", ")}. Betroffene Titel und Untertitel werden mit der Ersatzschrift Inter Variable gerendert. Die Schrift kann im Titel-Inspektor importiert werden.`,
        confirm: "Mit Ersatzschrift exportieren",
      });
      if (go !== true) return false;
    }
    // HDR is exported as it is, without tone mapping.
    const project = useProject.getState().project;
    const hdr = project ? hdrMediaIn(project, seq.id) : [];
    if (hdr.length) {
      const names = hdr.slice(0, 5).map((m) => m.name).join(", ") + (hdr.length > 5 ? ` und ${hdr.length - 5} weitere` : "");
      const go = await confirm({ title: "HDR-Material in der Sequenz", body: `${names}. ${HDR_NOTE}`, confirm: "Trotzdem exportieren" });
      if (go !== true) return false;
    }
    // License hints for downloaded assets (information only; Kerf cannot clear rights).
    const files = (useProject.getState().project?.media ?? []).filter((m) => m.path && !m.title).map((m) => m.path);
    const lic = await api.licenseEntries(files).catch(() => []);
    const notCommercial = lic.filter((e) => e.asset && e.asset.commercial !== "yes").length;
    const credits = lic.filter((e) => e.asset?.attributionRequired).length;
    if (notCommercial || credits) {
      toast.info(
        "Lizenzhinweise",
        [notCommercial && `${notCommercial} heruntergeladene Medien ohne ausdrückliche Erlaubnis zur kommerziellen Nutzung`, credits && `${credits} verlangen eine Namensnennung`].filter(Boolean).join(", ") +
          ". Details im Lizenzbericht (Stockmedien).",
      );
    }
    return true;
  };

  // Titles, animated titles and burned-in subtitles, drawn once for every job of a start.
  const renderInputs = async (): Promise<Pick<ExportSettings, "subtitles" | "titleFiles" | "titleSequences">> => {
    const titles = await titleFiles(seq, useProject.getState().mediaById);
    // Animated titles frame by frame (also inside nested sequences; clip ids are unique).
    const titleSeqs: Record<string, string[]> = {};
    for (const q of useProject.getState().project?.sequences ?? [seq]) Object.assign(titleSeqs, await titleSequences(q, useProject.getState().mediaById));
    let subtitles: SubtitleOutput | undefined;
    if (seq.subtitles.cues.length && (subs.burn || subs.sidecar || subs.embed)) {
      const files = subs.burn ? await burnInFiles(seq, [range[0], range[1]]) : { burn: [], blank: null };
      subtitles = { ...files, sidecar: subs.sidecar, embed: subs.embed };
    }
    return { subtitles, titleFiles: titles, titleSequences: titleSeqs };
  };

  const start = async () => {
    let output = s.output;
    if (!output) {
      const path = await save({ defaultPath: `${seq.name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (!path) return;
      output = path;
      upd({ output });
    }
    output = output.replace(/\.(mp4|mov|m4v)$/i, "") + "." + ext;
    if (!(await preflight(dirOf(output), size.bytes, size.exact))) return;
    try {
      const job = await api.exportStart(seq.id, { ...s, output, hardware: s.hardware && hw.length > 0, ...(await renderInputs()) });
      useProject.getState().upsertExport(job);
      toast.info("Export gestartet", output.split(/[\\/]/).pop());
    } catch (e) {
      reportError(e);
    }
  };

  // Batch: one job per chosen preset, into one folder; range, subtitles, chapters and loudness as set above.
  const batchItems = presets.filter((p) => batch.includes(p.id));
  const batchJobs = batchItems.map((p) => {
    const b = defaultSettings(seq, p, "");
    return { preset: p, settings: { ...b, useInOut: s.useInOut, chapters: s.chapters, loudness: s.loudness }, ext: extFor(b) };
  });
  const batchBytes = batchJobs.reduce((a, j) => a + estimateBytes(j.settings, seconds).bytes, 0);
  const batchBlocked = batchJobs.map((j) => ({ label: j.preset.label, why: blockedBy(j.settings, appInfo?.swEncoders) })).find((j) => j.why);
  const startBatch = async () => {
    if (batchBlocked) return;
    let dir = batchDir;
    if (!dir) {
      const picked = await openDialog({ directory: true, title: "Zielordner für den Stapel-Export" });
      if (typeof picked !== "string") return;
      dir = picked;
      setBatchDir(dir);
    }
    const outputs = batchOutputs(dir, seq.name, batchJobs.map((j) => ({ label: j.preset.label, ext: j.ext })));
    const existing = await api.existingPaths(outputs).catch(() => [] as string[]);
    if (existing.length) {
      const go = await confirm({
        title: "Dateien ersetzen?",
        body: `${existing.length === 1 ? "Diese Datei gibt es" : `Diese ${existing.length} Dateien gibt es`} schon: ${existing.map((p) => p.split(/[\\/]/).pop()).join(", ")}. Der Export ersetzt sie.`,
        confirm: "Ersetzen",
        danger: true,
      });
      if (go !== true) return;
    }
    if (!(await preflight(dir, batchBytes, batchJobs.every((j) => estimateBytes(j.settings, seconds).exact)))) return;
    let started = 0;
    try {
      const inputs = await renderInputs();
      for (const [i, j] of batchJobs.entries()) {
        // Saved presets bring their own hardware choice; built-in ones follow the switch above.
        const hwOk = (j.preset.custom ? j.settings.hardware : s.hardware) && hwFor(j.settings.videoCodec, appInfo?.hwEncoders ?? null).length > 0;
        const job = await api.exportStart(seq.id, { ...j.settings, output: outputs[i], hardware: hwOk, ...inputs });
        useProject.getState().upsertExport(job);
        started++;
      }
      toast.info("Stapel-Export gestartet", `${started} ${started === 1 ? "Auftrag" : "Aufträge"} in der Render-Warteschlange`);
    } catch (e) {
      if (started) toast.info("Stapel-Export unvollständig", `${started} von ${batchJobs.length} Aufträgen wurden hinzugefügt.`);
      reportError(e);
    }
  };

  const savePreset = async () => {
    const name = await prompt({ title: "Export-Vorgabe speichern", label: "Name", value: `${CODECS.find((c) => c.value === s.videoCodec)?.label.split(" ")[0]} ${s.height}p`, confirm: "Speichern" });
    if (!name?.trim()) return;
    const { output: _o, useInOut: _u, ...rest } = s;
    const p: Preset = { id: `custom-${Date.now().toString(36)}`, label: name.trim(), group: "Eigene", codec: s.videoCodec, rate: s.rate, audio: s.audioCodec, custom: rest };
    const list = [...custom, p];
    setCustom(list);
    storeCustom(list);
    setPresetId(p.id);
  };

  const deletePreset = () => {
    const list = custom.filter((p) => p.id !== presetId);
    setCustom(list);
    storeCustom(list);
    setPresetId("master");
  };

  const resolutions = [
    { value: `${seq.settings.width}x${seq.settings.height}`, label: `Sequenz (${seq.settings.width} × ${seq.settings.height})` },
    ...[2160, 1440, 1080, 720, 540]
      .filter((e) => e < Math.min(seq.settings.width, seq.settings.height))
      .map((e) => {
        const k = e / Math.min(seq.settings.width, seq.settings.height);
        const w = even(seq.settings.width * k);
        const h = even(seq.settings.height * k);
        return { value: `${w}x${h}`, label: `${w} × ${h}` };
      }),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Export" />
      <div className="min-h-0 flex-1 overflow-auto">
        <Section title="Vorgabe">
          <Field label="Preset">
            <Select
              width={220}
              value={presetId}
              onChange={setPresetId}
              options={presets.map((p) => ({ value: p.id, label: p.label, group: p.group }))}
            />
            <IconButton icon={<Save size={13} />} size={24} label="Aktuelle Einstellungen als Vorgabe speichern" onClick={() => void savePreset()} />
            {preset.custom && <IconButton icon={<Trash2 size={13} />} size={24} label="Vorgabe löschen" onClick={deletePreset} />}
          </Field>
          {preset.hint && <p className="-mt-1 mb-1 text-[10.5px] leading-snug text-fg-4">{preset.hint}</p>}
          <Field label="Datei">
            <button onClick={() => void chooseOutput()} className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm bg-field px-2 text-left text-xs text-fg-2 hover:bg-hover" title={s.output}>
              <FolderOpen size={12} className="shrink-0 text-fg-3" />
              <span className="truncate">{s.output ? s.output.split(/[\\/]/).pop() : "Speicherort wählen …"}</span>
            </button>
          </Field>
          <Field label="Bereich">
            <Segmented
              size="sm"
              value={s.useInOut ? "inout" : "all"}
              onChange={(v) => upd({ useInOut: v === "inout" })}
              options={[
                { value: "all", label: "Ganze Sequenz" },
                { value: "inout", label: "In bis Out" },
              ]}
            />
          </Field>
        </Section>
        <Section title="Video">
          <Field label="Codec">
            <Select
              width={180}
              value={s.videoCodec}
              onChange={(v) =>
                upd({
                  videoCodec: v,
                  hardware: false,
                  ...(isMezzanine(v) ? { audioCodec: "pcm" } : {}),
                  // AV1 goes into .mp4 (AAC), without CBR, and its CRF scale runs to 63.
                  ...(v === "av1" ? { audioCodec: "aac", rate: s.rate.mode === "quality" ? { mode: "quality", crf: 30 } : { mode: "bitrate", kbps } } : {}),
                  ...(s.videoCodec === "av1" && v !== "av1" && s.rate.mode === "quality" ? { rate: { mode: "quality", crf: 18 } } : {}),
                })
              }
              options={CODECS}
            />
          </Field>
          <Field label="Hardware">
            <Toggle label="Hardware-Encoder" checked={s.hardware && hw.length > 0} onChange={(v) => upd({ hardware: v })} />
            <span className="truncate text-xs text-fg-3">
              {hw.length ? hw.join(", ").replace(/_/g, " ").toUpperCase() : appInfo?.hwEncoders === null ? "wird erkannt …" : "nicht verfügbar"}
            </span>
          </Field>
          <Field label="Segmentiert">
            <Toggle label="Segmentiert rendern" checked={!!s.segmented} onChange={(v) => upd({ segmented: v })} />
            <span
              className="truncate text-xs text-fg-3"
              title="Das Bild wird in Teilen gleichzeitig gerendert und ohne neue Kodierung zusammengefügt, der Ton in einem Stück daneben. Schneller bei aufwendigen Timelines (Effekte, animierte Transformationen, viele Ebenen); bei einfachen Schnitten lastet FFmpeg die CPU schon allein aus. Ab 20 s Länge und 4 Kernen, nicht mit Hardware-Encoder oder konstanter Bitrate."
            >
              {s.hardware && hw.length > 0 && !isMezzanine(s.videoCodec) ? "nicht mit Hardware-Encoder" : s.rate.mode === "constant" && !isMezzanine(s.videoCodec) ? "nicht bei CBR" : "für aufwendige Timelines"}
            </span>
          </Field>
          <Field label="Auflösung">
            <Select
              width={200}
              value={`${s.width}x${s.height}`}
              onChange={(v) => {
                const [w, h] = v.split("x").map(Number);
                upd({ width: w, height: h });
              }}
              options={resolutions.some((r) => r.value === `${s.width}x${s.height}`) ? resolutions : [...resolutions, { value: `${s.width}x${s.height}`, label: `${s.width} × ${s.height}` }]}
            />
          </Field>
          <Field label="Bildrate">
            <Select
              width={140}
              value={`${s.fps.num}/${s.fps.den}`}
              onChange={(v) => {
                const [num, den] = v.split("/").map(Number);
                upd({ fps: { num, den } as Rational });
              }}
              options={[
                { value: `${seq.settings.fps.num}/${seq.settings.fps.den}`, label: `Sequenz (${formatRate(seq.settings.fps)})` },
                ...STANDARD_RATES.filter((r) => r.rate.num / r.rate.den !== seq.settings.fps.num / seq.settings.fps.den).map((r) => ({ value: `${r.rate.num}/${r.rate.den}`, label: `${r.label} fps` })),
              ]}
            />
          </Field>
          {!isMezzanine(s.videoCodec) && (
            <>
              <Field label="Steuerung">
                <Segmented
                  size="sm"
                  value={s.rate.mode}
                  onChange={(m) => upd({ rate: m === "quality" ? { mode: "quality", crf: s.videoCodec === "av1" ? 30 : 18 } : { mode: m, kbps } })}
                  options={[
                    { value: "quality" as const, label: "Qualität", title: "Konstante Qualität (CRF): Größe richtet sich nach dem Inhalt" },
                    { value: "bitrate" as const, label: "VBR", title: s.videoCodec === "av1" ? "Variable Bitrate um den Zielwert" : "Variable Bitrate um den Zielwert (Spitzen bis 1,5×)" },
                    ...(s.videoCodec === "av1" ? [] : [{ value: "constant" as const, label: "CBR", title: "Konstante Bitrate, z. B. für Streaming-Ingest oder Sendeabwicklung" }]),
                  ]}
                />
              </Field>
              {s.rate.mode === "quality" ? (
                <Field label="Qualität (CRF)">
                  <NumberField label="CRF" value={s.rate.crf} min={s.videoCodec === "av1" ? 1 : 0} max={s.videoCodec === "av1" ? 63 : 40} step={0.25} width={60} onCommit={(v) => upd({ rate: { mode: "quality", crf: Math.round(v) } })} />
                  <span className="text-xs text-fg-4">niedriger = besser</span>
                </Field>
              ) : (
                <Field label="Bitrate">
                  <NumberField label="Bitrate" value={s.rate.kbps / 1000} min={0.5} max={400} step={0.1} precision={1} unit=" Mbit/s" width={96} onCommit={(v) => upd({ rate: { mode: s.rate.mode === "constant" ? "constant" : "bitrate", kbps: Math.round(v * 1000) } })} />
                </Field>
              )}
            </>
          )}
        </Section>
        <Section title="Audio">
          <Field label="Codec">
            <Segmented
              size="sm"
              value={s.audioCodec}
              onChange={(v) => upd({ audioCodec: v })}
              options={[
                { value: "aac" as const, label: "AAC" },
                // AV1 goes into .mp4, which holds no PCM.
                ...(s.videoCodec === "av1" ? [] : [{ value: "pcm" as const, label: "PCM (MOV)" }]),
              ]}
            />
          </Field>
          {s.audioCodec === "aac" && (
            <Field label="Bitrate">
              <Select width={110} value={s.audioBitrateKbps} onChange={(v) => upd({ audioBitrateKbps: v })} options={[128, 192, 256, 320].map((k) => ({ value: k, label: `${k} kbit/s` }))} />
            </Field>
          )}
          <Field label="Kanäle">
            <Segmented
              size="sm"
              value={String(s.audioChannels)}
              onChange={(v) => upd({ audioChannels: v === "1" ? 1 : 2 })}
              options={[
                { value: "2", label: "Stereo" },
                { value: "1", label: "Mono", title: "Mischt beide Kanäle zusammen" },
              ]}
            />
          </Field>
          <Field label="Abtastrate">
            <Select width={110} value={s.sampleRate} onChange={(v) => upd({ sampleRate: v })} options={[44100, 48000].map((r) => ({ value: r, label: `${r / 1000} kHz` }))} />
          </Field>
          <Field label="Lautheit">
            <Select
              width={170}
              label="Lautheit normalisieren"
              value={s.loudness ? (LOUDNESS_PRESETS.some((p) => p.value === s.loudness!.integrated) ? String(s.loudness.integrated) : "custom") : "off"}
              onChange={(v) => upd({ loudness: v === "off" ? null : { integrated: v === "custom" ? (s.loudness?.integrated ?? -18) : Number(v), truePeak: s.loudness?.truePeak ?? -1 } })}
              options={[{ value: "off", label: "Unverändert" }, ...LOUDNESS_PRESETS.map((p) => ({ value: String(p.value), label: p.label })), { value: "custom", label: "Eigener Zielwert" }]}
            />
          </Field>
          {s.loudness && (
            <>
              <Field label="Ziel">
                <NumberField label="Integrierte Lautheit" value={s.loudness.integrated} min={-70} max={-5} step={0.1} precision={1} unit=" LUFS" width={92} onCommit={(v) => upd({ loudness: { ...s.loudness!, integrated: v } })} />
                <NumberField label="True Peak" value={s.loudness.truePeak} min={-9} max={0} step={0.1} precision={1} unit=" dBTP" width={86} onCommit={(v) => upd({ loudness: { ...s.loudness!, truePeak: v } })} />
              </Field>
              <p className="pb-1 text-[10.5px] leading-relaxed text-fg-4">Zwei Durchgänge: Kerf misst die fertige Mischung und verstärkt sie dann gleichmäßig auf den Zielwert. Lassen die Spitzen das nicht zu, regelt FFmpeg (loudnorm) dynamisch nach.</p>
            </>
          )}
        </Section>
        {seq.subtitles.cues.length > 0 && (
          <Section title="Untertitel">
            <Field label="Einbrennen">
              <Toggle checked={subs.burn} onChange={(burn) => setSubs({ ...subs, burn })} label="Untertitel ins Bild einbrennen" />
            </Field>
            <Field label="Eingebettet">
              <Toggle checked={subs.embed} onChange={(embed) => setSubs({ ...subs, embed })} label="Abschaltbare Untertitelspur in der Datei" />
            </Field>
            <Field label="Als Datei">
              <Segmented
                size="sm"
                value={subs.sidecar ?? "none"}
                onChange={(v) => setSubs({ ...subs, sidecar: v === "none" ? null : v })}
                options={[
                  { value: "none", label: "Keine" },
                  { value: "srt", label: "SRT", title: "Gleicher Name wie das Video, daneben" },
                  { value: "vtt", label: "VTT", title: "Gleicher Name wie das Video, daneben" },
                ]}
              />
            </Field>
          </Section>
        )}
        {seq.markers.some((m) => m.chapter) && (
          <Section title="Kapitel">
            <Field label="Kapitel">
              <Toggle checked={!!s.chapters} onChange={(v) => upd({ chapters: v })} label="Kapitelmarker in die Datei schreiben" />
              <span className="truncate text-xs text-fg-3" title="Marker mit Kapitel-Kennzeichen (Marker-Panel) werden als Kapitelspur in MP4/MOV geschrieben. Ein Kapitel reicht bis zum nächsten oder bis zum Ende des Exports.">
                {seq.markers.filter((m) => m.chapter).length} im Marker-Panel markiert
              </span>
            </Field>
          </Section>
        )}
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex justify-between gap-2 text-xs text-fg-3">
            <span>Dauer {formatDuration(seconds)}</span>
            <span className={cx(tight && "text-danger")} title={size.exact ? "Aus der Bitrate berechnet" : "Grobe Schätzung – die tatsächliche Größe hängt vom Bildinhalt ab"}>
              {size.exact ? "" : "≈ "}
              {formatBytes(size.bytes)} · .{ext}
              {free !== null && <span className={cx(!tight && "text-fg-4")}> · {formatBytes(free)} frei</span>}
            </span>
          </div>
          {tight && (
            <div className="flex items-start gap-1.5 text-[10.5px] leading-snug text-danger">
              <TriangleAlert size={12} className="mt-px shrink-0" />
              Auf dem Ziellaufwerk ist voraussichtlich nicht genug Platz.
            </div>
          )}
          {appInfo?.ffmpegTooOld && (
            <div className="flex items-start gap-1.5 text-[10.5px] leading-snug text-warn">
              <TriangleAlert size={12} className="mt-px shrink-0" />
              Das installierte FFmpeg ist älter als Version {appInfo.ffmpegMin}. Kerf übergibt den Filtergraphen mit einer Option, die es erst ab FFmpeg 7 gibt; mit dieser Version schlägt der Export fehl.
            </div>
          )}
          {blocked && (
            <div className="flex items-start gap-1.5 text-[10.5px] leading-snug text-warn">
              <TriangleAlert size={12} className="mt-px shrink-0" />
              {blocked}
            </div>
          )}
          <Button variant="primary" className="w-full" disabled={seconds <= 0 || !appInfo?.ffmpeg || !!blocked} onClick={() => void start()}>
            {appInfo?.ffmpeg ? "Zur Render-Warteschlange hinzufügen" : "FFmpeg nicht gefunden"}
          </Button>
        </div>
        <Section title="Stapel-Export">
          <p className="text-[10.5px] leading-snug text-fg-4">Eine Datei je gewählter Vorgabe in einen Ordner. Bereich, Untertitel, Kapitel und Lautheit wie oben eingestellt; die Aufträge laufen nacheinander in der Render-Warteschlange.</p>
          <div className="max-h-48 space-y-0.5 overflow-auto">
            {presets.map((p) => (
              <label key={p.id} className="flex h-6 cursor-default items-center gap-2 rounded-sm px-1 text-xs text-fg-2 hover:bg-hover">
                <input
                  type="checkbox"
                  className="accent-[var(--color-signal)]"
                  checked={batch.includes(p.id)}
                  onChange={(e) => setBatch((b) => (e.target.checked ? [...b, p.id] : b.filter((x) => x !== p.id)))}
                />
                <span className="truncate">{p.label}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-fg-4">{p.group}</span>
              </label>
            ))}
          </div>
          <Field label="Ordner">
            <button
              onClick={async () => {
                const picked = await openDialog({ directory: true, title: "Zielordner für den Stapel-Export", defaultPath: batchDir || undefined });
                if (typeof picked === "string") setBatchDir(picked);
              }}
              className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm bg-field px-2 text-left text-xs text-fg-2 hover:bg-hover"
              title={batchDir}
            >
              <FolderOpen size={12} className="shrink-0 text-fg-3" />
              <span className="truncate">{batchDir || "Ordner wählen …"}</span>
            </button>
          </Field>
          {batchJobs.length > 0 && (
            <div className="text-[10.5px] text-fg-4">
              {batchJobs.length} Dateien · {batchJobs.some((j) => !estimateBytes(j.settings, seconds).exact) ? "≈ " : ""}
              {formatBytes(batchBytes)} zusammen
            </div>
          )}
          {batchBlocked && (
            <div className="flex items-start gap-1.5 text-[10.5px] leading-snug text-warn">
              <TriangleAlert size={12} className="mt-px shrink-0" />
              {batchBlocked.label}: {batchBlocked.why}
            </div>
          )}
          <Button className="w-full" disabled={!batchJobs.length || seconds <= 0 || !appInfo?.ffmpeg || !!batchBlocked} onClick={() => void startBatch()}>
            {batchJobs.length ? `${batchJobs.length} ${batchJobs.length === 1 ? "Export" : "Exporte"} zur Warteschlange hinzufügen` : "Vorgaben auswählen"}
          </Button>
        </Section>
        <RenderQueue jobs={jobs} />
      </div>
    </div>
  );
}

const fmt1 = (v: number) => v.toFixed(1).replace(".", ",").replace("-", "−");
const fmtFps = (v: number) => String(Math.round(v * 1000) / 1000).replace(".", ",");

/** Findings of the post-render check worth a warning. */
function qcWarnings(j: ExportJob): string[] {
  const q = j.qc;
  if (!q) return [];
  if (q.error) return [`Datei konnte nicht geprüft werden: ${q.error}`];
  const out: string[] = [];
  if (Math.abs(q.duration - j.duration) > Math.max(0.1, 1.5 / j.fps)) out.push(`Dauer ${fmt1(q.duration)} s statt ${fmt1(j.duration)} s`);
  if (q.width !== null && (q.width !== j.width || q.height !== j.height)) out.push(`Auflösung ${q.width} × ${q.height} statt ${j.width} × ${j.height}`);
  if (q.fps !== null && Math.abs(q.fps - j.fps) > 0.01) out.push(`Bildrate ${fmtFps(q.fps)} statt ${fmtFps(j.fps)} fps`);
  if (q.videoCodec === null) out.push("Keine Videospur in der Datei");
  if (q.audioCodec === null) out.push("Keine Tonspur in der Datei");
  else if (q.channels !== null && q.channels !== j.channels) out.push(`${q.channels} statt ${j.channels} Tonkanäle`);
  const tp = q.loudness?.truePeak;
  if (tp !== null && tp !== undefined && tp > -1) out.push(`True Peak ${fmt1(tp)} dBTP – über −1 dBTP kann es nach dem Umkodieren auf Plattformen verzerren`);
  return out;
}

function QcSummary({ j }: { j: ExportJob }) {
  const q = j.qc;
  if (!q) {
    return (
      <div className="flex items-center gap-1.5 text-[10.5px] text-fg-3">
        <Loader2 size={11} className="animate-spin" /> Datei wird geprüft …
      </div>
    );
  }
  const warnings = qcWarnings(j);
  const l = q.loudness;
  return (
    <div className="space-y-0.5 text-[10.5px] leading-snug">
      {!q.error && (
        <div className="tc text-fg-3">
          {q.width} × {q.height} · {q.fps !== null ? fmtFps(q.fps) : "?"} fps · {[q.videoCodec, q.audioCodec].filter(Boolean).join(" / ")}
          {q.channels !== null && ` · ${q.channels === 1 ? "Mono" : q.channels === 2 ? "Stereo" : `${q.channels} Kan.`}`} · {formatBytes(q.sizeBytes)}
        </div>
      )}
      {l && (
        <div className="tc text-fg-3">
          {l.integrated !== null ? `${fmt1(l.integrated)} LUFS` : "Stille"}
          {l.truePeak !== null && ` · True Peak ${fmt1(l.truePeak)} dBTP`}
          {l.range !== null && ` · LRA ${fmt1(l.range)} LU`}
        </div>
      )}
      {warnings.length === 0 ? (
        <div className="flex items-center gap-1 text-signal">
          <CheckCircle2 size={11} /> Prüfung bestanden
        </div>
      ) : (
        warnings.map((w) => (
          <div key={w} className="flex items-start gap-1 text-warn">
            <TriangleAlert size={11} className="mt-px shrink-0" />
            {w}
          </div>
        ))
      )}
    </div>
  );
}

function RenderQueue({ jobs }: { jobs: ExportJob[] }) {
  const ordered = [...jobs].reverse();
  const showLog = (j: ExportJob) => useEditor.getState().set({ dialog: { kind: "exportLog", job: j.id, title: j.output.split(/[\\/]/).pop() ?? "" } });
  const retry = async (j: ExportJob) => {
    try {
      useProject.getState().upsertExport(await api.exportRetry(j.id));
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <Section
      title={`Render-Warteschlange (${jobs.length})`}
      right={
        jobs.some((j) => j.status !== "queued" && j.status !== "running") && (
          <button
            className="text-[10.5px] text-fg-3 hover:text-fg-2"
            onClick={() => void api.exportClear().then(() => api.exportJobs()).then((j) => useProject.getState().setExports(j))}
          >
            Fertige entfernen
          </button>
        )
      }
    >
      {!jobs.length && <p className="text-xs text-fg-4">Noch keine Exporte in dieser Sitzung.</p>}
      {ordered.map((j) => (
        <div key={j.id} className="space-y-1.5 rounded-md bg-raised p-2.5">
          <div className="flex items-center gap-2">
            {j.status === "done" ? (
              qcWarnings(j).length ? <TriangleAlert size={14} className="shrink-0 text-warn" /> : <CheckCircle2 size={14} className="shrink-0 text-signal" />
            ) : j.status === "failed" ? (
              <XCircle size={14} className="shrink-0 text-danger" />
            ) : j.status === "cancelled" ? (
              <CircleSlash size={14} className="shrink-0 text-fg-3" />
            ) : (
              <Loader2 size={14} className={cx("shrink-0 text-fg-2", j.status === "running" && "animate-spin")} />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium" title={j.output}>
                {j.output.split(/[\\/]/).pop()}
              </div>
              <div className="truncate text-[10.5px] text-fg-3">
                {j.sequenceName} · {j.encoder} · {formatDuration(j.duration)}
              </div>
            </div>
            {(j.status === "queued" || j.status === "running") && <IconButton icon={<X size={13} />} size={22} label="Abbrechen" onClick={() => void api.exportCancel(j.id)} />}
            {(j.status === "failed" || j.status === "cancelled") && <IconButton icon={<RotateCcw size={13} />} size={22} label="Erneut versuchen" onClick={() => void retry(j)} />}
            {j.status === "done" && <IconButton icon={<Play size={13} />} size={22} label="Datei öffnen" onClick={() => void api.openPath(j.output).catch(reportError)} />}
            {j.status === "done" && <IconButton icon={<FolderOpen size={13} />} size={22} label="Im Explorer anzeigen" onClick={() => void api.revealPath(j.output)} />}
            {j.status !== "queued" && j.status !== "running" && <IconButton icon={<ScrollText size={13} />} size={22} label="Protokoll anzeigen" onClick={() => showLog(j)} />}
          </div>
          {(j.status === "running" || j.status === "queued") && (
            <>
              <Progress value={j.progress.fraction} indeterminate={j.status === "queued"} />
              <div className="tc flex justify-between text-[10.5px] text-fg-3">
                <span>{j.status === "queued" ? "Wartet …" : `${j.progress.denoising ? "Rauschunterdrückung · " : j.progress.nested ? "Verschachtelte Sequenzen · " : j.progress.measuring ? "Lautheit messen · " : j.progress.joining ? "Zusammenfügen · " : j.progress.parallel ? `${j.progress.parallel}× parallel · ` : ""}${Math.round(j.progress.fraction * 100)} %${j.progress.speed && !j.progress.measuring && !j.progress.nested && !j.progress.joining ? ` · ${j.progress.speed.toFixed(1).replace(".", ",")}×` : ""}`}</span>
                <span>{j.progress.eta !== null && j.status === "running" ? `noch ${formatDuration(j.progress.eta)}` : ""}</span>
              </div>
            </>
          )}
          {j.status === "done" && (
            <>
              <div className="tc text-[10.5px] text-fg-3">Fertig in {formatDuration(j.progress.elapsed)}</div>
              <QcSummary j={j} />
            </>
          )}
          {j.status === "failed" && j.error && <div className="text-[10.5px] leading-snug text-danger">{j.error}</div>}
        </div>
      ))}
    </Section>
  );
}
