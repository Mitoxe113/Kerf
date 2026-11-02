# Audit Phase 7 (Ausgangslage)

Stand vor Phase 7, ermittelt am 1. November 2026 durch Code-Durchsicht, Profiling in der laufenden App (CPU-Profiler der WebView2, Prozessspeicher) und einen Lasttest mit 2.008 Clips. Die Maßnahmen aus Phase 7 und deren Messergebnisse stehen in [STATUS.md](STATUS.md).

## 1. Vollständig implementiert (in der App verifiziert)

Import (Dialog, Ordner, OS-Drop), Analyse, automatische Proxys, Medienbrowser mit Ablagen, Mehrspur-Timeline mit acht Werkzeugen, Snapping, verknüpfte Clips, Insert/Overwrite, Ripple-Löschen, Lücke schließen, Marker, In/Out, Undo/Redo, Echtzeit-Wiedergabe mit Audio, J/K/L, Programmmonitor mit direkter Manipulation, Scopes, Inspector (Bewegung, Zuschnitt, Farbe, Audio, Zeit, Blenden), Mixer, Export (H.264/HEVC/ProRes, HW-Encoder, Warteschlange, Abbruch), Speichern/Laden mit `.bak`, Autosave mit Wiederherstellung, Einzelinstanz, Arbeitsbereiche, frei belegbare Tastenkürzel.

## 2. Teilweise implementiert

| Funktion | Lücke |
| --- | --- |
| Spurhöhen | nur global (S/M/L), nicht pro Spur |
| J-/L-Cuts | funktionieren über `Alt`+Trimmen (ignoriert Verknüpfung), aber nirgends erklärt |
| Marker | Name und Farbe, aber kein Kommentar-Editor (Feld `note` existiert im Modell) |
| Geschwindigkeit | konstanter Wert im Inspector; keine Rampen, kein Rückwärts |
| Autosave | festes Intervall von 20 s, keine Projektversionen |
| Export | 6 Vorgaben, keine Plattform-Vorgaben (YouTube/Instagram/TikTok), keine eigenen Vorgaben, keine Prüfung nach dem Rendern, kein Protokoll, keine Speicherplatzprüfung |
| Zuletzt verwendet | im Menü, aber kein Startbildschirm |
| Arbeitsbereiche | Größen speicherbar, Panels nicht andockbar |
| Undo | vollständig, aber ohne History-Panel |

## 3. Fehlende Standardfunktionen

Quellmonitor und Dreipunktschnitt · Lift/Extract · Clip ersetzen · Match Frame · Im Projekt zeigen · Standbild (Freeze Frame) · Clip umbenennen in der Timeline · Clip- und Spurfarben · Auswahl links/rechts vom Playhead · Zoom auf Auswahl · Keyframes · Titel/Untertitel · Übergänge · Effekt-Stapel und LUTs · Audio normalisieren · Lautheitsmessung · Clipping-Anzeige · Command Palette · globale Suche · Einstellungen · Dateizuordnung `.kerf` · Hilfslinien/Raster im Monitor · Anzeige verworfener Frames · verschachtelte Sequenzen · Multicam · Einstellungsebenen

## 4. Fehlerhafte Funktionen

| Befund | Auswirkung |
| --- | --- |
| Playhead scrollt beim Scrubben über den Rand nicht mit | man muss loslassen und scrollen |
| Erste Lineal-Beschriftung wird vom Playhead-Kopf verdeckt | kosmetisch |

Die in Phase 3 gefundenen Fehler sind bereits behoben (siehe STATUS).

## 5. UX-Probleme

- Kein Weg, eine Funktion zu finden, ohne die Menüs zu kennen (keine Command Palette/Suche).
- Speicherzustand nur als Punkt im Titel; keine Zeitangabe „gespeichert vor …“.
- Tastenkürzel-Konflikte werden gelöst, aber nicht exportier-/teilbar.

## 6. Performance (gemessen, Dev-Build, 2.008 Clips)

| Messung | Wert | Ursache (Profiler) |
| --- | --- | --- |
| Kleinste Bearbeitung (1 Clip um 1 Frame) | **69 ms** Median | Engine schickt die **ganze Sequenz** zurück: 895 KB JSON pro Bearbeitung (64,5 ms IPC + Serialisierung, 19 ms UI) |
| Undo | 85 ms | liefert den kompletten Projektzustand |
| Timeline-Frame beim Scrollen | **74 ms** Median | 63 % Leerlauf im JS-Thread → Rasterisierung: pro Clip `save/clip/roundRect/restore`, Filmstreifen und Wellenform auch bei Clips < 1 px |
| Speicher der Undo-Historie | **+68 MB nach 150 Bearbeitungen** | jeder Schritt kopiert alle Sequenzen und Medien vollständig (≈ 450 KB/Schritt) |
| Re-Renders | Timeline, Monitor und Medienbrowser abonnieren den **ganzen** Editor-Store | jede Mausbewegung beim Drag (Ghost-Position) und jedes Scrollen rendert alle drei neu |
| Speichern | 77 ms für 2,1 MB | unkritisch |

## 7. Architekturprobleme

1. **Deltas auf Sequenz-Ebene** (siehe oben) skalieren linear mit der Projektgröße statt mit der Änderung.
2. **Vollkopien in der Historie** skalieren mit Projektgröße × Undo-Tiefe.
3. **Grob-granulare Store-Abonnements** im Frontend.
4. **Export: ein FFmpeg-Eingang pro Clipabschnitt.** Funktioniert, wird bei Hunderten Schnitten aber schwerfällig. Ein Umbau ist erst mit nativer Render-Pipeline sinnvoll (Roadmap Phase 6).
5. **Kein Erweiterungspunkt für Effekte.** Farbe und Bewegung sind fest verdrahtet. Ein Effekt-Stapel braucht einen gemeinsamen Vertrag aus GLSL (Vorschau) und Filtergraph (Export).

---

# Ergebnis nach Phase 7

| Audit-Punkt | Ergebnis |
| --- | --- |
| Deltas auf Sequenz-Ebene (895 KB pro Bearbeitung) | ✅ Delta enthält nur geänderte Clips: 1,9 KB, IPC 5,4 ms |
| Vollkopien in der Historie (+68 MB / 150 Schritte) | ✅ Schnappschüsse teilen unveränderte Sequenzen: +33 MB, 14× schneller |
| Timeline-Frame 74 ms | ✅ Detailstufen und weniger Canvas-Zustandswechsel: 8,3 ms |
| Grobe Store-Abonnements | ✅ Panels abonnieren nur die benötigten Felder (`useShallow`) |
| Spurhöhen nur global | ✅ pro Spur, per Ziehen oder Menü, plus Spurfarben |
| J-/L-Cuts unerklärt | ✅ Hinweis in der Trim-/Roll-Einblendung, reagiert live auf `Alt` |
| Marker ohne Kommentar-Editor | ⬜ offen (Feld `note` existiert, wird von der Suche schon durchsucht) |
| Geschwindigkeit ohne Rampen/Rückwärts | ⬜ offen (Phase 10) |
| Autosave fest 20 s, keine Versionen | ✅ Intervall einstellbar, Versionen mit Wiederherstellen |
| Export ohne Plattform-/eigene Vorgaben, ohne Prüfung, Protokoll, Platzprüfung | ✅ alles umgesetzt, dazu VBR/CBR und Mono |
| Kein Startbildschirm | ✅ mit Formatvorgaben und zuletzt verwendeten Projekten |
| Panels nicht andockbar | ◐ Tab-Gruppen und Fokus; freies Andocken offen |
| Kein History-Panel | ✅ Verlauf-Panel |
| Quellmonitor, Dreipunktschnitt, Lift/Extract, Clip ersetzen, Match Frame, Im Projekt zeigen, Standbild, Umbenennen, Farben, Auswahl ab Playhead, Zoom auf Auswahl | ✅ |
| Keyframes | ✅ Bewegung, Deckkraft, Lautstärke mit Easing, inkl. Export · ⬜ Bezier, Farbe |
| Audio normalisieren, Lautheitsmessung, Clipping-Anzeige | ✅ |
| Command Palette, globale Suche, Einstellungen, Dateizuordnung | ✅ |
| Hilfslinien/Raster, verworfene Frames | ✅ |
| Titel/Untertitel, Übergänge, Effekt-Stapel, LUTs, verschachtelte Sequenzen, Multicam, Einstellungsebenen | ⬜ offen (Phase 8–10) |
| Playhead scrollt beim Scrubben nicht mit | ✅ behoben (Auto-Scroll am Rand) |
| Erste Lineal-Beschriftung unter dem Playhead-Kopf | ✅ behoben |
| Keine Funktion auffindbar ohne Menükenntnis | ✅ Suche/Befehlspalette (`Strg+P`) |
| Speicherzustand nur als Punkt | ✅ Statusleiste mit Uhrzeit des Speicherns und Autosaves |
| Tastenkürzel nicht teilbar | ✅ Profile, JSON-Import/-Export |
| Export: ein FFmpeg-Eingang pro Clipabschnitt | ⬜ unverändert (native Pipeline, Phase 10) |
| Kein Erweiterungspunkt für Effekte | ⬜ offen; Keyframe-System ist als Grundlage für animierbare Effektparameter angelegt |
