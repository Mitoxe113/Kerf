// Renders a workspace layout tree. The 4 px gutters between panels are the
// resize handles; sizes persist per workspace. A panel dragged by its tab or
// header docks onto another area: as a tab (middle, tab row) or beside it.

import { Component, Fragment, useRef, type ReactNode } from "react";
import { movePanel, zoneAt, type DockZone } from "../state/dock";
import { currentLayout, isBranch, leafTabs, PANEL_LABELS, useEditor, type LayoutChild, type LayoutNode, type PanelGroup, type PanelId, type WorkspaceLayout } from "../state/editor";
import { Button, cx, PanelDock, PanelGroupTabs } from "../ui/primitives";
import { logError } from "../lib/errors";

/** Keeps a failing panel from taking the whole window down. */
class PanelBoundary extends Component<{ id: PanelId; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`panel ${this.props.id} crashed`, error);
    logError(`panel ${this.props.id} crashed: ${error.stack ?? error.message}`);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <div className="text-sm text-fg-2">{PANEL_LABELS[this.props.id]}: unerwarteter Fehler</div>
        <div className="max-w-80 break-words text-xs text-fg-4">{this.state.error.message}</div>
        <Button size="sm" onClick={() => this.setState({ error: null })}>
          Panel neu laden
        </Button>
      </div>
    );
  }
}

function visible(c: LayoutChild, hidden: PanelId[]): boolean {
  return isBranch(c.node) ? c.node.children.some((x) => visible(x, hidden)) : leafTabs(c.node).some((p) => !hidden.includes(p));
}

function updateAt(node: LayoutNode, path: number[], fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  if (!path.length) return fn(node);
  const [i, ...rest] = path;
  return {
    ...node,
    children: node.children.map((c, k) => (k === i && isBranch(c.node) ? { ...c, node: updateAt(c.node, rest, fn) } : c)),
  };
}

/** Pixels a tab or header moves before it becomes a drag. */
const DRAG_START_PX = 6;

/**
 * Drags `panel` from a pointer press: a label follows the pointer, the area
 * under it shows where the panel would go, and releasing moves it there.
 * Escape cancels.
 */
function startDock(e: React.PointerEvent, panel: PanelId) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let mark: HTMLDivElement | null = null;
  let drop: { area: string; zone: DockZone } | null = null;
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
      ghost = document.createElement("div");
      ghost.className = "pointer-events-none fixed left-0 top-0 z-[200] rounded-sm bg-raised px-2 py-1 text-xs text-fg shadow-pop";
      ghost.textContent = PANEL_LABELS[panel];
      mark = document.createElement("div");
      mark.className = "pointer-events-none fixed z-[199] rounded-md bg-signal/15 ring-2 ring-inset ring-signal transition-all duration-75";
      document.body.append(mark, ghost);
      document.body.style.cursor = "grabbing";
    }
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
    const area = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-dock-area]");
    drop = null;
    if (area) {
      const r = area.getBoundingClientRect();
      const zone = zoneAt(ev.clientX, ev.clientY, r);
      drop = { area: area.dataset.dockArea!, zone };
      const half = { center: [0, 0, 1, 1], left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5] }[zone];
      Object.assign(mark!.style, {
        display: "block",
        left: `${r.left + half[0] * r.width}px`,
        top: `${r.top + half[1] * r.height}px`,
        width: `${half[2] * r.width}px`,
        height: `${half[3] * r.height}px`,
      });
    } else if (mark) mark.style.display = "none";
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    if (!ghost) return;
    ghost.remove();
    mark?.remove();
    document.body.style.cursor = "";
    // The press ends in a click on whatever is under the pointer: not after a drag.
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (!commit || !drop) return;
    const s = useEditor.getState();
    const layout = currentLayout(s);
    const root = movePanel(layout.root, panel, drop.area, drop.zone);
    if (root !== layout.root) s.setLayout(s.workspace, { ...layout, root });
  };
  const up = () => finish(true);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}

/** One area: a single panel, or several panels as tabs. */
function Leaf({ id, dockable, group, hidden, panels, onSelect }: { id: string; dockable: boolean; group: PanelGroup | PanelId; hidden: PanelId[]; panels: Record<PanelId, ReactNode>; onSelect: (tab: number) => void }) {
  const all = leafTabs(group);
  const shown = all.filter((p) => !hidden.includes(p));
  const wanted = typeof group === "string" ? group : all[group.active];
  const active = shown.includes(wanted) ? wanted : shown[0];
  // The tab strip replaces the panel's own title in its header row.
  const strip =
    shown.length > 1 ? (
      <div className="flex gap-3 self-stretch">
        {shown.map((p) => (
          <button
            key={p}
            onClick={() => onSelect(all.indexOf(p))}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (dockable) startDock(e, p);
            }}
            className={cx("panel-title -mb-px border-b-2 pt-0.5", p === active ? "border-signal text-fg" : "border-transparent hover:text-fg-2")}
          >
            {PANEL_LABELS[p]}
          </button>
        ))}
      </div>
    ) : null;
  const focused = useEditor((s) => s.focusedPanel === active);
  return (
    <div
      data-dock-area={dockable ? id : undefined}
      className={cx("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md bg-panel", focused && (active === "source" || active === "monitor") && "ring-1 ring-inset ring-signal/30")}
      onPointerDownCapture={() => !focused && useEditor.getState().set({ focusedPanel: active })}
    >
      <PanelGroupTabs.Provider value={strip}>
        <PanelDock.Provider value={dockable ? (e) => startDock(e, active) : null}>
          <PanelBoundary key={active} id={active}>
            {panels[active]}
          </PanelBoundary>
        </PanelDock.Provider>
      </PanelGroupTabs.Provider>
    </div>
  );
}

function Group({ node, path, panels, layout, ws }: { node: LayoutNode; path: number[]; panels: Record<PanelId, ReactNode>; layout: WorkspaceLayout; ws: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const setLayout = useEditor((s) => s.setLayout);
  const shown = node.children.map((c, i) => ({ c, i })).filter(({ c }) => visible(c, layout.hidden));
  const horizontal = node.dir === "row";
  const selectTab = (child: number, tab: number) =>
    setLayout(ws, {
      ...layout,
      root: updateAt(layout.root, path, (n) => ({
        ...n,
        children: n.children.map((c, k) => (k === child && !isBranch(c.node) ? { ...c, node: { tabs: leafTabs(c.node), active: tab } } : c)),
      })),
    });

  const startResize = (e: React.PointerEvent, a: number, b: number) => {
    const el = ref.current;
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ca = node.children[a];
    const cb = node.children[b];
    const total = horizontal ? el.clientWidth : el.clientHeight;
    const flexTotal = shown.filter(({ c }) => !c.fixed).reduce((s, { c }) => s + c.size, 0);
    const fixedPx = shown.filter(({ c }) => c.fixed).reduce((s, { c }) => s + (c.fixed ?? 0), 0);
    const pxPerUnit = (total - fixedPx) / flexTotal;
    const start = horizontal ? e.clientX : e.clientY;
    const sa = ca.size;
    const sb = cb.size;
    const move = (ev: PointerEvent) => {
      const d = ((horizontal ? ev.clientX : ev.clientY) - start) / pxPerUnit;
      const min = 140 / pxPerUnit;
      const na = Math.max(min, Math.min(sa + sb - min, sa + d));
      setLayout(ws, {
        ...layout,
        root: updateAt(layout.root, path, (n) => ({
          ...n,
          children: n.children.map((c, k) => (k === a ? { ...c, size: na } : k === b ? { ...c, size: sa + sb - na } : c)),
        })),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={ref} className={cx("flex min-h-0 min-w-0 flex-1", horizontal ? "flex-row" : "flex-col")}>
      {shown.map(({ c, i }, k) => {
        const next = shown[k + 1];
        const resizable = next && !c.fixed && !next.c.fixed;
        const style = c.fixed ? { flex: `0 0 ${c.fixed}px` } : { flex: `${c.size} 1 0px` };
        return (
          <Fragment key={c.id}>
            <div className="flex min-h-0 min-w-0" style={style}>
              {isBranch(c.node) ? (
                <Group node={c.node} path={[...path, i]} panels={panels} layout={layout} ws={ws} />
              ) : (
                <Leaf id={c.id} dockable={!c.fixed} group={c.node} hidden={layout.hidden} panels={panels} onSelect={(k) => selectTab(i, k)} />
              )}
            </div>
            {next && (
              <div
                className={cx(
                  "shrink-0 transition-colors",
                  horizontal ? "w-1" : "h-1",
                  resizable && (horizontal ? "cursor-col-resize hover:bg-signal/40" : "cursor-row-resize hover:bg-signal/40"),
                )}
                onPointerDown={resizable ? (e) => startResize(e, i, next.i) : undefined}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export function Workspace({ panels }: { panels: Record<PanelId, ReactNode> }) {
  const ws = useEditor((s) => s.workspace);
  const layout = useEditor((s) => currentLayout(s));
  return (
    <div className="flex min-h-0 flex-1 p-1">
      <Group node={layout.root} path={[]} panels={panels} layout={layout} ws={ws} />
    </div>
  );
}
