import { describe, expect, it } from "vitest";
import tables from "../../fixtures/effects/tables.json";
import { FX_CATALOG, FX_IMPLEMENTED, FX_SHADERS, fxDefaults, fxIsIdentity, fxSanitize, glowFn, toneFns, toneTable } from "./fx";

describe("effect catalogue", () => {
  it("has a preview implementation for every catalogue effect", () => {
    expect(new Set(FX_CATALOG.map((d) => d.id))).toEqual(FX_IMPLEMENTED);
  });

  it("defaults survive sanitizing", () => {
    for (const d of FX_CATALOG) expect(fxSanitize(d, fxDefaults(d))).toEqual(fxDefaults(d));
  });

  it("clamps and rounds like the engine", () => {
    const d = FX_CATALOG.find((x) => x.id === "posterize")!;
    expect(fxSanitize(d, { levels: 99.6, evil: 1 })).toEqual({ levels: 32 });
  });

  it("knows when an effect changes nothing", () => {
    expect(fxIsIdentity("invert", { amount: 0 })).toBe(true);
    expect(fxIsIdentity("invert", { amount: 0.5 })).toBe(false);
    expect(fxIsIdentity("unknown", {})).toBe(true);
  });

  it("every shader source starts with the GLSL ES 3 header", () => {
    for (const [name, src] of Object.entries(FX_SHADERS)) expect(src.startsWith("#version 300 es"), name).toBe(true);
  });
});

describe("tone tables match the export's lutrgb", () => {
  for (const c of tables.tone)
    it(c.fx, () => {
      const fns = toneFns(c.fx, c.params as unknown as Record<string, number>)!;
      expect(fns.map((f) => Array.from(toneTable(f)))).toEqual(c.tables);
    });

  it("glow bright pass", () => {
    expect(Array.from(toneTable(glowFn(0.6)))).toEqual(tables.glow06);
  });
});
