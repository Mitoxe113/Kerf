# Status

Stand: 2. November 2026 · Version 0.1.0 · nach Phase 7 („Professional Polish“)

Diese Liste ist absichtlich nüchtern. „Fertig“ heißt: implementiert, durch Tests abgedeckt **und** in der laufenden App durchgespielt (echte Maus- und Tastaturereignisse über das WebView2-DevTools-Protokoll oder echte IPC-Aufrufe an die Engine). Alles andere ist als teilweise oder offen markiert. Die Ausgangslage vor Phase 7 steht in [AUDIT.md](AUDIT.md).

## Fertig und verifiziert

**Projekt und Dateien**
- Neues Projekt, Öffnen, Speichern, Speichern unter, zuletzt verwendete Projekte. Speichern ist atomar und legt eine `.bak` an; eine beschädigte Hauptdatei fällt automatisch auf die Sicherung zurück.
- Abfrage bei ungespeicherten Änderungen (Speichern / Nicht speichern / Abbrechen) vor Neu, Öffnen, Wiederherstellen und Schließen.
- **Autosave** mit einstellbarem Intervall (15 s bis 10 min, Standard 30 s). Nach einem Absturz bietet der Wiederherstellungsdialog die Sitzung an. In Phase 7 mit hartem Prozessabbruch geprüft: Die ungespeicherte Änderung kam zurück, der Projektpfad blieb erhalten.
- **Versionen:** Jedes Speichern legt eine Version an (Anzahl einstellbar, Standard 20, unveränderte Stände werden nicht doppelt abgelegt). *Datei › Versionen …* lädt einen älteren Stand, ohne den Projektpfad zu verlieren.
- **Speicherstatus** in der Statusleiste („Gespeichert 14:32“ bzw. „Ungespeicherte Änderungen · gesichert 14:35“).
- **Startbildschirm** mit Formatvorgaben für das neue Projekt (Full HD 25/30/50p, 4K, Hochformat 9:16, Quadrat), Öffnen und zuletzt verwendeten Projekten. Abschaltbar.
- **Dateizuordnung `.kerf`** im Installer. Doppelklick öffnet das Projekt; läuft Kerf schon, übergibt die zweite Instanz die Datei an das laufende Fenster (mit Abfrage bei ungespeicherten Änderungen). Eine `.kerf`-Datei ins Fenster ziehen öffnet sie ebenfalls. Der Release-Build erzeugt `Kerf_0.1.0_x64-setup.exe` (2,9 MB); das generierte NSIS-Skript registriert die Endung beim Installieren und entfernt sie beim Deinstallieren. Die Übergabe per Argument und an die laufende Instanz ist per Unit-Test und in der Dev-App geprüft.
- Rundreise Speichern → Schließen → Öffnen: Das Dokument ist danach identisch (verglichen über Sequenzen, Ablagen und Medien).

**Medien**
- Import per Dialog, Ordner (rekursiv) und Drag & Drop aus dem Explorer. Duplikate und nicht existierende Pfade werden abgelehnt.
- Analyse: Codec, Auflösung, Bildrate, Dauer, Rotation, Audio, Poster, Filmstreifen, Wellenform.
- Automatische Proxys für Formate, die die Vorschau nicht dekodieren kann (geprüft mit HEVC). Ein- und ausschaltbare Proxy-Vorschau.
- Medienbrowser: Ablagen mit Brotkrumen, Raster- und Listenansicht, Suche, Filter, Sortierung, Hover-Scrubbing, Umbenennen (`F2`), Neu verknüpfen, Statusanzeigen.
- **Quellmonitor:** Doppelklick auf ein Medium öffnet es. Eigenes In/Out pro Medium, J/K/L, Einzelbilder, zuletzt geöffnete Medien. **Dreipunktschnitt** mit `,`/`.`: Sequenz-In hat Vorrang, sonst wird auf den Sequenz-Out rückwärts angelegt, sonst ab Playhead. Das Bild lässt sich mit dem markierten Bereich direkt in die Timeline ziehen.
- **Match Frame** (`F`): öffnet die Quelle des Clips am Playhead im Quellmonitor, an derselben Stelle und mit dem Clipbereich als In/Out.

**Timeline**
- Mehrspur, alle acht Werkzeuge (Auswahl, Rasierklinge, Ripple-Trim, Rollen, Slip, Slide, Hand, Zoom), Snapping, verknüpfte Clips, Insert/Overwrite, Ripple-Löschen, Lücke schließen, Marker, In/Out, Undo/Redo.
- **Spurhöhe pro Spur** (am Spurkopf ziehen oder per Menü), **Spurfarben**, **Clip-Beschriftungen** (Farben), **Clips umbenennen** (`F2`).
- **Automatisches Scrollen** am Rand beim Scrubben und beim Ziehen von Clips, Trims und Marquee.
- **Lift** (`;`) und **Extract** (`'`) für den In/Out-Bereich auf allen nicht gesperrten Spuren.
- **Auswahl ab Playhead** vorwärts (`A`) und rückwärts (`Umschalt+A`), **Zoom auf Auswahl** (`Umschalt+Z`), Sprung zu Clip-Anfang/-Ende (`Umschalt+Pos1/Ende`).
- **Clip ersetzen** durch das im Browser gewählte Medium (Position und Länge bleiben), **Im Medienbrowser zeigen**.
- **Standbild** (`Umschalt+N`): exportiert den Frame am Playhead als PNG (in `Standbilder/` neben dem Projekt) und fügt ihn als 2-s-Clip ein, ein Undo-Schritt.
- **J/L-Schnitt:** `Alt` beim Trimmen oder Rollen bearbeitet nur die gezogene Spur; die Einblendung beim Ziehen sagt das an.
- **Verlauf-Panel:** alle Schritte mit Klartext, Klick springt zu jedem Stand.

**Keyframes**
- Position, Skalierung, Rotation, Deckkraft und Lautstärke sind animierbar. Stoppuhr im Inspector, Keyframe setzen/löschen, vorheriger/nächster Keyframe, Interpolation linear, Ease-In, Ease-Out, Ease-In-Out und Halten (Rechtsklick auf die Raute).
- Keyframes hängen an der Quellposition: Trimmen und Teilen verschieben sie nicht.
- Ziehen am Bild im Programmmonitor setzt bei animierten Eigenschaften einen Keyframe am Playhead. Die Timeline zeigt Rauten auf den Clips.
- Export: Bewegung über FFmpeg-`perspective` mit Frame-Ausdrücken, Deckkraft über `sendcmd`, Lautstärke über einen `volume`-Ausdruck. Dieselben Easing-Formeln in Rust, TypeScript und FFmpeg; ein Pipeline-Test prüft Position, Deckkraft und Lautstärke im gerenderten File.

**Audio**
- **Normalisieren** (Inspector, Clip-Kontextmenü, Menü *Clip*): Messung nach EBU R128 über den verwendeten Quellbereich, Ziel Spitzenpegel (dBFS), True Peak (dBTP) oder Lautheit (LUFS, Vorgaben −14/−16/−23). Einzeln oder gemeinsam (gleiche Änderung, Verhältnis bleibt). Lautstärke-Keyframes verschieben sich mit. Warnung, wenn Spitzen über 0 dBFS steigen würden.
- **Übersteuerungsanzeige:** Pegelanzeigen haben eine rote Clip-LED, die bis zum Klick stehen bleibt. Die Wellenform in der Timeline färbt Stellen rot, die nach Clip-Gain (auch animiert) über 0 dBFS liegen.
- Mixer, Spur-Fader, Mute/Solo, Pegel- und RMS-Anzeige.

**Vorschau und Wiedergabe**
- Echtzeit-Wiedergabe mit Audio, J/K/L, Rückwärts, Schleife, In bis Out, Einzelbilder.
- Programmmonitor mit Zoom, Vorschauqualität, Vollbild, Timecode-Eingabe, direkter Manipulation.
- **Überlagerungen:** sichere Bereiche, Drittel-Raster, Mittelkreuz, **Seitenverhältnis-Masken** (2,39:1, 1,85:1, 16:9, 4:5, 1:1, 9:16).
- **Wiedergabe-Statistik** und **Anzeige verworfener Frames:** erreichte Bildrate, ausgelassene Sequenz-Frames und Decoder-Drops. Ein Punkt in der Transportleiste wird gelb, wenn bei der letzten Wiedergabe Frames verloren gingen (geprüft mit einer künstlichen 300-ms-Blockade: 7 Frames bei 25 fps).
- Scopes: Waveform, RGB-Parade, Vektorskop, Histogramm.

**Export**
- H.264, HEVC, ProRes 422/HQ; AAC oder PCM; **Qualität (CRF), VBR oder CBR**; **Stereo oder Mono**; Auflösung, Bildrate, Abtastrate; ganze Sequenz oder In bis Out.
- **Vorgaben** in Gruppen: Allgemein, **Plattformen (YouTube 1080p, YouTube 4K, Instagram, TikTok)**, Mezzanine, plus **eigene Vorgaben** (speichern, löschen).
- Abweichendes Seitenverhältnis (z. B. 9:16 aus einer 16:9-Sequenz) wird mit Balken eingepasst statt verzerrt.
- **Größenschätzung und Speicherplatzprüfung:** freier Platz auf dem Ziellaufwerk, Warnung und Rückfrage, wenn er voraussichtlich nicht reicht.
- Render-Warteschlange mit Fortschritt, Restzeit, Abbruch, **Erneut versuchen**, **Datei öffnen**, **Im Explorer zeigen** und **Protokoll** (Befehlszeile, Filtergraph, FFmpeg-Warnungen; kopierbar).
- **Prüfung nach dem Rendern:** Die fertige Datei wird erneut analysiert (Dauer, Auflösung, Bildrate, Codecs, Kanäle, Größe) und nach EBU R128 gemessen (LUFS, True Peak, LRA). Abweichungen und True Peak über −1 dBTP werden als Warnung angezeigt.

**Bedienung**
- **Suche und Befehle** (`Strg+P` / `Strg+F`): Befehle mit Tastenkürzel, Medien, Clips, Marker, Sequenzen und Timecode-Sprünge in einer Liste, unscharfe Suche, zuletzt verwendete Befehle. `Strg+Umschalt+P` oder `>` sucht nur Befehle.
- **Einstellungen** (`Strg+,`): Autosave-Intervall, Anzahl Versionen, Vorschauqualität, Proxys, Einrasten, verknüpfte Auswahl, Spurhöhe, Tastaturbefehle, Systeminfo (FFmpeg, Encoder, Cache-Ordner).
- **Tastaturprofile:** Belegungen als Profil speichern, wechseln, löschen, als JSON exportieren und importieren (unbekannte Befehle werden übersprungen und gemeldet).
- Panel-Gruppen mit Tabs (Medien | Quelle, Inspector | Verlauf), Fokusrahmen; Transporttasten wirken auf den Monitor mit Fokus.
- Eigenes dunkles Design, alle Menüpunkte an echte Aktionen gebunden.

## Performance (Dev-Build, 2.008 Clips)

| Messung | vor Phase 7 | nach Phase 7 | Maßnahme |
| --- | --- | --- | --- |
| Kleinste Bearbeitung, IPC | 64,5 ms | **5,4 ms** | Delta enthält nur geänderte Clips statt der ganzen Sequenz |
| Antwort pro Bearbeitung | 895 KB | **1,9 KB** | dto. |
| Bearbeitung anwenden + zeichnen | 18,9 ms | **9,2 ms** | feinere Store-Abonnements |
| Undo | 85 ms | **14 ms** | Delta statt Gesamtzustand |
| Timeline-Frame beim Scrollen | 74 ms | **8,3 ms** | Detailstufen: keine Filmstreifen/Wellen/Rundungen bei winzigen Clips |
| 150 Bearbeitungen | 8,9 s, +68 MB | **0,65 s, +33 MB** | Undo-Schnappschüsse teilen unveränderte Sequenzen (`Arc`) |

## Tests

| Bereich | Anzahl | Was |
| --- | --- | --- |
| `kerf-core` Unit | 42 | Zeit/Timecode, alle Edit-Befehle inkl. Lift/Extract, Clip ersetzen, Standbild, Keyframes, Clip-Gain, Undo, Projektdatei |
| `kerf-core` Parität | 1 | Farbmatrix gegen gemeinsame Fixture |
| `kerf-media` Unit | 9 | Probe-Parsing, Filtergraph, CBR/Mono/Letterbox, EBU-R128-Parser |
| `kerf-media` Pipeline | 4 | Echtes FFmpeg: Schnitt → Render → Pixelprüfung, Abbruch, Keyframes im Render, Lautheitsmessung über Bereiche |
| App-Crate | 2 | Versionen, Projektdatei-Argument |
| Frontend (Vitest) | 37 | Timecode, Timeline-Constraints, Keyframes/Easing, unscharfe Suche, Tastaturprofile |

**QA-Durchlauf Phase 7** (alle 17 Schritte aus dem Auftrag, in der laufenden App): Medien importieren · organisieren · in die Timeline · schneiden · trimmen · verschieben · mehrere Clips bearbeiten · Audio hinzufügen · Audio schneiden · Effekte · Keyframes · speichern · schließen · wieder öffnen (identisch) · nach hartem Absturz wiederherstellen · exportieren · Export prüfen (Dauer 20,60/20,60 s, 1280×720, H.264/AAC, Lautheit gemessen). Zusätzlich: alle 16 Bearbeitungsschritte rückgängig und wiederhergestellt, Dokument danach identisch.

**In Phase 7 gefundene und behobene Fehler:** Schalter (Toggle) waren durch die 12-px-Grundschrift zu klein und der Knopf stand im eingeschalteten Zustand außerhalb; Export in ein anderes Seitenverhältnis verzerrte das Bild; erste Lineal-Beschriftung lag unter dem Playhead-Kopf; zuletzt verwendete Projekte erschienen doppelt (`/` und `\` im Pfad); Playhead scrollte beim Scrubben nicht mit; doppelter Panel-Titel in Tab-Gruppen; `F2` benannte je nach Fokus das Falsche um; Transportleisten liefen in schmalen Panels über.

## Bekannte Einschränkungen

- **Farbraum bei Material ohne Tag:** Die WebView dekodiert ungetaggtes HD-Material als BT.709, FFmpeg als BT.601 (Ø 5/255 Unterschied). Getaggtes Kameramaterial ist nicht betroffen.
- **Ripple** betrifft die bearbeitete und verknüpfte Spuren; *Einfügen*, Extract und Standbild verschieben alle nicht gesperrten Spuren.
- **Export-Skalierung:** ein FFmpeg-Eingang pro Clipabschnitt. Sehr lange Timelines belasten FFmpeg (funktioniert, nicht optimiert).
- **Keyframes:** Bezier-Griffe gibt es nicht (nur die fünf Interpolationsarten). Farbe ist noch nicht animierbar. Kopieren von Keyframes einzeln fehlt; beim Kopieren eines Clips kommen sie mit.
- **Quellmonitor-Marken** gelten für die Sitzung und werden nicht im Projekt gespeichert.
- **Normalisieren** misst die Quelle (ohne Blenden und Spurlautstärke) und setzt den Clip-Gain; es gibt keinen Limiter.
- **Verworfene Frames:** gezählt werden Sprünge in der Bildfolge der Vorschau und Decoder-Drops; ob ein Videoelement einen Frame zu spät lieferte, sieht die Statistik nicht.
- **Nur Windows** gebaut und getestet. macOS (Dateiübergabe per `Opened`-Ereignis ist vorbereitet) und Linux sind ungetestet.
- **Native Dateidialoge** wurden nicht ferngesteuert; getestet wurden die Aktionen dahinter mit festen Pfaden.
- **Installer und Explorer-Drop:** Der Installer wurde gebaut, aber nicht auf diesem System installiert; Doppelklick auf eine `.kerf`-Datei nach der Installation und Ziehen von Dateien aus dem Explorer ins Fenster sind nicht automatisiert getestet.

## Noch nicht umgesetzt

- Titel und Text, Untertitel (SRT/VTT)
- Übergänge zwischen Clips
- Effekt-Stapel mit Plugin-Schnittstelle, Masken, Chroma-Key, LUTs, Farbräder, Kurven
- Verschachtelte Sequenzen, Multicam, Geschwindigkeitsrampen, Rückwärts-Clips
- Audio-Effekte (EQ, Kompressor, Limiter, Rauschunterdrückung)
- Andockbare, frei verschiebbare Panels und mehrere Fenster/Monitore (heute: feste Layouts mit Tabs und Größenänderung)
- Smart Bins, Metadaten-Editor, Projekt archivieren
- Native GPU-Pipeline (wgpu) für Export
- Automatische Updates, Absturzberichte (bewusst ausgelassen)

Der Plan dafür steht in [ROADMAP.md](ROADMAP.md).
