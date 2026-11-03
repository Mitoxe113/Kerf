# Status

Stand: 3. November 2026 · Version 0.1.0 · nach Phase 8–10 (Titel, Effekte, Audio, Skalierung, Arbeitsumgebung) und der Release-Vorbereitung

Diese Liste ist absichtlich nüchtern. „Fertig“ heißt: implementiert, durch Tests abgedeckt **und** in der laufenden App durchgespielt (echte Maus- und Tastaturereignisse über das WebView2-DevTools-Protokoll oder echte IPC-Aufrufe an die Engine). Alles andere ist als teilweise oder offen markiert. Die Ausgangslage vor Phase 7 steht in [AUDIT.md](AUDIT.md).

## Fertig und verifiziert

**Projekt und Dateien**
- Neues Projekt, Öffnen, Speichern, Speichern unter, zuletzt verwendete Projekte. Speichern ist atomar und legt eine `.bak` an; eine beschädigte Hauptdatei fällt automatisch auf die Sicherung zurück.
- Abfrage bei ungespeicherten Änderungen (Speichern / Nicht speichern / Abbrechen) vor Neu, Öffnen, Wiederherstellen, Schließen und vor einem Update.
- **Autosave** mit einstellbarem Intervall (15 s bis 10 min, Standard 30 s). Nach einem Absturz bietet der Wiederherstellungsdialog die Sitzung an. Mit hartem Prozessabbruch geprüft: Die ungespeicherte Änderung kam zurück, der Projektpfad blieb erhalten.
- **Versionen:** Jedes Speichern legt eine Version an (Anzahl einstellbar, Standard 20, unveränderte Stände werden nicht doppelt abgelegt). *Datei › Versionen …* lädt einen älteren Stand, ohne den Projektpfad zu verlieren.
- **Speicherstatus** in der Statusleiste, **Startbildschirm** mit Formatvorgaben (Full HD 25/30/50p, 4K, Hochformat 9:16, Quadrat).
- **Dateizuordnung `.kerf`**, mit dem installierten Programm geprüft: Doppelklick bei geschlossenem Kerf startet es mit dem Projekt; läuft Kerf schon, übergibt die zweite Instanz die Datei an das laufende Fenster und beendet sich. Eine `.kerf`-Datei ins Fenster ziehen öffnet sie ebenfalls.
- Rundreise Speichern → Schließen → Öffnen: Das Dokument ist danach identisch (verglichen über Sequenzen, Ablagen und Medien).

**Medien**
- Import per Dialog, Ordner (rekursiv) und Drag & Drop aus dem Explorer. Duplikate und nicht existierende Pfade werden abgelehnt. Der Drop-Weg wurde in der installierten App mit dem Ereignis geprüft, das Tauri bei einem Datei-Drop sendet (Medium erschien in der Ablage); das Ziehen im Explorer selbst siehe Einschränkungen.
- Analyse: Codec, Auflösung, Bildrate, Dauer, Rotation, Farb-Tags (Matrix, Bereich, Transfer, Primärfarben), Audio, Poster, Filmstreifen, Wellenform.
- Automatische Proxys für Formate, die die Vorschau nicht dekodieren kann (geprüft mit HEVC). Ein- und ausschaltbare Proxy-Vorschau.
- Medienbrowser: Ablagen mit Brotkrumen, Raster- und Listenansicht, Suche, Filter, Sortierung, Hover-Scrubbing, Umbenennen (`F2`), Neu verknüpfen, Statusanzeigen.
- **Quellmonitor:** eigenes In/Out pro Medium, **im Projekt gespeichert** und rückgängig machbar, J/K/L, Einzelbilder, zuletzt geöffnete Medien. **Dreipunktschnitt** mit `,`/`.`. **Match Frame** (`F`).

**Timeline**
- Mehrspur, alle acht Werkzeuge (Auswahl, Rasierklinge, Ripple-Trim, Rollen, Slip, Slide, Hand, Zoom), Snapping, verknüpfte Clips, Insert/Overwrite, Ripple-Löschen, Lücke schließen, Marker, In/Out, Undo/Redo.
- Spurhöhe pro Spur, Spurfarben, Clip-Beschriftungen, Clips umbenennen, automatisches Scrollen, Lift (`;`) und Extract (`'`), Auswahl ab Playhead, Zoom auf Auswahl, Clip ersetzen, Standbild (`Umschalt+N`), J/L-Schnitt mit `Alt`, Verlauf-Panel.
- **Geschwindigkeit und Zeitumkehr:** Clips rückwärts (verknüpfte Partner folgen), Geschwindigkeit als Keyframe-Parameter mit Rampen (konstante Beschleunigung, Linear, Halten); die Clip-Länge folgt dem Quellbereich. Trim, Teilen, Slip, Roll und Slide arbeiten auf verzerrten Clips über den gezeigten Inhalt (`kerf_core::timemap`). Filmstreifen und Wellenform folgen der Zeitabbildung.
- **Verschachtelte Sequenzen:** Sequenzen lassen sich wie Medien platzieren (Tab in die Timeline ziehen), *Verschachteln* packt die Auswahl samt verknüpfter Partner in eine neue Sequenz. Zyklusschutz, verwendete Sequenzen sind nicht löschbar, Doppelklick öffnet die innere Sequenz an der Stelle.
- **Multicam:** Gruppen aus mehreren Kameras einer Aufnahme, Synchronisation über den Ton (Einsatz-Hüllkurve per FFT-Kreuzkorrelation, auf Sample-Ebene verfeinert) oder am Anfang. Kamerawechsel ab dem Playhead mit `1`–`9` oder Klick im Multicam-Panel, auch live während der Wiedergabe; Keyframes wandern mit.

**Keyframes**
- Animierbar: Position, Skalierung, Rotation, Deckkraft, Lautstärke, Geschwindigkeit sowie **Belichtung, Kontrast, Sättigung, Temperatur und Tönung**.
- Interpolation linear, Ease-In/-Out/-In-Out, Halten und **eigene Bezier-Kurven** (wie CSS `cubic-bezier`) mit Kurveneditor, Vorgaben und Bewegungsvorschau. Rust und TypeScript rechnen identisch, geprüft gegen Referenzwerte der WebView2 (Web Animations API).
- Keyframes hängen an der Quellposition: Trimmen und Teilen verschieben sie nicht.
- Export: Bewegung über `perspective`, Deckkraft und Farbe über `sendcmd`, Lautstärke über `volume`-Ausdrücke; Bezier-Kurven als stückweise lineare Ausdrücke (bis 32 Stücke).

**Effekte und Farbe**
- **Effekt-Stapel pro Videoclip** (rückgängig machbar): Weichzeichner, Schärfen, Vignette, **3D-LUT** (`.cube`, trilinear, Intensität), **Chroma-Key** (mit Pipette und Spill-Unterdrückung), **Farbräder** (Lift/Gamma/Gain) und **Kurven** (PCHIP, Master und je Kanal) im Farbe-Tab.
- Vorschau (WebGL2) und Export (FFmpeg) rechnen dieselbe Mathematik; die Kurven sind gegen die Tabellen von FFmpegs `curves` getestet.
- **Farbparität bei Material ohne Tag:** Der Export liest ungetaggtes Material wie die WebView2 (ab 720 Zeilen BT.709, darunter BT.601, gemessen). Der frühere Unterschied von Ø 5/255 ist damit behoben.

**Titel und Untertitel**
- Titel als erzeugte Medien: Text, Schrift, Kontur, Schatten, Hintergrund, Vorlagen (Mitte, Bauchbinde, Oben). Vorschau und Export zeichnen mit demselben Code.
- Untertitel pro Sequenz: Panel mit Zeiten und Text, eigene Spur in der Timeline, Stil und Abstand. Import und Export von **SRT und WebVTT** (UTF-8 oder Windows-1252).
- Export: einbrennen (bildgenau), als `mov_text`-Spur einbetten oder als SRT/VTT-Datei neben dem Video.

**Übergänge**
- Blende, Abblende über Farbe, Wischen und Audio-Kreuzblende; Lage Mitte/ab/bis Schnitt, höchstens die halbe Länge jedes Clips. Standard-Übergang mit `Strg+Umschalt+D`, verknüpftes Audio bekommt eine Kreuzblende.
- Beide Clips laufen mit echten Handles in den Übergang (sonst stehendes erstes/letztes Bild). Parität Vorschau ↔ Export im Mittel 1,4–2,6 Tonwerte auf 9 Fällen.

**Audio**
- **Clip- und Spureffekte:** parametrischer EQ (Hoch-/Tiefpass, Shelves, Glocke), Kompressor, Noise-Gate, Limiter. Die Vorschau rechnet mit Ports derselben FFmpeg-Filter im AudioWorklet (Abweichung < 1e-5 gegen FFmpegs Ausgabe).
- **Kanalzuordnung** pro Clip (Stereo, Mono, nur links/rechts, getauscht), Mono-Spuren, Panorama in Vorschau und Export gleich. Spuren mit Effekten oder Mono werden einzeln gemischt (Summe → Effekte → Regler).
- **Lautheit:** Normalisieren nach Peak/True Peak/LUFS mit **optionalem Limiter** an der Obergrenze; **Loudness-Normalisierung beim Export** in zwei Durchgängen (`loudnorm`, linear); **LUFS-Anzeige** (momentan, kurzzeit, integriert) am Master.
- Mixer, Spur-Fader, Mute/Solo, Pegel- und RMS-Anzeige mit Clip-LED, Übersteuerungsanzeige in der Wellenform.

**Vorschau und Wiedergabe**
- Echtzeit-Wiedergabe mit Audio, J/K/L, Rückwärts, Schleife, In bis Out, Einzelbilder; Seek-Latenz wird ausgeglichen.
- Programmmonitor mit Zoom, Vorschauqualität, Vollbild, Timecode-Eingabe, direkter Manipulation, Überlagerungen (sichere Bereiche, Raster, Masken für Seitenverhältnisse), Wiedergabe-Statistik und Anzeige verworfener Frames.
- **Programmausgabe in eigenem Fenster** (*Fenster › Programmausgabe in eigenem Fenster*), z. B. im Vollbild auf einem zweiten Bildschirm. Das Fenster zeigt die Bilder, die der Monitor zeichnet (kein zweiter Player, also immer synchron); der Monitor rendert dafür in der Auflösung des Fensters. Doppelklick oder `F` schaltet Vollbild, Tasten wirken wie im Editor.
- Scopes: Waveform, RGB-Parade, Vektorskop, Histogramm.

**Export**
- H.264, HEVC, ProRes 422/HQ; AAC oder PCM; Qualität (CRF), VBR oder CBR; Stereo oder Mono; Auflösung, Bildrate, Abtastrate; ganze Sequenz oder In bis Out. Vorgaben inkl. Plattformen und eigener Vorgaben; abweichende Seitenverhältnisse mit Balken.
- **Segmentiertes Rendern** (Schalter im Export-Panel): Das Bild wird in Teilen parallel kodiert, der Ton in einem Stück daneben, und die Teile werden ohne neue Kodierung zusammengefügt. Teilgrenzen liegen auf Bildern, die Sequenz- und Ausgaberate gemeinsam haben. Test: segmentiert und in einem Stück sind bildgenau gleich (PSNR je Bild), der Ton ist bitidentisch.
- Verschachtelte Sequenzen werden vorab verlustfrei mit Alpha gerendert (FFV1, PCM) und wie Medien gelesen, tiefste zuerst.
- Größenschätzung und Speicherplatzprüfung, Render-Warteschlange mit Fortschritt, Restzeit, Abbruch, Erneut versuchen, Datei öffnen, Im Explorer zeigen, Protokoll; **Prüfung nach dem Rendern** (Dauer, Auflösung, Bildrate, Codecs, Kanäle, EBU R128).

**Arbeitsumgebung**
- **Andockbare Panels:** Panels per Tab oder Titelzeile ziehen, in die Mitte oder Tableiste eines Bereichs (als Tab) oder an einen Rand (neuer Bereich daneben). Die Zielzone wird angezeigt, `Esc` bricht ab; leere Bereiche geben ihren Platz an den Nachbarn ab. Layouts bleiben gespeichert.
- Suche und Befehle (`Strg+P`), Einstellungen (`Strg+,`), Tastaturprofile mit Import/Export, eigenes dunkles Design, alle Menüpunkte an echte Aktionen gebunden.

**Verteilung und Updates**
- **Windows-Installer (NSIS)** auf diesem System installiert, aktualisiert und deinstalliert: Installation pro Benutzer ohne Adminrechte, Startmenü-Eintrag, Dateizuordnung. Die Deinstallation entfernt Programm, Startmenü-Eintrag, Uninstall-Eintrag und Dateityp und stellt eine vorher vorhandene Zuordnung von `.kerf` wieder her; Benutzerdaten (Wiederherstellung, Versionen) bleiben erhalten.
- **Automatische Updates** über GitHub-Releases, signiert mit einem eigenen Updater-Schlüssel (minisign). Ende-zu-Ende geprüft mit zwei signierten Builds (0.1.0 → 0.1.1) gegen einen lokalen Update-Server: Prüfung beim Start, Dialog mit Version, Datum und Hinweisen, Download, Signaturprüfung, Installation im passiven Modus, Neustart als 0.1.1. Ist beim Start schon ein Dialog offen (z. B. Wiederherstellung), erscheint das Angebot, sobald er geschlossen ist. Abschaltbar in den Einstellungen, *Hilfe › Nach Updates suchen …* prüft von Hand.
- **CI auf GitHub Actions** für Windows, macOS und Linux: Typprüfung, Frontend-Tests, Clippy, alle Rust-Tests einschließlich der Pipeline-Tests mit echtem FFmpeg (ein fehlendes FFmpeg lässt den Lauf scheitern statt Tests zu überspringen) und Installer für alle drei Systeme (`.exe`, `.dmg`/`.app`, `.deb`/`.AppImage`). Alle Jobs grün.
- **Release-Workflow:** Ein Tag `v…` baut signierte Installer und `latest.json` in einen Release-Entwurf; Code-Signierung für Windows und macOS ist vorbereitet und greift, sobald die Zertifikate als Secrets hinterlegt sind.
- **Lizenz:** GPL-3.0-or-later, Drittanbieter-Hinweise in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Performance

**Bearbeitung (Dev-Build, 2.008 Clips, Phase 7)**

| Messung | vor Phase 7 | nach Phase 7 | Maßnahme |
| --- | --- | --- | --- |
| Kleinste Bearbeitung, IPC | 64,5 ms | **5,4 ms** | Delta enthält nur geänderte Clips statt der ganzen Sequenz |
| Antwort pro Bearbeitung | 895 KB | **1,9 KB** | dto. |
| Bearbeitung anwenden + zeichnen | 18,9 ms | **9,2 ms** | feinere Store-Abonnements |
| Undo | 85 ms | **14 ms** | Delta statt Gesamtzustand |
| Timeline-Frame beim Scrollen | 74 ms | **8,3 ms** | Detailstufen: keine Filmstreifen/Wellen/Rundungen bei winzigen Clips |
| 150 Bearbeitungen | 8,9 s, +68 MB | **0,65 s, +33 MB** | Undo-Schnappschüsse teilen unveränderte Sequenzen (`Arc`) |

**Segmentierter Export (16 Threads, Software-Encoder):** Bei einer aufwendigen Timeline (Effekte, mehrere Ebenen) ist er mit 4 Teilen rund **17 % schneller**. Bei einfachen Schnitten lastet FFmpeg die CPU schon allein aus; dort ist ein Stück gleich schnell oder schneller. Deshalb ist der Schalter standardmäßig aus, und mit Hardware-Encoder oder CBR wird nie segmentiert.

## Tests

| Bereich | Anzahl | Was |
| --- | --- | --- |
| `kerf-core` Unit | 66 | Zeit/Timecode, alle Edit-Befehle, Zeitabbildung (Rampen, Rückwärts), Übergänge, verschachtelte Sequenzen, Multicam, Untertitel, Keyframes inkl. Bezier, Undo, Projektdatei |
| `kerf-core` Parität | 1 | Farbmatrix gegen gemeinsame Fixture |
| `kerf-media` Unit | 19 | Probe-Parsing, Filtergraph, CBR/Mono/Letterbox, EBU-R128-Parser, Teilgrenzen und Plan des segmentierten Exports |
| `kerf-media` Pipeline | 13 | Echtes FFmpeg: Schnitt → Render → Pixelprüfung, Abbruch, Keyframes, animierte Farbe, Effekt-Stapel, Lautheit, Untertitel (einbrennen, einbetten, Datei), Übergänge, Audio-Effekte und Loudnorm, Rückwärts und Rampen, verschachtelte Sequenzen, Multicam-Synchronisation, segmentiert = ein Stück |
| App-Crate | 3 | Versionen, Projektdatei-Argument, Untertitel-Kodierung (UTF-8, Windows-1252) |
| Frontend (Vitest) | 72 | Timecode, Timeline-Constraints, Keyframes/Easing/Bezier, Zeitabbildung, Effekte und Kurven, Audio-DSP gegen FFmpeg-Fixtures, Textsatz, Deltas, Docking, unscharfe Suche, Tastaturprofile |

Alle Rust-Tests laufen in der CI auf Windows, macOS und Linux.

**QA-Durchlauf Release-Vorbereitung** (installierte App): signierter Build installiert · Dateizuordnung im Registry geprüft · `.kerf` per Shell geöffnet bei laufendem und bei geschlossenem Kerf · Datei-Drop importiert · Update beim Start gefunden, installiert, Neustart als neue Version · Schließen mit ungespeicherten Änderungen fragt nach · Deinstallation mit und ohne vorher vorhandene Zuordnung.

**Gefundene und behobene Fehler (Phase 8 bis Release-Vorbereitung):** Ein segmentierter Teil begann ein Bild zu früh, weil `setpts` Verschiebungen abschneidet statt rundet (8,44 s = 210,99… Bilder); behoben in allen vier Ausdrücken, Regressionstest. Blenden, die vor dem Export-Bereich beginnen, starteten neu statt weiterzulaufen. Das Schärfen im Export lief über 8 Bit hinaus. Die Wiedergabe positionierte Elemente wegen der Seek-Latenz immer wieder neu. Nach einem Update merkte sich der Installer Kerfs eigenen Dateityp als „vorherige“ Zuordnung, die Deinstallation hinterließ dann einen verwaisten Eintrag (Installer-Hooks). Das Update-Angebot beim Start ging als kurze Meldung hinter dem Wiederherstellungsdialog unter.

## Bekannte Einschränkungen

- **Explorer-Drop und native Dateidialoge** wurden nicht mit echten Betriebssystem-Eingaben ferngesteuert (die Bildschirmsteuerung wurde für diesen Test nicht freigegeben). Geprüft sind der Drop-Handler mit Tauris Drop-Ereignis und die Aktionen hinter den Dialogen mit festen Pfaden.
- **macOS und Linux** bauen und bestehen alle automatischen Tests in der CI, die Oberfläche wurde dort aber nicht von Hand bedient. Die macOS-Builds sind nicht signiert (Gatekeeper fragt beim ersten Start), ebenso der Windows-Installer (SmartScreen-Hinweis), solange keine Zertifikate hinterlegt sind.
- **Updates über GitHub** sind erst mit dem ersten veröffentlichten Release wirksam; der Weg über einen lokalen Server ist geprüft, der über GitHub selbst noch nicht.
- **Export:** weiterhin ein FFmpeg-Eingang pro Clipabschnitt. Segmentiertes Rendern verteilt die Arbeit, beschleunigt aber nur aufwendige Timelines; eine eigene GPU-Pipeline gibt es nicht (bewusst: FFmpeg segmentiert statt wgpu).
- **Ripple** betrifft die bearbeitete und verknüpfte Spuren; *Einfügen*, Extract und Standbild verschieben alle nicht gesperrten Spuren.
- **Keyframes:** kein Keyframe-Editor in der Timeline (Gummiband), Keyframes lassen sich nicht einzeln kopieren.
- **Normalisieren** misst die Quelle ohne Blenden und Spurlautstärke.
- **Programmausgabe-Fenster:** Der Ton bleibt beim Hauptfenster; das Fenster zeigt nur etwas, solange der Programmmonitor im Arbeitsbereich sichtbar ist (es sagt das dann an).
- **Multicam-Synchronisation** über den Ton braucht gemeinsamen Ton der Kameras; sonst werden sie am Anfang ausgerichtet.
- **Verworfene Frames:** gezählt werden Sprünge in der Bildfolge der Vorschau und Decoder-Drops; ob ein Videoelement einen Frame zu spät lieferte, sieht die Statistik nicht.

## Noch nicht umgesetzt

- Masken (Formen) und Rauschunterdrückung
- Keyframe-Editor in der Timeline, Keyframes einzeln kopieren
- Smart Bins, Metadaten-Editor, Projekt archivieren (Medien sammeln), Cache-Verwaltung
- HDR, wählbare Farbmatrix für ungetaggte Quellen
- Native GPU-Pipeline (wgpu) für den Export
- Code-Signatur-Zertifikate (der Release-Workflow ist vorbereitet), Absturzberichte (bewusst ausgelassen)

Der Plan dafür steht in [ROADMAP.md](ROADMAP.md).
