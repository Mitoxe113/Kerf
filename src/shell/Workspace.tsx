// Renders a workspace layout tree. The 4 px gutters between panels are the
// resize handles; sizes persist per workspace.

import { Component, Fragment, useRef, type ReactNode } from "react";
import { currentLayout, isBranch, leafTabs, PANEL_LABELS, useEditor, type LayoutChild, type LayoutNode, type PanelGroup, type PanelId, type WorkspaceLayout } from "../state/editor";
import { Button, cx, PanelGroupTabs } from "../ui/primitives";

/** Keeps a failing panel from taking the whole window down. */
class PanelBoundary extends Component<{ id: PanelId; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`panel ${this.props.id} crashed`, error);
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

/** One area: a single panel, or several panels as tabs. */
function Leaf({ group, hidden, panels, onSelect }: { group: PanelGroup | PanelId; hidden: PanelId[]; panels: Record<PanelId, ReactNode>; onSelect: (tab: number) => void }) {
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
      className={cx("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md bg-panel", focused && (active === "source" || active === "monitor") && "ring-1 ring-inset ring-signal/30")}
      onPointerDownCapture={() => !focused && useEditor.getState().set({ focusedPanel: active })}
    >
      <PanelGroupTabs.Provider value={strip}>
        <PanelBoundary key={active} id={active}>
          {panels[active]}
        </PanelBoundary>
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
                <Leaf group={c.node} hidden={layout.hidden} panels={panels} onSelect={(k) => selectTab(i, k)} />
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
