// Errors the page cannot handle go into Kerf's log file (see the log folder in
// "Über Kerf"), so a report can include them. Nothing leaves the computer.

import { api } from "./ipc";

let sent = 0;

export function logError(message: string, level: "error" | "warn" = "error") {
  // A loop that throws every frame must not flood the log.
  if (++sent > 200) return;
  void api.logFrontend(level, message).catch(() => undefined);
}

/** Logs uncaught exceptions and rejected promises (once, at start). */
export function installErrorLogging() {
  window.addEventListener("error", (e) => logError(`uncaught: ${e.error?.stack ?? e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    logError(`unhandled rejection: ${r instanceof Error ? (r.stack ?? r.message) : typeof r === "object" ? JSON.stringify(r) : String(r)}`, "warn");
  });
}
