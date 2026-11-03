// Effect browser: every effect of the preview/export pipeline plus the user's
// presets, with search (German labels and the English effect ids), category
// filter, favourites and recently used items from the local library.
// Tiles show the real effect applied to a test picture; drag a tile onto a
// timeline clip or double-click it to apply it to the selected video clips.

import { Download, Search, Star, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  CATEGORY_LABELS,
  EFFECT_ENTRIES,
  applyEntry,
  applyPreset,
  exportPresets,
  importPresetFile,
  selectedVideoClips,
  type BrowserCategory,
  type EffectEntry,
} from "../actions/effects";
import { prompt } from "../actions/project";
import { effectThumb, THUMB_H, THUMB_W } from "../engine/thumbs";
import { fuzzyScore } from "../lib/fuzzy";
import type { Effect, EffectKind, Preset } from "../lib/types";
import { useEditor } from "../state/editor";
import { deletePreset, favoritePreset, loadLibrary, renamePreset, setFavorite, useLibrary } from "../state/library";
import { cx, IconButton, openContextMenu, PanelHeader, Select, TextInput, type MenuItem } from "../ui/primitives";
import { startPayloadDrag } from "../ui/dnd";

type Filter = "all" | "favorites" | "recent" | "presets" | BrowserCategory;

const FILTERS: { value: Filter; label: string; group?: string }[] = [
  { value: "all", label: "Alle Effekte" },
  { value: "favorites", label: "Favoriten" },
  { value: "recent", label: "Zuletzt verwendet" },
  { value: "presets", label: "Eigene Presets" },
  ...(["color", "blur", "light", "distort", "stylize", "keying", "transform"] as BrowserCategory[]).map((c) => ({ value: c as Filter, label: CATEGORY_LABELS[c], group: "Kategorien" })),
];

/** "brightnessContrast" -> "brightness contrast", so English words find effects too. */
const words = (id: string) => id.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

const haystack = (e: EffectEntry) => `${e.label} ${words(e.key.split(":")[1])} ${CATEGORY_LABELS[e.category]} ${e.description}`;

/** Settings that make a neutral-by-default effect visible on its tile. */
const THUMB_PARAMS: Record<string, Record<string, number>> = {
  brightnessContrast: { brightness: 0.1, contrast: 0.45 },
  levels: { inBlack: 0.15, inWhite: 0.8, gamma: 1.3 },
  tone: { shadows: 0.5, highlights: -0.5 },
  colorBalance: { shadowsB: 0.4, highR: 0.35, highG: 0.15 },
  hueShift: { angle: 120 },
  hslSecondary: { hue: 0, range: 40, shift: 140, saturation: 0.3 },
  lumaKey: { threshold: 0.45, softness: 0.1 },
  matte: { choke: 4, feather: 6 },
};
/** Effects that act on transparency get a cut-out subject to work on. */
const NEEDS_ALPHA = new Set(["stroke", "dropShadow", "matte"]);

/** The chain a tile shows: the entry's effect, made visible where its defaults change nothing. */
function thumbChain(e: EffectEntry): EffectKind[] | null {
  const k = e.needsFile ? null : e.make();
  if (!k) return null;
  if (k.type !== "fx") return [k];
  const fx: EffectKind = { ...k, params: { ...k.params, ...THUMB_PARAMS[k.fx] } };
  return NEEDS_ALPHA.has(k.fx) ? [{ type: "fx", fx: "shapeMask", params: { shape: 1, centerX: 0.5, centerY: 0.5, width: 0.55, height: 0.7, feather: 0, invert: 0 } }, fx] : [fx];
}

/** Renders the thumbnail after the first paint, so the panel opens at once. */
function Thumb({ effects }: { effects: EffectKind[] | null }) {
  const key = JSON.stringify(effects);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!effects) return;
    let live = true;
    const t = setTimeout(() => live && setUrl(effectThumb(effects)), 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);
  return (
    <div className="relative overflow-hidden rounded-xs bg-ground" style={{ aspectRatio: `${THUMB_W} / ${THUMB_H}` }}>
      {url ? <img src={url} alt="" draggable={false} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-[10px] text-fg-4">{effects ? "" : "Datei nötig"}</div>}
    </div>
  );
}

function Tile({ title, sub, effects, favorite, active, onPointerDown, onDoubleClick, onContextMenu, onFavorite }: {
  title: string;
  sub?: string;
  effects: EffectKind[] | null;
  favorite: boolean;
  active: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onFavorite: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cx("group relative cursor-grab rounded-sm p-1 ring-1 select-none", active ? "bg-signal-soft ring-signal" : "ring-transparent hover:bg-raised hover:ring-line")}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => e.key === "Enter" && onDoubleClick()}
    >
      <Thumb effects={effects} />
      <div className="mt-1 flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-2" title={title}>
          {title}
        </span>
        <button
          className={cx("shrink-0", favorite ? "text-signal" : "text-fg-4 opacity-0 group-hover:opacity-100")}
          aria-label={favorite ? "Aus Favoriten entfernen" : "Zu Favoriten"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onFavorite}
        >
          <Star size={11} fill={favorite ? "currentColor" : "none"} />
        </button>
      </div>
      {sub && <div className="truncate text-[10px] text-fg-4">{sub}</div>}
    </div>
  );
}

export function EffectsBrowser() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const { presets, favorites, recents, error, loaded } = useLibrary();
  useEditor((s) => s.selection);
  const targets = selectedVideoClips().length;
  useEffect(() => void loadLibrary(), []);

  const favFx = new Set(favorites.effect ?? []);
  const entries = useMemo(() => {
    let list = EFFECT_ENTRIES;
    if (filter === "favorites") list = list.filter((e) => favFx.has(e.key));
    else if (filter === "recent") {
      const order = recents.effect ?? [];
      list = order.map((k) => list.find((e) => e.key === k)).filter((e): e is EffectEntry => !!e);
    } else if (filter === "presets") list = [];
    else if (filter !== "all") list = list.filter((e) => e.category === filter);
    if (!query.trim()) return list;
    return list
      .map((e) => ({ e, s: fuzzyScore(query, haystack(e)) }))
      .filter((x): x is { e: EffectEntry; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.e);
  }, [filter, query, favorites, recents]);

  const shownPresets = useMemo(() => {
    let list = presets.filter((p) => p.kind === "effects");
    if (filter === "favorites") list = list.filter((p) => p.favorite);
    else if (filter === "recent") {
      const order = recents.preset ?? [];
      list = order.map((id) => list.find((p) => p.id === id)).filter((p): p is Preset => !!p);
    } else if (filter !== "all" && filter !== "presets") list = [];
    if (query.trim()) list = list.filter((p) => fuzzyScore(query, `${p.name} ${p.category}`) !== null);
    return list;
  }, [presets, filter, query, recents]);

  const info = EFFECT_ENTRIES.find((e) => e.key === selected) ?? null;
  const infoPreset = presets.find((p) => p.id === selected) ?? null;

  const entryMenu = (e: EffectEntry): MenuItem[] => [
    { label: targets ? `Auf ${targets} ausgewählte${targets > 1 ? "" : "n"} Clip${targets > 1 ? "s" : ""} anwenden` : "Anwenden (keine Clips ausgewählt)", disabled: !targets, onSelect: () => void applyEntry(e) },
    { label: favFx.has(e.key) ? "Aus Favoriten entfernen" : "Zu Favoriten", onSelect: () => void setFavorite("effect", e.key, !favFx.has(e.key)) },
  ];
  const presetMenu = (p: Preset): MenuItem[] => [
    { label: "Auf ausgewählte Clips anwenden", disabled: !targets, onSelect: () => void applyPreset(p) },
    { label: p.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten", onSelect: () => void favoritePreset(p.id, !p.favorite) },
    {
      label: "Umbenennen …",
      onSelect: async () => {
        const name = await prompt({ title: "Preset umbenennen", label: "Name", value: p.name, confirm: "Umbenennen" });
        if (name?.trim()) await renamePreset(p.id, name.trim());
      },
    },
    { label: "Exportieren …", onSelect: () => void exportPresets([p.id]) },
    { separator: true },
    { label: "Löschen", danger: true, onSelect: () => void deletePreset(p.id) },
  ];

  const presetEffects = (p: Preset) => (Array.isArray(p.data) ? (p.data as Effect[]).filter((e) => e.enabled !== false && e.type !== "lut") : []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title="Effekte">
        <IconButton icon={<Upload size={13} />} label="Presets importieren (.kerfpreset)" onClick={() => void importPresetFile()} />
        <IconButton
          icon={<Download size={13} />}
          label="Alle eigenen Presets exportieren"
          disabled={!presets.some((p) => p.kind === "effects")}
          onClick={() => void exportPresets(presets.filter((p) => p.kind === "effects").map((p) => p.id))}
        />
      </PanelHeader>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-4" />
          <TextInput value={query} onChange={setQuery} placeholder="Suchen (deutsch oder englisch)" className="pl-6" />
        </div>
        <Select value={filter} options={FILTERS} onChange={setFilter} width={150} label="Filter" />
      </div>
      {error && <p className="mx-2 mt-1.5 rounded-xs bg-warn/15 px-1.5 py-1 text-[10.5px] text-warn">Presets und Favoriten nicht verfügbar: {error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {shownPresets.length > 0 && (
          <>
            <h3 className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-fg-4">Eigene Presets</h3>
            <div className="mb-3 grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))" }}>
              {shownPresets.map((p) => (
                <Tile
                  key={p.id}
                  title={p.name}
                  sub={`${(p.data as unknown[]).length} Effekt${(p.data as unknown[]).length === 1 ? "" : "e"}`}
                  effects={presetEffects(p)}
                  favorite={p.favorite}
                  active={selected === p.id}
                  onPointerDown={(e) => startPayloadDrag(e, { kind: "preset", id: p.id, label: p.name }, () => setSelected(p.id))}
                  onDoubleClick={() => void applyPreset(p)}
                  onContextMenu={(e) => openContextMenu(e, presetMenu(p))}
                  onFavorite={() => void favoritePreset(p.id, !p.favorite)}
                />
              ))}
            </div>
          </>
        )}
        {filter === "presets" && !shownPresets.length && (
          <p className="text-xs text-fg-4">{loaded ? "Noch keine Presets. Im Inspector unter Effekte › … › „Als Preset speichern“ anlegen oder eine .kerfpreset-Datei importieren." : "Wird geladen …"}</p>
        )}
        {entries.length > 0 && (
          <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))" }}>
            {entries.map((e) => (
              <Tile
                key={e.key}
                title={e.label}
                sub={CATEGORY_LABELS[e.category]}
                effects={thumbChain(e)}
                favorite={favFx.has(e.key)}
                active={selected === e.key}
                onPointerDown={(ev) => startPayloadDrag(ev, { kind: "effect", key: e.key, label: e.label }, () => setSelected(e.key))}
                onDoubleClick={() => void applyEntry(e)}
                onContextMenu={(ev) => openContextMenu(ev, entryMenu(e))}
                onFavorite={() => void setFavorite("effect", e.key, !favFx.has(e.key))}
              />
            ))}
          </div>
        )}
        {filter !== "presets" && !entries.length && !shownPresets.length && <p className="text-xs text-fg-4">{filter === "favorites" ? "Noch keine Favoriten (Stern an einer Kachel)." : filter === "recent" ? "Noch nichts verwendet." : "Keine Treffer."}</p>}
      </div>
      <div className="shrink-0 border-t border-line px-2 py-1.5 text-[11px] leading-snug text-fg-3">
        {info ? (
          <>
            <span className="font-medium text-fg-2">{info.label}</span> · {info.description}
            {info.heavy && <span className="text-warn"> Im Export rechenintensiv.</span>}
          </>
        ) : infoPreset ? (
          <>
            <span className="font-medium text-fg-2">{infoPreset.name}</span> · {(infoPreset.data as Effect[]).length} Effekte
          </>
        ) : (
          <>Doppelklick wendet auf die {targets ? `${targets} ausgewählten` : "ausgewählten"} Videoclips an; Kachel auf einen Clip ziehen wendet sie dort an. Vorschaubilder zeigen den echten Effekt an einem Testbild.</>
        )}
      </div>
    </div>
  );
}
