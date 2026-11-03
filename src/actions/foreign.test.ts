import { beforeEach, describe, expect, it, vi } from "vitest";

const saved: string[] = [];
let openedPath = "";
let duringOpen: (() => void) | null = null;
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn(async () => "/neu/kopie.kerf") }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ destroy: async () => undefined }) }));
vi.mock("../engine/playback", () => ({ engine: { pause() {}, seek() {} } }));
vi.mock("../lib/ipc", () => ({
  api: {
    projectOpen: async (path: string) => {
      openedPath = path;
      duringOpen?.();
      duringOpen = null;
      return { usedBackup: false, state: { project: { id: "p", name: "Film", media: [], sequences: [], activeSequence: "s" }, path, dirty: false, revision: 0, history: { canUndo: false, canRedo: false } } };
    },
    projectSave: async (path: string) => {
      saved.push(path);
      return { path, revision: 1, dirty: false, name: "Film" };
    },
  },
  events: {},
  serial: (f: () => unknown) => f(),
}));

const { noteForeignFields, openProject, saveProject } = await import("./project");
const { useProject } = await import("../state/project");
const { useEditor } = await import("../state/editor");
type Dialog = { kind: string; body?: string; resolve: (v: boolean | "discard") => void };
const dialog = () => useEditor.getState().dialog as unknown as Dialog | null;

describe("files with unknown fields", () => {
  beforeEach(() => {
    saved.length = 0;
    useEditor.setState({ dialog: null });
    useProject.setState({ dirty: false });
  });

  it("asks before overwriting, also when the report came before the open finished", async () => {
    // The engine's background check reports while the open is still in flight.
    duringOpen = () => noteForeignFields("/p/film.kerf", ["laterFeature"]);
    await openProject("/p/film.kerf");
    expect(openedPath).toBe("/p/film.kerf");
    const pending = saveProject();
    await vi.waitFor(() => expect(dialog()?.body).toContain("laterFeature"));
    dialog()!.resolve(true); // save under a new name
    expect(await pending).toBe(true);
    expect(saved).toEqual(["/neu/kopie.kerf"]);
  });

  it("overwrites only when told to, and a report for another file is ignored", async () => {
    await openProject("/p/film.kerf");
    noteForeignFields("/p/anderes.kerf", ["x"]);
    expect(await saveProject()).toBe(true);
    expect(dialog()).toBeNull();
    noteForeignFields("/p/film.kerf", ["y"]);
    const pending = saveProject();
    await vi.waitFor(() => expect(dialog()?.kind).toBe("confirm"));
    dialog()!.resolve("discard");
    expect(await pending).toBe(true);
    expect(saved).toEqual(["/p/film.kerf", "/p/film.kerf"]);
  });
});
