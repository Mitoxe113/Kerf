// Single source of truth for user actions. Menus, shortcuts, toolbars and the
// shortcut editor all read from here, so every visible command is wired.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { checkForUpdate } from "./update";
import { toggleOutputWindow } from "../shell/OutputWindow";
import { switchAngle } from "./multicam";
import { engine } from "../engine/playback";
import { PANEL_LABELS, useEditor, WORKSPACES, type PanelId, type ToolId } from "../state/editor";
import { useProject } from "../state/project";
import { LABEL_NAMES, LABELS } from "../lib/labels";
import * as E from "./editing";
import { matchFrame, source, sourceDuration, useSource } from "../state/source";
import * as P from "./project";
import * as T from "./text";
import * as Tr from "./transitions";
import * as Fx from "./effects";

export interface Action {
  id: string;
  label: string;
  group: string;
  keys: string[];
  run: () => void | Promise<unknown>;
  enabled?: () => boolean;
  checked?: () => boolean;
}

const hasSelection = () => useEditor.getState().selection.length > 0;
const hasMediaSelection = () => useEditor.getState().mediaSelection.length > 0;
const ed = () => useEditor.getState();
const toggleGuide = (k: "safe" | "thirds" | "center" | "stats") => ed().set({ guides: { ...ed().guides, [k]: !ed().guides[k] } });
// Monitor shortcuts act on the source monitor while it has focus and media.
const onSource = () => ed().focusedPanel === "source" && !!useSource.getState().media;
// Insert/Overwrite take the source monitor unless the media browser has focus.
const fromSource = () => !!useSource.getState().media && (ed().focusedPanel !== "media" || !hasMediaSelection());
const canPlace = () => hasMediaSelection() || !!useSource.getState().media;

export const TOOLS: { id: ToolId; label: string; key: string; hint: string }[] = [
  { id: "select", label: "Auswahl", key: "V", hint: "Clips wählen, verschieben und trimmen" },
  { id: "razor", label: "Rasierklinge", key: "C", hint: "Klick schneidet, Umschalt+Klick schneidet alle Spuren" },
  { id: "ripple", label: "Ripple-Trim", key: "B", hint: "Kante trimmen und nachfolgende Clips mitziehen" },
  { id: "roll", label: "Rollen", key: "N", hint: "Schnittpunkt zwischen zwei Clips verschieben" },
  { id: "slip", label: "Slip", key: "Y", hint: "Clip-Inhalt verschieben, Position bleibt" },
  { id: "slide", label: "Slide", key: "U", hint: "Clip verschieben, Nachbarn passen sich an" },
  { id: "hand", label: "Hand", key: "H", hint: "Timeline verschieben" },
  { id: "zoom", label: "Zoom", key: "Z", hint: "Klick zoomt hinein, Alt+Klick hinaus" },
];

const base: Action[] = [
  // Datei
  { id: "file.new", group: "Datei", label: "Neues Projekt", keys: ["Ctrl+N"], run: P.newProject },
  { id: "file.open", group: "Datei", label: "Projekt öffnen …", keys: ["Ctrl+O"], run: () => P.openProject() },
  { id: "file.save", group: "Datei", label: "Speichern", keys: ["Ctrl+S"], run: () => P.saveProject() },
  { id: "file.saveAs", group: "Datei", label: "Speichern unter …", keys: ["Ctrl+Shift+S"], run: () => P.saveProject(true) },
  { id: "file.import", group: "Datei", label: "Medien importieren …", keys: ["Ctrl+I"], run: () => P.importMedia() },
  { id: "file.importFolder", group: "Datei", label: "Ordner importieren …", keys: ["Ctrl+Shift+I"], run: () => P.importMedia(undefined, true) },
  { id: "file.export", group: "Datei", label: "Exportieren …", keys: ["Ctrl+M"], run: () => ed().set({ workspace: "export" }) },
  { id: "file.versions", group: "Datei", label: "Versionen …", keys: [], run: () => ed().set({ dialog: { kind: "versions" } }), enabled: () => !!useProject.getState().path },
  { id: "file.recovery", group: "Datei", label: "Wiederherstellung …", keys: [], run: () => ed().set({ dialog: { kind: "recovery" } }) },
  { id: "file.quit", group: "Datei", label: "Beenden", keys: ["Ctrl+Q"], run: P.quit },
  { id: "app.palette", group: "Allgemein", label: "Suchen (Befehle, Medien, Clips, Marker) …", keys: ["Ctrl+P", "Ctrl+F"], run: () => ed().set({ dialog: { kind: "palette", query: "" } }) },
  { id: "app.commands", group: "Allgemein", label: "Befehl ausführen …", keys: ["Ctrl+Shift+P"], run: () => ed().set({ dialog: { kind: "palette", query: ">" } }) },
  { id: "app.start", group: "Allgemein", label: "Startbildschirm", keys: [], run: () => ed().set({ startScreen: true }) },
  { id: "app.preferences", group: "Allgemein", label: "Einstellungen …", keys: ["Ctrl+,"], run: () => ed().set({ dialog: { kind: "preferences" } }) },

  // Bearbeiten
  { id: "edit.undo", group: "Bearbeiten", label: "Rückgängig", keys: ["Ctrl+Z"], run: P.undo, enabled: () => !!useProject.getState().history.undo },
  { id: "edit.redo", group: "Bearbeiten", label: "Wiederholen", keys: ["Ctrl+Shift+Z", "Ctrl+Y"], run: P.redo, enabled: () => !!useProject.getState().history.redo },
  { id: "edit.cut", group: "Bearbeiten", label: "Ausschneiden", keys: ["Ctrl+X"], run: () => E.copySelection(true), enabled: hasSelection },
  { id: "edit.copy", group: "Bearbeiten", label: "Kopieren", keys: ["Ctrl+C"], run: () => E.copySelection(), enabled: hasSelection },
  { id: "edit.paste", group: "Bearbeiten", label: "Einfügen am Playhead", keys: ["Ctrl+V"], run: E.paste, enabled: () => ed().clipboard.length > 0 },
  { id: "edit.duplicate", group: "Bearbeiten", label: "Duplizieren", keys: ["Ctrl+D"], run: E.duplicateSelection, enabled: hasSelection },
  { id: "edit.delete", group: "Bearbeiten", label: "Löschen", keys: ["Delete", "Backspace"], run: () => E.deleteSelection(false), enabled: hasSelection },
  { id: "edit.rippleDelete", group: "Bearbeiten", label: "Löschen und Lücke schließen", keys: ["Shift+Delete", "Shift+Backspace"], run: () => E.deleteSelection(true), enabled: hasSelection },
  { id: "edit.selectAll", group: "Bearbeiten", label: "Alles auswählen", keys: ["Ctrl+A"], run: E.selectAll },
  { id: "edit.deselect", group: "Bearbeiten", label: "Auswahl aufheben", keys: ["Escape"], run: () => ed().select([]) },
  { id: "edit.selectForward", group: "Bearbeiten", label: "Alles ab Playhead auswählen", keys: ["A"], run: () => E.selectFromPlayhead(1) },
  { id: "edit.selectBackward", group: "Bearbeiten", label: "Alles vor dem Playhead auswählen", keys: ["Shift+A"], run: () => E.selectFromPlayhead(-1) },
  { id: "edit.shortcuts", group: "Bearbeiten", label: "Tastaturbefehle …", keys: ["Ctrl+Alt+K"], run: () => ed().set({ dialog: { kind: "shortcuts" } }) },

  // Sequenz
  { id: "seq.new", group: "Sequenz", label: "Neue Sequenz …", keys: ["Ctrl+Alt+N"], run: () => ed().set({ dialog: { kind: "newSequence" } }) },
  {
    id: "seq.settings", group: "Sequenz", label: "Sequenzeinstellungen …", keys: [],
    run: () => { const s = E.seq(); if (s) ed().set({ dialog: { kind: "sequenceSettings", sequence: s.id } }); },
  },
  { id: "seq.razor", group: "Sequenz", label: "Am Playhead schneiden", keys: ["Ctrl+K"], run: () => E.splitAtPlayhead(false) },
  { id: "seq.razorAll", group: "Sequenz", label: "Alle Spuren am Playhead schneiden", keys: ["Ctrl+Shift+K"], run: () => E.splitAtPlayhead(true) },
  { id: "seq.insert", group: "Sequenz", label: "Einfügen (Insert)", keys: [","], run: () => (fromSource() ? source.place("insert") : E.placeMedia(ed().mediaSelection, "insert")), enabled: canPlace },
  { id: "seq.overwrite", group: "Sequenz", label: "Überschreiben (Overwrite)", keys: ["."], run: () => (fromSource() ? source.place("overwrite") : E.placeMedia(ed().mediaSelection, "overwrite")), enabled: canPlace },
  { id: "seq.in", group: "Sequenz", label: "In-Point setzen", keys: ["I"], run: () => (onSource() ? source.setIn() : E.setIn()) },
  { id: "seq.out", group: "Sequenz", label: "Out-Point setzen", keys: ["O"], run: () => (onSource() ? source.setOut() : E.setOut()) },
  { id: "seq.clearInOut", group: "Sequenz", label: "In/Out löschen", keys: ["Ctrl+Shift+X"], run: () => (onSource() ? source.clearMarks() : E.clearInOut()) },
  { id: "seq.lift", group: "Sequenz", label: "Herausheben (In/Out, Lücke bleibt)", keys: [";"], run: () => E.removeInOut(false) },
  { id: "seq.extract", group: "Sequenz", label: "Extrahieren (In/Out, Lücke schließen)", keys: ["'"], run: () => E.removeInOut(true) },
  { id: "seq.marker", group: "Sequenz", label: "Marker setzen", keys: ["M"], run: () => E.addMarker() },
  { id: "seq.nextMarker", group: "Sequenz", label: "Nächster Marker", keys: ["Shift+M"], run: () => E.gotoMarker(1) },
  { id: "seq.prevMarker", group: "Sequenz", label: "Vorheriger Marker", keys: ["Ctrl+Shift+M"], run: () => E.gotoMarker(-1) },
  { id: "seq.addVideo", group: "Sequenz", label: "Videospur hinzufügen", keys: [], run: () => E.addTrack("video") },
  { id: "seq.addAudio", group: "Sequenz", label: "Audiospur hinzufügen", keys: [], run: () => E.addTrack("audio") },
  { id: "seq.addCue", group: "Sequenz", label: "Untertitel am Playhead hinzufügen", keys: ["Ctrl+Shift+T"], run: T.addCue },
  { id: "seq.importSubs", group: "Sequenz", label: "Untertitel importieren (SRT/VTT) …", keys: [], run: T.importSubtitles },
  { id: "seq.exportSubs", group: "Sequenz", label: "Untertitel exportieren (SRT/VTT) …", keys: [], run: T.exportSubtitles, enabled: () => !!E.seq()?.subtitles.cues.length },
  { id: "seq.snap", group: "Sequenz", label: "Magnetisches Einrasten", keys: ["S"], run: () => ed().set({ snapping: !ed().snapping }), checked: () => ed().snapping },
  { id: "seq.linked", group: "Sequenz", label: "Verknüpfte Auswahl", keys: ["Ctrl+Shift+L"], run: () => ed().set({ linkedSelection: !ed().linkedSelection }), checked: () => ed().linkedSelection },

  // Clip
  { id: "clip.enable", group: "Clip", label: "Aktivieren / Deaktivieren", keys: ["Shift+E"], run: E.toggleEnabled, enabled: hasSelection },
  { id: "clip.link", group: "Clip", label: "Verknüpfen", keys: ["Ctrl+L"], run: () => E.linkSelection(true), enabled: hasSelection },
  { id: "clip.unlink", group: "Clip", label: "Verknüpfung lösen", keys: ["Ctrl+Alt+L"], run: () => E.linkSelection(false), enabled: hasSelection },
  { id: "clip.nest", group: "Clip", label: "Verschachteln …", keys: [], run: E.nestSelection, enabled: hasSelection },
  { id: "clip.unnest", group: "Clip", label: "Verschachtelung auflösen", keys: [], run: () => { const c = E.selectedNested(); if (c) void E.unnestClip(c.id); }, enabled: () => !!E.selectedNested() },
  { id: "clip.copyEffects", group: "Clip", label: "Effekte kopieren", keys: ["Ctrl+Alt+C"], run: () => Fx.copyEffects(), enabled: Fx.firstSelectedHasEffects },
  { id: "clip.pasteEffects", group: "Clip", label: "Effekte einfügen", keys: ["Ctrl+Alt+V"], run: () => Fx.pasteEffects(), enabled: () => Fx.hasEffectClipboard() && Fx.selectedVideoClips().length > 0 },
  { id: "clip.bypassEffects", group: "Clip", label: "Alle Effekte umgehen", keys: [], run: () => Fx.toggleBypass(), enabled: () => Fx.selectedVideoClips().length > 0 },
  { id: "view.compareEffects", group: "Ansicht", label: "Vorher/Nachher (ohne Effekte)", keys: ["Ctrl+Alt+B"], run: () => Fx.setCompare(!Fx.useFxCompare.getState().on), checked: () => Fx.useFxCompare.getState().on },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `multicam.angle${n}`, group: "Multicam", label: `Kamera ${n}`, keys: [String(n)], run: () => switchAngle(n - 1) })),
  { id: "clip.nudgeLeft", group: "Clip", label: "1 Frame nach links", keys: ["Alt+ArrowLeft"], run: () => E.nudgeSelection(-1), enabled: hasSelection },
  { id: "clip.nudgeRight", group: "Clip", label: "1 Frame nach rechts", keys: ["Alt+ArrowRight"], run: () => E.nudgeSelection(1), enabled: hasSelection },
  { id: "clip.matchFrame", group: "Clip", label: "Match Frame (Quelle am Playhead öffnen)", keys: ["F"], run: matchFrame },
  { id: "clip.freeze", group: "Clip", label: "Standbild einfügen (2 s)", keys: ["Shift+N"], run: () => E.freezeFrame(2) },
  { id: "clip.title", group: "Clip", label: "Titel einfügen", keys: ["Ctrl+T"], run: T.addTitle },
  { id: "clip.normalize", group: "Clip", label: "Audio normalisieren …", keys: [], run: E.openNormalize, enabled: hasSelection },
  {
    id: "clip.rename", group: "Clip", label: "Umbenennen …", keys: ["F2"],
    // F2 renames whatever the focused panel shows: media in the browser, else clips.
    run: () => (ed().focusedPanel === "media" && ed().mediaSelection.length === 1 ? ed().set({ renameMedia: ed().mediaSelection[0] }) : E.renameSelection()),
    enabled: () => hasSelection() || (ed().focusedPanel === "media" && ed().mediaSelection.length === 1),
  },
  { id: "clip.reveal", group: "Clip", label: "Im Medienbrowser zeigen", keys: [], run: () => E.revealInProject(), enabled: hasSelection },
  ...LABELS.map((l): Action => ({ id: `clip.label.${l}`, group: "Clip", label: `Beschriftung: ${LABEL_NAMES[l]}`, keys: [], run: () => E.labelSelection(l), enabled: hasSelection })),

  // Effekte
  { id: "clip.fades", group: "Effekte", label: "Ein- und Ausblenden (½ s)", keys: ["Ctrl+Alt+F"], run: () => E.applyFades(), enabled: hasSelection },
  { id: "fx.fadeIn", group: "Effekte", label: "Einblenden (½ s)", keys: [], run: () => E.applyFades("in"), enabled: hasSelection },
  { id: "fx.fadeOut", group: "Effekte", label: "Ausblenden (½ s)", keys: [], run: () => E.applyFades("out"), enabled: hasSelection },
  { id: "fx.noFades", group: "Effekte", label: "Blenden entfernen", keys: [], run: () => E.applyFades("none"), enabled: hasSelection },
  { id: "fx.transition", group: "Effekte", label: "Standard-Übergang anwenden", keys: ["Ctrl+Shift+D"], run: Tr.applyDefaultTransitions },
  { id: "fx.noTransitions", group: "Effekte", label: "Übergänge entfernen", keys: [], run: Tr.removeTransitions, enabled: hasSelection },
  { id: "fx.fill", group: "Effekte", label: "Bildfüllend skalieren", keys: [], run: () => E.frameVisuals("fill"), enabled: hasSelection },
  { id: "fx.fit", group: "Effekte", label: "In Bild einpassen", keys: [], run: () => E.frameVisuals("fit"), enabled: hasSelection },
  { id: "fx.resetMotion", group: "Effekte", label: "Bewegung zurücksetzen", keys: [], run: E.resetMotion, enabled: hasSelection },
  { id: "fx.mono", group: "Effekte", label: "Schwarzweiß", keys: [], run: E.monochrome, enabled: hasSelection },
  { id: "fx.resetColor", group: "Effekte", label: "Farbkorrektur zurücksetzen", keys: [], run: E.resetColor, enabled: hasSelection },
  { id: "fx.resetAudio", group: "Effekte", label: "Lautstärke und Pan zurücksetzen", keys: [], run: E.resetAudio, enabled: hasSelection },
  {
    id: "fx.color", group: "Effekte", label: "Farbkorrektur öffnen", keys: [],
    run: () => ed().set({ workspace: "color", inspectorTab: "color" }),
  },

  // Wiedergabe
  { id: "play.toggle", group: "Wiedergabe", label: "Wiedergabe / Pause", keys: ["Space"], run: () => (onSource() ? source.toggle() : engine.toggle()) },
  { id: "play.inOut", group: "Wiedergabe", label: "In bis Out abspielen", keys: ["Ctrl+Shift+Space"], run: E.playInOut },
  { id: "play.forward", group: "Wiedergabe", label: "Vorwärts (mehrfach = schneller)", keys: ["L"], run: () => (onSource() ? source.shuttle(1) : E.shuttle(1)) },
  { id: "play.stop", group: "Wiedergabe", label: "Stopp", keys: ["K"], run: () => (onSource() ? source.pause() : engine.pause()) },
  { id: "play.reverse", group: "Wiedergabe", label: "Rückwärts (mehrfach = schneller)", keys: ["J"], run: () => (onSource() ? source.shuttle(-1) : E.shuttle(-1)) },
  { id: "play.stepBack", group: "Wiedergabe", label: "1 Frame zurück", keys: ["ArrowLeft"], run: () => (onSource() ? source.step(-1) : engine.step(-1)) },
  { id: "play.stepFwd", group: "Wiedergabe", label: "1 Frame vor", keys: ["ArrowRight"], run: () => (onSource() ? source.step(1) : engine.step(1)) },
  { id: "play.stepBack10", group: "Wiedergabe", label: "10 Frames zurück", keys: ["Shift+ArrowLeft"], run: () => (onSource() ? source.step(-10) : engine.step(-10)) },
  { id: "play.stepFwd10", group: "Wiedergabe", label: "10 Frames vor", keys: ["Shift+ArrowRight"], run: () => (onSource() ? source.step(10) : engine.step(10)) },
  { id: "play.prevEdit", group: "Wiedergabe", label: "Vorheriger Schnittpunkt", keys: ["ArrowUp"], run: () => E.gotoEdit(-1) },
  { id: "play.nextEdit", group: "Wiedergabe", label: "Nächster Schnittpunkt", keys: ["ArrowDown"], run: () => E.gotoEdit(1) },
  { id: "play.start", group: "Wiedergabe", label: "Zum Anfang", keys: ["Home"], run: () => (onSource() ? (source.pause(), source.seek(0)) : (engine.pause(), engine.seek(0))) },
  { id: "play.end", group: "Wiedergabe", label: "Zum Ende", keys: ["End"], run: () => (onSource() ? (source.pause(), source.seek(sourceDuration())) : (engine.pause(), engine.seek(Math.max(0, engine.duration - 1)))) },
  { id: "play.gotoIn", group: "Wiedergabe", label: "Zum In-Point", keys: ["Shift+I"], run: () => { if (onSource()) return source.gotoIn(); const s = E.seq(); if (s?.inPoint != null) engine.seek(s.inPoint); } },
  { id: "play.gotoOut", group: "Wiedergabe", label: "Zum Out-Point", keys: ["Shift+O"], run: () => { if (onSource()) return source.gotoOut(); const s = E.seq(); if (s?.outPoint != null) engine.seek(s.outPoint - 1); } },
  { id: "play.clipStart", group: "Wiedergabe", label: "Zum Clip-Anfang", keys: ["Shift+Home"], run: () => E.gotoClipEdge("start") },
  { id: "play.clipEnd", group: "Wiedergabe", label: "Zum Clip-Ende", keys: ["Shift+End"], run: () => E.gotoClipEdge("end") },
  { id: "play.loop", group: "Wiedergabe", label: "Endlosschleife", keys: ["Ctrl+Alt+Space"], run: () => { engine.loop = !engine.loop; }, checked: () => engine.loop },

  // Ansicht
  { id: "view.zoomIn", group: "Ansicht", label: "Timeline vergrößern", keys: ["+", "="], run: () => E.zoomBy(1.5) },
  { id: "view.zoomOut", group: "Ansicht", label: "Timeline verkleinern", keys: ["-"], run: () => E.zoomBy(1 / 1.5) },
  { id: "view.zoomFit", group: "Ansicht", label: "Sequenz einpassen", keys: ["#", "\\"], run: E.zoomToFit },
  { id: "view.zoomSelection", group: "Ansicht", label: "Auswahl einpassen", keys: ["Shift+Z"], run: E.zoomToSelection },
  { id: "view.trackS", group: "Ansicht", label: "Spurhöhe: klein", keys: [], run: () => ed().set({ trackSize: "s" }), checked: () => ed().trackSize === "s" },
  { id: "view.trackM", group: "Ansicht", label: "Spurhöhe: mittel", keys: [], run: () => ed().set({ trackSize: "m" }), checked: () => ed().trackSize === "m" },
  { id: "view.trackL", group: "Ansicht", label: "Spurhöhe: groß", keys: [], run: () => ed().set({ trackSize: "l" }), checked: () => ed().trackSize === "l" },
  { id: "view.proxies", group: "Ansicht", label: "Proxys für Vorschau verwenden", keys: ["Ctrl+Alt+P"], run: () => ed().set({ useProxies: !ed().useProxies }), checked: () => ed().useProxies },
  { id: "view.safe", group: "Ansicht", label: "Sichere Bereiche", keys: ["Ctrl+'"], run: () => toggleGuide("safe"), checked: () => ed().guides.safe },
  { id: "view.thirds", group: "Ansicht", label: "Drittel-Raster", keys: [], run: () => toggleGuide("thirds"), checked: () => ed().guides.thirds },
  { id: "view.center", group: "Ansicht", label: "Mittelkreuz", keys: [], run: () => toggleGuide("center"), checked: () => ed().guides.center },
  { id: "view.stats", group: "Ansicht", label: "Wiedergabe-Statistik", keys: [], run: () => toggleGuide("stats"), checked: () => ed().guides.stats },
  {
    id: "view.fullscreen", group: "Ansicht", label: "Vorschau im Vollbild", keys: ["Shift+F"],
    run: async () => { const on = !ed().fullscreen; ed().set({ fullscreen: on }); await getCurrentWindow().setFullscreen(on).catch(() => undefined); },
    checked: () => ed().fullscreen,
  },

  // Fenster
  { id: "win.output", group: "Fenster", label: "Programmausgabe in eigenem Fenster", keys: [], run: toggleOutputWindow, checked: () => ed().outputWindow },
  { id: "win.reset", group: "Fenster", label: "Arbeitsbereich zurücksetzen", keys: [], run: () => ed().resetWorkspace() },
  { id: "win.save", group: "Fenster", label: "Arbeitsbereich speichern unter …", keys: [], run: () => ed().set({ dialog: { kind: "saveWorkspace" } }) },

  // Hilfe
  { id: "help.update", group: "Hilfe", label: "Nach Updates suchen …", keys: [], run: () => checkForUpdate(false) },
  { id: "help.about", group: "Hilfe", label: "Über Kerf", keys: [], run: () => ed().set({ dialog: { kind: "about" } }) },
];

const tools: Action[] = TOOLS.map((t) => ({
  id: `tool.${t.id}`,
  group: "Werkzeuge",
  label: t.label,
  keys: [t.key],
  run: () => ed().setTool(t.id),
  checked: () => ed().tool === t.id,
}));

const workspaces: Action[] = WORKSPACES.map((w, i) => ({
  id: `ws.${w.id}`,
  group: "Fenster",
  label: `Arbeitsbereich: ${w.label}`,
  keys: [`Alt+${i + 1}`],
  run: () => ed().set({ workspace: w.id }),
  checked: () => ed().workspace === w.id,
}));

const panels: Action[] = (Object.keys(PANEL_LABELS) as PanelId[]).map((p) => ({
  id: `panel.${p}`,
  group: "Fenster",
  label: `Panel: ${PANEL_LABELS[p]}`,
  keys: [],
  run: () => ed().focusPanel(p),
}));

export const ACTIONS: Action[] = [...base, ...tools, ...workspaces, ...panels];
export const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export function runAction(id: string) {
  const a = ACTION_BY_ID.get(id);
  if (!a || (a.enabled && !a.enabled())) return;
  void a.run();
}
