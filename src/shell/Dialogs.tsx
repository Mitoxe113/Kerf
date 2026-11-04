import { CurveDialog } from "./CurveEditor";
import { useEffect, useMemo, useState } from "react";
import { comboOf, DEFAULT_PROFILE, formatCombo, keymapFile, keysFor, parseKeymapFile, profileChanged, recording, useKeymap } from "../actions/keymap";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ACTIONS } from "../actions/registry";
import { api } from "../lib/ipc";
import { formatRate, STANDARD_RATES } from "../lib/time";
import { formatBytes } from "../lib/media";
import type { AudioEffect, ClipGain, Loudness, PlaceMode, RecoveryInfo, SequenceSettings, Uuid, VersionInfo } from "../lib/types";
import { createMulticam, type SyncMethod } from "../actions/multicam";
import { AddAudioEffect, AudioEffectsEditor } from "../panels/AudioEffects";
import { currentLayout, useEditor, type Dialog } from "../state/editor";
import { activeSequence, edit, reportError, useProject } from "../state/project";
import { toast } from "../state/toasts";
import { Button, cx, Field, Kbd, Modal, NumberField, Progress, Segmented, Select, TextInput, Toggle } from "../ui/primitives";
import { installUpdate, pendingUpdate } from "../actions/update";
import { Logo } from "./TitleBar";
import { CommandPalette } from "./CommandPalette";
import { Preferences } from "./Preferences";
import { guardUnsaved, prompt } from "../actions/project";
import { engine } from "../engine/playback";
import { SmartBinDialog } from "./SmartBinDialog";
import { WatchFolderDialog } from "./WatchFolderDialog";
import { MacrosDialog } from "./MacrosDialog";

const RESOLUTIONS = [
  { value: "3840x2160", label: "UHD 3840 × 2160" },
  { value: "2560x1440", label: "QHD 2560 × 1440" },
  { value: "1920x1080", label: "Full HD 1920 × 1080" },
  { value: "1280x720", label: "HD 1280 × 720" },
  { value: "1080x1920", label: "Hochformat 1080 × 1920" },
  { value: "1080x1350", label: "Social 4:5 1080 × 1350" },
  { value: "1080x1080", label: "Quadrat 1080 × 1080" },
];

function SequenceForm({ initial, name: initialName, onSubmit, submitLabel, onClose, title }: { initial: SequenceSettings; name: string; onSubmit: (name: string, s: SequenceSettings) => void; submitLabel: string; onClose: () => void; title: string }) {
  const [name, setName] = useState(initialName);
  const [s, setS] = useState(initial);
  const res = `${s.width}x${s.height}`;
  const resOptions = RESOLUTIONS.some((r) => r.value === res) ? RESOLUTIONS : [{ value: res, label: `${s.width} × ${s.height}` }, ...RESOLUTIONS];
  const rateKey = `${s.fps.num}/${s.fps.den}`;
  const rates = STANDARD_RATES.some((r) => `${r.rate.num}/${r.rate.den}` === rateKey)
    ? STANDARD_RATES
    : [{ label: formatRate(s.fps), rate: s.fps }, ...STANDARD_RATES];
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => onSubmit(name.trim(), s)}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={setName} onEnter={() => name.trim() && onSubmit(name.trim(), s)} />
        </Field>
        <Field label="Auflösung">
          <Select
            width={230}
            value={res}
            options={resOptions}
            onChange={(v) => {
              const [width, height] = v.split("x").map(Number);
              setS({ ...s, width, height });
            }}
          />
        </Field>
        <Field label="Bildrate">
          <Select
            width={140}
            value={rateKey}
            options={rates.map((r) => ({ value: `${r.rate.num}/${r.rate.den}`, label: `${r.label} fps` }))}
            onChange={(v) => {
              const [num, den] = v.split("/").map(Number);
              setS({ ...s, fps: { num, den } });
            }}
          />
        </Field>
        <Field label="Audio">
          <Select width={140} value={s.sampleRate} options={[44100, 48000, 96000].map((r) => ({ value: r, label: `${r / 1000} kHz` }))} onChange={(v) => setS({ ...s, sampleRate: v })} />
        </Field>
        <p className="pt-1 text-xs text-fg-4">Eine leere Sequenz übernimmt beim ersten Clip automatisch dessen Auflösung und Bildrate.</p>
      </div>
    </Modal>
  );
}

function ShortcutEditor({ onClose }: { onClose: () => void }) {
  const overrides = useKeymap((s) => s.overrides);
  const profiles = useKeymap((s) => s.profiles);
  const profile = useKeymap((s) => s.profile);
  const changed = useKeymap(profileChanged);
  const { setKeys, reset, saveProfile, loadProfile, deleteProfile } = useKeymap.getState();
  const JSON_FILTER = [{ name: "Kerf-Tastaturbelegung", extensions: ["json"] }];

  const saveAs = async () => {
    // The name prompt takes the dialog slot; come back here afterwards.
    const name = (await prompt({ title: "Tastaturprofil speichern", label: "Name", value: profile === DEFAULT_PROFILE ? "Mein Profil" : profile, confirm: "Speichern" }))?.trim();
    useEditor.getState().set({ dialog: { kind: "shortcuts" } });
    if (!name) return;
    if (name === DEFAULT_PROFILE) return toast.info(`„${DEFAULT_PROFILE}“ ist reserviert`);
    saveProfile(name);
  };
  const exportFile = async () => {
    const path = await saveDialog({ defaultPath: `Kerf-Tastatur ${profile}.json`, filters: JSON_FILTER });
    if (!path) return;
    try {
      await api.jsonWrite(path, JSON.stringify(keymapFile(profile, overrides), null, 2));
      toast.success("Tastaturbelegung exportiert", path.split(/[\\/]/).pop());
    } catch (e) {
      reportError(e);
    }
  };
  const importFile = async () => {
    const path = await openDialog({ multiple: false, directory: false, filters: JSON_FILTER });
    if (!path || Array.isArray(path)) return;
    try {
      const { name, overrides: imported, skipped } = parseKeymapFile(await api.jsonRead(path), new Set(ACTIONS.map((a) => a.id)));
      const unique = name === DEFAULT_PROFILE || profiles[name] ? `${name} (importiert)` : name;
      useKeymap.setState({ overrides: imported });
      saveProfile(unique);
      toast.success(`Profil „${unique}“ importiert`, skipped ? `${skipped} unbekannte Befehle übersprungen` : undefined);
    } catch (e) {
      if (e instanceof Error) toast.error("Import fehlgeschlagen", e.message);
      else reportError(e);
    }
  };
  const [query, setQuery] = useState("");
  const [rec, setRec] = useState<string | null>(null);
  const groups = useMemo(() => {
    const q = query.toLowerCase();
    const list = ACTIONS.filter((a) => !q || a.label.toLowerCase().includes(q) || a.group.toLowerCase().includes(q));
    const map = new Map<string, typeof ACTIONS>();
    for (const a of list) map.set(a.group, [...(map.get(a.group) ?? []), a]);
    return [...map.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, overrides]);

  useEffect(() => {
    if (!rec) return;
    recording.active = true;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRec(null);
      const combo = comboOf(e);
      if (!combo) return;
      const clash = ACTIONS.find((a) => a.id !== rec && keysFor(a.id).includes(combo));
      if (clash) {
        setKeys(clash.id, keysFor(clash.id).filter((k) => k !== combo));
        toast.info(`„${formatCombo(combo)}“ wurde von „${clash.label}“ entfernt`);
      }
      setKeys(rec, [combo]);
      setRec(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      recording.active = false;
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [rec, setKeys]);

  return (
    <Modal
      title="Tastaturbefehle"
      width={680}
      onClose={() => (rec ? setRec(null) : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={() => reset()}>
            Alle zurücksetzen
          </Button>
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-1.5">
        <span className="text-xs text-fg-3">Profil</span>
        <Select
          width={170}
          value={profile}
          onChange={(v) => (v === DEFAULT_PROFILE ? (useKeymap.setState({ profile: DEFAULT_PROFILE }), reset()) : loadProfile(v))}
          options={[DEFAULT_PROFILE, ...Object.keys(profiles)].map((p) => ({ value: p, label: p }))}
        />
        {changed && <span className="text-[10.5px] text-warn">geändert</span>}
        <span className="flex-1" />
        <Button size="sm" onClick={() => void saveAs()}>
          Speichern unter …
        </Button>
        {profile !== DEFAULT_PROFILE && (
          <Button size="sm" variant="ghost" onClick={() => deleteProfile(profile)}>
            Löschen
          </Button>
        )}
        <Button size="sm" onClick={() => void importFile()}>
          Importieren …
        </Button>
        <Button size="sm" onClick={() => void exportFile()}>
          Exportieren …
        </Button>
      </div>
      <TextInput autoFocus value={query} onChange={setQuery} placeholder="Befehl suchen …" />
      <div className="mt-3 space-y-4">
        {groups.map(([group, actions]) => (
          <div key={group}>
            <div className="panel-title mb-1">{group}</div>
            {actions.map((a) => {
              const keys = keysFor(a.id);
              return (
                <div key={a.id} className="flex h-8 items-center gap-2 rounded-sm px-2 hover:bg-raised">
                  <span className="flex-1 text-sm text-fg-2">{a.label}</span>
                  <button
                    onClick={() => setRec(a.id)}
                    className={cx("flex h-6 min-w-24 items-center justify-end gap-1 rounded-sm px-2", rec === a.id ? "bg-signal-soft text-signal ring-1 ring-signal" : "hover:bg-hover")}
                  >
                    {rec === a.id ? <span className="text-xs">Taste drücken …</span> : keys.length ? keys.map((k) => <Kbd key={k}>{formatCombo(k)}</Kbd>) : <span className="text-xs text-fg-4">–</span>}
                  </button>
                  {overrides[a.id] && (
                    <button className="text-[10.5px] text-fg-3 hover:text-fg" onClick={() => reset(a.id)}>
                      Standard
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function RecoveryDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<RecoveryInfo[] | null>(null);
  useEffect(() => {
    void api.recoveryList().then(setList);
  }, []);
  const discard = async (r: RecoveryInfo) => {
    await api.recoveryDiscard(r.projectId);
    const rest = (list ?? []).filter((x) => x.projectId !== r.projectId);
    if (rest.length) setList(rest);
    else onClose();
  };
  const restore = async (r: RecoveryInfo) => {
    if (!(await guardUnsaved())) return;
    try {
      useProject.getState().applyState(await api.recoveryRestore(r.projectId));
      engine.seek(0);
      toast.success("Projekt wiederhergestellt", "Bitte speichern, um den Stand zu sichern.");
      onClose();
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <Modal title="Wiederherstellung" onClose={onClose} width={520} footer={<Button onClick={onClose}>Schließen</Button>}>
      {list === null ? (
        <p className="text-sm text-fg-3">Suche …</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-fg-3">Keine wiederherstellbaren Sitzungen gefunden.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-fg-2">Kerf wurde nicht ordnungsgemäß beendet. Diese automatisch gesicherten Stände können wiederhergestellt werden:</p>
          {list.map((r) => (
            <div key={r.projectId} className="flex items-center gap-3 rounded-md bg-raised p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.name}</div>
                <div className="truncate text-xs text-fg-3">
                  {new Date(r.savedAt).toLocaleString("de-DE")} · {r.path ?? "nie gespeichert"}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void discard(r)}>
                Verwerfen
              </Button>
              <Button size="sm" variant="primary" onClick={() => void restore(r)}>
                Wiederherstellen
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function VersionsDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<VersionInfo[] | null>(null);
  const path = useProject((s) => s.path);
  useEffect(() => {
    void api.versionList().then(setList);
  }, []);
  const restore = async (v: VersionInfo) => {
    if (!(await guardUnsaved())) return;
    try {
      useProject.getState().applyState(await api.versionRestore(v.file));
      useEditor.getState().set({ selection: [] });
      engine.seek(0);
      toast.success("Version geladen", `Stand vom ${new Date(v.savedAt).toLocaleString("de-DE")}. Speichern überschreibt die Projektdatei.`);
      onClose();
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <Modal title="Versionen" onClose={onClose} width={520} footer={<Button onClick={onClose}>Schließen</Button>}>
      {list === null ? (
        <p className="text-sm text-fg-3">Suche …</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-fg-3">Noch keine Versionen. Bei jedem Speichern wird eine Version angelegt.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-fg-3" title={path ?? undefined}>
            Gespeicherte Stände von <span className="text-fg-2">{path?.split(/[\\/]/).pop()}</span>, neueste zuerst. Das Laden ersetzt den aktuellen Stand; der Rückgängig-Verlauf beginnt neu.
          </p>
          <div className="max-h-[360px] space-y-1 overflow-y-auto">
            {list.map((v, i) => (
              <div key={v.file} className="flex items-center gap-3 rounded-md bg-raised px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{new Date(v.savedAt).toLocaleString("de-DE")}</div>
                  <div className="text-xs text-fg-3">
                    {formatBytes(v.size)}
                    {i === 0 && " · zuletzt gespeichert"}
                  </div>
                </div>
                <Button size="sm" onClick={() => void restore(v)}>
                  Laden
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

type NormMode = "peak" | "truePeak" | "lufs";
const NORM_MODES: { value: NormMode; label: string; unit: string }[] = [
  { value: "peak", label: "Spitzenpegel", unit: "dBFS" },
  { value: "truePeak", label: "True Peak", unit: "dBTP" },
  { value: "lufs", label: "Lautheit (LUFS)", unit: "LUFS" },
];
const LUFS_PRESETS = [
  { value: -14, label: "−14 Streaming" },
  { value: -16, label: "−16 Podcast" },
  { value: -23, label: "−23 EBU R128" },
];
// Remembered for the session.
const normDefaults = { mode: "peak" as NormMode, target: { peak: -1, truePeak: -1, lufs: -14 } as Record<NormMode, number>, together: false, limit: false, ceiling: -1 };
const fmtDb = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(1).replace(".", ",")}`;

/** Effects of an audio track (after the sum of its clips, before its fader). */
function TrackEffectsDialog({ sequence, track: id, onClose }: { sequence: Uuid; track: Uuid; onClose: () => void }) {
  const track = useProject((s) => s.project?.sequences.find((q) => q.id === sequence)?.tracks.find((t) => t.id === id));
  if (!track) return null;
  const effects = track.effects ?? [];
  const onChange = (next: AudioEffect[], live: boolean) => {
    engine.setTrackOverride(id, { effects: next });
    if (live) return;
    void edit({ type: "updateTrack", sequence, track: id, patch: { effects: next } }).finally(() => engine.setTrackOverride(id, null));
  };
  return (
    <Modal title={`Spureffekte – ${track.name}`} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Fertig</Button>}>
      <div className="w-[380px] space-y-2">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <Toggle checked={!!track.mono} onChange={(v) => void edit({ type: "updateTrack", sequence, track: id, patch: { mono: v } })} label="Mono" />
            <span>Mono</span>
            <span className="text-xs text-fg-4">(L+R)/2 vor den Effekten</span>
          </label>
          <AddAudioEffect effects={effects} onChange={onChange} />
        </div>
        <AudioEffectsEditor effects={effects} onChange={onChange} empty="Keine Spureffekte. Mit + hinzufügen; sie wirken auf die Summe der Clips, vor dem Regler." />
      </div>
    </Modal>
  );
}

function MulticamDialog({ media, onClose }: { media: Uuid[]; onClose: () => void }) {
  const mediaById = useProject((s) => s.mediaById);
  const angles = media.map((id) => mediaById.get(id)).filter((m): m is NonNullable<typeof m> => !!m && m.status.state === "ready" && m.kind === "video");
  const [name, setName] = useState(`Multicam ${String((useProject.getState().project?.multicams?.length ?? 0) + 1).padStart(2, "0")}`);
  const [method, setMethod] = useState<SyncMethod>("audio");
  const [audio, setAudio] = useState(angles.findIndex((m) => !!m.info?.audio));
  const [mode, setMode] = useState<PlaceMode>("insert");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createMulticam(name.trim(), angles.map((m) => m.id), method, audio >= 0 ? audio : null, mode);
    } finally {
      onClose();
    }
  };
  return (
    <Modal
      title="Multicam-Clip erstellen"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy || angles.length < 2}>
            {busy ? (method === "audio" ? "Synchronisiere …" : "Erstelle …") : "Erstellen"}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={setName} onEnter={() => void run()} />
        </Field>
        <Field label="Synchronisieren">
          <Segmented value={method} onChange={setMethod} options={[{ value: "audio", label: "Über den Ton" }, { value: "start", label: "Am Anfang" }]} />
        </Field>
        <Field label="Ton von">
          <Select value={audio} onChange={setAudio} width={220} options={[{ value: -1, label: "Kein Ton" }, ...angles.map((m, i) => ({ value: i, label: `Kamera ${i + 1}: ${m.name}` }))].filter((o) => o.value < 0 || !!angles[o.value].info?.audio)} />
        </Field>
        <Field label="Einfügen">
          <Segmented value={mode} onChange={setMode} options={[{ value: "insert", label: "Einfügen" }, { value: "overwrite", label: "Überschreiben" }]} />
        </Field>
        <ol className="mt-1 space-y-0.5 text-xs text-fg-3">
          {angles.map((m, i) => (
            <li key={m.id} className="truncate">
              <span className="font-mono text-fg-2">{i + 1}</span> {m.name}
            </li>
          ))}
        </ol>
        <p className="text-xs text-fg-4">Die Kameras werden am Playhead eingefügt; mit den Tasten 1–9 (oder einem Klick im Multicam-Panel) wird ab dem Playhead umgeschaltet, auch während der Wiedergabe.</p>
      </div>
    </Modal>
  );
}

function NormalizeDialog({ clips, onClose }: { clips: Uuid[]; onClose: () => void }) {
  const [mode, setMode] = useState(normDefaults.mode);
  const [targets, setTargets] = useState(normDefaults.target);
  const [together, setTogether] = useState(normDefaults.together);
  const [limit, setLimit] = useState(normDefaults.limit);
  const [ceiling, setCeiling] = useState(normDefaults.ceiling);
  const [busy, setBusy] = useState(false);
  const target = targets[mode];
  const unit = NORM_MODES.find((m) => m.value === mode)!.unit;
  const run = async () => {
    const s = activeSequence(useProject.getState().project);
    if (!s) return;
    Object.assign(normDefaults, { mode, target: targets, together, limit, ceiling });
    setBusy(true);
    try {
      const res = await api.measureClips(s.id, clips);
      const now = activeSequence(useProject.getState().project) ?? s;
      const gainOf = (id: Uuid) => now.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.volumeDb ?? 0;
      const pick = (l: Loudness | null) => (l ? (mode === "peak" ? l.samplePeak : mode === "truePeak" ? l.truePeak : l.integrated) : null);
      const valid = res.flatMap((r) => {
        const v = pick(r.loudness);
        return v === null ? [] : [{ clip: r.clip, level: v, peak: r.loudness!.samplePeak ?? -Infinity, gain: gainOf(r.clip) }];
      });
      const skipped = clips.length - valid.length;
      if (!valid.length) {
        toast.info("Nichts zu normalisieren", "Die ausgewählten Clips enthalten keinen hörbaren Ton.");
        onClose();
        return;
      }
      // Together: one shared change so the loudest clip (with its current gain) hits the target.
      const shared = target - Math.max(...valid.map((v) => v.level + v.gain));
      const gains: ClipGain[] = valid.map((v) => ({ clip: v.clip, volumeDb: Math.round((together ? v.gain + shared : target - v.level) * 10) / 10, limitDb: limit ? ceiling : null }));
      await edit({ type: "setClipGain", sequence: s.id, gains });
      const [lo, hi] = [-96, 24];
      const limited = gains.filter((g) => g.volumeDb < lo || g.volumeDb > hi).length;
      // The limiter holds the peaks at the ceiling (kerf-core places it below the new gain).
      const clipping = limit ? 0 : valid.filter((v, i) => v.peak + gains[i].volumeDb > 0).length;
      const notes = [
        skipped && `${skipped} ohne Ton übersprungen`,
        limited && `${limited} durch die Verstärkungsgrenze (+24 dB) begrenzt`,
        clipping && `Achtung: ${clipping === 1 ? "1 Clip übersteuert" : `${clipping} Clips übersteuern`} (Spitzen über 0 dBFS)`,
      ].filter(Boolean);
      const what = valid.length === 1 ? "1 Clip" : `${valid.length} Clips`;
      (clipping ? toast.error : toast.success)(`${what} auf ${fmtDb(target)} ${unit} normalisiert`, notes.join(" · ") || undefined);
      onClose();
    } catch (e) {
      reportError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Audio normalisieren"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {busy ? "Messe …" : "Normalisieren"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-fg-3">
          {clips.length === 1 ? "1 Audioclip" : `${clips.length} Audioclips`}. Gemessen wird der verwendete Bereich der Quelle (EBU R128); die Clip-Lautstärke wird so gesetzt, dass er den Zielwert erreicht. Lautstärke-Keyframes verschieben sich mit.
        </p>
        <Field label="Messen nach">
          <Segmented value={mode} onChange={setMode} options={NORM_MODES.map((m) => ({ value: m.value, label: m.label }))} />
        </Field>
        <Field label="Zielwert">
          <div className="flex items-center gap-2">
            <NumberField value={target} min={mode === "lufs" ? -40 : -30} max={0} step={0.1} precision={1} unit={` ${unit}`} width={104} label="Zielwert" onCommit={(v) => setTargets({ ...targets, [mode]: v })} />
            {mode === "lufs" &&
              LUFS_PRESETS.map((p) => (
                <Button key={p.value} size="sm" variant={target === p.value ? "primary" : undefined} onClick={() => setTargets({ ...targets, lufs: p.value })}>
                  {p.label}
                </Button>
              ))}
          </div>
        </Field>
        {clips.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <Toggle checked={together} onChange={setTogether} label="Gemeinsam anpassen" />
            <span>Gemeinsam anpassen</span>
            <span className="text-xs text-fg-4">gleiche Änderung für alle, Verhältnis bleibt</span>
          </label>
        )}
        <div className="flex items-center gap-2 text-sm">
          <Toggle checked={limit} onChange={setLimit} label="Limiter anfügen" />
          <span>Limiter anfügen</span>
          {limit && <NumberField value={ceiling} min={-24} max={0} step={0.1} precision={1} unit=" dBFS" width={92} label="Obergrenze" onCommit={setCeiling} />}
        </div>
        <p className="text-xs text-fg-4">
          {limit
            ? "Ein Limiter am Ende der Clipeffekte hält die Spitzen nach der Verstärkung unter der Obergrenze; ein vorhandener Limiter dort wird ersetzt."
            : mode === "lufs"
              ? "Ohne Limiter können laute Spitzen dabei über 0 dBFS steigen – Kerf weist darauf hin."
              : "Ohne Limiter bleibt der Klang unverändert, nur die Lautstärke ändert sich."}
        </p>
      </div>
    </Modal>
  );
}

function ExportLogDialog({ job, title, onClose }: { job: Uuid; title: string; onClose: () => void }) {
  const [log, setLog] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void api.exportLog(job).then(setLog, () => setLog(null));
  }, [job]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(log ?? "");
      toast.success("Protokoll kopiert");
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <Modal
      title={`Export-Protokoll · ${title}`}
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button disabled={!log} onClick={() => void copy()}>
            Kopieren
          </Button>
          <Button variant="primary" onClick={onClose}>
            Schließen
          </Button>
        </>
      }
    >
      {log === undefined ? (
        <p className="text-sm text-fg-3">Lade …</p>
      ) : log === null ? (
        <p className="text-sm text-fg-3">Für diesen Auftrag gibt es (noch) kein Protokoll.</p>
      ) : (
        <pre className="tc max-h-[420px] select-text overflow-auto whitespace-pre-wrap break-all rounded-md bg-ground p-3 text-[11px] leading-4 text-fg-2">{log}</pre>
      )}
    </Modal>
  );
}

function PromptDialog({ dialog, onClose }: { dialog: Extract<Dialog, { kind: "prompt" }>; onClose: () => void }) {
  const [value, setValue] = useState(dialog.value);
  const done = (v: string | null) => {
    onClose();
    dialog.resolve(v);
  };
  return (
    <Modal
      title={dialog.title}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Abbrechen</Button>
          <Button variant="primary" disabled={!value.trim()} onClick={() => done(value)}>
            {dialog.confirm}
          </Button>
        </>
      }
    >
      <Field label={dialog.label}>
        <TextInput autoFocus selectOnFocus value={value} onChange={setValue} onEnter={() => value.trim() && done(value)} />
      </Field>
    </Modal>
  );
}

function SaveWorkspace({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("Mein Arbeitsbereich");
  const ed = useEditor.getState();
  const submit = () => {
    if (!name.trim()) return;
    const id = `custom-${Date.now().toString(36)}`;
    const layout = currentLayout(ed);
    ed.set({ customWorkspaces: [...ed.customWorkspaces, { id, name: name.trim(), base: "edit", layout }], workspace: id });
    onClose();
  };
  return (
    <Modal title="Arbeitsbereich speichern" onClose={onClose} footer={<><Button onClick={onClose}>Abbrechen</Button><Button variant="primary" onClick={submit}>Speichern</Button></>}>
      <Field label="Name">
        <TextInput autoFocus value={name} onChange={setName} onEnter={submit} />
      </Field>
      <p className="mt-2 text-xs text-fg-4">Speichert die aktuelle Panel-Anordnung, Größen und ausgeblendeten Panels.</p>
    </Modal>
  );
}

function UpdateDialog({ onClose }: { onClose: () => void }) {
  const update = pendingUpdate();
  // undefined: not started; null: running, size unknown; 0..1: downloaded part.
  const [progress, setProgress] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  if (!update) return null;
  const busy = progress !== undefined;
  const run = async () => {
    setError(null);
    try {
      if (!(await installUpdate(setProgress))) setProgress(undefined);
    } catch (e) {
      setError(String(e));
      setProgress(undefined);
    }
  };
  const date = update.date ? new Date(update.date.replace(" ", "T").replace(/ .*$/, "")) : null;
  return (
    <Modal
      title="Update verfügbar"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Später
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy}>
            {busy ? "Wird installiert …" : "Jetzt installieren"}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        <div>
          <span className="font-semibold">Kerf {update.version}</span> <span className="text-fg-3">(installiert: {update.currentVersion})</span>
          {date && !Number.isNaN(date.getTime()) && <span className="text-fg-3"> · {date.toLocaleDateString("de-DE")}</span>}
        </div>
        {update.body && <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-sm bg-ground p-2 font-sans text-xs text-fg-2">{update.body}</pre>}
        {busy && <Progress value={progress ?? undefined} indeterminate={progress === null} />}
        {error && <div className="text-xs text-danger">{error}</div>}
        <p className="text-xs text-fg-4">Ungespeicherte Änderungen werden vorher abgefragt. Kerf startet danach neu.</p>
      </div>
    </Modal>
  );
}

function About({ onClose }: { onClose: () => void }) {
  const info = useProject((s) => s.appInfo);
  return (
    <Modal title="Über Kerf" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>OK</Button>}>
      <div className="flex items-start gap-4">
        <Logo size={56} />
        <div className="space-y-1 text-sm">
          <div className="text-base font-semibold">
            Kerf {info?.version}
            <span className="ml-2 font-mono text-xs font-normal text-fg-4" title="Commit, aus dem diese Version gebaut wurde">
              Build {info?.build}
              {info?.debug ? " · Debug" : ""}
            </span>
          </div>
          <div className="text-fg-3">Nicht-linearer Videoschnitt. Rust-Engine, Tauri-Shell, WebGL2-Vorschau.</div>
          <div className="text-xs text-fg-3">
            Freie Software unter der GNU GPL v3 (oder später), ohne Gewährleistung. Quellcode und Drittanbieter-Hinweise:{" "}
            <span className="select-text text-fg-2">github.com/Mitoxe113/Kerf</span>
          </div>
          <div className="pt-2 text-xs text-fg-3">{info?.ffmpeg ?? "FFmpeg nicht gefunden"}</div>
          <div className="text-xs text-fg-3">Hardware-Encoder: {info?.hwEncoders?.length ? info.hwEncoders.join(", ") : "keine"}</div>
          <div className="truncate text-xs text-fg-4" title={info?.cacheDir}>Cache: {info?.cacheDir}</div>
          {info?.logDir && (
            <div className="flex items-center gap-1 text-xs text-fg-4">
              <span className="truncate" title={info.logDir}>Protokoll: {info.logDir}</span>
              <Button size="sm" variant="ghost" onClick={() => void api.revealPath(info.logDir!).catch(reportError)}>
                Anzeigen
              </Button>
            </div>
          )}
          {info?.dataDir && <div className="truncate text-xs text-fg-4" title={info.dataDir}>Daten: {info.dataDir}</div>}
          <div className="pt-1 text-[10.5px] leading-relaxed text-fg-4">Kerf sammelt keine Nutzungsdaten. Was wohin übertragen wird, steht in den Einstellungen unter „Datenschutz“.</div>
        </div>
      </div>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useEditor((s) => s.dialog);
  const project = useProject((s) => s.project);
  const close = () => useEditor.getState().set({ dialog: null });
  if (!dialog) return null;
  switch (dialog.kind) {
    case "newSequence": {
      const base = project?.sequences.find((s) => s.id === project.activeSequence)?.settings ?? { fps: { num: 25, den: 1 }, width: 1920, height: 1080, sampleRate: 48000 };
      return (
        <SequenceForm
          title="Neue Sequenz"
          name={`Sequenz ${String((project?.sequences.length ?? 0) + 1).padStart(2, "0")}`}
          initial={base}
          submitLabel="Erstellen"
          onClose={close}
          onSubmit={async (name, settings) => {
            const d = await edit({ type: "addSequence", name, settings });
            close();
            const id = d?.outcome.created[0];
            if (id) {
              await api.setActiveSequence(id);
              useProject.getState().setActiveSequence(id);
            }
          }}
        />
      );
    }
    case "sequenceSettings": {
      const seq = project?.sequences.find((s) => s.id === dialog.sequence);
      if (!seq) return null;
      return (
        <SequenceForm
          title="Sequenzeinstellungen"
          name={seq.name}
          initial={seq.settings}
          submitLabel="Übernehmen"
          onClose={close}
          onSubmit={async (name, settings) => {
            if (name !== seq.name) await edit({ type: "renameSequence", sequence: seq.id, name });
            if (JSON.stringify(settings) !== JSON.stringify(seq.settings)) await edit({ type: "updateSequenceSettings", sequence: seq.id, settings });
            close();
          }}
        />
      );
    }
    case "shortcuts":
      return <ShortcutEditor onClose={close} />;
    case "macros":
      return <MacrosDialog onClose={close} />;
    case "recovery":
      return <RecoveryDialog onClose={close} />;
    case "versions":
      return <VersionsDialog onClose={close} />;
    case "palette":
      return <CommandPalette initial={dialog.query} onClose={close} />;
    case "preferences":
      return <Preferences onClose={close} />;
    case "exportLog":
      return <ExportLogDialog job={dialog.job} title={dialog.title} onClose={close} />;
    case "normalize":
      return <NormalizeDialog clips={dialog.clips} onClose={close} />;
    case "trackEffects":
      return <TrackEffectsDialog sequence={dialog.sequence} track={dialog.track} onClose={close} />;
    case "multicam":
      return <MulticamDialog media={dialog.media} onClose={close} />;
    case "smartBin":
      return <SmartBinDialog bin={dialog.bin} parent={dialog.parent} onClose={close} />;
    case "watchFolder":
      return <WatchFolderDialog bin={dialog.bin} onClose={close} />;
    case "curve":
      return <CurveDialog sequence={dialog.sequence} clip={dialog.clip} params={dialog.params} at={dialog.at} onClose={close} />;
    case "saveWorkspace":
      return <SaveWorkspace onClose={close} />;
    case "about":
      return <About onClose={close} />;
    case "update":
      return <UpdateDialog onClose={close} />;
    case "prompt":
      return <PromptDialog key={dialog.title} dialog={dialog} onClose={close} />;
    case "confirm": {
      const done = (v: boolean | "discard") => {
        close();
        dialog.resolve(v);
      };
      return (
        <Modal
          title={dialog.title}
          onClose={() => done(false)}
          footer={
            <>
              {dialog.discard && (
                <Button variant="ghost" className="mr-auto" onClick={() => done("discard")}>
                  {dialog.discard}
                </Button>
              )}
              <Button onClick={() => done(false)}>Abbrechen</Button>
              <Button variant={dialog.danger ? "danger" : "primary"} autoFocus onClick={() => done(true)}>
                {dialog.confirm}
              </Button>
            </>
          }
        >
          <p className="text-sm text-fg-2">{dialog.body}</p>
        </Modal>
      );
    }
  }
}
