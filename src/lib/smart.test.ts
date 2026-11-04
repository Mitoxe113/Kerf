import { describe, expect, it } from "vitest";
import { EMPTY_RULES, describeRules, holdingBin, smartMatch, usedMedia } from "./smart";
import type { Bin, MediaAsset, Project, SmartRules } from "./types";

const asset = (over: Partial<MediaAsset>): MediaAsset =>
  ({ id: "m", name: "Interview A", kind: "video", status: { state: "ready" }, favorite: false, label: "none", tags: [], note: "", title: null, ...over }) as unknown as MediaAsset;
const rules = (over: Partial<SmartRules>): SmartRules => ({ ...EMPTY_RULES, ...over });

describe("smart bins", () => {
  const none = new Set<string>();

  it("matches everything without rules", () => {
    expect(smartMatch(EMPTY_RULES, asset({}), none)).toBe(true);
    expect(describeRules(EMPTY_RULES)).toBe("Alle Medien");
  });

  it("tells titles from other images", () => {
    const title = asset({ kind: "image", title: {} as MediaAsset["title"] });
    const still = asset({ kind: "image" });
    expect(smartMatch(rules({ kinds: ["title"] }), title, none)).toBe(true);
    expect(smartMatch(rules({ kinds: ["title"] }), still, none)).toBe(false);
    expect(smartMatch(rules({ kinds: ["image", "audio"] }), still, none)).toBe(true);
  });

  it("finds text in name, note and tags without case", () => {
    expect(smartMatch(rules({ text: " interview " }), asset({}), none)).toBe(true);
    expect(smartMatch(rules({ text: "drohne" }), asset({ note: "Drohnenflug am Morgen" }), none)).toBe(true);
    expect(smartMatch(rules({ text: "b-roll" }), asset({ tags: ["B-Roll"] }), none)).toBe(true);
    expect(smartMatch(rules({ text: "musik" }), asset({}), none)).toBe(false);
  });

  it("needs every tag, any label, and the flags", () => {
    const a = asset({ tags: ["Außen", "Tag 1"], label: "green", favorite: true });
    expect(smartMatch(rules({ tags: ["außen", "TAG 1"] }), a, none)).toBe(true);
    expect(smartMatch(rules({ tags: ["außen", "Tag 2"] }), a, none)).toBe(false);
    expect(smartMatch(rules({ labels: ["red", "green"] }), a, none)).toBe(true);
    expect(smartMatch(rules({ labels: ["red"] }), a, none)).toBe(false);
    expect(smartMatch(rules({ favorites: true }), asset({}), none)).toBe(false);
    expect(smartMatch(rules({ missing: true }), asset({ status: { state: "missing" } }), none)).toBe(true);
    expect(smartMatch(rules({ missing: true }), a, none)).toBe(false);
  });

  it("knows used media from sequences and multicam angles", () => {
    const p = {
      sequences: [{ tracks: [{ clips: [{ mediaId: "a" }] }] }],
      multicams: [{ angles: [{ media: "b" }] }],
    } as unknown as Project;
    const used = usedMedia(p);
    expect([...used].sort()).toEqual(["a", "b"]);
    expect(smartMatch(rules({ usage: "used" }), asset({ id: "a" }), used)).toBe(true);
    expect(smartMatch(rules({ usage: "unused" }), asset({ id: "b" }), used)).toBe(false);
    expect(smartMatch(rules({ usage: "unused" }), asset({ id: "c" }), used)).toBe(true);
  });

  it("puts new media and bins next to an open smart bin", () => {
    const bins: Bin[] = [
      { id: "f", name: "Ordner", parent: null },
      { id: "s", name: "Smart", parent: "f", smart: EMPTY_RULES },
      { id: "t", name: "Smart 2", parent: null, smart: EMPTY_RULES },
    ];
    expect(holdingBin(bins, "f")).toBe("f");
    expect(holdingBin(bins, "s")).toBe("f");
    expect(holdingBin(bins, "t")).toBe(null);
    expect(holdingBin(bins, "gone")).toBe(null);
    expect(holdingBin(bins, null)).toBe(null);
  });
});
