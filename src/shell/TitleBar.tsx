import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Redo2, Save, Square, Undo2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatCombo, keysFor } from "../actions/keymap";
import { ACTION_BY_ID, runAction } from "../actions/registry";
import { editLabel } from "../lib/i18n";
import { LABEL_NAMES, LABELS } from "../lib/labels";
import { currentLayout, layoutPanels, PANEL_LABELS, useEditor, WORKSPACES } from "../state/editor";
import { useProject } from "../state/project";
import { cx, IconButton, MenuList, type MenuItem } from "../ui/primitives";
import { recentProjects, openProject, saveProject } from "../actions/project";

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <rect width="1024" height="1024" rx="232" fill="#1b1b1f" />
      <path d="M262 292 H576 L486 732 H262 Q232 732 232 702 V322 Q232 292 262 292 Z" fill="#ECECEF" />
      <path d="M636 292 H762 Q792 292 792 322 V702 Q792 732 762 732 H546 Z" fill="#C8F542" />
    </svg>
  );
}

const MENUS: { label: string; items: (string | "-")[] }[] = [
  { label: "Datei", items: ["file.new", "file.open", "@recent", "-", "file.save", "file.saveAs", "file.versions", "-", "file.import", "file.importFolder", "-", "file.export", "file.recovery", "-", "app.preferences", "-", "file.quit"] },
  { label: "Bearbeiten", items: ["edit.undo", "edit.redo", "-", "edit.cut", "edit.copy", "edit.paste", "edit.duplicate", "-", "edit.delete", "edit.rippleDelete", "-", "edit.selectAll", "edit.deselect", "edit.selectForward", "edit.selectBackward", "-", "tool.select", "tool.razor", "tool.ripple", "tool.roll", "tool.slip", "tool.slide", "tool.hand", "tool.zoom", "-", "edit.shortcuts", "macro.manage", "macro.record"] },
  { label: "Ansicht", items: ["view.zoomIn", "view.zoomOut", "view.zoomFit", "view.zoomSelection", "-", "view.trackS", "view.trackM", "view.trackL", "-", "view.proxies", "-", "view.safe", "view.thirds", "view.center", "view.stats", "view.fullscreen"] },
  { label: "Sequenz", items: ["seq.new", "seq.settings", "-", "seq.razor", "seq.razorAll", "seq.insert", "seq.overwrite", "-", "seq.in", "seq.out", "seq.clearInOut", "seq.lift", "seq.extract", "-", "seq.marker", "seq.nextMarker", "seq.prevMarker", "-", "seq.addVideo", "seq.addAudio", "-", "clip.title", "clip.adjustment", "-", "seq.snap", "seq.linked"] },
  { label: "Clip", items: ["clip.rename", "@labels", "clip.reveal", "clip.matchFrame", "-", "clip.freeze", "clip.normalize", "-", "clip.enable", "clip.link", "clip.unlink", "-", "clip.nest", "clip.unnest", "-", "clip.nudgeLeft", "clip.nudgeRight"] },
  { label: "Effekte", items: ["clip.fades", "fx.fadeIn", "fx.fadeOut", "fx.noFades", "-", "fx.fill", "fx.fit", "fx.resetMotion", "-", "fx.mono", "fx.resetColor", "fx.color", "-", "fx.resetAudio"] },
  { label: "Wiedergabe", items: ["play.toggle", "play.inOut", "play.loop", "-", "play.reverse", "play.stop", "play.forward", "-", "play.stepBack", "play.stepFwd", "play.prevEdit", "play.nextEdit", "-", "play.start", "play.end", "-", "play.gotoIn", "play.gotoOut", "play.clipStart", "play.clipEnd"] },
  { label: "Fenster", items: ["@workspaces", "-", "@panels", "-", "win.output", "-", "win.save", "win.reset"] },
  { label: "Hilfe", items: ["app.palette", "app.commands", "-", "edit.shortcuts", "app.start", "-", "help.update", "help.about"] },
];

function actionItem(id: string): MenuItem | null {
  const a = ACTION_BY_ID.get(id);
  if (!a) return null;
  const keys = keysFor(id);
  return {
    label: id === "edit.undo" ? `Rückgängig${labelSuffix("undo")}` : id === "edit.redo" ? `Wiederholen${labelSuffix("redo")}` : a.label,
    shortcut: keys[0] ? formatCombo(keys[0]) : undefined,
    disabled: a.enabled ? !a.enabled() : false,
    checked: a.checked?.(),
    // Through runAction, so a macro recording sees menu commands too.
    onSelect: () => runAction(id),
  };
}

function labelSuffix(kind: "undo" | "redo") {
  const k = useProject.getState().history[kind];
  return k ? `: ${editLabel(k)}` : "";
}

function buildMenu(items: (string | "-")[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const id of items) {
    if (id === "-") out.push({ separator: true });
    else if (id === "@recent") {
      const recent = recentProjects();
      out.push({
        label: "Zuletzt geöffnet",
        disabled: !recent.length,
        submenu: recent.map((p) => ({ label: p.split(/[\\/]/).pop(), onSelect: () => void openProject(p) })),
      });
    } else if (id === "@labels") {
      out.push({ label: "Beschriftung", disabled: !useEditor.getState().selection.length, submenu: LABELS.map((l) => actionItem(`clip.label.${l}`)!).map((m, i) => ({ ...m, label: LABEL_NAMES[LABELS[i]] })) });
    } else if (id === "@workspaces") {
      const ed = useEditor.getState();
      for (const w of WORKSPACES) out.push(actionItem(`ws.${w.id}`)!);
      for (const c of ed.customWorkspaces)
        out.push({ label: `Arbeitsbereich: ${c.name}`, checked: ed.workspace === c.id, onSelect: () => ed.set({ workspace: c.id }) });
    } else if (id === "@panels") {
      const ed = useEditor.getState();
      const layout = currentLayout(ed);
      // Every panel can be shown in any workspace; missing ones are added as a tab.
      const all = Object.keys(PANEL_LABELS);
      const visible = layoutPanels(layout);
      for (const p of all)
        out.push({
          label: PANEL_LABELS[p as keyof typeof PANEL_LABELS],
          checked: visible.includes(p as never),
          onSelect: () => ed.togglePanel(p as never),
        });
    } else {
      const it = actionItem(id);
      if (it) out.push(it);
    }
  }
  return out;
}

function MenuBar() {
  const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);
  const openAt = (index: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOpen({ index, x: r.left, y: r.bottom + 2 });
  };
  return (
    <nav className="flex items-center" onPointerDown={(e) => e.stopPropagation()}>
      {MENUS.map((m, i) => (
        <button
          key={m.label}
          className={cx(
            "h-7 rounded-sm px-2 text-[12.5px] transition-colors",
            open?.index === i ? "bg-hover text-fg" : "text-fg-2 hover:text-fg hover:bg-hover/60",
          )}
          onClick={(e) => (open?.index === i ? setOpen(null) : openAt(i, e.currentTarget))}
          onPointerEnter={(e) => open && open.index !== i && openAt(i, e.currentTarget)}
        >
          {m.label}
        </button>
      ))}
      {open &&
        createPortal(<MenuList items={buildMenu(MENUS[open.index].items)} x={open.x} y={open.y} onClose={() => setOpen(null)} />, document.body)}
    </nav>
  );
}

function WindowControls() {
  const w = getCurrentWindow();
  const btn = "flex h-full w-11 items-center justify-center text-fg-3 transition-colors hover:text-fg";
  return (
    <div className="flex h-full">
      <button aria-label="Minimieren" className={cx(btn, "hover:bg-hover")} onClick={() => void w.minimize()}>
        <Minus size={14} strokeWidth={1.5} />
      </button>
      <button aria-label="Maximieren" className={cx(btn, "hover:bg-hover")} onClick={() => void w.toggleMaximize()}>
        <Square size={11} strokeWidth={1.5} />
      </button>
      <button aria-label="Schließen" className={cx(btn, "hover:bg-[#c42b1c] hover:text-white")} onClick={() => void w.close()}>
        <X size={15} strokeWidth={1.5} />
      </button>
    </div>
  );
}

export function TitleBar() {
  const name = useProject((s) => s.project?.name ?? "");
  const dirty = useProject((s) => s.dirty);
  const history = useProject((s) => s.history);
  const workspace = useEditor((s) => s.workspace);
  const custom = useEditor((s) => s.customWorkspaces);
  const set = useEditor((s) => s.set);

  useEffect(() => {
    void getCurrentWindow().setTitle(`${dirty ? "● " : ""}${name} – Kerf`).catch(() => undefined);
  }, [name, dirty]);

  return (
    <header className="flex h-[38px] shrink-0 items-center border-b border-line bg-ground pl-2.5">
      <div className="flex items-center gap-2 pr-2">
        <Logo />
        <span className="text-[13px] font-semibold tracking-tight">Kerf</span>
      </div>
      <MenuBar />
      <div className="flex h-full min-w-8 flex-1 items-center justify-center" data-tauri-drag-region>
        <span className="pointer-events-none flex items-center gap-1.5 truncate text-xs text-fg-3" data-tauri-drag-region>
          {dirty && <span className="h-1.5 w-1.5 rounded-full bg-signal" title="Ungespeicherte Änderungen" />}
          {name}
        </span>
      </div>
      <div className="mr-2 flex items-center gap-px rounded-md bg-panel p-0.5">
        {[...WORKSPACES, ...custom.map((c) => ({ id: c.id, label: c.name }))].map((w) => (
          <button
            key={w.id}
            onClick={() => set({ workspace: w.id })}
            className={cx(
              "h-6 rounded-sm px-2.5 text-xs transition-colors duration-100",
              workspace === w.id ? "bg-hover text-fg" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {w.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-0.5 pr-2">
        <IconButton icon={<Undo2 size={15} />} label={history.undo ? `Rückgängig: ${editLabel(history.undo)}` : "Rückgängig"} shortcut="Strg+Z" disabled={!history.undo} onClick={() => void ACTION_BY_ID.get("edit.undo")!.run()} />
        <IconButton icon={<Redo2 size={15} />} label={history.redo ? `Wiederholen: ${editLabel(history.redo)}` : "Wiederholen"} shortcut="Strg+⇧+Z" disabled={!history.redo} onClick={() => void ACTION_BY_ID.get("edit.redo")!.run()} />
        <IconButton icon={<Save size={15} />} label="Speichern" shortcut="Strg+S" onClick={() => void saveProject()} />
        <button
          onClick={() => set({ workspace: "export" })}
          className="ml-1.5 flex h-7 items-center gap-1.5 rounded-sm bg-signal px-3 text-xs font-semibold text-signal-ink transition-colors hover:bg-signal-hover"
        >
          <Upload size={13} strokeWidth={2.2} />
          Export
        </button>
      </div>
      <WindowControls />
    </header>
  );
}
