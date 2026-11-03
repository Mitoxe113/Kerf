// Docking: moving a panel within a workspace layout, as a tab of another area
// or beside it (splitting that area). Pure functions on the layout tree.

import { isBranch, leafTabs, type LayoutChild, type LayoutNode, type PanelId } from "./editor";

/** Where a dragged panel lands on an area: as a tab, or on one of its sides. */
export type DockZone = "center" | "left" | "right" | "top" | "bottom";

const newId = () => Math.random().toString(36).slice(2, 10);

/** The area (leaf) with id `id`, if any. */
export function findLeaf(root: LayoutNode, id: string): LayoutChild | null {
  for (const c of root.children) {
    if (isBranch(c.node)) {
      const hit = findLeaf(c.node, id);
      if (hit) return hit;
    } else if (c.id === id) return c;
  }
  return null;
}

/** Id of the area holding `panel`. */
export function leafOf(root: LayoutNode, panel: PanelId): string | null {
  for (const c of root.children) {
    if (isBranch(c.node)) {
      const hit = leafOf(c.node, panel);
      if (hit) return hit;
    } else if (leafTabs(c.node).includes(panel)) return c.id;
  }
  return null;
}

/** `root` without `panel`; an area left empty goes away and its neighbour takes its room. */
function remove(root: LayoutNode, panel: PanelId): LayoutNode {
  const children: LayoutChild[] = [];
  let freed = -1;
  root.children.forEach((c, k) => {
    if (isBranch(c.node)) {
      children.push({ ...c, node: remove(c.node, panel) });
      return;
    }
    const tabs = leafTabs(c.node);
    const i = tabs.indexOf(panel);
    if (i < 0) {
      children.push(c);
      return;
    }
    const rest = tabs.filter((p) => p !== panel);
    if (!rest.length) {
      if (!c.fixed) freed = k;
      return;
    }
    const active = typeof c.node === "string" ? 0 : c.node.active;
    children.push({ ...c, node: { tabs: rest, active: Math.min(rest.length - 1, active > i ? active - 1 : active) } });
  });
  if (freed >= 0) {
    // The area before it grows (after it, for the first), unless that one has a fixed size.
    const size = root.children[freed].size;
    const order = [freed - 1, freed].filter((k) => k >= 0 && k < children.length && !children[k].fixed);
    if (order.length) children[order[0]] = { ...children[order[0]], size: children[order[0]].size + size };
  }
  return { ...root, children };
}

/** `root` with `fn` applied to the children list that holds area `id`. */
function atParent(root: LayoutNode, id: string, fn: (n: LayoutNode, i: number) => LayoutNode): LayoutNode {
  const i = root.children.findIndex((c) => c.id === id && !isBranch(c.node));
  if (i >= 0) return fn(root, i);
  return { ...root, children: root.children.map((c) => (isBranch(c.node) ? { ...c, node: atParent(c.node, id, fn) } : c)) };
}

/**
 * Tidies a tree after a move: drops empty branches, lifts the only child of a
 * branch into its place and merges a branch into a parent of the same
 * direction (sizes scaled to the slot it had).
 */
export function normalize(root: LayoutNode): LayoutNode {
  const children: LayoutChild[] = [];
  for (const c of root.children) {
    if (!isBranch(c.node)) {
      children.push(c);
      continue;
    }
    const n = normalize(c.node);
    if (!n.children.length) continue;
    if (n.children.length === 1) {
      const only = n.children[0];
      if (isBranch(only.node) && only.node.dir === root.dir) children.push(...scaled(only.node.children, c.size));
      else children.push({ ...only, size: c.size, fixed: only.fixed ?? c.fixed });
      continue;
    }
    if (n.dir === root.dir && !c.fixed) children.push(...scaled(n.children, c.size));
    else children.push({ ...c, node: n });
  }
  return { ...root, children };
}

/** `children` sized to share `size` in their old proportions. */
function scaled(children: LayoutChild[], size: number): LayoutChild[] {
  const total = children.filter((c) => !c.fixed).reduce((s, c) => s + c.size, 0) || 1;
  return children.map((c) => (c.fixed ? c : { ...c, size: (c.size / total) * size }));
}

/**
 * Moves `panel` onto area `target`: as its active tab (`center`) or as a new
 * area on one side of it, which takes half of its room. Returns `root`
 * unchanged when the move would change nothing.
 */
export function movePanel(root: LayoutNode, panel: PanelId, target: string, zone: DockZone): LayoutNode {
  const from = leafOf(root, panel);
  const area = findLeaf(root, target);
  if (!from || !area || isBranch(area.node) || area.fixed) return root;
  const own = from === target;
  if (own && (zone === "center" || leafTabs(area.node).length === 1)) return root;

  let next = remove(root, panel);
  if (zone === "center") {
    next = atParent(next, target, (n, i) => ({
      ...n,
      children: n.children.map((c, k) => {
        if (k !== i || isBranch(c.node)) return c;
        const tabs = [...leafTabs(c.node), panel];
        return { ...c, node: { tabs, active: tabs.length - 1 } };
      }),
    }));
  } else {
    const dir = zone === "left" || zone === "right" ? "row" : "col";
    const first = zone === "left" || zone === "top";
    next = atParent(next, target, (n, i) => {
      const t = n.children[i];
      const added: LayoutChild = { id: newId(), size: t.size / 2, node: panel };
      if (n.dir === dir) {
        const children = [...n.children];
        children.splice(i, 1, ...(first ? [added, { ...t, size: t.size / 2 }] : [{ ...t, size: t.size / 2 }, added]));
        return { ...n, children };
      }
      const pair = first ? [{ ...added, size: 0.5 }, { ...t, size: 0.5 }] : [{ ...t, size: 0.5 }, { ...added, size: 0.5 }];
      const split: LayoutChild = { id: newId(), size: t.size, node: { dir, children: pair } };
      return { ...n, children: n.children.map((c, k) => (k === i ? split : c)) };
    });
  }
  return normalize(next);
}

/** The zone of an area's rectangle under a pointer: near an edge, or the middle (and the tab row). */
export function zoneAt(x: number, y: number, rect: { left: number; top: number; width: number; height: number }, header = 32): DockZone {
  if (y - rect.top < header) return "center";
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const edges: [DockZone, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  const [zone, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return d < 0.25 ? zone : "center";
}
