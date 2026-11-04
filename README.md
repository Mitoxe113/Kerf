# Kerf

Nicht-linearer Videoschnitt für den Desktop. Rust-Engine, Tauri-2-Shell, React-Oberfläche, FFmpeg für Analyse und Export, WebGL2 für die Echtzeit-Vorschau.

> **Stand:** Phase 1–3 und 7–10 sind fertig und getestet: Mehrspur-Timeline mit allen Profi-Werkzeugen, Quellmonitor, Keyframes mit Bezier-Kurven, Effekt-Stapel mit LUTs, Chroma-Key, Farbrädern und Kurven, Titel und Untertitel (SRT/VTT), Übergänge, Audio-Effekte und Lautheit, Geschwindigkeitsrampen und Rückwärts-Clips, verschachtelte Sequenzen, Multicam, andockbare Panels, Programmausgabe auf einem zweiten Bildschirm, segmentierter Export, automatische Updates. Die CI baut und testet unter Windows. Was noch fehlt, steht ehrlich in [docs/STATUS.md](docs/STATUS.md), die nächsten Schritte in [docs/ROADMAP.md](docs/ROADMAP.md).

## Installieren

Kerf gibt es für **Windows (64 Bit)**. Den Installer (`Kerf_<Version>_x64-setup.exe`) gibt es unter [Releases](https://github.com/Mitoxe113/Kerf/releases). Danach sucht Kerf selbst nach Updates (abschaltbar in den Einstellungen); ein Update wird nur installiert, wenn seine Signatur zum in Kerf hinterlegten öffentlichen Schlüssel passt.

Kerf braucht ein installiertes **FFmpeg 7 oder neuer**, unter Windows z. B. `winget install Gyan.FFmpeg`. Die Statusleiste zeigt an, ob Kerf FFmpeg gefunden hat und ob die Version reicht.

Ist der Installer nicht mit einem Code-Signing-Zertifikat signiert, zeigt Windows beim ersten Start einen SmartScreen-Hinweis (*Weitere Informationen › Trotzdem ausführen*).

**macOS und Linux** werden nicht gebaut und nicht getestet. Der Quellcode enthält noch die Konfiguration dafür; ein Test unter Linux (WebKitGTK 2.52) ergab, dass der Programmmonitor Videos über Tauris `asset:`-Protokoll nicht abspielt (GStreamer meldet `FormatError`), auch mit installiertem `gstreamer1.0-libav`.

## Voraussetzungen zum Entwickeln

| Werkzeug | Version | Zweck |
| --- | --- | --- |
| Rust (stable, MSVC) | 1.85+ | Engine und Tauri-Shell |
| Node.js | 22+ | Frontend-Build |
| WebView | Windows: WebView2 (ab Windows 11 vorinstalliert), macOS: WKWebView, Linux: WebKitGTK 4.1 | Laufzeit der Oberfläche |
| FFmpeg + ffprobe | 7+ (getestet mit 9.0.2) | Analyse, Proxys, Export |

Unter Linux braucht der Build zusätzlich `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf` (Debian/Ubuntu).

FFmpeg wird automatisch gefunden: `KERF_FFMPEG_DIR`, Ordner der Programmdatei, `PATH`, unter Windows WinGet-Installationen und `C:\ffmpeg\bin`, unter macOS/Linux `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.

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

Die Rust-Tests enthalten 20 echte Läufe mit FFmpeg (`crates/kerf-media/tests/pipeline.rs`): Testmedien erzeugen → analysieren → schneiden → rendern → Pixel, Ton und Dauer des Ergebnisses prüfen, für Keyframes, Effekte (auch animiert und mit Freiform-Masken), Übergänge, Untertitel, Audio-Effekte, Rauschunterdrückung, Rampen, verschachtelte Sequenzen, Multicam und den segmentierten Export. Ohne FFmpeg werden sie übersprungen; mit `KERF_REQUIRE_FFMPEG=1` (so in der CI) schlagen sie stattdessen fehl.

Die [CI](.github/workflows/ci.yml) führt bei jedem Push alles unter Windows aus und baut den unsignierten Installer als Artefakt.

## Release bauen

```bash
npm run tauri build
```

Erzeugt das Programm und die Installer unter `target/release/bundle/`. Der Installer verknüpft `.kerf`-Dateien mit Kerf; ein Doppelklick öffnet das Projekt, auch in einem bereits laufenden Fenster.

Weil die Update-Pakete signiert werden, braucht `tauri build` den Updater-Schlüssel (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Ohne ihn baut man mit `npm run tauri build -- --config src-tauri/tauri.unsigned.conf.json`.

**Veröffentlichen:** Version in `src-tauri/tauri.conf.json`, `Cargo.toml` und `package.json` erhöhen, committen, Tag `v<Version>` pushen. Der [Release-Workflow](.github/workflows/release.yml) baut den Windows-Installer samt `latest.json` und veröffentlicht das Release, sobald der Build gelungen ist; ab dann ist es das Update für alle installierten Kerfs. Das Update-Paket und `latest.json` entstehen nur mit den Secrets `TAURI_SIGNING_PRIVATE_KEY` und `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (unter *Settings › Secrets and variables › Actions*); fehlen sie, enthält das Release nur den Installer, der Lauf warnt, und die Release-Notizen sagen es. Ein Code-Signing-Zertifikat für Windows ist optional (`WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`). Ein manueller Lauf des Workflows erzeugt einen Entwurf; mit der Option *publish* veröffentlicht er ihn und legt dabei das Tag `v<Version>` auf dem gebauten Commit an.

> Den Updater-Schlüssel und sein Passwort sicher aufbewahren: Ohne sie lassen sich keine Updates mehr für bereits installierte Kopien ausliefern.

## Bedienung in Kürze

**Arbeitsbereiche:** Schnitt, Medien, Farbe, Audio, Export (`Alt+1` … `Alt+5`). Panels lassen sich über die Trennlinien in der Größe ändern, über *Fenster* ein- und ausblenden und am Tab oder an der Titelzeile an eine andere Stelle ziehen (in einen Bereich als Tab, an einen Rand als neuer Bereich). Eigene Anordnungen können gespeichert werden. *Fenster › Programmausgabe in eigenem Fenster* zeigt das Programmbild in einem eigenen Fenster, z. B. im Vollbild (`F` oder Doppelklick) auf einem zweiten Bildschirm.

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
| Standard-Übergang an den Schnitten der Auswahl | `Strg+Umschalt+D` |
| Multicam: Kamera ab Playhead wechseln | `1` … `9` |
| Einstellungen | `Strg+,` |

Alle Tastaturbefehle sind unter *Bearbeiten → Tastaturbefehle …* (`Strg+Alt+K`) einsehbar und frei belegbar. Eigene Belegungen lassen sich als Profil speichern und als JSON-Datei austauschen.

**Quellmonitor:** Doppelklick auf ein Medium öffnet es im Tab *Quelle*. Dort In/Out setzen und mit `,` / `.` an den Playhead der Timeline einfügen oder überschreiben (Dreipunktschnitt; ist in der Timeline In/Out gesetzt, gilt deren In-Point).

**Keyframes:** Im Inspector neben einer animierbaren Eigenschaft (Bewegung, Deckkraft, Lautstärke, Geschwindigkeit, Farbkorrektur) auf die Raute klicken. Steht der Playhead auf einem Keyframe, wählt ein Rechtsklick auf die Raute die Interpolation (linear, Ease-In/-Out, Halten oder eine eigene Kurve im Kurveneditor). Die Pfeile daneben springen zum vorherigen und nächsten Keyframe. Über das Rechtsklick-Menü der Raute lässt sich ein Keyframe kopieren und am Playhead einfügen, auch in einem anderen Clip.

**Effekte animieren:** Im Inspector (Tab *Effekte*) haben animierbare Parameter eine Stoppuhr. Ein Klick darauf setzt einen Keyframe am Playhead; danach setzt jede Änderung einen Keyframe dort, die Raute fügt einen hinzu oder entfernt ihn, Rechtsklick auf die Raute wählt die Interpolation.

**Intelligente Ablagen und Metadaten:** Der Knopf mit der Lupe im Medienbrowser legt eine intelligente Ablage an, die alle Medien nach Regeln (Typ, Text, Tags, Farbe, Favorit, Verwendung, offline) zeigt. Rechtsklick auf ein Medium › *Metadaten bearbeiten* öffnet Tags, Notiz, Farbe und Favorit, auch für mehrere Medien, und für Videos die Farbmatrix (Automatisch, BT.601, BT.709), die in Vorschau und Export gilt. *Ordner überwachen …* importiert neue Dateien eines Ordners automatisch, solange das Projekt offen ist.

**Freiform-Maske:** Effekt *Freiform-Maske* (Kategorie Keying und Masken) auf einen Clip legen, *Im Monitor bearbeiten* wählen und bei ausgewähltem Clip die Punkte im Programmmonitor ziehen. Doppelklick auf eine Kante fügt einen Punkt ein, Rechtsklick auf einen Punkt entfernt ihn. Weiche Kante, Umkehren und ein animierbarer Versatz stehen im Inspector.

**Rauschunterdrückung:** Im Inspector eines Audioclips den Schalter bei *Rauschunterdrückung* einschalten und Stärke und Rauschpegel einstellen. Für ein genaueres Ergebnis In- und Out-Punkt auf eine Stelle des Clips setzen, an der nur Rauschen zu hören ist, und *Aus In/Out lernen* wählen. Der entrauschte Ton wird einmal berechnet und im Cache abgelegt; Vorschau und Export verwenden dieselbe Datei.

**Lautstärke in der Timeline:** Auf Audioclips liegt die Lautstärke als Linie über der Wellenform. Ziehen ändert sie (Umschalt: fein), Strg+Klick setzt oder entfernt einen Keyframe, die Punkte lassen sich einzeln ziehen. Der Rechtsklick auf die Linie oder einen Punkt kopiert, fügt ein oder löscht.

**Drag & Drop:** Dateien und Ordner aus dem Explorer ins Fenster ziehen importiert sie. Medien aus dem Browser in die Timeline ziehen überschreibt, mit gedrückter `Strg`-Taste wird eingefügt.

## Lizenz

Kerf ist freie Software unter der [GNU General Public License v3.0 oder später](LICENSE) (GPL-3.0-or-later). Du darfst es nutzen, untersuchen, verändern und weitergeben; Weitergaben (auch veränderte) müssen wieder unter der GPL stehen und ihren Quellcode mitliefern.

Kerf bringt kein FFmpeg mit, sondern ruft ein installiertes FFmpeg als eigenes Programm auf; dafür gilt dessen Lizenz. Code und Schriften Dritter sowie der aus FFmpeg abgeleitete Teil der Audio-Vorschau sind in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) aufgeführt.

## Projektstruktur

```
crates/kerf-core     Datenmodell, Zeit/Timecode, Edit-Befehle, Undo, Projektdatei (.kerf)
crates/kerf-media    FFmpeg: Probe, Poster/Filmstreifen/Wellenform, Proxys, Export-Renderer
src-tauri            Tauri-Shell: IPC-Befehle, Worker-Threads, Autosave, Render-Warteschlange, Installer-Hooks
src/engine           Wiedergabe-Engine, WebGL2-Compositor, WebAudio-Mixer
src/timeline         Timeline-Geometrie, Constraints, Canvas-Rendering
src/panels           Medien, Monitor, Timeline, Inspector, Export, Mixer, Scopes
src/shell            Titelleiste, Menüs, Arbeitsbereiche, Dialoge, Statusleiste
src/actions          Aktions-Registry (Menüs, Shortcuts, Toolbars), Tastaturbelegung
fixtures/parity      Gemeinsame Testdaten für Vorschau/Export-Parität (Rust + TS)
docs                 Architektur, Status, Roadmap
.github/workflows    CI und Release (Windows)
```

Details zur Architektur: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
