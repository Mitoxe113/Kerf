// Program output in a window of its own, e.g. full screen on a second
// display. The shell answers window.open with a window that shares this
// page's script context, so it shows the frames the program monitor draws,
// copied as they are drawn: no second player to keep in sync. The sound stays
// with the main window.

import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { engine } from "../engine/playback";
import { useEditor } from "../state/editor";
import { useActiveSequence } from "../state/project";
import { toast } from "../state/toasts";

let output: { win: Window; root: Root } | null = null;

/** The output window as the shell knows it (labels count up; older ones are closed). */
async function shellWindow() {
  const all = await getAllWebviewWindows();
  return all.filter((w) => w.label.startsWith("output-")).at(-1) ?? null;
}

async function setFullscreen(on: boolean | "toggle"): Promise<boolean> {
  const w = await shellWindow();
  if (!w) return false;
  const next = on === "toggle" ? !(await w.isFullscreen()) : on;
  await w.setFullscreen(next);
  return next;
}

function OutputView({ win }: { win: Window }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const seq = useActiveSequence();
  const [missing, setMissing] = useState(false);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d", { alpha: false })!;
    // Copied right after the monitor draws, while its buffer holds the frame.
    const off = engine.onFrame((src) => {
      if (c.width !== src.width || c.height !== src.height) {
        c.width = src.width;
        c.height = src.height;
      }
      ctx.drawImage(src, 0, 0);
    });
    // Without a program monitor in the layout nothing is drawn.
    const poll = win.setInterval(() => setMissing(!engine.canvas), 500);
    return () => {
      off();
      win.clearInterval(poll);
    };
  }, [win]);

  // The monitor renders at least as many pixels as this window shows.
  useEffect(() => {
    if (!seq) return;
    const { width, height } = seq.settings;
    const fit = () => {
      const s = Math.min(win.innerWidth / width, win.innerHeight / height) * (win.devicePixelRatio || 1);
      useEditor.getState().set({ outputScale: Math.min(1, s) });
    };
    fit();
    win.addEventListener("resize", fit);
    return () => win.removeEventListener("resize", fit);
  }, [win, seq?.settings.width, seq?.settings.height, seq]);

  // Keys work as in the editor; F and a double click toggle full screen, Escape leaves it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (plain && (e.key === "f" || e.key === "F" || (e.key === "Escape" && full))) {
        e.preventDefault();
        void setFullscreen(e.key === "Escape" ? false : "toggle").then(setFull);
        return;
      }
      e.preventDefault();
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat, bubbles: true, cancelable: true }),
      );
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [win, full]);

  return (
    <div
      style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#000", cursor: full ? "none" : "default" }}
      onDoubleClick={() => void setFullscreen("toggle").then(setFull)}
    >
      <canvas ref={ref} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      {missing && (
        <div style={{ position: "absolute", color: "#7a7a85", font: "12px system-ui, sans-serif", textAlign: "center" }}>
          Der Programm-Monitor ist im Arbeitsbereich ausgeblendet.
          <br />
          Fenster › Programm zeigt ihn wieder an.
        </div>
      )}
    </div>
  );
}

export const outputWindowOpen = () => !!output && !output.win.closed;

/** Opens the program output window, or closes it when it is open. */
export function toggleOutputWindow() {
  if (output && !output.win.closed) {
    output.win.close();
    return;
  }
  const win = window.open("about:blank", "_blank", "width=1280,height=720");
  if (!win) {
    toast.info("Programmausgabe konnte nicht geöffnet werden");
    return;
  }
  win.document.title = "Kerf – Programm";
  Object.assign(win.document.body.style, { margin: "0", background: "#000", overflow: "hidden" });
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const root = createRoot(host);
  output = { win, root };
  root.render(<OutputView win={win} />);
  useEditor.getState().set({ outputWindow: true });
  // A reload of this page (development) leaves no window without its script.
  window.addEventListener("beforeunload", () => win.close(), { once: true });
  // Closed by its own title bar: noticed here (the page in it is ours to tidy).
  const watch = window.setInterval(() => {
    if (!win.closed) return;
    window.clearInterval(watch);
    root.unmount();
    if (output?.win === win) output = null;
    useEditor.getState().set({ outputWindow: false, outputScale: 0 });
  }, 400);
}
