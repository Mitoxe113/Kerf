// Stock media browser: search Pexels, GIPHY, Freesound and Openverse through
// Kerf's backend (API keys stay in the OS credential store), download into the
// asset library with the provider's license data, and add downloads to the
// project or insert them at the playhead. License data is the provider's
// statement, not a legal clearance.

import { save } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Download, ExternalLink, FileText, KeyRound, Loader2, Plus, Search, Star, X } from "lucide-react";
import { useEffect, useState } from "react";
import { confirm } from "../actions/project";
import { api } from "../lib/ipc";
import { fileUrl, formatBytes } from "../lib/media";
import type { AssetRecord, Commercial, DownloadJob, ProviderId, ProviderInfo, RemoteAsset, ReportFormat, SearchKind } from "../lib/types";
import {
  addToProject,
  cancelDownload,
  clearDownloads,
  clearProviderKey,
  deleteAsset,
  download,
  favoriteAsset,
  initAssets,
  insertAtPlayhead,
  loadAssetLibrary,
  runSearch,
  setProviderKey,
  setSearchOptions,
  useAssets,
} from "../state/assets";
import { reportError, useProject } from "../state/project";
import { toast } from "../state/toasts";
import { Button, cx, IconButton, openContextMenu, PanelHeader, Progress, Segmented, Select, TextInput, Toggle, type MenuItem } from "../ui/primitives";

const KIND_LABELS: Record<SearchKind, string> = { photo: "Fotos", video: "Videos", gif: "GIFs", audio: "Audio" };

const COMMERCIAL: Record<Commercial, { label: string; cls: string; title: string }> = {
  yes: { label: "kommerziell erlaubt", cls: "text-signal", title: "Die Lizenz des Anbieters erlaubt kommerzielle Nutzung. Einschränkungen der Lizenz gelten weiter." },
  no: { label: "nicht kommerziell", cls: "text-danger", title: "Die Lizenz verbietet kommerzielle Nutzung." },
  unknown: { label: "Lizenz unklar", cls: "text-warn", title: "Keine ausdrückliche Erlaubnis zur kommerziellen Nutzung bekannt." },
};

function LicenseBadge({ c }: { c: Commercial }) {
  const m = COMMERCIAL[c] ?? COMMERCIAL.unknown;
  return (
    <span className={cx("text-[10px]", m.cls)} title={m.title}>
      {m.label}
    </span>
  );
}

const open = (provider: string, id: string, which: "page" | "creator" | "license" | "key") => api.mediaOpenLink(provider, id, which).catch(reportError);

// --- key setup -----------------------------------------------------------------------------

function KeySetup({ p }: { p: ProviderInfo }) {
  const [key, setKey] = useState("");
  const [persist, setPersist] = useState(true);
  return (
    <div className="m-2 space-y-2 rounded-sm border border-line bg-ground p-2.5 text-[11.5px] text-fg-3">
      <div className="flex items-center gap-1.5 text-fg-2">
        <KeyRound size={13} /> {p.name} braucht einen eigenen API-Schlüssel
      </div>
      <p>
        Den Schlüssel stellt {p.name} nach einer Registrierung aus. Kerf speichert ihn im Schlüsselspeicher des Betriebssystems und sendet ihn nur an {p.name}; die Oberfläche
        bekommt ihn nicht zurück.
      </p>
      <Button size="sm" onClick={() => void open(p.id, "", "key")}>
        <ExternalLink size={12} /> Schlüssel bei {p.name} beantragen
      </Button>
      <input
        type="password"
        aria-label={`API-Schlüssel für ${p.name}`}
        placeholder="API-Schlüssel"
        autoComplete="off"
        className="h-7 w-full rounded-sm border border-line-strong bg-field px-2 text-sm text-fg outline-none focus:border-signal"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <label className="flex items-center gap-2">
        <Toggle checked={persist} onChange={setPersist} label="Im Schlüsselspeicher sichern" />
        {persist ? "Im Schlüsselspeicher des Systems sichern" : "Nur bis Kerf beendet wird merken"}
      </label>
      <Button size="sm" variant="primary" disabled={!key.trim()} onClick={() => void setProviderKey(p.id, key, persist).then(() => setKey(""))}>
        Speichern
      </Button>
    </div>
  );
}

// --- search results ------------------------------------------------------------------------

function RemoteThumb({ a }: { a: RemoteAsset }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!a.thumbUrl) return;
    let live = true;
    api
      .mediaThumb(a.provider, a.providerId)
      .then((p) => live && setSrc(fileUrl(p)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [a.provider, a.providerId, a.thumbUrl]);
  const label = a.kind === "sfx" || a.kind === "audio" ? `${(a.durationMs / 1000).toFixed(1)} s` : failed ? "kein Vorschaubild" : "";
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xs bg-ground text-[10px] text-fg-4">
      {src ? <img src={src} alt="" draggable={false} className="h-full w-full object-cover" /> : label || (a.thumbUrl && <Loader2 size={12} className="animate-spin" />)}
    </div>
  );
}

function ResultCard({ a }: { a: RemoteAsset }) {
  const all = useAssets((s) => s.downloads);
  const jobs = all.filter((d) => d.provider === a.provider && d.providerId === a.providerId);
  const active = jobs.find((j) => j.state === "queued" || j.state === "running");
  const done = jobs.find((j) => j.state === "done");
  const menu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [
      ...a.files.map((f, i) => ({
        label: `Herunterladen: ${f.label}${f.size ? ` (${formatBytes(f.size)})` : ""}`,
        onSelect: () => void download(a, i),
      })),
      { separator: true },
      { label: "Quelle im Browser öffnen", disabled: !a.pageUrl, onSelect: () => void open(a.provider, a.providerId, "page") },
      { label: "Urheber im Browser öffnen", disabled: !a.creatorUrl, onSelect: () => void open(a.provider, a.providerId, "creator") },
      { label: "Lizenz im Browser öffnen", disabled: !a.license.url, onSelect: () => void open(a.provider, a.providerId, "license") },
    ];
    openContextMenu(e, items);
  };
  return (
    <div className="group rounded-sm p-1 ring-1 ring-transparent hover:bg-raised hover:ring-line" onContextMenu={menu}>
      <RemoteThumb a={a} />
      <div className="mt-1 truncate text-[11.5px] text-fg-2" title={a.title || a.providerId}>
        {a.title || a.providerId}
      </div>
      <div className="truncate text-[10px] text-fg-4" title={a.creator}>
        {a.creator || "Urheber unbekannt"}
      </div>
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[10px] text-fg-3" title={`${a.license.name}${a.license.notes ? `\n${a.license.notes}` : ""}`}>
          {a.license.name}
        </span>
        {active ? (
          <IconButton icon={<X size={12} />} size={20} label="Download abbrechen" onClick={() => void cancelDownload(active.id)} />
        ) : (
          <IconButton icon={<Download size={12} />} size={20} label={done ? "Erneut herunterladen" : `Herunterladen (${a.files[0]?.label ?? ""})`} onClick={() => void download(a, 0)} />
        )}
      </div>
      <LicenseBadge c={a.license.commercial} />
      {active && <Progress value={active.total ? active.done / active.total : undefined} indeterminate={!active.total} />}
    </div>
  );
}

function SearchView() {
  const { providers, search } = useAssets();
  const info = providers.find((p) => p.id === search.provider);
  const needsKey = !!info?.needsKey && !info.keyStorage;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 border-b border-line p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            label="Anbieter"
            value={search.provider}
            options={providers.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(provider) => setSearchOptions({ provider: provider as ProviderId })}
            width={120}
          />
          {info && info.kinds.length > 1 && (
            <Segmented size="sm" value={search.kind} onChange={(kind) => setSearchOptions({ kind })} options={info.kinds.map((k) => ({ value: k, label: KIND_LABELS[k] }))} />
          )}
          <div className="flex-1" />
          {info?.keyStorage && (
            <IconButton
              icon={<KeyRound size={13} />}
              size={24}
              label={`API-Schlüssel für ${info.name} entfernen (${info.keyStorage === "system" ? "Schlüsselspeicher" : "nur Sitzung"})`}
              onClick={() => void clearProviderKey(info.id)}
            />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Search size={13} className="shrink-0 text-fg-3" />
          <TextInput value={search.query} onChange={(query) => setSearchOptions({ query })} placeholder={`${info?.name ?? ""} durchsuchen`} onEnter={() => void runSearch()} className="flex-1" />
          <Button size="sm" disabled={!search.query.trim() || needsKey} onClick={() => void runSearch()}>
            Suchen
          </Button>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-fg-3">
          <Toggle checked={search.commercialOnly} onChange={(commercialOnly) => setSearchOptions({ commercialOnly })} label="Nur kommerziell nutzbar" />
          Nur Treffer, deren Lizenz kommerzielle Nutzung ausdrücklich erlaubt
        </label>
      </div>
      {needsKey && info ? (
        <KeySetup p={info} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {search.notice && <p className="mb-1.5 px-1 text-[11px] text-fg-3">{search.notice}</p>}
          {search.error && (
            <p className="mb-1.5 flex gap-1.5 px-1 text-[11px] text-danger">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {search.error}
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-1">
            {search.results.map((a) => (
              <ResultCard key={`${a.provider}:${a.providerId}`} a={a} />
            ))}
          </div>
          {search.loading && (
            <div className="flex justify-center p-3 text-fg-3">
              <Loader2 size={14} className="animate-spin" />
            </div>
          )}
          {!search.loading && search.hasMore && (
            <div className="flex justify-center p-2">
              <Button size="sm" onClick={() => void runSearch(true)}>
                Mehr laden
              </Button>
            </div>
          )}
          {!search.loading && !search.error && search.results.length === 0 && search.total !== null && <p className="p-3 text-center text-xs text-fg-4">Keine Treffer.</p>}
        </div>
      )}
      <ProviderFooter provider={search.provider} />
    </div>
  );
}

/** Credits each provider asks for. GIPHY requires "Powered By GIPHY" wherever its results show. */
function ProviderFooter({ provider }: { provider: ProviderId }) {
  const text: Record<ProviderId, string> = {
    pexels: "Fotos und Videos von Pexels",
    giphy: "Powered By GIPHY",
    freesound: "Sounds von Freesound (freesound.org), Vorschau-MP3 mit API-Schlüssel",
    openverse: "Suche über Openverse; Dateien liegen bei den jeweiligen Quellen",
  };
  return (
    <div className={cx("shrink-0 border-t border-line px-2 py-1 text-[10.5px]", provider === "giphy" ? "font-semibold text-fg-2" : "text-fg-4")}>
      {text[provider]}
    </div>
  );
}

// --- library -------------------------------------------------------------------------------

function LibraryRow({ a }: { a: AssetRecord }) {
  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: "Zum Projekt hinzufügen", disabled: a.missing, onSelect: () => void addToProject(a) },
      { label: "Am Playhead einfügen", disabled: a.missing, onSelect: () => void insertAtPlayhead(a) },
      { separator: true },
      { label: "Quelle im Browser öffnen", disabled: !a.pageUrl, onSelect: () => void open(a.provider, a.providerId, "page") },
      { label: "Lizenz im Browser öffnen", disabled: !a.licenseUrl, onSelect: () => void open(a.provider, a.providerId, "license") },
      { label: "Namensnennung kopieren", disabled: !a.attribution, onSelect: () => void navigator.clipboard.writeText(a.attribution).then(() => toast.success("Namensnennung kopiert")) },
      { separator: true },
      {
        label: "Aus der Bibliothek löschen …",
        danger: true,
        onSelect: async () => {
          const ok = await confirm({ title: "Asset löschen", body: `„${a.title || a.providerId}“ aus der Bibliothek entfernen und die heruntergeladene Datei löschen? Projekte, die die Datei verwenden, finden sie danach nicht mehr.`, confirm: "Löschen", danger: true });
          if (ok === true) void deleteAsset(a, true);
        },
      },
    ]);
  return (
    <div className="group flex items-center gap-2 border-b border-line px-2 py-1.5 hover:bg-raised" onContextMenu={menu} onDoubleClick={() => void addToProject(a)}>
      <div className="h-9 w-14 shrink-0 overflow-hidden rounded-xs bg-ground">
        {a.mime.startsWith("image/") && !a.missing && <img src={fileUrl(a.filePath)} alt="" className="h-full w-full object-cover" draggable={false} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] text-fg-2" title={a.title}>
          {a.title || a.providerId}
        </div>
        <div className="truncate text-[10px] text-fg-4">
          {a.provider} · {a.creator || "Urheber unbekannt"} · {a.licenseName}
        </div>
        <div className="flex items-center gap-2">
          <LicenseBadge c={a.commercial} />
          {a.attributionRequired && <span className="text-[10px] text-fg-3">Namensnennung nötig</span>}
          {a.missing && <span className="text-[10px] text-danger">Datei fehlt</span>}
        </div>
      </div>
      <button className={cx("shrink-0", a.favorite ? "text-signal" : "text-fg-4 opacity-0 group-hover:opacity-100")} aria-label={a.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten"} onClick={() => void favoriteAsset(a, !a.favorite)}>
        <Star size={12} fill={a.favorite ? "currentColor" : "none"} />
      </button>
      <IconButton icon={<Plus size={13} />} size={22} label="Am Playhead einfügen" disabled={a.missing} onClick={() => void insertAtPlayhead(a)} />
    </div>
  );
}

function LibraryView() {
  const { library, libraryQuery: q, libraryError } = useAssets();
  const [text, setText] = useState(q.text ?? "");
  const set = (p: Partial<typeof q>) => void loadAssetLibrary({ ...q, ...p });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 border-b border-line p-2">
        <div className="flex items-center gap-1.5">
          <Search size={13} className="shrink-0 text-fg-3" />
          <TextInput value={text} onChange={setText} placeholder="Bibliothek durchsuchen" onEnter={() => set({ text: text.trim() || null })} className="flex-1" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-3">
          <Select
            label="Art"
            value={q.kind ?? ""}
            options={[
              { value: "", label: "Alle Arten" },
              { value: "photo", label: "Fotos" },
              { value: "video", label: "Videos" },
              { value: "gif", label: "GIFs" },
              { value: "audio", label: "Audio" },
              { value: "sfx", label: "Soundeffekte" },
            ]}
            onChange={(kind) => set({ kind: kind || null })}
            width={110}
          />
          <label className="flex items-center gap-1.5">
            <Toggle checked={!!q.favorites} onChange={(favorites) => set({ favorites })} label="Nur Favoriten" /> Favoriten
          </label>
          <label className="flex items-center gap-1.5">
            <Toggle checked={!!q.commercialOnly} onChange={(commercialOnly) => set({ commercialOnly })} label="Nur kommerziell erlaubt" /> kommerziell erlaubt
          </label>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {libraryError && <p className="p-2 text-[11px] text-danger">{libraryError}</p>}
        {library.map((a) => (
          <LibraryRow key={a.id} a={a} />
        ))}
        {!library.length && !libraryError && <p className="p-3 text-center text-xs text-fg-4">Noch keine heruntergeladenen Assets.</p>}
      </div>
    </div>
  );
}

// --- downloads -----------------------------------------------------------------------------

const STATE_LABELS: Record<DownloadJob["state"], string> = { queued: "Wartet", running: "Lädt", done: "Fertig", failed: "Fehlgeschlagen", cancelled: "Abgebrochen" };

function DownloadsView() {
  const jobs = useAssets((s) => s.downloads);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {[...jobs].reverse().map((j) => (
          <div key={j.id} className="border-b border-line px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-2">{j.title}</span>
              <span className={cx("text-[10px]", j.state === "failed" ? "text-danger" : "text-fg-3")}>{STATE_LABELS[j.state]}</span>
              {(j.state === "queued" || j.state === "running") && <IconButton icon={<X size={12} />} size={20} label="Abbrechen" onClick={() => void cancelDownload(j.id)} />}
              {j.state === "done" && j.asset && <IconButton icon={<Plus size={12} />} size={20} label="Am Playhead einfügen" onClick={() => void insertAtPlayhead(j.asset!)} />}
            </div>
            {j.state === "running" && <Progress value={j.total ? j.done / j.total : undefined} indeterminate={!j.total} />}
            <div className="text-[10px] text-fg-4">
              {j.provider} · {formatBytes(j.done)}
              {j.total ? ` von ${formatBytes(j.total)}` : ""}
            </div>
            {j.error && <div className="text-[10.5px] text-danger">{j.error}</div>}
          </div>
        ))}
        {!jobs.length && <p className="p-3 text-center text-xs text-fg-4">Keine Downloads in dieser Sitzung.</p>}
      </div>
      {jobs.some((j) => j.state !== "queued" && j.state !== "running") && (
        <div className="border-t border-line p-1.5">
          <Button size="sm" onClick={() => void clearDownloads()}>
            Abgeschlossene entfernen
          </Button>
        </div>
      )}
    </div>
  );
}

// --- license report ------------------------------------------------------------------------

export async function writeLicenseReport(format: ReportFormat) {
  const project = useProject.getState().project;
  if (!project) return;
  const files = project.media.filter((m) => !m.title && m.path).map((m) => m.path);
  const path = await save({ defaultPath: `${project.name} – Lizenzen.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
  if (!path) return;
  try {
    await api.licenseReport(project.name, files, format, path);
    toast.success("Lizenzbericht gespeichert", path.split(/[\\/]/).pop());
  } catch (e) {
    reportError(e);
  }
}

const reportMenu = (e: React.MouseEvent) =>
  openContextMenu(
    e,
    (["html", "txt", "csv", "json"] as ReportFormat[]).map((f) => ({ label: `Lizenzbericht als ${f.toUpperCase()} …`, onSelect: () => void writeLicenseReport(f) })),
  );

type Tab = "search" | "library" | "downloads";

export function StockBrowser() {
  const [tab, setTab] = useState<Tab>("search");
  const running = useAssets((s) => s.downloads.filter((d) => d.state === "queued" || d.state === "running").length);
  useEffect(() => initAssets(), []);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader>
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: "search", label: "Suche" },
            { value: "library", label: "Bibliothek" },
            { value: "downloads", label: running ? `Downloads (${running})` : "Downloads" },
          ]}
        />
        <div className="flex-1" />
        <IconButton icon={<FileText size={13} />} size={24} label="Lizenzbericht des Projekts" onClick={reportMenu} />
      </PanelHeader>
      {tab === "search" ? <SearchView /> : tab === "library" ? <LibraryView /> : <DownloadsView />}
    </div>
  );
}
