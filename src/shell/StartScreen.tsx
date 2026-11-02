// Start screen: shown over an untouched, untitled project at launch.
// New project with a format preset, open, or pick a recent project.

import { FolderOpen, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { newProject, openProject, recentProjects } from "../actions/project";
import type { SequenceSettings } from "../lib/types";
import { useEditor } from "../state/editor";
import { activeSequence, edit, useProject } from "../state/project";
import { Button, cx, Kbd, Toggle } from "../ui/primitives";
import { Logo } from "./TitleBar";

const FORMATS: { id: string; label: string; detail: string; width: number; height: number; fps: number }[] = [
  { id: "hd25", label: "Full HD", detail: "1920 × 1080 · 25p", width: 1920, height: 1080, fps: 25 },
  { id: "hd30", label: "Full HD", detail: "1920 × 1080 · 30p", width: 1920, height: 1080, fps: 30 },
  { id: "hd50", label: "Full HD", detail: "1920 × 1080 · 50p", width: 1920, height: 1080, fps: 50 },
  { id: "uhd25", label: "4K UHD", detail: "3840 × 2160 · 25p", width: 3840, height: 2160, fps: 25 },
  { id: "vert30", label: "Hochformat 9:16", detail: "1080 × 1920 · 30p", width: 1080, height: 1920, fps: 30 },
  { id: "square30", label: "Quadrat 1:1", detail: "1080 × 1080 · 30p", width: 1080, height: 1080, fps: 30 },
];
const FORMAT_KEY = "kerf.start.format";

const fileName = (p: string) => p.split(/[\\/]/).pop()?.replace(/\.kerf$/i, "") ?? p;
const folder = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

export function StartScreen() {
  const show = useEditor((s) => s.startScreen);
  const showAtLaunch = useEditor((s) => s.showStartScreen);
  const path = useProject((s) => s.path);
  const dirty = useProject((s) => s.dirty);
  const mediaCount = useProject((s) => s.project?.media.length ?? 0);
  const [format, setFormat] = useState(() => {
    try {
      return localStorage.getItem(FORMAT_KEY) ?? "hd25";
    } catch {
      return "hd25";
    }
  });
  const [recent] = useState(recentProjects);
  const hide = () => useEditor.getState().set({ startScreen: false });

  // Any real work (opening, importing, editing) puts the screen away.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (path || dirty || mediaCount) hide();
  }, [path, dirty, mediaCount]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  if (!show) return null;

  const create = async () => {
    const f = FORMATS.find((x) => x.id === format) ?? FORMATS[0];
    try {
      localStorage.setItem(FORMAT_KEY, f.id);
    } catch {
      // ignore
    }
    const st = useProject.getState();
    if (st.path || st.dirty || (st.project?.media.length ?? 0) > 0) await newProject();
    const seq = activeSequence(useProject.getState().project);
    if (seq) {
      const settings: SequenceSettings = { ...seq.settings, width: f.width, height: f.height, fps: { num: f.fps, den: 1 } };
      if (JSON.stringify(settings) !== JSON.stringify(seq.settings)) await edit({ type: "updateSequenceSettings", sequence: seq.id, settings });
    }
    hide();
  };

  return (
    <div className="anim-fade absolute inset-0 z-[500] flex items-center justify-center bg-ground/95 backdrop-blur-sm">
      <div className="flex w-[820px] max-w-[94%] overflow-hidden rounded-xl border border-line-strong bg-panel shadow-pop">
        <div className="flex w-[380px] shrink-0 flex-col gap-5 border-r border-line p-7">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <div>
              <div className="text-lg font-semibold">Kerf</div>
              <div className="text-xs text-fg-3">Videoschnitt</div>
            </div>
          </div>
          <div className="space-y-2">
            <div className="panel-title">Neues Projekt</div>
            <div className="grid grid-cols-2 gap-1.5">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  onDoubleClick={() => void create()}
                  className={cx("rounded-md border px-2.5 py-2 text-left transition-colors", format === f.id ? "border-signal bg-signal-soft" : "border-line-strong hover:bg-hover")}
                >
                  <div className={cx("text-xs font-medium", format === f.id ? "text-signal" : "text-fg")}>{f.label}</div>
                  <div className="tc text-[10.5px] text-fg-3">{f.detail}</div>
                </button>
              ))}
            </div>
            <Button variant="primary" className="w-full" onClick={() => void create()}>
              <Plus size={14} /> Neues Projekt
            </Button>
            <Button className="w-full" onClick={() => void openProject()}>
              <FolderOpen size={14} /> Projekt öffnen …
            </Button>
          </div>
          <label className="mt-auto flex items-center gap-2 text-xs text-fg-3">
            <Toggle label="Beim Start anzeigen" checked={showAtLaunch} onChange={(v) => useEditor.getState().set({ showStartScreen: v })} />
            Beim Start anzeigen
          </label>
        </div>
        <div className="flex min-w-0 flex-1 flex-col p-7">
          <div className="panel-title mb-2">Zuletzt geöffnet</div>
          {recent.length === 0 ? (
            <p className="text-sm text-fg-4">Noch keine Projekte. Gespeicherte Projekte erscheinen hier; .kerf-Dateien lassen sich auch per Doppelklick oder Ziehen ins Fenster öffnen.</p>
          ) : (
            <div className="-mx-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {recent.map((p) => (
                <button key={p} onClick={() => void openProject(p)} className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-hover" title={p}>
                  <span className="truncate text-sm text-fg">{fileName(p)}</span>
                  <span className="truncate text-[10.5px] text-fg-4">{folder(p)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-[10.5px] text-fg-4">
            <span>
              <Kbd>Strg+P</Kbd> Befehle, Medien und Clips suchen
            </span>
            <span>
              <Kbd>Esc</Kbd> leeres Projekt
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
