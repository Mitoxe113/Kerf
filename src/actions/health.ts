// Project health check: finds problems a reader of the project can verify
// (missing media and fonts, empty stretches, odd frame rates, export limits).
// It only reports; every fix is a separate, explicit user action.

import type { Frame, MediaAsset, Project, Sequence, Uuid } from "../lib/types";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  sequence?: Uuid;
  frame?: Frame;
  media?: Uuid;
  /** What the panel can offer to fix it. */
  fix?: "relink" | "closeGap" | "seek";
  track?: Uuid;
}

const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120];
const rate = (r: { num: number; den: number }) => r.num / r.den;
const isStandard = (fps: number) => STANDARD_FPS.some((s) => Math.abs(s - fps) < 0.01);

/** Frame ranges of [0, end) no enabled clip on a visible video track covers. */
export function videoGaps(seq: Sequence): [Frame, Frame][] {
  const spans = seq.tracks
    .filter((t) => t.kind === "video" && !t.hidden)
    .flatMap((t) => t.clips.filter((c) => c.enabled).map((c): [Frame, Frame] => [c.start, c.start + c.duration]))
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return [];
  const end = Math.max(...seq.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
  const gaps: [Frame, Frame][] = [];
  let at = 0;
  for (const [a, b] of spans) {
    if (a > at) gaps.push([at, a]);
    at = Math.max(at, b);
  }
  if (end > at) gaps.push([at, end]);
  return gaps;
}

/** The video track with a gap at `frame` (for "close gap"), when exactly one clip track has a hole there. */
function gapTrack(seq: Sequence, frame: Frame): Uuid | undefined {
  const holes = seq.tracks.filter((t) => t.kind === "video" && t.clips.some((c) => c.start > frame) && !t.clips.some((c) => c.start <= frame && c.start + c.duration > frame));
  return holes.length === 1 ? holes[0].id : undefined;
}

export interface HealthContext {
  /** True when a font family is available, false when not, null when unknown. */
  fontAvailable: (family: string) => boolean | null;
}

export function checkProject(p: Project, ctx: HealthContext): Issue[] {
  const out: Issue[] = [];
  const mediaById = new Map(p.media.map((m) => [m.id, m]));
  const used = new Set(p.sequences.flatMap((s) => s.tracks.flatMap((t) => t.clips.map((c) => c.mediaId))));

  for (const m of p.media) {
    if (m.title || m.adjustment) continue;
    const where = used.has(m.id) ? "Wird in einer Sequenz verwendet." : "Wird in keiner Sequenz verwendet.";
    if (m.status.state === "missing") out.push({ id: `missing-${m.id}`, severity: used.has(m.id) ? "error" : "warning", title: `Medium fehlt: ${m.name}`, detail: `${m.path}\n${where}`, media: m.id, fix: "relink" });
    else if (m.status.state === "error") out.push({ id: `error-${m.id}`, severity: "error", title: `Medium nicht lesbar: ${m.name}`, detail: m.status.message, media: m.id });
    else if (m.status.state === "ready" && m.info?.video && !m.derived.previewNative && !m.derived.proxy && m.kind !== "image")
      out.push({ id: `proxy-${m.id}`, severity: "info", title: `Vorschau braucht einen Proxy: ${m.name}`, detail: `Die Vorschau kann ${m.info.video.codec} nicht direkt abspielen; der Proxy wird noch erzeugt oder ist abgeschaltet. Der Export liest das Original.`, media: m.id });
  }

  const fonts = new Map<string, string>();
  for (const m of p.media) if (m.title) fonts.set(m.title.style.font, `Titel „${m.name}“`);
  for (const s of p.sequences) if (s.subtitles.cues.length) fonts.set(s.subtitles.style.font, `Untertitel von „${s.name}“`);
  for (const [font, where] of fonts) {
    if (ctx.fontAvailable(font) === false) out.push({ id: `font-${font}`, severity: "warning", title: `Schrift fehlt: ${font}`, detail: `${where}. Vorschau und Export nehmen sonst eine Ersatzschrift.` });
  }

  for (const s of p.sequences) {
    const fps = rate(s.settings.fps);
    const clips = s.tracks.flatMap((t) => t.clips.map((c) => ({ c, t })));
    if (!clips.length) {
      out.push({ id: `empty-${s.id}`, severity: "info", title: `Sequenz „${s.name}“ ist leer`, detail: "Sie enthält keine Clips.", sequence: s.id });
      continue;
    }
    if (!isStandard(fps)) out.push({ id: `fps-${s.id}`, severity: "info", title: `Ungewöhnliche Bildrate in „${s.name}“`, detail: `${fps.toFixed(3)} fps. Manche Plattformen und Abspieler erwarten eine übliche Bildrate.`, sequence: s.id });
    if (s.settings.width % 2 || s.settings.height % 2)
      out.push({ id: `size-${s.id}`, severity: "error", title: `Ungerade Abmessungen in „${s.name}“`, detail: `${s.settings.width} × ${s.settings.height}: H.264 und HEVC mit 4:2:0 brauchen gerade Breite und Höhe.`, sequence: s.id });

    for (const [a, b] of videoGaps(s)) {
      out.push({
        id: `gap-${s.id}-${a}`,
        severity: "warning",
        title: `Leerer Bereich in „${s.name}“`,
        detail: `${((b - a) / fps).toFixed(2)} s ohne Bild ab Bild ${a}: dort ist der Export schwarz.`,
        sequence: s.id,
        frame: a,
        fix: gapTrack(s, a) ? "closeGap" : "seek",
        track: gapTrack(s, a),
      });
    }
    const mismatched = new Map<string, MediaAsset>();
    for (const { c } of clips) {
      const m = mediaById.get(c.mediaId);
      const vfps = m?.info?.video && m.kind === "video" ? rate(m.info.video.fps) : null;
      if (m && vfps && Math.abs(vfps - fps) > 0.01 && Math.abs(vfps / fps - Math.round(vfps / fps)) > 0.01 && Math.abs(fps / vfps - Math.round(fps / vfps)) > 0.01) mismatched.set(m.id, m);
      if (c.duration < 3) out.push({ id: `short-${c.id}`, severity: "info", title: `Sehr kurzer Clip „${c.name}“`, detail: `${c.duration} Bild(er) lang, vielleicht ein Rest eines Schnitts.`, sequence: s.id, frame: c.start, fix: "seek" });
    }
    for (const m of mismatched.values())
      out.push({ id: `fpsmix-${s.id}-${m.id}`, severity: "info", title: `Bildrate von „${m.name}“ passt nicht zu „${s.name}“`, detail: `${rate(m.info!.video!.fps).toFixed(3)} fps in einer ${fps.toFixed(3)}-fps-Sequenz: Bilder werden wiederholt oder ausgelassen, Bewegungen können ruckeln.`, sequence: s.id, media: m.id });
    const disabled = clips.filter(({ c }) => !c.enabled).length;
    if (disabled) out.push({ id: `disabled-${s.id}`, severity: "info", title: `${disabled} deaktivierte Clips in „${s.name}“`, detail: "Sie fehlen in Vorschau und Export.", sequence: s.id });
    const end = Math.max(...clips.map(({ c }) => c.start + c.duration));
    const late = s.markers.filter((m) => m.frame > end).length;
    if (late) out.push({ id: `markers-${s.id}`, severity: "info", title: `${late} Marker hinter dem Ende von „${s.name}“`, detail: "Sie liegen nach dem letzten Clip.", sequence: s.id });
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

const SUBSAMPLING: [RegExp, string][] = [
  [/^(yuv|yuvj)420/, "4:2:0"],
  [/^(yuv|yuvj)422/, "4:2:2"],
  [/^(yuv|yuvj)444/, "4:4:4"],
  [/^(yuv|yuvj)411/, "4:1:1"],
  [/^nv12|^nv21|^p010|^p016/, "4:2:0"],
  [/^nv16|^p210|^p216/, "4:2:2"],
  [/^(rgb|bgr|gbr|argb|rgba|bgra|abgr|0rgb|rgb0)/, "RGB (ohne Unterabtastung)"],
  [/^gray/, "Graustufen"],
];

/** Chroma subsampling and bit depth from an FFmpeg pixel format name. */
export function describePixFmt(pixFmt: string | null | undefined): { subsampling: string | null; bitDepth: number | null } {
  if (!pixFmt) return { subsampling: null, bitDepth: null };
  const f = pixFmt.toLowerCase();
  const subsampling = SUBSAMPLING.find(([re]) => re.test(f))?.[1] ?? null;
  const bits = /p(\d{2})(le|be)?$/.exec(f) ?? /^p0(\d{2})/.exec(f);
  let bitDepth: number | null = bits ? Number(bits[1]) : null;
  if (bitDepth == null) {
    if (/^p010/.test(f)) bitDepth = 10;
    else if (/^(yuv|yuvj|nv|gray|rgb|bgr|gbr|argb|rgba|bgra|abgr|0rgb|rgb0)/.test(f) && !/\d{2}(le|be)$/.test(f)) bitDepth = 8;
  }
  return { subsampling, bitDepth };
}
