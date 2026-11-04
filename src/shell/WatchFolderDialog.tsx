// Adds a watch folder (kerf_core EditCommand::AddWatchFolder): new media
// files in it are imported into the chosen bin while the project is open.

import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { MAX_WATCH_FOLDERS, type Uuid } from "../lib/types";
import { edit, useProject } from "../state/project";
import { toast } from "../state/toasts";
import { syncWatchFolder } from "../state/watch";
import { Button, Field, Modal, Select, Toggle } from "../ui/primitives";

/** Bins that hold media, as "Parent › Child" paths. */
function binOptions(bins: { id: Uuid; name: string; parent: Uuid | null; smart?: unknown }[]) {
  const path = (id: Uuid | null, depth = 0): string => {
    const b = bins.find((x) => x.id === id);
    return !b || depth > bins.length ? "" : `${b.parent ? `${path(b.parent, depth + 1)} › ` : ""}${b.name}`;
  };
  return [
    { value: "", label: "Projekt (oberste Ebene)" },
    ...bins.filter((b) => !b.smart).map((b) => ({ value: b.id, label: path(b.id) })).sort((a, b) => a.label.localeCompare(b.label, "de")),
  ];
}

export function WatchFolderDialog({ bin, onClose }: { bin: Uuid | null; onClose: () => void }) {
  const project = useProject((s) => s.project);
  const [path, setPath] = useState("");
  const [target, setTarget] = useState<string>(bin ?? "");
  const [subfolders, setSubfolders] = useState(true);
  const [existing, setExisting] = useState(true);
  const count = project?.watchFolders?.length ?? 0;

  const choose = async () => {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setPath(sel);
  };
  const save = async () => {
    if (!path) return;
    const d = await edit({ type: "addWatchFolder", path, bin: target || null, subfolders });
    const id = d?.outcome.created[0];
    onClose();
    if (!id) return;
    if (!existing) {
      toast.success("Ordner wird überwacht", "Neue Dateien werden importiert, sobald sie fertig kopiert sind.");
      return;
    }
    const n = await syncWatchFolder(id);
    if (n === null) toast.error("Ordner nicht erreichbar", path);
    else toast.success("Ordner wird überwacht", n === 1 ? "1 vorhandenes Medium importiert." : `${n} vorhandene Medien importiert.`);
  };

  return (
    <Modal
      title="Ordner überwachen"
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!path || count >= MAX_WATCH_FOLDERS} onClick={() => void save()}>
            Überwachen
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Field label="Ordner">
          <span className="min-w-0 flex-1 truncate text-xs text-fg-2" title={path}>
            {path || "Kein Ordner gewählt"}
          </span>
          <Button size="sm" onClick={() => void choose()}>
            Wählen …
          </Button>
        </Field>
        <Field label="Ablage">
          <Select value={target} onChange={setTarget} options={binOptions(project?.bins ?? [])} width={280} label="Ablage" />
        </Field>
        <Field label="Unterordner">
          <Toggle checked={subfolders} onChange={setSubfolders} label="Unterordner einbeziehen" />
        </Field>
        <Field label="Vorhandene">
          <Toggle checked={existing} onChange={setExisting} label="Vorhandene Dateien jetzt importieren" />
          <span className="text-xs text-fg-3">jetzt importieren</span>
        </Field>
        <p className="text-xs text-fg-4">
          Solange das Projekt geöffnet ist, sieht Kerf alle 3 Sekunden nach und importiert neue Video-, Audio- und Bilddateien, sobald sie zwei Mal hintereinander gleich groß sind. Dateien, die schon vor dem Öffnen im Ordner lagen, meldet Kerf nur; „Projekt › Ordner › Abgleichen“ importiert sie.
        </p>
        {count >= MAX_WATCH_FOLDERS && <p className="text-xs text-warn">Ein Projekt überwacht höchstens {MAX_WATCH_FOLDERS} Ordner.</p>}
      </div>
    </Modal>
  );
}
