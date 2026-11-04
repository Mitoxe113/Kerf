// Noise reduction of audio clips (kerf-core Denoise, FFmpeg afftdn). The
// denoised sound is rendered into the media cache once per setting; the
// preview plays it as soon as it exists (until then the original) and the
// export reads the same file.

import { useEffect, useReducer, useState } from "react";
import { engine } from "../engine/playback";
import { api } from "../lib/ipc";
import type { Clip, ClipPatch, Denoise, Sequence } from "../lib/types";
import { DEFAULT_DENOISE, learnRange } from "../lib/denoise";
import { reportError } from "../state/project";
import { toast } from "../state/toasts";
import { Button, Field, Section, Toggle } from "../ui/primitives";
import { ParamRow } from "./Effects";

export function DenoiseSection({ seq, clips, commit }: { seq: Sequence; clips: Clip[]; commit: (targets: Clip[], patch: ClipPatch) => Promise<void> }) {
  const c = clips[0];
  const d = c.denoise ?? null;
  // Values while a slider is held: the sound is rendered only for released values.
  const [held, setHeld] = useState<Partial<Denoise>>({});
  const [learning, setLearning] = useState(false);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    engine.onDenoiseState = refresh;
    return () => {
      if (engine.onDenoiseState === refresh) engine.onDenoiseState = null;
    };
  }, []);
  const shown: Denoise = { ...(d ?? { ...DEFAULT_DENOISE, enabled: false }), ...held };
  const put = (p: Partial<Denoise>, live = false) => {
    if (live) {
      setHeld((h) => ({ ...h, ...p }));
      return;
    }
    setHeld({});
    const next: Denoise = { ...(d ?? DEFAULT_DENOISE), ...p };
    void commit(clips, { denoise: next });
  };
  const state = d?.enabled ? engine.denoiseState(c.mediaId, d) : null;
  const range = learnRange(seq, c);
  const learn = async () => {
    if (!range) return;
    setLearning(true);
    try {
      const profile = await api.denoiseProfile(c.mediaId, range[0], range[1]);
      put({ profile, enabled: true });
      const secs = range[1] - range[0];
      toast.success("Rauschprofil gelernt", `Aus ${secs >= 10 ? Math.round(secs) : secs.toFixed(1).replace(".", ",")} s des Mediums.`);
    } catch (e) {
      reportError(e);
    } finally {
      setLearning(false);
    }
  };
  const learned = (shown.profile?.length ?? 0) > 0;
  return (
    <Section title="Rauschunterdrückung" right={<Toggle checked={!!d?.enabled} onChange={(v) => put({ enabled: v })} label="Rauschunterdrückung aktiv" />}>
      <div className={shown.enabled ? "" : "opacity-60"}>
        <ParamRow label="Stärke" value={shown.reductionDb} min={1} max={40} step={0.5} precision={1} unit=" dB" onChange={(v, l) => put({ reductionDb: v }, l)} />
        <ParamRow label="Rauschpegel" value={shown.floorDb} min={-80} max={-20} step={1} precision={0} unit=" dB" onChange={(v, l) => put({ floorDb: v }, l)} />
        <Field label="Nachführen">
          <Toggle checked={shown.track} onChange={(v) => put({ track: v })} label="Rauschpegel nachführen" />
          <span className="text-[10.5px] text-fg-4">folgt einem sich ändernden Rauschen</span>
        </Field>
        <Field label="Profil">
          <span className="min-w-0 flex-1 truncate text-xs text-fg-2">{learned ? "Gelernt" : "Weißes Rauschen"}</span>
          <Button size="sm" disabled={!range || learning || clips.length > 1} title={range ? "Lernt die Form des Rauschens aus dem Bereich zwischen In- und Out-Punkt" : "In- und Out-Punkt auf eine Stelle dieses Clips setzen, an der nur Rauschen zu hören ist"} onClick={() => void learn()}>
            {learning ? "Lernt …" : "Aus In/Out lernen"}
          </Button>
          {learned && (
            <Button size="sm" onClick={() => put({ profile: [] })}>
              Zurücksetzen
            </Button>
          )}
        </Field>
      </div>
      <p className="pt-1 text-[10.5px] leading-relaxed text-fg-4">
        {state === "pending"
          ? "Wird berechnet … bis dahin spielt die Vorschau den Originalton."
          : state === "failed"
            ? "Die Berechnung ist fehlgeschlagen; die Vorschau spielt den Originalton."
            : state === "ready"
              ? "Vorschau und Export verwenden denselben entrauschten Ton (FFmpeg afftdn, im Cache)."
              : "Wirkt vor Kanalzuordnung, Effekten und Lautstärke. Der entrauschte Ton wird einmal je Einstellung berechnet und im Cache gespeichert."}
      </p>
      {clips.length > 1 && <p className="pt-1 text-[10.5px] text-fg-4">Änderungen gelten für alle {clips.length} ausgewählten Clips.</p>}
    </Section>
  );
}
