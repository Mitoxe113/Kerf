// Creates a smart bin or edits its rules (kerf_core::model::SmartRules).

import { useMemo, useState } from "react";
import { LABEL_COLORS, LABEL_NAMES } from "../lib/labels";
import { EMPTY_RULES, smartMatch, usedMedia } from "../lib/smart";
import type { LabelColor, SmartKind, SmartRules, SmartUsage, Uuid } from "../lib/types";
import { useEditor } from "../state/editor";
import { edit, useProject } from "../state/project";
import { Button, cx, Field, Modal, Segmented, TextInput, Toggle } from "../ui/primitives";

const KINDS: { value: SmartKind; label: string }[] = [
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "image", label: "Bilder" },
  { value: "title", label: "Titel" },
  { value: "adjustment", label: "Einstellungsebenen" },
];

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Comma separated tags as the rules store them (trimmed, no empties). */
const parseTags = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);

export function SmartBinDialog({ bin, parent, onClose }: { bin: Uuid | null; parent: Uuid | null; onClose: () => void }) {
  const project = useProject((s) => s.project);
  const existing = bin ? project?.bins.find((b) => b.id === bin) : undefined;
  const [name, setName] = useState(existing?.name ?? "Intelligente Ablage");
  const [rules, setRules] = useState<SmartRules>(existing?.smart ?? EMPTY_RULES);
  const [tags, setTags] = useState((existing?.smart?.tags ?? []).join(", "));
  const set = (p: Partial<SmartRules>) => setRules((r) => ({ ...r, ...p }));
  const final: SmartRules = useMemo(() => ({ ...rules, tags: parseTags(tags) }), [rules, tags]);
  const used = useMemo(() => (project ? usedMedia(project) : new Set<Uuid>()), [project]);
  const count = useMemo(() => (project?.media ?? []).filter((m) => smartMatch(final, m, used)).length, [project, final, used]);

  const save = async () => {
    if (!name.trim()) return;
    if (existing) {
      await edit({ type: "setSmartRules", bin: existing.id, rules: final });
      onClose();
      return;
    }
    const d = await edit({ type: "createBin", name: name.trim(), parent, smart: final });
    onClose();
    const id = d?.outcome.created[0];
    if (id) useEditor.getState().set({ currentBin: id, mediaSearch: "", mediaSelection: [] });
  };

  if (bin && !existing?.smart) return null;
  return (
    <Modal
      title={existing ? `Regeln: ${existing.name}` : "Intelligente Ablage"}
      onClose={onClose}
      width={480}
      footer={
        <>
          <span className="mr-auto text-xs text-fg-3">{count === 1 ? "1 Medium passt" : `${count} Medien passen`}</span>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>
            {existing ? "Übernehmen" : "Erstellen"}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {!existing && (
          <Field label="Name">
            <TextInput autoFocus selectOnFocus value={name} onChange={setName} onEnter={() => void save()} />
          </Field>
        )}
        <Field label="Typ">
          <div className="flex flex-wrap gap-1">
            {KINDS.map((k) => (
              <Chip key={k.value} on={rules.kinds.includes(k.value)} onClick={() => set({ kinds: toggle(rules.kinds, k.value) })}>
                {k.label}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="Enthält">
          <TextInput value={rules.text} onChange={(v) => set({ text: v })} placeholder="Name, Notiz oder Tag" />
        </Field>
        <Field label="Alle Tags">
          <TextInput value={tags} onChange={setTags} placeholder="z. B. Außen, Tag 1" />
        </Field>
        <Field label="Farbe">
          <div className="flex flex-wrap gap-1">
            {(Object.keys(LABEL_COLORS) as Exclude<LabelColor, "none">[]).map((l) => (
              <button
                key={l}
                title={LABEL_NAMES[l]}
                aria-label={LABEL_NAMES[l]}
                aria-pressed={rules.labels.includes(l)}
                onClick={() => set({ labels: toggle(rules.labels, l) })}
                className={cx("h-5 w-5 rounded-full ring-offset-1 ring-offset-panel", rules.labels.includes(l) ? "ring-2 ring-signal" : "opacity-70 hover:opacity-100")}
                style={{ background: LABEL_COLORS[l] }}
              />
            ))}
          </div>
        </Field>
        <Field label="Verwendung">
          <Segmented<SmartUsage>
            size="sm"
            value={rules.usage}
            onChange={(v) => set({ usage: v })}
            options={[
              { value: "any", label: "Egal" },
              { value: "used", label: "In Sequenzen" },
              { value: "unused", label: "Nicht verwendet" },
            ]}
          />
        </Field>
        <Field label="Nur Favoriten">
          <Toggle checked={rules.favorites} onChange={(v) => set({ favorites: v })} label="Nur Favoriten" />
        </Field>
        <Field label="Nur offline">
          <Toggle checked={rules.missing} onChange={(v) => set({ missing: v })} label="Nur offline" />
        </Field>
        <p className="text-xs text-fg-4">Ein Medium muss alle gesetzten Regeln erfüllen. Leere Regeln gelten nicht. Die Ablage enthält nichts selbst, sie zeigt die passenden Medien aus dem ganzen Projekt.</p>
      </div>
    </Modal>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-pressed={on}
      onClick={onClick}
      className={cx("h-6 rounded-sm px-2 text-xs transition-colors", on ? "bg-signal-soft text-signal ring-1 ring-signal" : "bg-ground text-fg-3 hover:text-fg-2")}
    >
      {children}
    </button>
  );
}
