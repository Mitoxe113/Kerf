// Command palette and global search (Ctrl+P / Ctrl+F): commands, media,
// clips of the active sequence, markers and sequences in one list, plus
// "go to timecode". A leading ">" (Ctrl+Shift+P) limits it to commands.

import { useEffect, useMemo, useRef, useState } from "react";
import { revealFrame, selectClips } from "../actions/editing";
import { formatCombo, keysFor } from "../actions/keymap";
import { useMacros } from "../actions/macros";
import { ACTIONS, runAction, runMacro } from "../actions/registry";
import { engine } from "../engine/playback";
import { fuzzyScore } from "../lib/fuzzy";
import { api } from "../lib/ipc";
import { formatDuration, formatTimecode, parseTimecode } from "../lib/time";
import { activeSequence, reportError, useProject } from "../state/project";
import { source } from "../state/source";
import { cx, Kbd } from "../ui/primitives";

interface Item {
  key: string;
  group: string;
  label: string;
  detail?: string;
  shortcut?: string;
  disabled?: boolean;
  score: number;
  run: () => void;
}

const RECENT_KEY = "kerf.palette.recent";
const GROUP_LIMIT = 8;
const KIND_LABEL = { video: "Video", audio: "Audio", image: "Bild" } as const;

function recentActions(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function rememberAction(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentActions().filter((x) => x !== id)].slice(0, 8)));
  } catch {
    // Storage unavailable: no recent list.
  }
}

function commandItem(id: string, score: number, group = "Befehle"): Item | null {
  const a = ACTIONS.find((x) => x.id === id);
  if (!a) return null;
  const keys = keysFor(a.id);
  return {
    key: `cmd:${a.id}`,
    group,
    label: a.label,
    detail: a.group,
    shortcut: keys[0] ? formatCombo(keys[0]) : undefined,
    disabled: a.enabled ? !a.enabled() : false,
    score,
    run: () => {
      rememberAction(a.id);
      runAction(a.id);
    },
  };
}

/** Best matches per group, groups in a fixed order. */
function search(raw: string): Item[] {
  const commandsOnly = raw.startsWith(">");
  const q = (commandsOnly ? raw.slice(1) : raw).trim();
  const out: Item[] = [];
  const add = (group: Item[]) => out.push(...group.sort((a, b) => b.score - a.score).slice(0, q ? GROUP_LIMIT : group.length));

  if (!q) {
    const recent = recentActions().flatMap((id) => commandItem(id, 0, "Zuletzt verwendet") ?? []);
    add(recent);
    if (commandsOnly || !recent.length) add(ACTIONS.flatMap((a) => (recent.some((r) => r.key === `cmd:${a.id}`) ? [] : (commandItem(a.id, 0) ?? []))));
    return out;
  }

  const p = useProject.getState().project;
  const seq = activeSequence(p);

  // Timecode: "1:00:00", "250", "+2:00" …
  if (!commandsOnly && seq && /^[+-]?[\d:;.]+$/.test(q)) {
    const f = parseTimecode(q, seq.settings.fps, Math.round(engine.frame));
    if (f !== null) {
      const tc = formatTimecode(Math.max(0, f), seq.settings.fps);
      out.push({ key: "tc", group: "Gehe zu", label: `Gehe zu ${tc}`, detail: seq.name, score: 0, run: () => (engine.pause(), engine.seek(f), revealFrame(f)) });
    }
  }

  add(
    ACTIONS.flatMap((a) => {
      const s = fuzzyScore(q, `${a.label} ${a.group}`);
      return s === null ? [] : (commandItem(a.id, s) ?? []);
    }),
  );
  add(
    useMacros.getState().macros.flatMap((m): Item[] => {
      const s = fuzzyScore(q, `Makro ${m.name}`);
      return s === null || !m.steps.length ? [] : [{ key: `macro:${m.id}`, group: "Makros", label: m.name.trim() || "Makro", detail: `${m.steps.length} ${m.steps.length === 1 ? "Schritt" : "Schritte"}`, score: s, run: () => void runMacro(m) }];
    }),
  );
  if (commandsOnly || !p) return out;

  add(
    p.media.flatMap((m): Item[] => {
      const s = fuzzyScore(q, m.name);
      if (s === null) return [];
      const d = m.info && m.kind !== "image" ? ` · ${formatDuration(m.info.duration)}` : "";
      return [{ key: `media:${m.id}`, group: "Medien", label: m.name, detail: `${KIND_LABEL[m.kind]}${d}`, score: s, run: () => source.open(m.id) }];
    }),
  );

  if (seq) {
    add(
      seq.tracks.flatMap((t, ti) =>
        t.clips.flatMap((c): Item[] => {
          const s = fuzzyScore(q, c.name);
          if (s === null) return [];
          const track = `${t.kind === "video" ? "V" : "A"}${seq.tracks.filter((x, i) => x.kind === t.kind && i <= ti).length}`;
          return [
            {
              key: `clip:${c.id}`,
              group: "Clips",
              label: c.name,
              detail: `${track} · ${formatTimecode(c.start, seq.settings.fps)}`,
              score: s,
              run: () => {
                selectClips([c.id]);
                engine.pause();
                engine.seek(c.start);
                revealFrame(c.start);
              },
            },
          ];
        }),
      ),
    );
    add(
      seq.markers.flatMap((m): Item[] => {
        const s = fuzzyScore(q, `${m.name} ${m.note ?? ""}`);
        if (s === null) return [];
        return [{ key: `marker:${m.id}`, group: "Marker", label: m.name || "Marker", detail: formatTimecode(m.frame, seq.settings.fps), score: s, run: () => (engine.pause(), engine.seek(m.frame), revealFrame(m.frame)) }];
      }),
    );
  }

  add(
    p.sequences.flatMap((sq): Item[] => {
      const s = fuzzyScore(q, sq.name);
      if (s === null) return [];
      return [
        {
          key: `seq:${sq.id}`,
          group: "Sequenzen",
          label: sq.name,
          detail: sq.id === p.activeSequence ? "aktiv" : `${sq.settings.width} × ${sq.settings.height}`,
          score: s,
          run: () =>
            void api
              .setActiveSequence(sq.id)
              .then(() => useProject.getState().setActiveSequence(sq.id))
              .catch(reportError),
        },
      ];
    }),
  );
  return out;
}

export function CommandPalette({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [query, setQuery] = useState(initial);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => search(query), [query]);
  const sel = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (it: Item | undefined) => {
    if (!it || it.disabled) return;
    // Close first: the command may open a dialog of its own.
    onClose();
    it.run();
  };

  const move = (d: number) => {
    if (!items.length) return;
    let i = sel;
    for (let n = 0; n < items.length; n++) {
      i = (i + d + items.length) % items.length;
      if (!items[i].disabled) break;
    }
    setActive(i);
  };

  return (
    <div className="fixed inset-0 z-[800] flex justify-center bg-black/40 pt-[12vh]" onPointerDown={onClose}>
      <div className="anim-pop flex h-fit max-h-[70vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-line-strong bg-raised shadow-pop" onPointerDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Befehle, Medien, Clips, Marker oder Timecode suchen …  (> nur Befehle)"
          className="h-11 shrink-0 border-b border-line bg-transparent px-4 text-sm text-fg outline-none placeholder:text-fg-4"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            } else if (e.key === "PageDown" || e.key === "PageUp") {
              e.preventDefault();
              setActive(Math.max(0, Math.min(items.length - 1, sel + (e.key === "PageDown" ? 8 : -8))));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(items[sel]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
          {items.length === 0 && <div className="px-3 py-6 text-center text-sm text-fg-4">Nichts gefunden</div>}
          {items.map((it, i) => (
            <div key={it.key}>
              {(i === 0 || items[i - 1].group !== it.group) && <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-fg-4">{it.group}</div>}
              <button
                data-index={i}
                disabled={it.disabled}
                onPointerMove={() => !it.disabled && sel !== i && setActive(i)}
                onClick={() => choose(it)}
                className={cx("flex h-8 w-full items-center gap-3 rounded-md px-3 text-left text-sm", i === sel && !it.disabled ? "bg-hover text-fg" : "text-fg-2", it.disabled && "opacity-40")}
              >
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.detail && <span className="shrink-0 truncate text-xs text-fg-4">{it.detail}</span>}
                {it.shortcut && <Kbd>{it.shortcut}</Kbd>}
              </button>
            </div>
          ))}
        </div>
        <div className="flex shrink-0 gap-4 border-t border-line px-4 py-1.5 text-[10.5px] text-fg-4">
          <span>↑↓ auswählen</span>
          <span>Enter ausführen</span>
          <span>Esc schließen</span>
          <span className="ml-auto">„&gt;“ nur Befehle · Zahl = Timecode</span>
        </div>
      </div>
    </div>
  );
}
