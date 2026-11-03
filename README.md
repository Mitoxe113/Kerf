# Kerf

Nicht-linearer Videoschnitt für den Desktop. Rust-Engine, Tauri-2-Shell, React-Oberfläche, FFmpeg für Analyse und Export, WebGL2 für die Echtzeit-Vorschau.

> **Stand:** Phase 1–3 und Phase 7 (Professional Polish) sind fertig und getestet: Import, Analyse, Proxys, Mehrspur-Timeline mit allen Profi-Werkzeugen, Quellmonitor mit Dreipunktschnitt, Keyframes für Bewegung, Deckkraft und Lautstärke, Audio normalisieren, Echtzeit-Wiedergabe, Speichern/Laden mit Versionen und Autosave-Wiederherstellung, Export mit Plattform-Vorgaben und Prüfung nach dem Rendern. Was noch fehlt, steht ehrlich in [docs/STATUS.md](docs/STATUS.md), die nächsten Schritte in [docs/ROADMAP.md](docs/ROADMAP.md).

## Voraussetzungen (Windows)

| Werkzeug | Version | Zweck |
| --- | --- | --- |
| Rust (stable, MSVC) | 1.85+ | Engine und Tauri-Shell |
| Node.js | 22+ | Frontend-Build |
| WebView2 | vorinstalliert ab Windows 11 | Laufzeit der Oberfläche |
| FFmpeg + ffprobe | 6+ (getestet mit 9.0.2) | Analyse, Proxys, Export |

FFmpeg wird automatisch gefunden: `KERF_FFMPEG_DIR`, Ordner der `kerf.exe`, `PATH`, WinGet-Installationen, `C:\ffmpeg\bin`. Installation z. B. mit `winget install Gyan.FFmpeg`.

## Entwickeln

```bash
npm install
```

```bash
npm run tauri dev
```

Startet Vite (Port 1420) und die App mit Hot Reload. Änderungen an Rust-Code bauen und starten die App automatisch neu.

## Testen

```bash
cargo test --workspace
```

```bash
npm test
```

```bash
npm run typecheck
```

Die Rust-Tests enthalten einen echten End-to-End-Lauf mit FFmpeg (`crates/kerf-media/tests/pipeline.rs`): Testmedien erzeugen → analysieren → Proxy → schneiden → speichern/laden → rendern → Pixel und Dauer des Ergebnisses prüfen. Ein zweiter Test misst Lautheit und Peaks eines erzeugten Signals. Ohne FFmpeg werden diese Tests übersprungen.

## Release bauen

```bash
npm run tauri build
```

Erzeugt `target/release/kerf.exe` und den Installer unter `target/release/bundle/nsis/`. Der Installer verknüpft `.kerf`-Dateien mit Kerf; ein Doppelklick öffnet das Projekt, auch in einem bereits laufenden Fenster.

## Bedienung in Kürze

**Arbeitsbereiche:** Schnitt, Medien, Farbe, Audio, Export (`Alt+1` … `Alt+5`). Panels lassen sich über die Trennlinien in der Größe ändern und über *Fenster* ein- und ausblenden; eigene Anordnungen können gespeichert werden.

**Werkzeuge:** Auswahl `V` · Rasierklinge `C` · Ripple-Trim `B` · Rollen `N` · Slip `Y` · Slide `U` · Hand `H` · Zoom `Z`

| Aktion | Taste |
| --- | --- |
| Wiedergabe / Pause | `Leertaste` |
| J / K / L (rückwärts, Stopp, vorwärts; mehrfach = schneller) | `J` `K` `L` |
| Frame zurück / vor | `←` `→` (mit `Umschalt` 10 Frames) |
| Vorheriger / nächster Schnittpunkt | `↑` `↓` |
| In / Out setzen | `I` `O` |
| Am Playhead schneiden (alle Spuren) | `Strg+K` (`Strg+Umschalt+K`) |
| Einfügen / Überschreiben aus dem Medienbrowser | `,` `.` |
| Löschen / Löschen und Lücke schließen | `Entf` / `Umschalt+Entf` |
| Marker setzen | `M` |
| Einrasten ein/aus | `S` |
| Herausheben / Extrahieren (In bis Out) | `;` / `'` |
| Match Frame (Quelle am Playhead öffnen) | `F` |
| Standbild einfügen | `Umschalt+N` |
| Clip umbenennen | `F2` |
| Alles ab / vor dem Playhead auswählen | `A` / `Umschalt+A` |
| Zum Clip-Anfang / -Ende | `Umschalt+Pos1` / `Umschalt+Ende` |
| Auswahl einpassen | `Umschalt+Z` |
| Rückgängig / Wiederholen | `Strg+Z` / `Strg+Umschalt+Z` |
| Speichern / Exportieren | `Strg+S` / `Strg+M` |
| Suchen (Befehle, Medien, Clips, Marker, Timecode) | `Strg+P` oder `Strg+F` |
| Befehl ausführen | `Strg+Umschalt+P` |
| Einstellungen | `Strg+,` |

Alle Tastaturbefehle sind unter *Bearbeiten → Tastaturbefehle …* (`Strg+Alt+K`) einsehbar und frei belegbar. Eigene Belegungen lassen sich als Profil speichern und als JSON-Datei austauschen.

**Quellmonitor:** Doppelklick auf ein Medium öffnet es im Tab *Quelle*. Dort In/Out setzen und mit `,` / `.` an den Playhead der Timeline einfügen oder überschreiben (Dreipunktschnitt; ist in der Timeline In/Out gesetzt, gilt deren In-Point).

**Keyframes:** Im Inspector neben Position, Skalierung, Rotation, Deckkraft und Lautstärke auf die Raute klicken. Steht der Playhead auf einem Keyframe, wählt ein Rechtsklick auf die Raute die Interpolation (linear, Ease-In/-Out, Halten). Die Pfeile daneben springen zum vorherigen und nächsten Keyframe.

**Drag & Drop:** Dateien und Ordner aus dem Explorer ins Fenster ziehen importiert sie. Medien aus dem Browser in die Timeline ziehen überschreibt, mit gedrückter `Strg`-Taste wird eingefügt.

## Lizenz

Kerf ist freie Software unter der [GNU General Public License v3.0 oder später](LICENSE) (GPL-3.0-or-later). Du darfst es nutzen, untersuchen, verändern und weitergeben; Weitergaben (auch veränderte) müssen wieder unter der GPL stehen und ihren Quellcode mitliefern.

Kerf bringt kein FFmpeg mit, sondern ruft ein installiertes FFmpeg als eigenes Programm auf; dafür gilt dessen Lizenz. Code und Schriften Dritter sowie der aus FFmpeg abgeleitete Teil der Audio-Vorschau sind in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) aufgeführt.

## Projektstruktur

```
crates/kerf-core     Datenmodell, Zeit/Timecode, Edit-Befehle, Undo, Projektdatei (.kerf)
crates/kerf-media    FFmpeg: Probe, Poster/Filmstreifen/Wellenform, Proxys, Export-Renderer
src-tauri            Tauri-Shell: IPC-Befehle, Worker-Threads, Autosave, Render-Warteschlange
src/engine           Wiedergabe-Engine, WebGL2-Compositor, WebAudio-Mixer
src/timeline         Timeline-Geometrie, Constraints, Canvas-Rendering
src/panels           Medien, Monitor, Timeline, Inspector, Export, Mixer, Scopes
src/shell            Titelleiste, Menüs, Arbeitsbereiche, Dialoge, Statusleiste
src/actions          Aktions-Registry (Menüs, Shortcuts, Toolbars), Tastaturbelegung
fixtures/parity      Gemeinsame Testdaten für Vorschau/Export-Parität (Rust + TS)
docs                 Architektur, Status, Roadmap
```

Details zur Architektur: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
