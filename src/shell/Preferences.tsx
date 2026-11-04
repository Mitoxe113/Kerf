// Preferences: autosave and versions, preview, timeline defaults, keyboard
// and system information. Values live in the editor store (persisted);
// autosave/version settings are pushed to the engine by App.

import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { checkForUpdate } from "../actions/update";
import { api } from "../lib/ipc";
import { formatBytes } from "../lib/media";
import type { CacheSettings } from "../lib/types";
import { useEditor } from "../state/editor";
import { reportError, useProject } from "../state/project";
import { toast } from "../state/toasts";
import { Button, Field, Modal, NumberField, Segmented, Select, Toggle } from "../ui/primitives";

const AUTOSAVE = [15, 30, 60, 120, 300, 600].map((s) => ({ value: s, label: s < 60 ? `alle ${s} Sekunden` : s === 60 ? "jede Minute" : `alle ${s / 60} Minuten` }));

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="panel-title">{title}</div>
      {children}
    </div>
  );
}

const GB = 1024 ** 3;
const LIMITS = [0, 5, 10, 20, 50, 100, 200].map((g) => ({ value: g * GB, label: g ? `${g} GB` : "unbegrenzt" }));

/** Where the cache lives (from the next start) and how large it may grow (at once). */
function CacheGroup() {
  const [c, setC] = useState<CacheSettings | null>(null);
  useEffect(() => {
    api.cacheSettings().then(setC).catch(reportError);
  }, []);
  if (!c) return null;
  const next = c.configured ?? c.default;
  const moving = next !== c.active;
  const limit = c.limitBytes ?? 0;
  const limits = LIMITS.some((o) => o.value === limit) ? LIMITS : [...LIMITS, { value: limit, label: formatBytes(limit) }];
  const choose = async () => {
    const picked = await open({ directory: true, title: "Ordner für den Cache wählen", defaultPath: next });
    if (typeof picked !== "string") return;
    try {
      setC(await api.cacheLocationSet(picked));
    } catch (e) {
      reportError(e);
    }
  };
  const setLimit = async (bytes: number) => {
    try {
      const freed = await api.cacheLimitSet(bytes || null);
      setC({ ...c, limitBytes: bytes || null });
      if (freed > 0) toast.success("Cache verkleinert", `${formatBytes(freed)} freigegeben`);
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <Group title="Cache">
      <Field label="Ordner">
        <span className="min-w-0 flex-1 truncate text-xs text-fg-2" title={c.active}>
          {c.active}
        </span>
        <Button size="sm" onClick={() => void api.revealPath(c.active)} title="Im Explorer anzeigen">
          <FolderOpen size={12} />
        </Button>
        <Button size="sm" onClick={() => void choose()}>
          Ändern …
        </Button>
        {c.configured && (
          <Button size="sm" onClick={() => void api.cacheLocationSet(null).then(setC).catch(reportError)}>
            Standard
          </Button>
        )}
      </Field>
      {moving ? (
        <Note>
          Ab dem nächsten Start: {next}. Vorschaubilder, Wellenformen und die für die Vorschau nötigen Proxys entstehen dort neu. Der bisherige Ordner bleibt mit seinen Dateien liegen; wer ihn nicht mehr braucht, leert ihn vorher unter <i>Projekt › Cache</i>.
        </Note>
      ) : (
        <Note>Vorschaubilder, Wellenformen, Proxys und aufbereiteter Ton. Ein anderer Ordner gilt ab dem nächsten Start.</Note>
      )}
      <Field label="Höchstens">
        <Select width={180} value={limit} onChange={(v) => void setLimit(v)} options={limits} />
      </Field>
      <Note>
        Wird der Cache größer, löscht Kerf die am längsten nicht geschriebenen Einträge, sofort und danach alle zehn Minuten. Was die Medien des geöffneten Projekts brauchen, bleibt. Fehlende Vorschaubilder, Wellenformen und nötige Proxys erstellt Kerf beim nächsten Öffnen eines Projekts neu.
      </Note>
    </Group>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="-mt-1 pl-[104px] text-[10.5px] leading-snug text-fg-4">{children}</p>;
}

export function Preferences({ onClose }: { onClose: () => void }) {
  const p = useEditor(
    useShallow((s) => ({
      autosaveSeconds: s.autosaveSeconds,
      keepVersions: s.keepVersions,
      quality: s.quality,
      useProxies: s.useProxies,
      snapping: s.snapping,
      linkedSelection: s.linkedSelection,
      trackSize: s.trackSize,
      checkUpdates: s.checkUpdates,
      set: s.set,
    })),
  );
  const info = useProject((s) => s.appInfo);
  const autosave = AUTOSAVE.some((o) => o.value === p.autosaveSeconds) ? AUTOSAVE : [...AUTOSAVE, { value: p.autosaveSeconds, label: `alle ${p.autosaveSeconds} Sekunden` }];

  return (
    <Modal
      title="Einstellungen"
      width={560}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Fertig
        </Button>
      }
    >
      <div className="space-y-5">
        <Group title="Sichern">
          <Field label="Automatisch">
            <Select width={180} value={p.autosaveSeconds} onChange={(v) => p.set({ autosaveSeconds: v })} options={autosave} />
          </Field>
          <Note>Sichert ungespeicherte Änderungen zur Wiederherstellung nach einem Absturz. Die Projektdatei selbst ändert sich erst beim Speichern.</Note>
          <Field label="Versionen">
            <NumberField label="Versionen behalten" value={p.keepVersions} min={0} max={200} step={0.2} width={64} onCommit={(v) => p.set({ keepVersions: Math.round(v) })} />
            <span className="text-xs text-fg-3">{p.keepVersions === 0 ? "keine Versionen anlegen" : "ältere Stände pro Projekt"}</span>
          </Field>
          <Note>Jedes Speichern legt eine Version an (Datei › Versionen). Unveränderte Stände werden nicht doppelt gespeichert.</Note>
        </Group>

        <Group title="Vorschau">
          <Field label="Qualität">
            <Segmented
              size="sm"
              value={String(p.quality)}
              onChange={(v) => p.set({ quality: Number(v) })}
              options={[
                { value: "1", label: "Voll" },
                { value: "0.5", label: "½" },
                { value: "0.25", label: "¼" },
              ]}
            />
          </Field>
          <Field label="Proxys">
            <Toggle label="Proxys für die Vorschau verwenden" checked={p.useProxies} onChange={(v) => p.set({ useProxies: v })} />
            <span className="truncate text-xs text-fg-3">Export nutzt immer das Original</span>
          </Field>
        </Group>

        <Group title="Timeline">
          <Field label="Einrasten">
            <Toggle label="Einrasten" checked={p.snapping} onChange={(v) => p.set({ snapping: v })} />
          </Field>
          <Field label="Verknüpft">
            <Toggle label="Verknüpfte Auswahl" checked={p.linkedSelection} onChange={(v) => p.set({ linkedSelection: v })} />
            <span className="truncate text-xs text-fg-3">Bild und Ton gemeinsam auswählen</span>
          </Field>
          <Field label="Spurhöhe">
            <Segmented
              size="sm"
              value={p.trackSize}
              onChange={(v) => p.set({ trackSize: v })}
              options={[
                { value: "s", label: "Klein" },
                { value: "m", label: "Mittel" },
                { value: "l", label: "Groß" },
              ]}
            />
          </Field>
        </Group>

        <Group title="Updates">
          <Field label="Beim Start">
            <Toggle label="Beim Start nach Updates suchen" checked={p.checkUpdates} onChange={(v) => p.set({ checkUpdates: v })} />
            <Button size="sm" onClick={() => void checkForUpdate(false)}>
              Jetzt suchen
            </Button>
          </Field>
          <Note>Fragt die Release-Seite von Kerf auf GitHub ab. Installiert wird nur auf Nachfrage; Updates sind signiert und werden vor der Installation geprüft.</Note>
        </Group>

        <Group title="Tastatur">
          <Field label="Befehle">
            <Button size="sm" onClick={() => p.set({ dialog: { kind: "shortcuts" } })}>
              Tastaturbefehle bearbeiten …
            </Button>
            <span className="text-xs text-fg-3">Profile, Import und Export</span>
          </Field>
        </Group>

        <Group title="Datenschutz">
          <Note>
            <b className="font-medium text-fg-2">Lokal:</b> Projekte, Wiederherstellungs- und Versionsstände, der Cache (Proxys, Vorschaubilder, Wellenformen, Analysen), die Bibliothek (Presets, Favoriten, heruntergeladene Medien, Schriften) und das Protokoll liegen auf diesem Computer. Szenen-, Stille-, Beat- und Lautheitsanalysen rechnet Kerf lokal mit FFmpeg; es gibt keine KI- oder Cloud-Verarbeitung.
          </Note>
          <Note>
            <b className="font-medium text-fg-2">Übertragen wird nur auf deine Aktion:</b> Suchbegriffe und dein API-Schlüssel an den gewählten Stockmedien-Anbieter (Pexels, GIPHY, Freesound, Openverse), wenn du dort suchst oder lädst; die Abfrage der Release-Seite auf GitHub bei der Update-Suche (abschaltbar unter „Updates“). Medien und Projekte werden nie hochgeladen.
          </Note>
          <Note>
            <b className="font-medium text-fg-2">Keine Telemetrie:</b> Kerf sendet keine Nutzungsdaten und keine Absturzberichte. API-Schlüssel liegen im Schlüsselspeicher des Systems (oder nur für diese Sitzung), nicht in Projektdateien oder im Protokoll.
          </Note>
        </Group>

        <Group title="System">
          <Field label="FFmpeg">
            <span className="truncate text-xs text-fg-2" title={info?.ffmpeg ?? undefined}>
              {info?.ffmpeg?.replace(/\s*Copyright.*$/, "") ?? "nicht gefunden"}
            </span>
          </Field>
          <Field label="Encoder">
            <span className="truncate text-xs text-fg-2">
              {info?.hwEncoders?.length ? info.hwEncoders.join(", ") : info?.hwEncoders === null ? "wird erkannt …" : "nur Software"}
              {info?.swEncoders?.includes("libsvtav1") ? " · AV1 (SVT-AV1)" : info?.swEncoders ? " · kein AV1" : ""}
            </span>
          </Field>
        </Group>

        <CacheGroup />
      </div>
    </Modal>
  );
}
