// Undo history as a list: every step is visible and clickable. Steps after
// the current position are the redo stack (dimmed until a new edit drops them).

import { useEffect, useRef, useState } from "react";
import { historyGoto } from "../actions/project";
import { editLabel } from "../lib/i18n";
import { api } from "../lib/ipc";
import type { HistoryList } from "../lib/types";
import { useProject } from "../state/project";
import { cx, PanelHeader } from "../ui/primitives";

const clock = (ms: number) => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function HistoryPanel() {
  const revision = useProject((s) => s.revision);
  const history = useProject((s) => s.history);
  const [list, setList] = useState<HistoryList>({ entries: [], position: 0 });
  const current = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    void api.historyList().then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [revision, history]);

  useEffect(() => {
    current.current?.scrollIntoView({ block: "center" });
  }, [list]);

  const rows = [{ label: "", time: 0 }, ...list.entries];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Verlauf">
        <span className="text-[10px] tabular-nums text-fg-4">
          {list.position}/{list.entries.length}
        </span>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {rows.map((e, i) => {
          const active = i === list.position;
          return (
            <button
              key={i}
              ref={active ? current : undefined}
              onClick={() => i !== list.position && void historyGoto(i)}
              className={cx(
                "flex h-7 w-full items-center gap-2 px-2.5 text-left text-xs",
                active ? "bg-signal/15 text-fg" : i > list.position ? "text-fg-4 hover:bg-raised" : "text-fg-2 hover:bg-raised",
              )}
            >
              <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", active ? "bg-signal" : i > list.position ? "border border-fg-4" : "bg-fg-3")} />
              <span className="min-w-0 flex-1 truncate">{i === 0 ? "Ausgangszustand" : editLabel(e.label)}</span>
              {i > 0 && <span className="shrink-0 text-[10px] tabular-nums text-fg-4">{clock(e.time)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
