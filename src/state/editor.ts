// UI state that is not part of the document: tools, selection, view,
// workspaces. View preferences persist per user in localStorage.

import { create } from "zustand";
import type { KeyParam, PasteItem, Rgb, Uuid } from "../lib/types";

export type ToolId = "select" | "razor" | "ripple" | "roll" | "slip" | "slide" | "hand" | "zoom";
export type PanelId = "media" | "monitor" | "inspector" | "timeline" | "meters" | "scopes" | "export" | "mixer" | "history" | "source" | "subtitles" | "multicam";
export type WorkspaceId = "edit" | "media" | "color" | "audio" | "export";

export interface LayoutNode {
  dir: "row" | "col";
  children: LayoutChild[];
}
/** Panels sharing one area as tabs. */
export interface PanelGroup {
  tabs: PanelId[];
  active: number;
}

export interface LayoutChild {
  id: string;
  size: number;
  /** Fixed size in px (not resizable). */
  fixed?: number;
  node: LayoutNode | PanelGroup | PanelId;
}

export const isBranch = (n: LayoutChild["node"]): n is LayoutNode => typeof n === "object" && "dir" in n;
/** Tabs of a leaf (a bare panel id is a single tab). */
export const leafTabs = (n: PanelGroup | PanelId): PanelId[] => (typeof n === "string" ? [n] : n.tabs);

export interface WorkspaceLayout {
  root: LayoutNode;
  hidden: PanelId[];
}

const row = (...children: LayoutChild[]): LayoutNode => ({ dir: "row", children });
const col = (...children: LayoutChild[]): LayoutNode => ({ dir: "col", children });
const tabs = (...t: PanelId[]): PanelGroup => ({ tabs: t, active: 0 });
const leaf = (node: PanelId | PanelGroup | LayoutNode, size: number, id?: string, fixed?: number): LayoutChild => ({
  id: id ?? (typeof node === "string" ? node : isBranch(node) ? Math.random().toString(36).slice(2) : node.tabs[0]),
  size,
  node,
  fixed,
});
const timelineRow = (size: number) => leaf(row(leaf("timeline", 1), leaf("meters", 0, "meters", 54)), size, "bottom");

export const DEFAULT_LAYOUTS: Record<WorkspaceId, WorkspaceLayout> = {
  edit: {
    root: col(leaf(row(leaf(tabs("media", "source", "multicam", "subtitles"), 0.25), leaf("monitor", 0.49), leaf(tabs("inspector", "history"), 0.26)), 0.57, "top"), timelineRow(0.43)),
    hidden: [],
  },
  media: {
    root: col(leaf(row(leaf("media", 0.36), leaf("source", 0.32), leaf("monitor", 0.32)), 0.64, "top"), timelineRow(0.36)),
    hidden: [],
  },
  color: {
    root: col(leaf(row(leaf("scopes", 0.3), leaf("monitor", 0.44), leaf(tabs("inspector", "history"), 0.26)), 0.62, "top"), timelineRow(0.38)),
    hidden: [],
  },
  audio: {
    root: col(leaf(row(leaf("media", 0.24), leaf("monitor", 0.4), leaf("mixer", 0.36)), 0.55, "top"), timelineRow(0.45)),
    hidden: [],
  },
  export: {
    root: col(leaf(row(leaf("monitor", 0.56), leaf("export", 0.44)), 0.62, "top"), timelineRow(0.38)),
    hidden: [],
  },
};

export const WORKSPACES: { id: WorkspaceId; label: string }[] = [
  { id: "edit", label: "Schnitt" },
  { id: "media", label: "Medien" },
  { id: "color", label: "Farbe" },
  { id: "audio", label: "Audio" },
  { id: "export", label: "Export" },
];

export const PANEL_LABELS: Record<PanelId, string> = {
  media: "Medien",
  monitor: "Programm",
  inspector: "Inspector",
  timeline: "Timeline",
  meters: "Pegel",
  scopes: "Scopes",
  export: "Export",
  mixer: "Mixer",
  history: "Verlauf",
  source: "Quelle",
  subtitles: "Untertitel",
  multicam: "Multicam",
};

export interface CustomWorkspace {
  id: string;
  name: string;
  base: WorkspaceId;
  layout: WorkspaceLayout;
}

export type TrackSize = "s" | "m" | "l";
export const TRACK_HEIGHTS: Record<TrackSize, { video: number; audio: number }> = {
  s: { video: 40, audio: 36 },
  m: { video: 64, audio: 54 },
  l: { video: 96, audio: 80 },
};

export interface Guides {
  /** Action (90 %) and title (80 %) safe areas. */
  safe: boolean;
  thirds: boolean;
  center: boolean;
  /** Masks the frame to this aspect ratio (width / height), e.g. 2.39 or 9/16. */
  aspect: number | null;
  /** Playback frame rate and dropped frames. */
  stats: boolean;
}

export const NO_GUIDES: Guides = { safe: false, thirds: false, center: false, aspect: null, stats: false };

export type Dialog =
  | { kind: "newSequence" }
  | { kind: "sequenceSettings"; sequence: Uuid }
  | { kind: "shortcuts" }
  | { kind: "about" }
  | { kind: "update" }
  | { kind: "recovery" }
  | { kind: "versions" }
  | { kind: "normalize"; clips: Uuid[] }
  | { kind: "trackEffects"; sequence: Uuid; track: Uuid }
  | { kind: "multicam"; media: Uuid[] }
  | { kind: "curve"; sequence: Uuid; clip: Uuid; params: KeyParam[]; at: number }
  | { kind: "palette"; query: string }
  | { kind: "preferences" }
  | { kind: "exportLog"; job: Uuid; title: string }
  | { kind: "saveWorkspace" }
  | { kind: "prompt"; title: string; label: string; value: string; confirm: string; resolve: (v: string | null) => void }
  | { kind: "confirm"; title: string; body: string; confirm: string; danger?: boolean; resolve: (v: boolean | "discard") => void; discard?: string };

interface EditorStore {
  tool: ToolId;
  selection: Uuid[];
  mediaSelection: Uuid[];
  currentBin: Uuid | null;
  /** Pixels per frame. */
  zoom: number;
  scrollX: number;
  scrollY: number;
  trackSize: TrackSize;
  snapping: boolean;
  linkedSelection: boolean;
  useProxies: boolean;
  quality: number;
  /** Program monitor overlays. */
  guides: Guides;
  /** Start screen visible (this session). */
  startScreen: boolean;
  /** Show the start screen when Kerf launches. */
  showStartScreen: boolean;
  monitorZoom: "fit" | number;
  workspace: string;
  layouts: Record<string, WorkspaceLayout>;
  customWorkspaces: CustomWorkspace[];
  clipboard: PasteItem[];
  dialog: Dialog | null;
  /** Eyedropper waiting for a click in the program monitor (null = cancelled). */
  picker: ((rgb: Rgb | null) => void) | null;
  inspectorTab: "clip" | "title" | "color" | "effects" | "audio";
  /** Subtitle cue being edited in the subtitles panel. */
  activeCue: Uuid | null;
  /** Transition clicked in the timeline (id of the clip it leads into); cleared by any selection. */
  activeTransition: Uuid | null;
  mediaView: "grid" | "list";
  mediaSort: "name" | "date" | "duration" | "kind";
  mediaFilter: "all" | "video" | "audio" | "image" | "favorites";
  mediaSearch: string;
  fullscreen: boolean;
  /** Track height while its header edge is being dragged (not persisted). */
  trackResize: { track: Uuid; h: number } | null;
  /** Panel that received the last click; monitor shortcuts act on it (not persisted). */
  focusedPanel: PanelId | null;
  /** Asks the media browser to start inline renaming of this item. */
  renameMedia: Uuid | null;
  /** Seconds between recovery snapshots. */
  autosaveSeconds: number;
  /** Saved versions kept per project (0 = none). */
  keepVersions: number;
  /** Look for a new version when Kerf starts. */
  checkUpdates: boolean;
  /** The program output window is open (not persisted). */
  outputWindow: boolean;
  /** Pixels per sequence pixel the output window shows (0 = none); the monitor renders at least that many. */
  outputScale: number;

  set: (p: Partial<EditorStore>) => void;
  setTool: (t: ToolId) => void;
  select: (ids: Uuid[]) => void;
  setLayout: (ws: string, layout: WorkspaceLayout) => void;
  togglePanel: (p: PanelId) => void;
  /** Shows `p` (adding it to the layout if needed) and makes it the active tab. */
  focusPanel: (p: PanelId) => void;
  resetWorkspace: () => void;
}

const PREFS_KEY = "kerf.prefs.v1";
const PERSISTED = [
  "trackSize",
  "snapping",
  "linkedSelection",
  "useProxies",
  "quality",
  "guides",
  "showStartScreen",
  "workspace",
  "layouts",
  "customWorkspaces",
  "mediaView",
  "mediaSort",
  "autosaveSeconds",
  "keepVersions",
  "checkUpdates",
] as const;

function loadPrefs(): Partial<EditorStore> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<EditorStore>) : {};
  } catch {
    return {};
  }
}

const prefs = loadPrefs();

export const useEditor = create<EditorStore>((set, get) => ({
  tool: "select",
  selection: [],
  mediaSelection: [],
  currentBin: null,
  zoom: 2,
  scrollX: 0,
  scrollY: 0,
  trackSize: "m",
  snapping: true,
  linkedSelection: true,
  useProxies: false,
  quality: 1,
  monitorZoom: "fit",
  workspace: "edit",
  layouts: {},
  customWorkspaces: [],
  clipboard: [],
  dialog: null,
  picker: null,
  inspectorTab: "clip",
  activeCue: null,
  activeTransition: null,
  mediaView: "grid",
  mediaSort: "name",
  mediaFilter: "all",
  mediaSearch: "",
  fullscreen: false,
  trackResize: null,
  focusedPanel: null,
  renameMedia: null,
  autosaveSeconds: 30,
  keepVersions: 20,
  checkUpdates: true,
  outputWindow: false,
  outputScale: 0,
  showStartScreen: true,
  ...prefs,
  startScreen: prefs.showStartScreen ?? true,
  // Older preferences stored only a safe-area flag; new guide kinds default off.
  guides: { ...NO_GUIDES, safe: (prefs as { safeAreas?: boolean }).safeAreas ?? false, ...prefs.guides },

  set: (p) => set(p),
  setTool: (tool) => set({ tool }),
  select: (selection) => set({ selection, activeTransition: null }),
  setLayout: (ws, layout) => set((s) => ({ layouts: { ...s.layouts, [ws]: layout } })),
  togglePanel: (p) => {
    const layout = currentLayout(get());
    if (layoutPanels(layout).includes(p)) get().setLayout(get().workspace, { ...layout, hidden: [...layout.hidden, p] });
    else get().focusPanel(p);
  },
  focusPanel: (p) => {
    const layout = currentLayout(get());
    const hidden = layout.hidden.filter((x) => x !== p);
    const focus = (g: PanelGroup) => ({ ...g, active: g.tabs.indexOf(p) });
    const root =
      mapLeaf(layout.root, (t) => t.includes(p), focus) ??
      // Not in this layout yet: add it as a tab next to the inspector (or the first area).
      mapLeaf(layout.root, (t) => t.includes("inspector"), (g) => focus({ ...g, tabs: [...g.tabs, p] })) ??
      mapLeaf(layout.root, () => true, (g) => focus({ ...g, tabs: [...g.tabs, p] }))!;
    get().setLayout(get().workspace, { root, hidden });
  },
  resetWorkspace: () => {
    const s = get();
    const layouts = { ...s.layouts };
    delete layouts[s.workspace];
    set({ layouts });
  },
}));

export function currentLayout(s: Pick<EditorStore, "workspace" | "layouts" | "customWorkspaces">): WorkspaceLayout {
  const saved = s.layouts[s.workspace];
  if (saved) return saved;
  const custom = s.customWorkspaces.find((c) => c.id === s.workspace);
  if (custom) return custom.layout;
  return DEFAULT_LAYOUTS[(s.workspace as WorkspaceId) in DEFAULT_LAYOUTS ? (s.workspace as WorkspaceId) : "edit"];
}

/** Panels present (and not hidden) in a layout. */
export function layoutPanels(layout: WorkspaceLayout): PanelId[] {
  const out: PanelId[] = [];
  const walk = (n: LayoutNode) => n.children.forEach((c) => (isBranch(c.node) ? walk(c.node) : out.push(...leafTabs(c.node))));
  walk(layout.root);
  return out.filter((p) => !layout.hidden.includes(p));
}

// Persist only when a persisted field changed (not on every scroll or selection change).
useEditor.subscribe((s, prev) => {
  if (PERSISTED.every((k) => s[k] === prev[k])) return;
  try {
    const out: Record<string, unknown> = {};
    for (const k of PERSISTED) out[k] = s[k];
    localStorage.setItem(PREFS_KEY, JSON.stringify(out));
  } catch {
    // Storage unavailable: preferences simply don't persist.
  }
});

/** Replaces the first leaf whose tabs match `pred`; null when none matches. */
export function mapLeaf(n: LayoutNode, pred: (tabs: PanelId[]) => boolean, fn: (g: PanelGroup) => PanelGroup): LayoutNode | null {
  for (let i = 0; i < n.children.length; i++) {
    const c = n.children[i];
    let next: LayoutChild["node"] | null = null;
    if (isBranch(c.node)) next = mapLeaf(c.node, pred, fn);
    else if (c.id !== "meters" && pred(leafTabs(c.node))) next = fn(typeof c.node === "string" ? { tabs: [c.node], active: 0 } : c.node);
    if (next) return { ...n, children: n.children.map((x, k) => (k === i ? { ...x, node: next } : x)) };
  }
  return null;
}

/** Ends a running eyedropper without a colour. */
export function cancelPick() {
  const pick = useEditor.getState().picker;
  if (!pick) return;
  useEditor.getState().set({ picker: null });
  pick(null);
}
