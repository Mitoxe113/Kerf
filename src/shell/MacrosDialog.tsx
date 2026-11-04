// Makros: list, rename, reorder and edit the steps of the user's macros,
// start a recording or run one.

import { ArrowDown, ArrowUp, Play, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { MAX_MACROS, MAX_STEPS, NUMBERED_MACROS, recordable, useMacros } from "../actions/macros";
import { ACTIONS, actionLabel, runMacro, toggleMacroRecording } from "../actions/registry";
import { Button, cx, IconButton, Modal, Select, TextInput } from "../ui/primitives";

const STEP_OPTIONS = [{ value: "", label: "Schritt hinzufügen …" }, ...ACTIONS.filter((a) => recordable(a.id)).map((a) => ({ value: a.id, label: a.label, group: a.group }))];

export function MacrosDialog({ onClose }: { onClose: () => void }) {
  const { macros, recording, add, update, remove, move } = useMacros();
  const [selected, setSelected] = useState<string | null>(macros[0]?.id ?? null);
  const m = macros.find((x) => x.id === selected) ?? macros[0] ?? null;
  const create = () => {
    const made = add(`Makro ${macros.length + 1}`, []);
    if (made) setSelected(made.id);
  };
  const record = () => {
    onClose();
    void toggleMacroRecording();
  };
  const setSteps = (steps: string[]) => m && update(m.id, { steps });
  return (
    <Modal
      title="Makros"
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button onClick={record}>{recording ? "Aufzeichnung beenden" : "Aufzeichnen"}</Button>
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        </>
      }
    >
      <div className="flex h-[420px] gap-3 text-sm">
        <div className="flex w-[220px] shrink-0 flex-col rounded-sm border border-line">
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {macros.map((x, i) => (
              <button
                key={x.id}
                className={cx("flex w-full items-center gap-2 px-2.5 py-1 text-left", x.id === m?.id ? "bg-signal-soft text-fg" : "text-fg-2 hover:bg-hover")}
                onClick={() => setSelected(x.id)}
              >
                <span className="w-4 shrink-0 text-right text-[10.5px] text-fg-4">{i < NUMBERED_MACROS ? i + 1 : ""}</span>
                <span className="min-w-0 flex-1 truncate">{x.name.trim() || "Makro"}</span>
                <span className="text-[10.5px] text-fg-4">{x.steps.length}</span>
              </button>
            ))}
            {!macros.length && <div className="px-3 py-2 text-xs text-fg-4">Noch keine Makros. Lege eines an oder zeichne Befehle auf.</div>}
          </div>
          <div className="flex items-center gap-1 border-t border-line p-1">
            <IconButton icon={<Plus size={14} />} label="Neues Makro" size={24} disabled={macros.length >= MAX_MACROS} onClick={create} />
            <IconButton icon={<ArrowUp size={14} />} label="Nach oben" size={24} disabled={!m || macros[0]?.id === m.id} onClick={() => m && move(m.id, -1)} />
            <IconButton icon={<ArrowDown size={14} />} label="Nach unten" size={24} disabled={!m || macros[macros.length - 1]?.id === m.id} onClick={() => m && move(m.id, 1)} />
            <div className="flex-1" />
            <IconButton icon={<Trash2 size={14} />} label="Makro löschen" size={24} disabled={!m} onClick={() => m && remove(m.id)} />
          </div>
        </div>
        {m ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <TextInput key={m.id} value={m.name} onChange={(v) => update(m.id, { name: v })} className="flex-1" />
              <Button disabled={!m.steps.length} onClick={() => (onClose(), void runMacro(m))}>
                <Play size={12} /> Ausführen
              </Button>
            </div>
            <div className="text-xs text-fg-4">
              {macros.indexOf(m) < NUMBERED_MACROS ? `Läuft auch über „Makro ${macros.indexOf(m) + 1} ausführen“ (Befehlspalette, Tastenkürzel zuweisbar). ` : ""}
              Jeder Schritt wirkt auf die aktuelle Auswahl und den Playhead, wie von Hand ausgeführt, und ist ein eigener Rückgängig-Schritt.
            </div>
            <ol className="min-h-0 flex-1 overflow-auto rounded-sm border border-line py-1">
              {m.steps.map((id, i) => (
                <li key={`${i}-${id}`} className="group flex items-center gap-2 px-2.5 py-0.5 hover:bg-hover">
                  <span className="w-5 shrink-0 text-right text-[10.5px] text-fg-4">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate text-fg-2">{actionLabel(id)}</span>
                  <IconButton icon={<ArrowUp size={12} />} label="Schritt nach oben" size={20} disabled={i === 0} onClick={() => setSteps(m.steps.map((s, k) => (k === i - 1 ? id : k === i ? m.steps[i - 1] : s)))} />
                  <IconButton icon={<ArrowDown size={12} />} label="Schritt nach unten" size={20} disabled={i === m.steps.length - 1} onClick={() => setSteps(m.steps.map((s, k) => (k === i + 1 ? id : k === i ? m.steps[i + 1] : s)))} />
                  <IconButton icon={<X size={12} />} label="Schritt entfernen" size={20} onClick={() => setSteps(m.steps.filter((_, k) => k !== i))} />
                </li>
              ))}
              {!m.steps.length && <li className="px-3 py-2 text-xs text-fg-4">Keine Schritte.</li>}
            </ol>
            <Select label="Schritt hinzufügen" value="" options={STEP_OPTIONS} onChange={(v) => v && m.steps.length < MAX_STEPS && setSteps([...m.steps, v])} />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-fg-4">Kein Makro gewählt.</div>
        )}
      </div>
    </Modal>
  );
}
