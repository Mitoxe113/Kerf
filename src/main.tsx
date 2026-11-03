import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installErrorLogging } from "./lib/errors";
import { RootBoundary } from "./shell/RootBoundary";
import "./styles.css";

installErrorLogging();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </StrictMode>,
);

// Dev builds expose the live stores and actions for automated UI tests.
if (import.meta.env.DEV) {
  void Promise.all([
    import("./state/project"),
    import("./state/editor"),
    import("./lib/ipc"),
    import("./actions/project"),
    import("./actions/editing"),
    import("./actions/registry"),
    import("./engine/playback"),
    import("./state/source"),
  ]).then(([project, editor, ipc, projectActions, editing, registry, playback, source]) => {
    Object.assign(globalThis, {
      kerf: { ...project, ...editor, ...ipc, projectActions, editing, registry, engine: playback.engine, source },
    });
  });
}
