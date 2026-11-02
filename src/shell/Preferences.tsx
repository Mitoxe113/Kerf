// Preferences: autosave and versions, preview, timeline defaults, keyboard
// and system information. Values live in the editor store (persisted);
// autosave/version settings are pushed to the engine by App.

import { FolderOpen } from "lucide-react";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/ipc";
import { useEditor } from "../state/editor";
import { useProject } from "../state/project";
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

        <Group title="Tastatur">
          <Field label="Befehle">
            <Button size="sm" onClick={() => p.set({ dialog: { kind: "shortcuts" } })}>
              Tastaturbefehle bearbeiten …
            </Button>
            <span className="text-xs text-fg-3">Profile, Import und Export</span>
          </Field>
        </Group>

        <Group title="System">
          <Field label="FFmpeg">
            <span className="truncate text-xs text-fg-2" title={info?.ffmpeg ?? undefined}>
              {info?.ffmpeg?.replace(/s*Copyright.*$/, "") ?? "nicht gefunden"}
            </span>
          </Field>
          <Field label="Encoder">
            <span className="truncate text-xs text-fg-2">{info?.hwEncoders?.length ? info.hwEncoders.join(", ") : info?.hwEncoders === null ? "wird erkannt …" : "nur Software"}</span>
          </Field>
          <Field label="Cache">
            <span className="min-w-0 flex-1 truncate text-xs text-fg-2" title={info?.cacheDir}>
              {info?.cacheDir}
            </span>
            {info?.cacheDir && <Button size="sm" onClick={() => void api.revealPath(info.cacheDir)}><FolderOpen size={12} /></Button>}
          </Field>
        </Group>
      </div>
    </Modal>
  );
}
