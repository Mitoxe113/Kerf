# Architektur

Kerf trennt strikt zwischen **Engine** (Rust) und **Oberfläche** (React). Die Engine besitzt das Dokument, und jede Änderung läuft als typisierter Befehl durch sie. Die Oberfläche hält nur einen Spiegel des Zustands, zeigt ihn an und sendet Befehle.

```
┌────────────────────────── WebView2 (React + TypeScript) ───────────────────────────┐
│  Panels ─ Aktions-Registry ─ Zustand-Stores (Spiegel)                              │
│     │                                   ▲                                          │
│     │ edit(cmd) FIFO                    │ Delta / Events                           │
│  Wiedergabe-Engine: AudioContext-Uhr → <video>/<audio>-Pool → WebGL2 + WebAudio    │
└─────┼───────────────────────────────────┼──────────────────────────────────────────┘
      ▼ Tauri IPC                         │
┌──── src-tauri ────────────────────────────────────────────────────────────────────┐
│  commands.rs   Session (Projekt + History + Pfad + Revision) hinter einem Mutex   │
│  media_jobs    3 Analyse-Worker, 1 Proxy-Worker   ──► Event "media-updated"       │
│  export_jobs   Render-Warteschlange (1 Worker), Protokoll, Prüfung nach Render    │
│  recovery      Autosave (Intervall einstellbar) ──► Event "autosaved"             │
│  versions      Projektversionen bei jedem Speichern                               │
└─────┬───────────────────────────────┬─────────────────────────────────────────────┘
      ▼                               ▼
  kerf-core (rein, ohne I/O-Abh.)   kerf-media (FFmpeg als externer Prozess)
```

## kerf-core

- **Zeit:** Alles Zeitliche ist ein ganzzahliger Frame (`i64`) in der Bildrate der Sequenz. Bildraten sind exakte Brüche (`Rational`, z. B. 30000/1001), Timecode inklusive Drop-Frame. Fließkomma kommt nur an den Rändern vor (Sekunden für FFmpeg und die Medienelemente).
- **Modell:** `Project → MediaAsset[] / Bin[] / Sequence[] → Track[] → Clip[]`. Clips einer Spur sind sortiert und überlappungsfrei. Diese Invariante sichert `apply` nach jedem Befehl.
- **Befehle:** `EditCommand` ist ein serde-getaggtes Enum (Import, Platzieren mit Insert/Overwrite, Verschieben, Trim mit Ripple, Roll, Slip, Slide, Split, Löschen mit Ripple, Lücke schließen, Einfügen, Duplizieren, Clip-Eigenschaften, Verknüpfen, Marker, In/Out, Sequenz- und Spurverwaltung). `apply` ist atomar: Bei einem Fehler bleibt das Projekt unverändert.
- **Interaktive Kanten werden geklemmt, nicht abgelehnt:** Ein Trim über das Quellmaterial hinaus endet an der Mediengrenze, so wie es Cutter erwarten. Die Timeline spiegelt dieselben Grenzen lokal (`src/timeline/geometry.ts`), damit die Vorschau beim Ziehen genau dort stoppt, wo die Engine stoppen wird.
- **Undo:** Snapshot-basiert (Medien, Bins, Sequenzen, aktive Sequenz; maximal 200 Schritte). Unveränderte Spuren, Medien und Ablagen werden zwischen aufeinanderfolgenden Schnappschüssen per `Arc` geteilt, der Speicher wächst also mit der Änderung, nicht mit der Projektgröße. Hintergrundergebnisse wie Analyse und Proxys werden per `patch_media` in alle Snapshots übernommen, damit ein Undo sie nicht zurückdreht. `History::diff` vergleicht den Stand vor und nach einem Schritt und liefert ein `ProjectDiff` (nur geänderte Clips, Spuren, Medien, Ablagen).
- **Keyframes:** `Clip.keys` ordnet animierbaren Eigenschaften (`Param`: X, Y, Skalierung, Rotation, Deckkraft, Lautstärke) sortierte Keyframes zu. `at` ist eine **Quellposition** (Frames bei Geschwindigkeit 1), damit Trimmen und Teilen die Animation nicht verschieben. Interpolation über `Ease` (linear, Ease-In `u²`, Ease-Out `u(2−u)`, Ease-In-Out `u²(3−2u)`, Halten), identisch in `model.rs`, `src/lib/keys.ts` und den FFmpeg-Ausdrücken des Exports. `SetKeyframes` prüft, dass Lautstärke nur auf Audio- und Bildparameter nur auf Videoclips liegen.
- **Projektdatei:** JSON (`.kerf`) mit `schemaVersion` und Migrations-Hook. Das Schreiben ist atomar (temporäre Datei, dann Umbenennen). Die vorherige Fassung bleibt als `.bak` erhalten und wird beim Laden automatisch genutzt, wenn die Hauptdatei beschädigt ist.

## kerf-media

- **Werkzeugsuche** wie im README beschrieben. Alle Prozesse starten ohne Konsolenfenster (`CREATE_NO_WINDOW`).
- **Analyse** pro Datei: ffprobe → Typ, Codec, Auflösung, Bildrate (VFR wird auf Standardraten gerastert), Rotation, Audio. Anschließend werden ein Poster, ein Filmstreifen-Sprite und Wellenform-Spitzen (u8, 100/s) erzeugt. Der Cache-Ordner ergibt sich aus einem Fingerprint aus Pfad, Größe und Änderungszeit; eine geänderte Datei bekommt damit automatisch neue Ableitungen.
- **Proxys:** H.264 720p mit kurzer GOP (schnelles Scrubbing). Sie entstehen **automatisch**, wenn die WebView das Original nicht dekodieren kann (HEVC, ProRes, 10-Bit, PCM in MOV, …), und auf Wunsch für jede Datei.
- **Lautheit:** `analysis::loudness` misst einen Quellbereich mit `ebur128` (integriert, LRA, Sample- und True Peak) und liest die Zusammenfassung aus dem FFmpeg-Log. Genutzt für das Normalisieren (`measure_clips`, bis zu vier Messungen parallel, ohne Sitzungs-Sperre) und die Prüfung nach dem Rendern.
- **Export:** Die Timeline wird in **einen** FFmpeg-Filtergraphen übersetzt. Grundlage ist eine schwarze RGBA-Fläche, darauf folgt pro sichtbarem Clipabschnitt ein Overlay mit Zuschnitt → Einpassen → Skalieren/Drehen um den Ankerpunkt → Farbmatrix → Kontrast → Deckkraft/Blenden, aktiv nur im eigenen Zeitfenster. Audio pro Clip: Tempo, Lautstärke, Pan, Blenden, Versatz → `amix`. Animierte Geometrie läuft über `perspective` mit Eckpunkt-Ausdrücken über die Frame-Nummer (auf einer transparent erweiterten, auf Sequenzgröße skalierten Ebene), animierte Deckkraft über `sendcmd` an einen benannten `colorchannelmixer`, animierte Lautstärke über einen `volume`-Ausdruck mit `eval=frame`. Weicht das Ausgabeformat vom Seitenverhältnis der Sequenz ab, wird auf der Sequenzfläche mit Balken aufgefüllt und erst dann skaliert, damit die BT.709-Umrechnung in genau einem Skalierer passiert. Ausgabe nach BT.709 TV-Range in eine `.partial`-Datei, die erst nach Erfolg umbenannt wird. Ein Abbruch hinterlässt keine Dateien. Ratensteuerung: CRF/CQ, VBR (Spitzen bis 1,5×) oder CBR (`minrate = maxrate = bufsize`, bei x264 zusätzlich `nal-hrd=cbr`).
- **Prüfung nach dem Rendern:** Der Export-Worker analysiert die fertige Datei erneut (Probe + Lautheit) und hängt das Ergebnis als `qc` an den Auftrag. Das Frontend vergleicht es mit den Sollwerten (Dauer, Auflösung, Bildrate, Kanäle) und warnt bei True Peak über −1 dBTP. Jeder Lauf behält sein Protokoll (Befehlszeile, Filtergraph, FFmpeg-Warnungen, max. 400 Zeilen) und seinen Plan, damit er wiederholt werden kann. Hardware-Encoder (NVENC/QSV/AMF) werden mit einer echten 1-Frame-Testkodierung erkannt, nicht nur über die Encoder-Liste.

## Vorschau = Export

Die Echtzeit-Vorschau nutzt den Hardware-Decoder der WebView: pro Clip ein gepooltes `<video>`-Element über das Tauri-Asset-Protokoll (mit Range- und CORS-Unterstützung). Die Frames werden als Texturen in einen WebGL2-Compositor geladen. Der Compositor rechnet **dieselbe** Geometrie und Farbmathematik wie der Export-Filtergraph:

- `src/engine/math.ts` ⇔ `ColorAdjust::matrix` / Platzierung in `render.rs`
- Ein gemeinsamer Fixture-Test (`fixtures/parity/color.json`) wird von Rust **und** TypeScript gegen beide Implementierungen geprüft.
- In der App wurden Monitorbild und exportierter Frame bei denselben Timecodes verglichen: Die Geometrie ist deckungsgleich. Der verbleibende Farbunterschied stammt nur aus dem Dekodieren von Material ohne Farbraum-Tag (siehe STATUS).

Die Wiedergabe läuft auf der Uhr des `AudioContext`. Videoelemente werden nachgeführt: Ab 0,12 s Abweichung springen sie hart auf die richtige Stelle, ab 0,02 s wird die Abspielrate sanft angepasst. Elemente der nächsten Clips werden 1,2 s vorher vorbereitet. Beim Scrubben im Pausezustand werden Seeks zusammengefasst und framegenau ausgeführt. Rückwärts- und schnelle J/K/L-Wiedergabe erfolgt über Seeks.

Audio: Clip-Gain → Pan → Spur-Bus (Lautstärke, Mute, Solo) → Master → Analyser für die Pegelanzeigen.

## IPC und Reihenfolge

- Dokumentänderungen laufen durch eine **FIFO-Warteschlange** (`src/lib/ipc.ts`). Sie erreichen die Engine deshalb in der Reihenfolge, in der der Nutzer sie ausgelöst hat. Die Antwort ist ein **Delta** mit dem `ProjectDiff` des Schritts: geänderte und entfernte Clips pro Spur, geänderte Spuren und Sequenz-Metadaten, und nur bei Bedarf Medien, Ablagen oder die Sequenzliste. Bei 2.008 Clips sind das rund 2 KB statt 895 KB. Undo und Redo liefern ebenfalls Deltas.
- Lesende Abfragen, die den aktuellen Stand brauchen (z. B. `measure_clips`), warten, bis die Warteschlange leer ist, blockieren sie aber nicht.
- Ereignisse aus Hintergrund-Workern (z. B. „Analyse fertig“) können die Antwort des auslösenden Befehls überholen. Diese Antwort trägt dann einen älteren Stand. Deshalb wendet das Frontend Medien-Ereignisse erst an, wenn keine Befehle mehr ausstehen (`whenIdle`). Gefunden wurde dieser Fehler im End-to-End-Test: Neue Medien blieben auf „Analyse …“ stehen.

## Oberfläche

- **Aktions-Registry** (`src/actions/registry.ts`): Jede Aktion steht dort genau einmal, mit Label, Gruppe, Standard-Tasten und Zuständen (aktiviert, abgehakt). Menüs, Tastatur, Toolbars und der Tastaturbefehle-Editor lesen alle aus dieser Liste. Dadurch gibt es keinen Menüpunkt ohne Funktion.
- **Arbeitsbereiche** sind Layout-Bäume (Zeilen und Spalten mit Größenanteilen und ausgeblendeten Panels) und werden lokal gespeichert. Jedes Panel hat eine eigene Error-Boundary.
- **Timeline:** zwei Canvas-Ebenen. Die Basisebene enthält Spuren, Clips, Filmstreifen und Wellenformen und wird nur bei Änderungen neu gezeichnet. Die Overlay-Ebene enthält Playhead, Drag-Vorschauen und Snap-Linie. Nur der sichtbare Bereich wird gezeichnet.
- **Panel-Gruppen:** Ein Blatt des Layout-Baums kann mehrere Panels als Tabs halten (z. B. Medien | Quelle). `focusedPanel` wird beim Zeigerdruck gesetzt und entscheidet, ob Transporttasten den Programm- oder den Quellmonitor steuern und was `F2` umbenennt.
- **Suche und Befehle** (`src/shell/CommandPalette.tsx`): durchsucht die Aktions-Registry, Medien, Clips, Marker und Sequenzen mit einer unscharfen Suche (`src/lib/fuzzy.ts`) und erkennt Timecodes. Weil die Liste direkt aus der Registry kommt, ist jede neue Aktion automatisch auffindbar.
- **Tastaturprofile** (`src/actions/keymap.ts`): Überschreibungen der Standardbelegung, als benannte Profile lokal gespeichert und als JSON (`app: "kerf", kind: "keymap"`) austauschbar.
- **Startbildschirm und Dateizuordnung:** Der Installer registriert `.kerf`. Der erste Start liest die Datei aus den Argumenten (`take_launch_file`); bei laufender Instanz leitet das Single-Instance-Plugin die Argumente weiter, die App sendet `open-project` an das Fenster. Unter macOS ist der Weg über `RunEvent::Opened` vorbereitet.
- **Drag & Drop innerhalb der App** basiert auf Pointer-Ereignissen. Grund: Das HTML5-DnD-API ist unter Windows nicht nutzbar, solange das Fenster Dateien aus dem Explorer annimmt.

## Threads

| Thread | Aufgabe |
| --- | --- |
| Tauri-Hauptthread | Fenster, IPC-Dispatch |
| `kerf-analysis-0..2` | ffprobe, Poster, Filmstreifen, Wellenform |
| `kerf-proxy` | Proxy-Transkodierung (abbrechbar, mit Fortschritt) |
| Export-Worker | eine Renderaufgabe gleichzeitig, Fortschritt über `-progress pipe:1` |
| Autosave | prüft jede Sekunde, sichert nach dem eingestellten Intervall, nur wenn sich etwas geändert hat |
| Lautheitsmessung | bis zu vier FFmpeg-Prozesse gleichzeitig (Normalisieren), kurzlebig |
