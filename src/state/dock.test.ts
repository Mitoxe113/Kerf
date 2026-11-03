import { describe, expect, it } from "vitest";
import { findLeaf, leafOf, movePanel, normalize, zoneAt } from "./dock";
import { DEFAULT_LAYOUTS, isBranch, leafTabs, type LayoutChild, type LayoutNode, type PanelId } from "./editor";

const edit = DEFAULT_LAYOUTS.edit.root;

/** The tree as nested tab lists, e.g. `col(row([media,source],[monitor]),row([timeline],[meters]))`. */
function shape(n: LayoutNode): string {
  const part = (c: LayoutChild): string => (isBranch(c.node) ? shape(c.node) : `[${leafTabs(c.node).join(",")}]`);
  return `${n.dir}(${n.children.map(part).join(",")})`;
}

const sizes = (n: LayoutNode) => n.children.map((c) => +c.size.toFixed(3));

describe("docking", () => {
  it("adds a panel as the active tab of another area", () => {
    const next = movePanel(edit, "history", "media", "center");
    const area = findLeaf(next, "media")!;
    expect(leafTabs(area.node as never)).toEqual(["media", "source", "effects", "multicam", "subtitles", "history"]);
    expect((area.node as { active: number }).active).toBe(5);
    // The inspector area keeps the inspector alone.
    expect(leafTabs(findLeaf(next, "inspector")!.node as never)).toEqual(["inspector"]);
  });

  it("splits an area beside it, in the direction of the drop", () => {
    // The monitor sits in a row: dropping to its right inserts a sibling with half its room.
    const next = movePanel(edit, "history", "monitor", "right");
    const top = next.children[0].node as LayoutNode;
    expect(shape(top)).toBe("row([media,source,effects,multicam,subtitles],[monitor],[history],[inspector])");
    expect(sizes(top)).toEqual([0.25, 0.245, 0.245, 0.26]);
    // Below it: a column in the monitor's slot.
    const below = movePanel(edit, "scopes" as PanelId, "monitor", "bottom");
    expect(below).toBe(edit); // not in the layout: nothing to move
    const col = movePanel(edit, "history", "monitor", "bottom");
    const slot = (col.children[0].node as LayoutNode).children[1];
    expect(slot.size).toBe(0.49);
    expect(shape(slot.node as LayoutNode)).toBe("col([monitor],[history])");
  });

  it("removes an area its last panel left and lifts a lone child", () => {
    // Moving the monitor next to the timeline empties its area.
    const next = movePanel(edit, "monitor", "timeline", "top");
    expect(leafOf(next, "monitor")).not.toBeNull();
    expect(shape(next)).toBe("col(row([media,source,effects,multicam,subtitles],[inspector,history]),row(col([monitor],[timeline]),[meters]))");
    // The area before the monitor takes its room.
    expect(sizes(next.children[0].node as LayoutNode)).toEqual([0.74, 0.26]);
    // The meters keep their fixed width.
    const bottom = next.children[1].node as LayoutNode;
    expect(bottom.children[1].fixed).toBe(54);
  });

  it("gives the room of a removed area to its neighbour", () => {
    const there = movePanel(edit, "history", "monitor", "right");
    const back = movePanel(there, "history", "inspector", "center");
    expect(sizes(back.children[0].node as LayoutNode)).toEqual([0.25, 0.49, 0.26]);
    // The first area of a row gives its room to the next one.
    const tree: LayoutNode = {
      dir: "row",
      children: [
        { id: "a", size: 1, node: "media" },
        { id: "b", size: 2, node: "monitor" },
        { id: "c", size: 1, node: "inspector" },
      ],
    };
    expect(sizes(movePanel(tree, "media", "c", "center"))).toEqual([3, 1]);
  });

  it("leaves the layout alone for moves that change nothing", () => {
    expect(movePanel(edit, "monitor", "monitor", "center")).toBe(edit);
    expect(movePanel(edit, "monitor", "monitor", "left")).toBe(edit);
    expect(movePanel(edit, "media", "media", "center")).toBe(edit);
    // Fixed areas (the meters) take no panels.
    expect(movePanel(edit, "history", "meters", "center")).toBe(edit);
  });

  it("splits a tab off its own area", () => {
    const next = movePanel(edit, "source", "media", "bottom");
    const slot = (next.children[0].node as LayoutNode).children[0];
    expect(shape(slot.node as LayoutNode)).toBe("col([media,effects,multicam,subtitles],[source])");
  });

  it("merges branches of the same direction", () => {
    const tree: LayoutNode = {
      dir: "row",
      children: [
        { id: "a", size: 1, node: "media" },
        { id: "x", size: 2, node: { dir: "row", children: [{ id: "b", size: 1, node: "monitor" }, { id: "c", size: 3, node: "inspector" }] } },
        { id: "y", size: 1, node: { dir: "col", children: [{ id: "d", size: 1, node: "history" }] } },
      ],
    };
    const n = normalize(tree);
    expect(shape(n)).toBe("row([media],[monitor],[inspector],[history])");
    expect(sizes(n)).toEqual([1, 0.5, 1.5, 1]);
  });

  it("finds the zone under the pointer", () => {
    const r = { left: 100, top: 100, width: 400, height: 300 };
    expect(zoneAt(110, 250, r)).toBe("left");
    expect(zoneAt(490, 250, r)).toBe("right");
    expect(zoneAt(300, 390, r)).toBe("bottom");
    expect(zoneAt(300, 150, r)).toBe("top");
    expect(zoneAt(300, 250, r)).toBe("center");
    // The header row adds a tab.
    expect(zoneAt(110, 110, r)).toBe("center");
  });
});
