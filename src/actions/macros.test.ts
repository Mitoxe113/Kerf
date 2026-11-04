import { beforeEach, describe, expect, it } from "vitest";
import { MAX_STEPS, parseMacros, recordable, runSteps, useMacros, type StepAction } from "./macros";

describe("macros", () => {
  beforeEach(() => useMacros.setState({ macros: [], recording: null }));

  it("reads stored macros defensively", () => {
    const long = Array.from({ length: MAX_STEPS + 5 }, () => "clip.split");
    const got = parseMacros([
      { id: "a", name: "  Schnitt  ", steps: ["clip.split", 3, "macro.run1", "edit.delete"] },
      { id: "a", name: "doppelt", steps: [] },
      { id: "b", name: "", steps: long },
      { id: "", name: "ohne Id", steps: [] },
      { name: "kaputt" },
      "nichts",
    ]);
    expect(got.map((m) => [m.id, m.name, m.steps.length])).toEqual([
      ["a", "Schnitt", 2],
      ["b", "Makro", MAX_STEPS],
    ]);
    expect(got[0].steps).toEqual(["clip.split", "edit.delete"]);
    expect(parseMacros({ not: "a list" })).toEqual([]);
  });

  it("records commands but not the macro commands themselves", () => {
    const s = useMacros.getState();
    s.record("clip.split");
    expect(useMacros.getState().recording).toBeNull();
    s.startRecording();
    for (const id of ["clip.split", "macro.record", "macro.run1", "edit.delete"]) useMacros.getState().record(id);
    expect(useMacros.getState().stopRecording()).toEqual(["clip.split", "edit.delete"]);
    expect(useMacros.getState().recording).toBeNull();
    expect(recordable("macro.manage")).toBe(false);
    const m = useMacros.getState().add("  Neu ", ["edit.copy", "macro.run2"]);
    expect([m?.name, m?.steps]).toEqual(["Neu", ["edit.copy"]]);
    expect(useMacros.getState().add("   ", [])).toBeNull();
  });

  it("runs steps in order and stops at the first one that cannot run", async () => {
    const log: string[] = [];
    let open = true;
    const actions: Record<string, StepAction> = {
      a: { run: async () => void log.push("a") },
      b: { run: () => void log.push("b"), enabled: () => open },
      boom: {
        run: () => {
          throw new Error("x");
        },
      },
    };
    let settled = 0;
    const settle = async () => void settled++;
    expect(await runSteps(["a", "b", "a"], (id) => actions[id], settle)).toEqual({ done: 3 });
    expect([log, settled]).toEqual([["a", "b", "a"], 3]);
    open = false;
    log.length = 0;
    expect(await runSteps(["a", "b", "a"], (id) => actions[id], settle)).toEqual({ done: 1, stop: { index: 1, reason: "disabled" } });
    expect(log).toEqual(["a"]);
    expect((await runSteps(["a", "gone"], (id) => actions[id], settle)).stop).toEqual({ index: 1, reason: "unknown" });
    expect((await runSteps(["boom", "a"], (id) => actions[id], settle)).stop?.reason).toBe("failed");
  });
});
