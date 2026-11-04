// Decides which files of a watch folder to import. A file is imported once,
// when it is new since the project was opened (or the folder was added) and
// two scans in a row saw the same size and time, so a file that is still
// being copied is not read half-written. Files are keyed case-insensitively
// like the import (media_import).

import type { WatchedFile } from "./types";

export const fileKey = (path: string) => path.replace(/\\/g, "/").toLowerCase();

export interface FolderScan {
  /** Files handled already: present at the first scan, imported, or found in the project. */
  known: Set<string>;
  /** New files by key: the size and time of the last scan. */
  pending: Map<string, string>;
  /** Present at the first scan but not in the project (paths). */
  outside: string[];
  missing: boolean;
}

/**
 * One scan of a folder. `prev` undefined = first scan: everything present
 * counts as known (files not in the project are listed in `outside`).
 * `files` null = the folder is missing. Returns the new state and the paths
 * to import now.
 */
export function scanStep(prev: FolderScan | undefined, files: WatchedFile[] | null, inProject: (key: string) => boolean): { state: FolderScan; ready: string[] } {
  if (!files) return { state: prev ? { ...prev, missing: true } : { known: new Set(), pending: new Map(), outside: [], missing: true }, ready: [] };
  if (!prev || (prev.missing && !prev.known.size)) {
    return { state: { known: new Set(files.map((f) => fileKey(f.path))), pending: new Map(), outside: files.filter((f) => !inProject(fileKey(f.path))).map((f) => f.path), missing: false }, ready: [] };
  }
  const known = new Set(prev.known);
  const pending = new Map<string, string>();
  const ready: string[] = [];
  for (const f of files) {
    const key = fileKey(f.path);
    if (known.has(key)) continue;
    if (inProject(key)) {
      known.add(key);
      continue;
    }
    const sig = `${f.size}:${f.modified}`;
    if (prev.pending.get(key) === sig && f.size > 0) {
      ready.push(f.path);
      known.add(key);
    } else pending.set(key, sig);
  }
  const present = new Set(files.map((f) => fileKey(f.path)));
  const outside = prev.outside.filter((p) => present.has(fileKey(p)) && !inProject(fileKey(p)));
  return { state: { known, pending, outside, missing: false }, ready };
}
