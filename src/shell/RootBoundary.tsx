// Last line of defence: if the window's shell itself fails to render, show
// what happened instead of an empty window. The project lives in the engine,
// not in the page, so reloading the page loses nothing that was edited.

import { Component, type ReactNode } from "react";
import { logError } from "../lib/errors";

export class RootBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    logError(`window crashed: ${error.stack ?? error.message}`);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ground p-6 text-center">
        <div className="text-sm text-fg-1">Die Oberfläche ist auf einen Fehler gestoßen.</div>
        <p className="max-w-[460px] text-xs leading-relaxed text-fg-3">
          Dein Projekt liegt in der Engine und ist davon nicht betroffen; Änderungen seit dem letzten Speichern sind dort noch vorhanden. Lade die Oberfläche neu und speichere dann. Der Fehler steht im Protokoll (Über Kerf → Protokollordner).
        </p>
        <pre className="max-h-32 max-w-[560px] overflow-auto whitespace-pre-wrap rounded border border-line bg-field p-2 text-left font-mono text-[10.5px] text-fg-4">{this.state.error.message}</pre>
        <button className="rounded bg-signal px-3 py-1.5 text-xs font-medium text-signal-ink hover:bg-signal-hover" onClick={() => location.reload()}>
          Oberfläche neu laden
        </button>
      </div>
    );
  }
}
