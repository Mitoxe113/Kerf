// Marker list of the active sequence: search, filter by category, jump,
// rename, notes, colour, chapter flag and delete. Every change is an edit
// command (undoable); chapters are written into exports that support them.

import { BookMarked, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { engine } from "../engine/playback";
import { usePlayhead } from "../engine/hooks";
import { fuzzyScore } from "../lib/fuzzy";
import { formatTimecode } from "../lib/time";
import type { Marker, MarkerColor, Sequence } from "../lib/types";
import { edit, useActiveSequence } from "../state/project";
import { cx, IconButton, PanelHeader, Select, TextInput } from "../ui/primitives";

const COLORS: Record<MarkerColor, string> = { signal: "#c8f542", red: "#ff6b5e", amber: "#f5b544", blue: "#6fb6ff", violet: "#b18cff" };
const ORDER: MarkerColor[] = ["signal", "red", "amber", "blue", "violet"];
const CATEGORY_NAMES: Record<string, string> = { "": "Ohne Kategorie", scene: "Szenen", silence: "Pausen", beat: "Beats", highlight: "Vorschläge" };

const patch = (seq: Sequence, m: Marker, p: Partial<Marker>) => void edit({ type: "updateMarker", sequence: seq.id, marker: m.id, patch: p });

function Row({ seq, m, active }: { seq: Sequence; m: Marker; active: boolean }) {
  const [editing, setEditing] = useState<"name" | "note" | null>(null);
  const [text, setText] = useState("");
  const begin = (what: "name" | "note") => {
    setText(what === "name" ? m.name : m.note);
    setEditing(what);
  };
  const commit = () => {
    if (editing && text !== (editing === "name" ? m.name : m.note)) patch(seq, m, { [editing]: text });
    setEditing(null);
  };
  const nextColor = ORDER[(ORDER.indexOf(m.color) + 1) % ORDER.length];
  return (
    <div className={cx("group flex items-start gap-2 border-b border-line px-2 py-1 text-xs", active && "bg-surface-2")}>
      <button className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLORS[m.color] }} title="Farbe wechseln" onClick={() => patch(seq, m, { color: nextColor })} />
      <button className="w-[84px] shrink-0 text-left font-mono text-fg-2 hover:text-fg-1" onClick={() => engine.seek(m.frame)} title="Zum Marker springen">
        {formatTimecode(m.frame, seq.settings.fps)}
      </button>
      <div className="min-w-0 flex-1">
        {editing === "name" ? (
          <div onBlur={commit}>
            <TextInput value={text} onChange={setText} onEnter={commit} autoFocus selectOnFocus className="h-5" />
          </div>
        ) : (
          <div className="truncate text-fg-1" onDoubleClick={() => begin("name")} title="Doppelklick zum Umbenennen">
            {m.name || <span className="text-fg-4">Ohne Namen</span>}
            {(m.duration ?? 0) > 0 && <span className="ml-1 text-fg-4">· {formatTimecode(m.duration!, seq.settings.fps)}</span>}
          </div>
        )}
        {editing === "note" ? (
          <div onBlur={commit}>
            <TextInput value={text} onChange={setText} onEnter={commit} autoFocus className="mt-0.5 h-5" />
          </div>
        ) : (
          <div className="truncate text-[11px] text-fg-4" onDoubleClick={() => begin("note")} title="Doppelklick für eine Notiz">
            {m.note || (m.category ? CATEGORY_NAMES[m.category] ?? m.category : "Notiz …")}
          </div>
        )}
      </div>
      <IconButton
        size={20}
        icon={<BookMarked size={12} className={m.chapter ? "text-signal" : "text-fg-4"} />}
        label={m.chapter ? "Kein Kapitel mehr" : "Als Kapitel exportieren"}
        onClick={() => patch(seq, m, { chapter: !m.chapter })}
      />
      <IconButton size={20} icon={<Trash2 size={12} />} label="Marker löschen" onClick={() => void edit({ type: "removeMarker", sequence: seq.id, marker: m.id })} />
    </div>
  );
}

export function MarkersPanel() {
  const seq = useActiveSequence();
  const frame = usePlayhead();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("*");
  const markers = useMemo(() => seq?.markers ?? [], [seq?.markers]);
  const categories = useMemo(() => [...new Set(markers.map((m) => m.category ?? ""))].sort(), [markers]);
  const shown = useMemo(() => {
    const q = query.trim();
    return markers.filter((m) => (category === "*" || category === "chapters" ? true : (m.category ?? "") === category) && (category !== "chapters" || m.chapter) && (!q || fuzzyScore(q, `${m.name} ${m.note} ${m.category ?? ""}`) !== null));
  }, [markers, query, category]);
  if (!seq) return null;
  // The marker at or just before the playhead.
  const current = [...markers].reverse().find((m) => m.frame <= frame)?.id;
  const clearShown = () => shown.length && void edit({ type: "removeMarkers", sequence: seq.id, markers: shown.map((m) => m.id) });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader>
        <TextInput value={query} onChange={setQuery} placeholder="Marker suchen" className="h-6 flex-1" />
        <Select
          value={category}
          onChange={setCategory}
          width={130}
          options={[
            { value: "*", label: `Alle (${markers.length})` },
            { value: "chapters", label: `Kapitel (${markers.filter((m) => m.chapter).length})` },
            ...categories.map((c) => ({ value: c, label: CATEGORY_NAMES[c] ?? c })),
          ]}
        />
        <IconButton size={24} icon={<Trash2 size={13} />} label={`${shown.length} angezeigte Marker löschen`} onClick={clearShown} />
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length ? shown.map((m) => <Row key={m.id} seq={seq} m={m} active={m.id === current} />) : <p className="p-3 text-xs text-fg-4">{markers.length ? "Kein Marker passt." : "Noch keine Marker. Setze einen mit M oder über den Assistenten."}</p>}
      </div>
    </div>
  );
}
