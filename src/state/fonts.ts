// Fonts: the two bundled with Kerf, the system's (read only) and the ones the
// user imported into Kerf's font folder. Imported fonts are registered with
// the webview via @font-face; nothing is installed system-wide.

import { create } from "zustand";
import { invalidateText } from "../engine/text";
import { fileUrl } from "../lib/media";
import { api } from "../lib/ipc";
import type { FontFaceInfo } from "../lib/types";
import { reportError } from "./project";

const bundled = (family: string, designer: string, url: string): FontFaceInfo => ({
  family,
  style: "Variable",
  fullName: family,
  weight: 400,
  italic: false,
  variable: true,
  axes: [{ tag: "wght", min: 100, default: 400, max: 900 }],
  path: "",
  index: 0,
  source: "bundled",
  embedding: "installable",
  license: "SIL Open Font License 1.1 (OFL-1.1), laut Paketangabe von @fontsource-variable",
  licenseUrl: "https://openfontlicense.org",
  designer,
  vendorUrl: url,
});

/** Shipped with Kerf (npm packages @fontsource-variable/*, license OFL-1.1). */
export const BUNDLED_FONTS: FontFaceInfo[] = [
  bundled("Inter Variable", "Rasmus Andersson", "https://rsms.me/inter/"),
  bundled("JetBrains Mono Variable", "JetBrains", "https://www.jetbrains.com/lp/mono/"),
];

export interface FontFamily {
  family: string;
  source: FontFaceInfo["source"];
  faces: FontFaceInfo[];
}

interface FontState {
  loaded: boolean;
  loading: boolean;
  faces: FontFaceInfo[];
  error: string | null;
}

export const useFonts = create<FontState>(() => ({ loaded: false, loading: false, faces: BUNDLED_FONTS, error: null }));

/** Registered @font-face entries by "path#index". */
const registered = new Map<string, FontFace>();
/** Imported faces the webview could not load (they count as missing). */
const failed = new Set<string>();

/** Makes imported fonts usable in the webview (preview and export drawing). */
async function register(faces: FontFaceInfo[]) {
  let added = false;
  for (const f of faces) {
    const key = `${f.path}#${f.index}`;
    if (f.source !== "imported" || registered.has(key) || failed.has(key)) continue;
    try {
      const face = new FontFace(f.family, `url("${fileUrl(f.path)}")`, { weight: f.variable ? "100 900" : String(f.weight), style: f.italic ? "italic" : "normal" });
      document.fonts.add(await face.load());
      registered.set(key, face);
      added = true;
    } catch {
      failed.add(key);
    }
  }
  if (added) invalidateText();
}

let inflight: Promise<void> | null = null;

/** Reads the font list (once; `reread` reads it again, `refresh` also rescans the system folders); concurrent calls share one read. */
export function loadFonts(refresh = false, reread = false): Promise<void> {
  if (inflight) return inflight;
  if (useFonts.getState().loaded && !refresh && !reread) return Promise.resolve();
  useFonts.setState({ loading: true });
  inflight = (async () => {
    try {
      const faces = await api.fontList(refresh);
      useFonts.setState({ faces: [...BUNDLED_FONTS, ...faces], loaded: true, loading: false, error: null });
      await register(faces);
    } catch (e) {
      useFonts.setState({ loaded: true, loading: false, error: String((e as { message?: string })?.message ?? e) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function importFonts(paths: string[]): Promise<FontFaceInfo[]> {
  try {
    const got = await api.fontImport(paths);
    await register(got);
    await loadFonts(false, true);
    return got;
  } catch (e) {
    reportError(e);
    return [];
  }
}

export async function removeFont(path: string) {
  try {
    await api.fontRemove(path);
    for (const [key, face] of registered) {
      if (!key.startsWith(path + "#")) continue;
      document.fonts.delete(face);
      registered.delete(key);
    }
    invalidateText();
    await loadFonts(false, true);
  } catch (e) {
    reportError(e);
  }
}

/** Faces grouped by family; imported first, then bundled, then system. */
export function families(faces: FontFaceInfo[]): FontFamily[] {
  const map = new Map<string, FontFamily>();
  for (const f of faces) {
    const key = `${f.source}:${f.family}`;
    let g = map.get(key);
    if (!g) map.set(key, (g = { family: f.family, source: f.source, faces: [] }));
    g.faces.push(f);
  }
  const rank = { imported: 0, bundled: 1, system: 2 };
  return [...map.values()].sort((a, b) => rank[a.source] - rank[b.source] || a.family.localeCompare(b.family));
}

/** Whether `family` is known (bundled, imported or found on the system); null until the list is loaded. */
export function fontAvailable(family: string, state: FontState = useFonts.getState()): boolean | null {
  const f = family.trim().toLowerCase();
  if (["sans-serif", "serif", "monospace", "system-ui"].includes(f)) return true;
  if (!state.loaded || state.error) return null;
  // System fonts are resolved by the webview by name; imported ones only count once registered.
  return state.faces.some((x) => x.family.toLowerCase() === f && !(x.source === "imported" && failed.has(`${x.path}#${x.index}`)));
}

export const EMBEDDING_LABELS: Record<FontFaceInfo["embedding"], string> = {
  "": "keine Angabe in der Datei",
  installable: "installierbar (keine Einschränkung angegeben)",
  restricted: "eingeschränkt: Einbetten laut Datei nicht erlaubt",
  previewAndPrint: "nur Vorschau und Druck",
  editable: "bearbeitbar einbettbar",
};
