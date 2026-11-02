import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { installKeyboard } from "./actions/keymap";
import { guardUnsaved, importMedia, openProject } from "./actions/project";
import { engine } from "./engine/playback";
import { api, events } from "./lib/ipc";
import { ExportPanel } from "./panels/ExportPanel";
import { HistoryPanel } from "./panels/History";
import { Inspector } from "./panels/Inspector";
import { MediaBrowser } from "./panels/MediaBrowser";
import { Meters, Mixer } from "./panels/Audio";
import { Monitor } from "./panels/Monitor";
import { Scopes } from "./panels/Scopes";
import { SourceMonitor } from "./panels/SourceMonitor";
import { SubtitlesPanel } from "./panels/Text";
import { Timeline } from "./panels/Timeline";
import { Dialogs } from "./shell/Dialogs";
import { StartScreen } from "./shell/StartScreen";
import { DragGhost, StatusBar, Toasts } from "./shell/StatusBar";
import { TitleBar } from "./shell/TitleBar";
import { MulticamPanel } from "./panels/Multicam";
import { Workspace } from "./shell/Workspace";
import { useEditor, type PanelId } from "./state/editor";
import { activeSequence, useProject } from "./state/project";
import { ContextMenuHost } from "./ui/primitives";

const PANELS: Record<PanelId, React.ReactNode> = {
  media: <MediaBrowser />,
  monitor: <Monitor />,
  inspector: <Inspector />,
  timeline: <Timeline />,
  meters: <Meters />,
  scopes: <Scopes />,
  export: <ExportPanel />,
  mixer: <Mixer />,
  history: <HistoryPanel />,
  source: <SourceMonitor />,
  subtitles: <SubtitlesPanel />,
  multicam: <MulticamPanel />,
};

/** Keeps the playback engine in sync with the document and view settings. */
function syncEngine() {
  let last: unknown[] = [];
  const push = () => {
    const p = useProject.getState();
    const e = useEditor.getState();
    const seq = activeSequence(p.project);
    const next = [seq, p.mediaById, e.useProxies, e.quality, p.project?.sequences];
    if (next.every((v, i) => v === last[i])) return;
    last = next;
    engine.update(seq, p.mediaById, { useProxies: e.useProxies, quality: e.quality }, p.project?.sequences);
  };
  const a = useProject.subscribe(push);
  const b = useEditor.subscribe(push);
  push();
  return () => {
    a();
    b();
  };
}

/** Pushes the engine-side preferences (autosave interval, kept versions) on start and on change. */
function syncEnginePrefs() {
  const push = () => {
    const { autosaveSeconds, keepVersions } = useEditor.getState();
    void api.setPreferences(autosaveSeconds, keepVersions).catch(() => undefined);
  };
  push();
  return useEditor.subscribe((s, prev) => {
    if (s.autosaveSeconds !== prev.autosaveSeconds || s.keepVersions !== prev.keepVersions) push();
  });
}

export function App() {
  const fullscreen = useEditor((s) => s.fullscreen);

  useEffect(() => {
    const cleanups: (() => void)[] = [installKeyboard(), syncEngine(), syncEnginePrefs()];
    const st = useProject.getState();
    void api.projectState().then(st.applyState);
    void api.appInfo().then(st.setAppInfo);
    void api.exportJobs().then(st.setExports);
    void api.recoveryList().then((list) => {
      if (list.length) useEditor.getState().set({ dialog: { kind: "recovery" } });
    });
    // Launched by double-clicking a project file.
    void api.takeLaunchFile().then((path) => path && void openProject(path));

    const unlisten = [
      events.mediaUpdated((a) => useProject.getState().applyMedia(a)),
      events.mediaJob((j) => useProject.getState().setProxyJob(j.mediaId, j.progress)),
      events.exportUpdated((j) => useProject.getState().upsertExport(j)),
      events.appInfoChanged(() => void api.appInfo().then(useProject.getState().setAppInfo)),
      events.autosaved((at) => useProject.getState().setAutosaved(at)),
      events.openProject((path) => void openProject(path)),
      // Files dropped from the OS are imported into the current bin; a dropped project is opened.
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type !== "drop" || !e.payload.paths.length) return;
        const project = e.payload.paths.find((p) => /\.kerf$/i.test(p));
        if (project) void openProject(project);
        else void importMedia(e.payload.paths);
      }),
      getCurrentWindow().onCloseRequested(async (e) => {
        e.preventDefault();
        if (!(await guardUnsaved())) return;
        await api.sessionEnd().catch(() => undefined);
        await getCurrentWindow().destroy();
      }),
    ];

    const exitFullscreen = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useEditor.getState().fullscreen) {
        useEditor.getState().set({ fullscreen: false });
        void getCurrentWindow().setFullscreen(false);
      }
    };
    window.addEventListener("keydown", exitFullscreen);
    const noMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", noMenu);

    return () => {
      cleanups.forEach((c) => c());
      unlisten.forEach((p) => void p.then((u) => u()));
      window.removeEventListener("keydown", exitFullscreen);
      window.removeEventListener("contextmenu", noMenu);
    };
  }, []);

  const ready = useProject((s) => !!s.project);

  return (
    <div className="flex h-full flex-col">
      {!fullscreen && <TitleBar />}
      {ready ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Workspace panels={PANELS} />
          {!fullscreen && <StartScreen />}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-3">Lade Engine …</div>
      )}
      {!fullscreen && <StatusBar />}
      <ContextMenuHost />
      <Dialogs />
      <Toasts />
      <DragGhost />
    </div>
  );
}
