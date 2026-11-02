import { describe, expect, it } from "vitest";
import { keymapFile, parseKeymapFile, profileChanged } from "./keymap";

describe("keyboard profiles", () => {
  const known = new Set(["file.save", "seq.razor"]);

  it("round-trips an exported profile and skips unknown commands", () => {
    const file = keymapFile("Schnitt", { "seq.razor": ["Ctrl+B"], "future.cmd": ["F9"] });
    const parsed = parseKeymapFile(JSON.stringify(file), known);
    expect(parsed.name).toBe("Schnitt");
    expect(parsed.overrides).toEqual({ "seq.razor": ["Ctrl+B"] });
    expect(parsed.skipped).toBe(1);
  });

  it("rejects files that are not keyboard profiles", () => {
    expect(() => parseKeymapFile(JSON.stringify({ app: "other", overrides: {} }), known)).toThrow();
    expect(() => parseKeymapFile("not json", known)).toThrow();
    const bad = parseKeymapFile(JSON.stringify({ app: "kerf", kind: "keymap", version: 1, name: "", overrides: { "file.save": [1] } }), known);
    expect(bad).toEqual({ name: "Importiert", overrides: {}, skipped: 1 });
  });

  it("detects changes against the active profile, ignoring key order", () => {
    const profiles = { Mein: { "seq.razor": ["Ctrl+B"], "file.save": ["Ctrl+S"] } };
    expect(profileChanged({ overrides: { "file.save": ["Ctrl+S"], "seq.razor": ["Ctrl+B"] }, profiles, profile: "Mein" })).toBe(false);
    expect(profileChanged({ overrides: {}, profiles, profile: "Mein" })).toBe(true);
    expect(profileChanged({ overrides: {}, profiles, profile: "Standard" })).toBe(false);
  });
});
