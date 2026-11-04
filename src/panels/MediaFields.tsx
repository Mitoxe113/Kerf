// Editable project metadata of media: name, favourite, colour label, tags,
// note and the colour matrix of videos. With several media selected,
// favourite, label and matrix apply to all of them, and tags can be added to
// or removed from all of them in one step.

import { Star, X } from "lucide-react";
import { useEffect, useState } from "react";
import { readYcc, taggedYcc, webviewYcc, type Ycc } from "../engine/ycc";
import { LABEL_COLORS, LABEL_NAMES, LABELS } from "../lib/labels";
import type { EditCommand, LabelColor, MatrixChoice, MediaAsset } from "../lib/types";
import { edit } from "../state/project";
import { cx, Segmented } from "../ui/primitives";

const parseTags = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2 border-b border-line px-2 py-1 text-xs">
      <span className="w-36 shrink-0 text-fg-4">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** A text field that commits on Enter or when it loses focus. */
function CommitInput({ value, onCommit, placeholder, area }: { value: string; onCommit: (v: string) => void; placeholder?: string; area?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onCommit(v);
  const cls = "w-full rounded-sm bg-field px-1.5 text-xs text-fg outline-none placeholder:text-fg-4 focus:ring-1 focus:ring-signal";
  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") setV(value);
    if (e.key === "Enter" && (!area || e.ctrlKey)) (e.target as HTMLElement).blur();
  };
  return area ? (
    <textarea value={v} rows={3} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={keys} className={cx(cls, "resize-y py-1")} />
  ) : (
    <input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={keys} className={cx(cls, "h-6")} />
  );
}

function LabelPicker({ value, onChange }: { value: LabelColor | null; onChange: (l: LabelColor) => void }) {
  return (
    <>
      {LABELS.map((l) => (
        <button
          key={l}
          title={LABEL_NAMES[l]}
          aria-label={LABEL_NAMES[l]}
          aria-pressed={value === l}
          onClick={() => onChange(l)}
          className={cx(
            "flex h-4 w-4 items-center justify-center rounded-full ring-offset-1 ring-offset-panel",
            value === l ? "ring-2 ring-signal" : "opacity-70 hover:opacity-100",
            l === "none" && "border border-line-strong text-fg-4",
          )}
          style={l === "none" ? undefined : { background: LABEL_COLORS[l] }}
        >
          {l === "none" && <X size={9} />}
        </button>
      ))}
    </>
  );
}

const YCC_NAMES: Record<Ycc, string> = { bt601: "BT.601", bt709: "BT.709" };

/**
 * Y'CbCr matrix of videos whose tag is BT.601, BT.709 or missing (kerf_core
 * MediaPatch::matrix). Automatic follows what the preview decodes with; the
 * hint says whether that comes from the file's tag or is a guess.
 */
function MatrixRow({ media, onChange }: { media: MediaAsset[]; onChange: (m: MatrixChoice) => void }) {
  const videos = media.flatMap((m) => (m.kind === "video" && !m.title && m.info?.video && taggedYcc(m.info.video) !== undefined ? [{ m, v: m.info.video }] : []));
  if (!videos.length || videos.length !== media.length) return null;
  const choice = (m: MediaAsset) => m.matrix ?? "auto";
  const value = media.every((m) => choice(m) === choice(media[0])) ? choice(media[0]) : null;
  const autos = new Set(videos.map(({ m, v }) => readYcc(v, "auto", m.derived.previewNative)));
  const auto = autos.size === 1 ? [...autos][0] : undefined;
  // From the tag where the WebView honours it (webviewYcc), else guessed from codec and size.
  const tagged = videos.every(({ m, v }) => taggedYcc(v) && webviewYcc(v, m.derived.previewNative) === taggedYcc(v));
  const guessed = videos.every(({ m, v }) => !(taggedYcc(v) && webviewYcc(v, m.derived.previewNative) === taggedYcc(v)));
  const hint = auto ? `Automatisch liest ${YCC_NAMES[auto]}${tagged ? " (Tag der Datei)" : guessed ? " (geschätzt, die Datei hat keinen gültigen Tag)" : ""}.` : "Automatisch liest je nach Medium BT.601 oder BT.709.";
  return (
    <Row label="Farbmatrix">
      <Segmented<MatrixChoice | "">
        size="sm"
        value={value ?? ""}
        onChange={(v) => v && onChange(v)}
        options={[
          { value: "auto", label: "Automatisch", title: "Wie die Vorschau die Datei dekodiert" },
          { value: "bt601", label: "BT.601", title: "Y'CbCr als BT.601 lesen (Standardauflösung)" },
          { value: "bt709", label: "BT.709", title: "Y'CbCr als BT.709 lesen (HD)" },
        ]}
      />
      {value === null && <span className="text-fg-4">gemischt</span>}
      <span className="w-full text-[11px] text-fg-4">{hint} Wirkt in Vorschau und Export. Wähle die andere Matrix, wenn die Farben von der Kamera oder einem anderen Programm abweichen.</span>
    </Row>
  );
}

export function MediaFields({ media }: { media: MediaAsset[] }) {
  if (!media.length) return null;
  const ids = media.map((m) => m.id);
  const one = media.length === 1 ? media[0] : null;
  const favorite = media.every((m) => m.favorite);
  const label = media.every((m) => m.label === media[0].label) ? media[0].label : null;
  const patch = (p: Extract<EditCommand, { type: "updateMedia" }>["patch"]) => void edit({ type: "updateMedia", media: ids, patch: p });
  // Tags that every selected medium has.
  const common = media[0].tags.filter((t) => media.every((m) => m.tags.includes(t)));
  const changeTags = (f: (tags: string[]) => string[]) => {
    const commands: EditCommand[] = media.map((m) => ({ type: "updateMedia", media: [m.id], patch: { tags: f(m.tags) } }));
    void edit(commands.length === 1 ? commands[0] : { type: "batch", label: "mediaTags", commands });
  };
  return (
    <div className="border-b border-line-strong pb-1">
      <div className="px-2 pb-1 pt-2 text-[11px] uppercase tracking-wide text-fg-4">{one ? "Angaben im Projekt" : `Angaben im Projekt · ${media.length} Medien`}</div>
      {one && (
        <Row label="Name">
          <CommitInput value={one.name} onCommit={(v) => v.trim() && void edit({ type: "renameMedia", media: one.id, name: v })} />
        </Row>
      )}
      <Row label="Favorit">
        <button
          aria-pressed={favorite}
          onClick={() => void edit({ type: "setMediaFavorite", media: ids, favorite: !favorite })}
          className={cx("flex h-6 items-center gap-1 rounded-sm px-1.5", favorite ? "text-signal" : "text-fg-3 hover:text-fg-2")}
        >
          <Star size={12} className={favorite ? "fill-signal" : undefined} />
          {favorite ? "Favorit" : "Kein Favorit"}
        </button>
      </Row>
      <Row label="Farbe">
        <LabelPicker value={label} onChange={(l) => patch({ label: l })} />
        {label === null && <span className="text-fg-4">gemischt</span>}
      </Row>
      {one ? (
        <Row label="Tags">
          <CommitInput value={one.tags.join(", ")} placeholder="Kommagetrennt, z. B. Außen, Tag 1" onCommit={(v) => patch({ tags: parseTags(v) })} />
        </Row>
      ) : (
        <>
          <Row label="Gemeinsame Tags">
            {common.length ? (
              common.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-sm bg-ground px-1.5 py-0.5 text-fg-2">
                  {t}
                  <button title={`„${t}“ bei allen entfernen`} aria-label={`${t} entfernen`} className="text-fg-4 hover:text-danger" onClick={() => changeTags((tags) => tags.filter((x) => x !== t))}>
                    <X size={10} />
                  </button>
                </span>
              ))
            ) : (
              <span className="text-fg-4">keine</span>
            )}
          </Row>
          <Row label="Tags hinzufügen">
            <CommitInput key={common.join(",")} value="" placeholder="Kommagetrennt, Enter fügt zu allen hinzu" onCommit={(v) => parseTags(v).length && changeTags((tags) => [...tags, ...parseTags(v)])} />
          </Row>
        </>
      )}
      <MatrixRow media={media} onChange={(m) => patch({ matrix: m })} />
      {one && (
        <Row label="Notiz">
          <CommitInput area value={one.note} placeholder="Notiz zum Medium (Strg+Enter übernimmt)" onCommit={(v) => patch({ note: v })} />
        </Row>
      )}
    </div>
  );
}
