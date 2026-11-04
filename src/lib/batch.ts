// File names of a batch export: one file per export preset in one folder.

/** A file name Windows accepts: no reserved characters, no trailing dots or spaces, not a device name. */
export function safeFileName(name: string): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = `_${s}`;
  return s.slice(0, 120) || "Export";
}

/**
 * Output paths in `dir` for `items` (preset label and extension):
 * "<base> - <label>.<ext>", unique without regard to case.
 */
export function batchOutputs(dir: string, base: string, items: { label: string; ext: string }[]): string[] {
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  const root = dir.replace(/[\\/]+$/, "");
  const seen = new Set<string>();
  return items.map(({ label, ext }) => {
    const stem = `${safeFileName(base)} - ${safeFileName(label)}`;
    let name = `${stem}.${ext}`;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${stem} (${n}).${ext}`;
    seen.add(name.toLowerCase());
    return `${root}${sep}${name}`;
  });
}
