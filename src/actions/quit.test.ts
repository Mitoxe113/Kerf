import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ destroy: async () => void calls.push("destroy") }) }));
vi.mock("../engine/playback", () => ({ engine: { pause() {}, seek() {} } }));
vi.mock("../lib/ipc", () => ({
  api: { sessionEnd: async () => void calls.push("sessionEnd") },
  events: {},
  serial: (f: () => unknown) => f(),
}));

const { guardJobs, quit } = await import("./project");
const { useProject } = await import("../state/project");
const { useAssets } = await import("../state/assets");
const { useEditor } = await import("../state/editor");

type Dialog = { kind: string; body?: string; resolve: (v: boolean | "discard") => void };
const dialog = () => useEditor.getState().dialog as unknown as Dialog | null;

describe("quitting", () => {
  beforeEach(() => {
    calls.length = 0;
    useProject.setState({ exports: [], dirty: false });
    useAssets.setState({ downloads: [] });
    useEditor.setState({ dialog: null });
  });

  it("ends the session without asking when nothing runs", async () => {
    await quit();
    expect(calls).toEqual(["sessionEnd", "destroy"]);
    expect(dialog()).toBeNull();
  });

  it("asks before cancelling running exports and stays open on no", async () => {
    useProject.setState({ exports: [{ id: "a", status: "running" }, { id: "b", status: "done" }] as never });
    const pending = quit();
    await vi.waitFor(() => expect(dialog()?.kind).toBe("confirm"));
    expect(dialog()?.body).toContain("1 Export ist");
    dialog()!.resolve(false);
    await pending;
    expect(calls).toEqual([]);
  });

  it("counts downloads too and quits once confirmed", async () => {
    useProject.setState({ exports: [{ id: "a", status: "queued" }] as never });
    useAssets.setState({ downloads: [{ id: "d", state: "running" }] as never });
    const answer = guardJobs();
    await vi.waitFor(() => expect(dialog()?.body).toContain("1 Export und 1 Download sind"));
    dialog()!.resolve(true);
    expect(await answer).toBe(true);
  });
});
