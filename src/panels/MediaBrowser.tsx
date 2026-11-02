import { useShallow } from "zustand/react/shallow";
import { AlertTriangle, ChevronRight, Film, Folder, FolderPlus, Image as ImageIcon, LayoutGrid, List, Loader2, Music, Plus, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { placeMedia } from "../actions/editing";
import { importMedia, relinkMedia } from "../actions/project";
import { api } from "../lib/ipc";
import { codecLabel, fileUrl, formatBytes } from "../lib/media";
import { formatDuration, formatRate } from "../lib/time";
import type { Bin, MediaAsset, Uuid } from "../lib/types";
import { useEditor } from "../state/editor";
import { edit, useProject } from "../state/project";
import { source } from "../state/source";
import { registerDropTarget, startMediaDrag } from "../ui/dnd";
import { cx, IconButton, openContextMenu, PanelHeader, Segmented, Select, useInPanelGroup, type MenuItem } from "../ui/primitives";

const KIND_ICON = { video: Film, audio: Music, image: ImageIcon };

function statusOf(a: MediaAsset, proxyJob: number | undefined): { label: string; tone: "busy" | "error" | "warn" } | null {
  if (a.status.state === "analyzing") return { label: "Analyse …", tone: "busy" };
  if (a.status.state === "missing") return { label: "Offline", tone: "error" };
  if (a.status.state === "error") return { label: "Nicht lesbar", tone: "error" };
  if (proxyJob !== undefined) return { label: `Proxy ${Math.round(proxyJob * 100)} %`, tone: "busy" };
  if (!a.derived.previewNative && !a.derived.proxy) return { label: "Proxy ausstehend", tone: "warn" };
  return null;
}

function Thumb({ a, scrub }: { a: MediaAsset; scrub: number | null }) {
  const strip = a.derived.filmstrip;
  if (scrub !== null && strip) {
    const i = Math.min(strip.tiles - 1, Math.floor(scrub * strip.tiles));
    return (
      <div
        className="h-full w-full bg-no-repeat"
        style={{
          backgroundImage: `url("${fileUrl(strip.path)}")`,
          backgroundSize: `${strip.tiles * 100}% 100%`,
          backgroundPosition: `${strip.tiles > 1 ? (i / (strip.tiles - 1)) * 100 : 0}% 0`,
        }}
      />
    );
  }
  if (a.derived.poster) return <img src={fileUrl(a.derived.poster)} className="h-full w-full object-contain" draggable={false} alt="" />;
  const Icon = KIND_ICON[a.kind];
  return (
    <div className="flex h-full w-full items-center justify-center text-fg-4">
      <Icon size={22} strokeWidth={1.3} />
    </div>
  );
}

function WaveIcon() {
  return (
    <svg viewBox="0 0 64 24" className="h-8 w-24 text-[#6cc4b9]" aria-hidden>
      {Array.from({ length: 21 }, (_, i) => {
        const h = 3 + Math.abs(Math.sin(i * 1.7) * 9) + (i % 3) * 2;
        return <rect key={i} x={i * 3} y={12 - h / 2} width={1.6} height={h} rx={0.8} fill="currentColor" />;
      })}
    </svg>
  );
}

export function MediaBrowser() {
  const project = useProject((s) => s.project);
  const proxyJobs = useProject((s) => s.proxyJobs);
  const ed = useEditor(
    useShallow((s) => ({ currentBin: s.currentBin, mediaFilter: s.mediaFilter, mediaSearch: s.mediaSearch, mediaSelection: s.mediaSelection, mediaSort: s.mediaSort, mediaView: s.mediaView, set: s.set })),
  );
  const [renaming, setRenaming] = useState<Uuid | null>(null);
  const [dropBin, setDropBin] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<number>(-1);

  const bins = project?.bins ?? [];
  const childBins = bins.filter((b) => b.parent === ed.currentBin);
  const crumbs = useMemo(() => {
    const out: Bin[] = [];
    let id = ed.currentBin;
    while (id) {
      const b = bins.find((x) => x.id === id);
      if (!b) break;
      out.unshift(b);
      id = b.parent;
    }
    return out;
  }, [bins, ed.currentBin]);

  const items = useMemo(() => {
    let list = (project?.media ?? []).filter((m) => (ed.mediaSearch ? true : m.bin === ed.currentBin));
    const q = ed.mediaSearch.trim().toLowerCase();
    if (q) list = list.filter((m) => m.name.toLowerCase().includes(q));
    if (ed.mediaFilter === "favorites") list = list.filter((m) => m.favorite);
    else if (ed.mediaFilter !== "all") list = list.filter((m) => m.kind === ed.mediaFilter);
    const cmp: Record<string, (a: MediaAsset, b: MediaAsset) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, "de", { numeric: true }),
      date: (a, b) => b.importedAt - a.importedAt,
      duration: (a, b) => (b.info?.duration ?? 0) - (a.info?.duration ?? 0),
      kind: (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "de", { numeric: true }),
    };
    return [...list].sort(cmp[ed.mediaSort]);
  }, [project?.media, ed.currentBin, ed.mediaSearch, ed.mediaFilter, ed.mediaSort]);

  // Media can be dropped onto bins (and onto the browser to move to the current bin).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    return registerDropTarget({
      el,
      onMove: (x, y) => {
        const hit = document.elementFromPoint(x, y)?.closest("[data-bin]") as HTMLElement | null;
        setDropBin(hit?.dataset.bin ?? null);
      },
      onLeave: () => setDropBin(null),
      onDrop: (x, y, media) => {
        setDropBin(null);
        const hit = document.elementFromPoint(x, y)?.closest("[data-bin]") as HTMLElement | null;
        if (!hit) return;
        const bin = hit.dataset.bin === "root" ? null : hit.dataset.bin!;
        void edit({ type: "moveMediaToBin", media, bin });
      },
    });
  }, []);

  const select = (e: React.MouseEvent, id: Uuid, index: number) => {
    if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = [anchor.current, index].sort((x, y) => x - y);
      ed.set({ mediaSelection: items.slice(a, b + 1).map((m) => m.id) });
      return;
    }
    anchor.current = index;
    if (e.ctrlKey || e.metaKey) {
      const s = new Set(ed.mediaSelection);
      s.has(id) ? s.delete(id) : s.add(id);
      ed.set({ mediaSelection: [...s] });
    } else if (!ed.mediaSelection.includes(id)) ed.set({ mediaSelection: [id] });
  };

  // F2 (global shortcut) asks for inline renaming through the editor store.
  const renameRequest = useEditor((s) => s.renameMedia);
  useEffect(() => {
    if (!renameRequest) return;
    setRenaming(renameRequest);
    useEditor.getState().set({ renameMedia: null });
  }, [renameRequest]);

  const menuFor = (a: MediaAsset): MenuItem[] => {
    const ids = ed.mediaSelection.includes(a.id) ? ed.mediaSelection : [a.id];
    const ready = a.status.state === "ready";
    return [
      { label: "Im Quellmonitor öffnen", disabled: !ready, onSelect: () => source.open(a.id) },
      { label: "Am Playhead einfügen (Insert)", shortcut: ",", disabled: !ready, onSelect: () => void placeMedia(ids, "insert") },
      { label: "Am Playhead überschreiben", shortcut: ".", disabled: !ready, onSelect: () => void placeMedia(ids, "overwrite") },
      { separator: true },
      { label: a.favorite ? "Favorit entfernen" : "Als Favorit markieren", onSelect: () => void edit({ type: "setMediaFavorite", media: ids, favorite: !a.favorite }) },
      { label: "Umbenennen", shortcut: "F2", onSelect: () => setRenaming(a.id) },
      {
        label: "In Ablage verschieben",
        submenu: [
          { label: "Projektstamm", onSelect: () => void edit({ type: "moveMediaToBin", media: ids, bin: null }) },
          ...bins.map((b) => ({ label: b.name, onSelect: () => void edit({ type: "moveMediaToBin", media: ids, bin: b.id }) })),
        ],
      },
      { separator: true },
      { label: "Proxy erstellen", disabled: !ready || a.kind === "image" || !!a.derived.proxy, onSelect: () => void api.createProxies(ids) },
      { label: "Neu analysieren", onSelect: () => void api.analyzeMedia(ids) },
      { label: "Neu verknüpfen …", onSelect: () => void relinkMedia(a.id) },
      { label: "Im Explorer anzeigen", onSelect: () => void api.revealPath(a.path) },
      { separator: true },
      { label: "Aus Projekt entfernen", danger: true, onSelect: () => void edit({ type: "removeMedia", media: ids }) },
    ];
  };

  const binMenu = (b: Bin): MenuItem[] => [
    { label: "Öffnen", onSelect: () => ed.set({ currentBin: b.id }) },
    { label: "Umbenennen", onSelect: () => setRenaming(b.id) },
    { separator: true },
    { label: "Ablage löschen (Inhalt bleibt erhalten)", danger: true, onSelect: () => void edit({ type: "removeBin", bin: b.id }) },
  ];

  const newBin = async () => {
    const d = await edit({ type: "createBin", name: `Ablage ${bins.length + 1}`, parent: ed.currentBin });
    if (d?.outcome.created[0]) setRenaming(d.outcome.created[0]);
  };

  const stopRename = () => setRenaming(null);

  const empty = !project?.media.length;
  const grouped = useInPanelGroup();

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col"
      tabIndex={-1}
    >
      <PanelHeader
        tabs={
          // In a tab group the tab already says "Medien"; the path only matters inside a bin.
          (!grouped || crumbs.length > 0) && (
          <div className={cx("flex min-w-0 items-center gap-1 text-xs", grouped && "border-l border-line pl-2")}>
            <button data-bin="root" className={cx("panel-title rounded-xs px-1 hover:text-fg-2", dropBin === "root" && "bg-signal-soft text-signal")} onClick={() => ed.set({ currentBin: null })}>
              Medien
            </button>
            {crumbs.map((b) => (
              <span key={b.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight size={12} className="shrink-0 text-fg-4" />
                <button className="truncate text-fg-2 hover:text-fg" onClick={() => ed.set({ currentBin: b.id })}>
                  {b.name}
                </button>
              </span>
            ))}
          </div>
          )
        }
      >
        <IconButton icon={<FolderPlus size={14} />} label="Neue Ablage" onClick={() => void newBin()} />
        <IconButton icon={<LayoutGrid size={14} />} label="Rasteransicht" active={ed.mediaView === "grid"} onClick={() => ed.set({ mediaView: "grid" })} />
        <IconButton icon={<List size={14} />} label="Listenansicht" active={ed.mediaView === "list"} onClick={() => ed.set({ mediaView: "list" })} />
        <IconButton icon={<Plus size={15} />} label="Medien importieren" shortcut="Strg+I" onClick={() => void importMedia()} />
      </PanelHeader>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-4" />
          <input
            value={ed.mediaSearch}
            onChange={(e) => ed.set({ mediaSearch: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Suchen"
            className="h-6 w-full rounded-sm bg-field pl-6 pr-2 text-xs text-fg outline-none placeholder:text-fg-4 focus:ring-1 focus:ring-signal"
          />
        </div>
        <Segmented
          size="sm"
          value={ed.mediaFilter}
          onChange={(v) => ed.set({ mediaFilter: v })}
          options={[
            { value: "all", label: "Alle" },
            { value: "video", label: <Film size={12} />, title: "Video" },
            { value: "audio", label: <Music size={12} />, title: "Audio" },
            { value: "image", label: <ImageIcon size={12} />, title: "Bilder" },
            { value: "favorites", label: <Star size={12} />, title: "Favoriten" },
          ]}
        />
        <Select
          label="Sortierung"
          width={92}
          value={ed.mediaSort}
          onChange={(v) => ed.set({ mediaSort: v })}
          options={[
            { value: "name", label: "Name" },
            { value: "date", label: "Importiert" },
            { value: "duration", label: "Dauer" },
            { value: "kind", label: "Typ" },
          ]}
        />
      </div>

      <div
        className="min-h-0 flex-1 overflow-auto p-2"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) ed.set({ mediaSelection: [] });
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          openContextMenu(e, [
            { label: "Medien importieren …", shortcut: "Strg+I", onSelect: () => void importMedia() },
            { label: "Ordner importieren …", onSelect: () => void importMedia(undefined, true) },
            { label: "Neue Ablage", onSelect: () => void newBin() },
          ]);
        }}
      >
        {empty ? (
          <button
            onClick={() => void importMedia()}
            className="flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line-strong text-fg-3 transition-colors hover:border-signal/60 hover:text-fg-2"
          >
            <Plus size={22} strokeWidth={1.4} />
            <span className="text-sm">Medien importieren</span>
            <span className="text-xs text-fg-4">oder Dateien und Ordner hierher ziehen</span>
          </button>
        ) : ed.mediaView === "grid" ? (
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))" }}>
            {!ed.mediaSearch &&
              childBins.map((b) => (
                <div
                  key={b.id}
                  data-bin={b.id}
                  onDoubleClick={() => ed.set({ currentBin: b.id })}
                  onContextMenu={(e) => openContextMenu(e, binMenu(b))}
                  className={cx(
                    "flex cursor-default flex-col gap-1 rounded-md p-1 transition-colors hover:bg-hover",
                    dropBin === b.id && "bg-signal-soft ring-1 ring-signal",
                  )}
                >
                  <div className="flex aspect-video items-center justify-center rounded-sm bg-ground text-fg-3">
                    <Folder size={28} strokeWidth={1.2} />
                  </div>
                  <div className="truncate px-0.5 text-xs text-fg-2">
                    {renaming === b.id ? <InlineRename id={b.id} initial={b.name} isBin onDone={stopRename} /> : b.name}
                  </div>
                </div>
              ))}
            {items.map((a, i) => (
              <GridItem
                key={a.id}
                a={a}
                selected={ed.mediaSelection.includes(a.id)}
                status={statusOf(a, proxyJobs[a.id])}
                proxyJob={proxyJobs[a.id]}
                renaming={renaming === a.id ? <InlineRename id={a.id} initial={a.name} isBin={false} onDone={stopRename} /> : null}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  select(e, a.id, i);
                  const ids = ed.mediaSelection.includes(a.id) && !e.ctrlKey ? ed.mediaSelection : [a.id];
                  startMediaDrag(e, ids);
                }}
                onContextMenu={(e) => {
                  if (!ed.mediaSelection.includes(a.id)) ed.set({ mediaSelection: [a.id] });
                  openContextMenu(e, menuFor(a));
                }}
                onDoubleClick={() => source.open(a.id)}
              />
            ))}
          </div>
        ) : (
          <table className="w-full table-fixed text-xs">
            <thead className="sticky top-0 bg-panel text-left text-[10.5px] uppercase tracking-wider text-fg-4">
              <tr>
                <th className="w-[34%] py-1 pl-1 font-medium">Name</th>
                <th className="font-medium">Dauer</th>
                <th className="font-medium">Format</th>
                <th className="font-medium">fps</th>
                <th className="font-medium">Codec</th>
                <th className="font-medium">Audio</th>
                <th className="pr-1 text-right font-medium">Größe</th>
              </tr>
            </thead>
            <tbody>
              {!ed.mediaSearch &&
                childBins.map((b) => (
                  <tr key={b.id} data-bin={b.id} className={cx("h-7 text-fg-2 hover:bg-hover", dropBin === b.id && "bg-signal-soft")} onDoubleClick={() => ed.set({ currentBin: b.id })} onContextMenu={(e) => openContextMenu(e, binMenu(b))}>
                    <td className="truncate pl-1" colSpan={7}>
                      <span className="inline-flex items-center gap-2">
                        <Folder size={13} className="text-fg-3" />
                        {renaming === b.id ? <InlineRename id={b.id} initial={b.name} isBin onDone={stopRename} /> : b.name}
                      </span>
                    </td>
                  </tr>
                ))}
              {items.map((a, i) => {
                const Icon = KIND_ICON[a.kind];
                const v = a.info?.video;
                const au = a.info?.audio;
                const st = statusOf(a, proxyJobs[a.id]);
                const sel = ed.mediaSelection.includes(a.id);
                return (
                  <tr
                    key={a.id}
                    className={cx("h-7 [content-visibility:auto]", sel ? "bg-signal-soft text-fg" : "text-fg-2 hover:bg-hover")}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      select(e, a.id, i);
                      startMediaDrag(e, ed.mediaSelection.includes(a.id) ? ed.mediaSelection : [a.id]);
                    }}
                    onContextMenu={(e) => {
                      if (!sel) ed.set({ mediaSelection: [a.id] });
                      openContextMenu(e, menuFor(a));
                    }}
                    onDoubleClick={() => source.open(a.id)}
                  >
                    <td className="truncate pl-1">
                      <span className="inline-flex max-w-full items-center gap-2">
                        <Icon size={13} className={cx("shrink-0", sel ? "text-signal" : "text-fg-3")} />
                        <span className="truncate">{renaming === a.id ? <InlineRename id={a.id} initial={a.name} isBin={false} onDone={stopRename} /> : a.name}</span>
                        {a.favorite && <Star size={10} className="shrink-0 fill-signal text-signal" />}
                        {st && <span className={cx("shrink-0 text-[10px]", st.tone === "error" ? "text-danger" : st.tone === "warn" ? "text-warn" : "text-fg-3")}>{st.label}</span>}
                      </span>
                    </td>
                    <td className="tc">{a.kind === "image" ? "–" : a.info ? formatDuration(a.info.duration) : ""}</td>
                    <td className="tc">{v ? `${v.width}×${v.height}` : "–"}</td>
                    <td className="tc">{v && a.kind === "video" ? formatRate(v.fps) : "–"}</td>
                    <td>{codecLabel(v?.codec ?? au?.codec)}</td>
                    <td>{au ? `${au.channels} ch · ${au.sampleRate / 1000} kHz` : "–"}</td>
                    <td className="tc pr-1 text-right">{a.info ? formatBytes(a.info.sizeBytes) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {!empty && (
        <div className="flex h-6 shrink-0 items-center border-t border-line px-2.5 text-[10.5px] text-fg-4">
          {items.length} {items.length === 1 ? "Element" : "Elemente"}
          {ed.mediaSelection.length > 0 && ` · ${ed.mediaSelection.length} ausgewählt`}
        </div>
      )}
    </div>
  );
}

function InlineRename({ id, initial, isBin, onDone }: { id: Uuid; initial: string; isBin: boolean; onDone: () => void }) {
  const [v, setV] = useState(initial);
  const done = (commit: boolean) => {
    onDone();
    if (commit && v.trim() && v !== initial)
      void edit(isBin ? { type: "renameBin", bin: id, name: v } : { type: "renameMedia", media: id, name: v });
  };
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="w-full rounded-xs border border-signal bg-ground px-1 text-xs text-fg outline-none"
    />
  );
}

function GridItem({
  a,
  selected,
  status,
  proxyJob,
  renaming,
  ...handlers
}: {
  a: MediaAsset;
  selected: boolean;
  status: ReturnType<typeof statusOf>;
  proxyJob: number | undefined;
  renaming: React.ReactNode;
  onPointerDown: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  const [scrub, setScrub] = useState<number | null>(null);
  const dur = a.info?.duration ?? 0;
  const offline = a.status.state === "missing" || a.status.state === "error";
  return (
    <div
      {...handlers}
      title={a.path}
      className={cx("group flex cursor-default flex-col gap-1 rounded-md p-1 transition-colors [content-visibility:auto]", selected ? "bg-signal-soft" : "hover:bg-hover")}
    >
      <div
        className={cx(
          "relative aspect-video overflow-hidden rounded-sm bg-ground",
          selected ? "ring-[1.5px] ring-signal" : "ring-1 ring-line",
          offline && "opacity-50",
        )}
        onPointerMove={(e) => {
          if (a.kind !== "video") return;
          const r = e.currentTarget.getBoundingClientRect();
          setScrub(Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width)));
        }}
        onPointerLeave={() => setScrub(null)}
      >
        {a.kind === "audio" ? (
          <div className="flex h-full items-center justify-center bg-clip-audio/60">
            <WaveIcon />
          </div>
        ) : (
          <Thumb a={a} scrub={scrub} />
        )}
        {a.kind !== "image" && dur > 0 && (
          <span className="tc absolute bottom-1 right-1 rounded-xs bg-black/70 px-1 text-[10px] text-fg">{formatDuration(dur)}</span>
        )}
        {a.favorite && <Star size={11} className="absolute left-1 top-1 fill-signal text-signal" />}
        {status && (
          <span
            className={cx(
              "absolute left-1 top-1 flex items-center gap-1 rounded-xs bg-black/75 px-1 text-[10px]",
              status.tone === "error" ? "text-danger" : status.tone === "warn" ? "text-warn" : "text-fg-2",
              a.favorite && "left-5",
            )}
            title={a.status.state === "error" ? a.status.message : undefined}
          >
            {status.tone === "busy" ? <Loader2 size={9} className="animate-spin" /> : <AlertTriangle size={9} />}
            {status.label}
          </span>
        )}
        {proxyJob !== undefined && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-black/50">
            <div className="h-full bg-signal" style={{ width: `${proxyJob * 100}%` }} />
          </div>
        )}
        {scrub !== null && <div className="pointer-events-none absolute inset-y-0 w-px bg-signal" style={{ left: `${scrub * 100}%` }} />}
      </div>
      <div className={cx("truncate px-0.5 text-xs", selected ? "text-fg" : "text-fg-2")}>{renaming ?? a.name}</div>
    </div>
  );
}
