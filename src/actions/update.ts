// Updates: Kerf asks its GitHub releases for a newer version (latest.json,
// whose installers are signed with the project's updater key) and installs
// it when asked to.

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { api } from "../lib/ipc";
import { useEditor } from "../state/editor";
import { toast } from "../state/toasts";
import { guardUnsaved } from "./project";

let pending: Update | null = null;

/** The update found by the last check. */
export const pendingUpdate = () => pending;

/**
 * Looks for a newer version and offers it. `quiet` (the check at start)
 * says nothing when there is none or the check fails, and only mentions an
 * update when a dialog is already open.
 */
export async function checkForUpdate(quiet: boolean) {
  let update: Update | null;
  try {
    update = await check({ timeout: 15_000 });
  } catch (e) {
    // No release published yet (or none with update data): nothing to offer.
    if (quiet) return;
    if (/valid release JSON/i.test(String(e))) toast.info("Keine Updates gefunden", "Es ist noch keine Version mit Update-Daten veröffentlicht.");
    else toast.error("Update-Prüfung fehlgeschlagen", String(e));
    return;
  }
  if (!update) {
    if (!quiet) toast.success("Kerf ist aktuell");
    return;
  }
  pending = update;
  if (quiet && useEditor.getState().dialog) toast.info(`Kerf ${update.version} ist verfügbar`, "Hilfe › Nach Updates suchen …");
  else useEditor.getState().set({ dialog: { kind: "update" } });
}

/**
 * Downloads and installs the pending update, then restarts Kerf (Windows:
 * the installer closes it). Unsaved changes are asked about first; false
 * when that was cancelled.
 */
export async function installUpdate(onProgress: (fraction: number | null) => void): Promise<boolean> {
  const update = pending;
  if (!update || !(await guardUnsaved())) return false;
  let total = 0;
  let done = 0;
  onProgress(null);
  await update.downloadAndInstall((e) => {
    if (e.event === "Started") total = e.data.contentLength ?? 0;
    else if (e.event === "Progress") {
      done += e.data.chunkLength;
      onProgress(total ? done / total : null);
    } else onProgress(1);
  });
  await api.sessionEnd().catch(() => undefined);
  await relaunch();
  return true;
}
