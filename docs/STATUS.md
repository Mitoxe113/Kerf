# Status

Stand: 3. November 2026 · Version 0.1.0 (erstes Release, nur Windows) · nach Phase 8–10 (Titel, Effekte, Audio, Skalierung, Arbeitsumgebung), der Release-Vorbereitung, dem Kreativ-Ökosystem (Effekt-Browser, Typografie, Stockmedien) und den Schnittassistenten mit Projektverwaltung

Diese Liste ist absichtlich nüchtern. „Fertig“ heißt: implementiert, durch Tests abgedeckt **und** in der laufenden App durchgespielt (echte Maus- und Tastaturereignisse über das WebView2-DevTools-Protokoll oder echte IPC-Aufrufe an die Engine). Alles andere ist als teilweise oder offen markiert. Die Ausgangslage vor Phase 7 steht in [AUDIT.md](AUDIT.md).

## Release 0.1.0: Stabilisierung und Abnahme

**Plattform:** Veröffentlicht wird nur Windows (64 Bit). CI und Release-Workflow bauen und testen nur noch unter Windows; macOS und Linux werden nicht gebaut.

**Neu in dieser Runde, mit Tests:**
- Beenden fragt nach laufenden Exporten und Downloads, bricht sie ab, wartet bis zu 10 s auf das Ende aller Hintergrundaufträge und löscht unvollständige Dateien (3 Frontend-Tests).
- Unbekannte Angaben in Projektdateien (z. B. aus einer neueren Version) werden gemeldet; Überschreiben fragt nach (Rust-Test, 2 Frontend-Tests, keine Fehlmeldung bei den 10 Projekten der Pipeline-Tests). Messung mit 6.000 Clips (7,2 MB, Release-Build): Laden 51 ms, Prüfung 149 ms im Hintergrund, das Öffnen wartet nicht darauf.
- Fehler der Oberfläche, unbehandelte Promises und nicht ladbare Vorschau-Medien landen im Protokoll; eine Fehlergrenze um die ganze App bietet „Oberfläche neu laden“.
- `open_path` öffnet nur Dateien, die in dieser Sitzung fertig exportiert wurden.
- FFmpeg älter als 7 wird in Statusleiste und Export-Panel markiert, ein daran gescheiterter Export nennt den Grund (Versionserkennung mit 6 echten Versionszeilen getestet).
- *Über Kerf* zeigt Build-Kennung (Commit), Protokoll- und Datenordner; Einstellungen › Datenschutz beschreibt, was lokal bleibt und was nur auf Aktion übertragen wird.
- Lizenzübersicht aller 537 Rust-Crates und 11 npm-Pakete in [LICENSES.md](LICENSES.md), erzeugt mit `scripts/licenses.mjs`. `npm audit`: 0 Meldungen. `cargo audit` (0.22.2, nach dem Wechsel von `ttf-parser` zu `skrifa`): 0 Schwachstellen, 8 Warnungen (7 nicht mehr gepflegt: `proc-macro-error`, `zbus_names`, `zvariant`, `zvariant_derive`; 1 unsound: `glib`). Die Prüfung auf zurückgezogene Versionen scheiterte in der Prüfumgebung an einer 503-Antwort der Registry.

**Ende-zu-Ende-Test der Release-Version** (eigener Release-Build, echte Maus- und Tastatureingaben über XTest, echte GTK-Dateidialoge). Er lief unter Linux (Xvfb, WebKitGTK 2.52, FFmpeg 6.1.1 über einen Adapter für `-/filter_complex`), weil diese Umgebung kein Windows hat:

| Ablauf | Ergebnis |
| --- | --- |
| Start, neues Projekt, Import von 3 Dateien über den Dialog, Ziehen in die Timeline, Schnitt mit `Strg+K` | bestanden |
| Titel einfügen und Text ändern, Effekt (Vignette) per Ziehen auf einen Clip | bestanden |
| Speichern über den Dialog; zweites Speichern legt `.bak` mit dem vorigen Stand an | bestanden |
| Export über die Render-Warteschlange, Datei mit `ffprobe` geprüft: H.264 1280×720, 25 fps, AAC 48 kHz Stereo, 30,28 s (= Sequenzlänge), Titel und Vignette im Bild, Ton vorhanden; Prüfung nach dem Rendern bestanden | bestanden |
| Schließen während des Exports fragt nach („Aufträge laufen noch“), Abbrechen lässt den Export weiterlaufen | bestanden |
| Verlauf-Panel: Sprung zu einem früheren Schritt | bestanden |
| `kill -9` nach automatischer Sicherung, Neustart bietet den Stand an, Wiederherstellen enthält die letzte Änderung | bestanden |
| Sauberes Beenden ohne offene Aufträge, Neustart ohne Wiederherstellungsdialog, Öffnen über „Zuletzt geöffnet“ | bestanden |
| Programmmonitor zeigt Videobilder | **nicht bestanden unter Linux**: WebKitGTK spielt Medien über Tauris `asset:`-Protokoll nicht ab (`MediaError 4`, GStreamer `FormatError`), auch mit `gstreamer1.0-libav`; mit `file://` dekodiert derselbe Browser die Datei. Titel und Effekt-Vorschaubilder erscheinen. Unter Windows (WebView2, Medien über `http://asset.localhost`) ist die Wiedergabe laut Abschnitt *Fertig und verifiziert* in früheren Durchläufen in der laufenden App geprüft; in dieser Runde ließ sich Windows nicht bedienen. |

**CI-Lauf für Commit `c749c22` (Tag `v0.1.0`):** Tests unter Windows grün, darunter 16 von 16 Pipeline-Tests mit aktuellem FFmpeg, 30 Unit-Tests von kerf-media und 13 von kerf-library; der unsignierte CI-Installer baut.

**Veröffentlicht:** [Kerf 0.1.0](https://github.com/Mitoxe113/Kerf/releases/tag/v0.1.0), Tag `v0.1.0` auf Commit `c749c22`, gebaut vom Release-Workflow (manueller Lauf mit *publish*). Einziges Asset: `Kerf_0.1.0_x64-setup.exe` (6.071.370 Byte, SHA-256 `53b0bd0fc20fc7c4ff15286b251c5dacc962655d64e000e17170b75b8c8d2536`), ein NSIS-Installer. Nicht Authenticode-signiert (kein Zertifikat hinterlegt, das Security-Verzeichnis der Datei ist leer). Ohne Update-Daten: Der Updater-Schlüssel war nicht als Secret hinterlegt, deshalb gibt es kein Update-Paket und kein `latest.json` (die App meldet bei manueller Prüfung „Keine Updates gefunden“). Der veröffentlichte Installer selbst wurde in dieser Umgebung nicht unter Windows ausgeführt.

## Schnittassistenten und Projektverwaltung

Gleicher Prüfstand wie das Kreativ-Ökosystem: implementiert, durch automatische Tests (zum Teil mit echtem FFmpeg) abgedeckt, Oberflächen in Headless-Chromium mit simuliertem Backend gerendert. **In der laufenden Tauri-App bedient wurde davon nichts.** Keine Funktion schickt Medien an einen Dienst; alles läuft lokal über FFmpeg. Die Bestandsaufnahme und die bewusst ausgelassenen Teile stehen in [AUDIT.md](AUDIT.md#audit-phase-10-werkzeuge-und-projektverwaltung).

### Implementiert und automatisch geprüft

- **Szenenerkennung** (Panel *Assistent*): harte Schnitte über Histogrammabstand mit adaptiver Schwelle, Blitzunterdrückung, weiche Übergänge über die Erdbewegerdistanz, Mindestlänge. Ergebnis als Liste zum Abhaken; übernommen werden wahlweise Schnitte am Clip, Marker der Kategorie „Szenen“ oder neue Clips je Szene. Für Clips und für Medien im Medienpool, abbrechbar, mit Fortschritt.
- **Stille finden und entfernen**: RMS in 10-ms-Blöcken, Grundrauschen als 10. Perzentil, relative oder absolute Schwelle, Mindestdauer, Vor- und Nachlauf, kurze Geräusche überbrücken. Entfernen schneidet den Clip und seine verknüpften Partner und schließt die Lücken; alles ist ein Undo-Schritt.
- **Beat-Erkennung**: spektraler Fluss, Tempo per Autokorrelation, Beat-Verfolgung per dynamischer Programmierung; Taktbeginn nur, wenn er sich deutlich abhebt (sonst nicht angezeigt). Übernahme als Marker (alle Beats, starke Beats oder Taktanfänge).
- **Momente** (Highlights): Vorschläge aus Bewegung, Lautstärke und Schnittdichte, ausdrücklich als Vorschläge beschriftet, nicht als Qualitätsurteil.
- **Ducking**: Sprachbereiche aus Auslöser-Spuren, Absenkungskurve mit Attack, Hold und Release als Lautstärke-Keyframes auf den Zielclips; Vorschau der Kurve vor der Übernahme, vorhandene Lautstärke-Keyframes werden ausgewiesen, bevor sie ersetzt werden.
- **Marker**: Kategorie, Dauer (Bereichsmarker) und Kapitel-Kennzeichen; Panel *Marker* mit Suche, Filter, Umbenennen, Notiz, Farbe, Kapitel, Löschen. Neue Edit-Befehle `addMarkers`, `removeMarkers` und `batch` (mehrere Befehle als ein Undo-Schritt, ganz oder gar nicht).
- **Kapitel im Export**: Marker mit Kapitel-Kennzeichen werden als Kapitelspur in MP4/MOV geschrieben (FFmpeg-Metadatendatei, `-map_chapters`), im Einzel- und im segmentierten Export, nach dem Export-Bereich zugeschnitten. Schalter im Export-Panel, sichtbar sobald es Kapitelmarker gibt. Mit FFmpeg 6.1 in beiden Exportwegen per `ffprobe -show_chapters` geprüft.
- **Projektprüfung** (Panel *Projekt*): fehlende oder unlesbare Medien, fehlende Schriften, nötige Proxys, leere Sequenzen, ungewöhnliche Bildraten, ungerade Abmessungen, leere Bereiche (mit „Lücke schließen“ oder Springen), abweichende Bildraten der Quellen, sehr kurze und deaktivierte Clips, Marker hinter dem Ende. Sie meldet nur; jede Korrektur ist ein eigener Klick.
- **Neu verknüpfen**: Suche nach fehlenden Medien in gewählten Ordnern (Name und Größe, Name, Dateiname ohne Endung), die besten Treffer werden auf gleiche Dauer geprüft; Übernahme als ein Undo-Schritt. Begrenzt auf 300.000 Einträge und 16 Ebenen, überspringt versteckte Ordner und den Cache.
- **Projekt archivieren**: kopiert benutzte (wahlweise alle) Medien und LUTs in einen leeren Zielordner, schreibt ein Projekt mit relativen Pfaden und eine `ARCHIV.txt` (mit nicht mitkopierten Schriften), prüft Größen und liest das Projekt zurück. Kopien laufen über `.part`-Dateien; Abbruch, voller Datenträger und nicht leere Ziele werden gemeldet. Abgeleitete Dateien (Proxys, Wellenformen) werden nicht mitkopiert, sondern am Ziel neu erzeugt.
- **Portable Projekte**: Projektdateien dürfen relative Medienpfade enthalten (`portablePaths`); alte Projekte bleiben unverändert lesbar.
- **Cache-Verwaltung**: Größe je Art (Proxys, Miniaturen, Wellenformen, Sonstiges wie Vorschaudateien und Analysen) und davon ungenutzt, freier Speicher; Leeren je Art, wahlweise auch für geöffnete Medien (diese werden neu erzeugt). Nur Ordner mit Kerfs Fingerabdruck-Namen im Cache werden gelöscht, nie Originale oder Projektdateien.
- **Cache-Ordner und Größengrenze** (*Einstellungen › Cache*): Der Ordner wird in `cache.json` im Datenordner gespeichert und beim Start gelesen, weil die Vorschau nur Dateien aus dem beim Start freigegebenen Ordner laden darf; ist er dann nicht beschreibbar, nimmt Kerf den Standardordner und protokolliert das. Der alte Ordner bleibt unangetastet. Vorschaudateien außerhalb des aktuellen Cache gelten als fehlend und werden neu erstellt. Die Grenze (5 bis 200 GB oder unbegrenzt) gilt sofort und wird eine Minute nach dem Start und dann alle zehn Minuten geprüft: Einträge werden nach der letzten Schreibzeit gelöscht, älteste zuerst, nur bis der Cache passt, nie die der Medien im geöffneten Projekt. Rust-Tests mit echten Dateien und Schreibzeiten; die Einstellungen im Browser mit simuliertem Backend bedient, in der Tauri-App unter Windows noch nicht von Hand.
- **Metadaten**: vollständige `ffprobe`-Ausgabe je Medium mit Farbunterabtastung und Bittiefe. Darüber bearbeitbar: Name, Favorit, Farbe, Tags und Notiz; bei mehreren Medien Favorit und Farbe für alle sowie Tags für alle hinzufügen oder entfernen (ein Undo-Schritt). Tags höchstens 64 je Medium mit je 60 Zeichen, Notizen höchstens 10.000 Zeichen.
- **Intelligente Ablagen (Smart Bins)**: zeigen alle Medien des Projekts, die ihre Regeln erfüllen (Typ inklusive Titel, Text in Name, Notiz oder Tag, alle Tags, Farbe, Favorit, in Sequenzen verwendet oder nicht, offline). Sie enthalten selbst nichts; Verschieben in eine solche Ablage lehnt der Kern ab, Import und neue Ablagen landen daneben. Die Suche im Medienbrowser findet jetzt auch Notizen und Tags.

## Kreativ-Ökosystem (Effekte, Typografie, Stockmedien)

Dieser Abschnitt hat einen anderen Prüfstand als „Fertig und verifiziert“: Alles hier ist implementiert und durch automatische Tests abgedeckt, die Oberflächen wurden in Headless-Chromium mit simuliertem Backend gerendert. **In der laufenden Tauri-App bedient wurde davon nichts**, und **kein Medienanbieter wurde live angefragt** (siehe unten).

### Implementiert und automatisch geprüft

**Effekte**
- **Effekt-Katalog mit 39 Effekten** (`kerf_core::fx`) in Farbe, Unschärfe, Licht, Verzerren, Stil, Keying und Form, jeweils als WebGL-Pass in der Vorschau und als FFmpeg-Filter im Export. `scripts/fx-parity.mjs` (Bericht in `fixtures/effects/parity-report.json`): 12 Effekte bitgenau, 23 mit höchstens 3 Stufen Abweichung; die 4 auf der Gauß-Unschärfe aufbauenden (Tilt-Shift, Weichzeichnung, Leuchten, Schlagschatten mit weicher Kante) haben einzelne Ausreißer von 12 bis 65 Stufen bei höchstens 1,71 % der Werte über 2 Stufen, wie der Gaußsche Weichzeichner selbst (19).
- **Animierbare Effektparameter:** Keyframes (Stoppuhr, Raute, vorheriger/nächster, Interpolation per Rechtsklick) im Inspector für den Radius des Gaußschen Weichzeichners, die Stärke der Vignette, den Versatz der Freiform-Maske und 11 Katalog-Effekte: Dynamik, Zoom-Weichzeichner, Welle, Strudel, Wölben und Kneifen, Objektivverzerrung, Zeilenraster, Filmkorn, Kanten finden, Luma-Key, Formmaske (Mittelpunkt, Größe, weiche Kante). Keys liegen wie bei Clips auf Quellpositionen (`Effect.keys`), Werte werden auf den Bereich des Parameters begrenzt. Die Vorschau wertet sie je Bild mit `Clip::effect_at` aus; der Export schreibt die Ausdrücke der Clip-Keyframes in `geq` und `vignette` (`eval=frame`) und schickt dem Weichzeichner je geändertem Bild `sigma` und `sigmaV` per `sendcmd`. Pipeline-Test `animated_effects_match_their_values_per_frame`: 7 Fälle, je Bild 0, 17, 33 und 49 kein einziger abweichender Wert gegenüber einem Standbild-Export mit den festen Werten dieses Bildes.
- **Freiform-Maske:** 3 bis 32 Punkte, im Programmmonitor bearbeitet (Punkte ziehen, Doppelklick auf eine Kante fügt ein, Rechtsklick entfernt), weiche Kante nach innen, Umkehren, Versatz animierbar; Startformen Rechteck, Ellipse (16 Punkte), Dreieck. Der Export rastert die Maske einmal je Form und Größe als PGM in den Cache (`kerf_media::mask`) und multipliziert das Alpha damit; die Vorschau rastert dieselbe Maske mit derselben Arithmetik und lädt sie als Textur. Die Innen-Prüfung rechnet mit Ganzzahlen auf einem 1/256-Pixel-Raster, damit Gleitkomma-Unterschiede an Kanten keine Rolle spielen. `fx-parity`: 0 Abweichung in beiden Fällen (weich, umgekehrt und verschoben).
- **Panel „Effekte“:** Suche (deutsche Namen und englische IDs), Kategorien, Favoriten, zuletzt verwendet, eigene Presets; Vorschaubilder aus der echten Effekt-Pipeline an einem Testbild; Ziehen auf Timeline-Clips oder Doppelklick für die Auswahl (`addEffects`, ein Rückgängig-Schritt für mehrere Clips).
- **Effekt-Stapel im Inspector:** Parameter aus dem Katalog, Umbenennen, Zurücksetzen, Duplizieren, Kopieren/Einfügen (`Strg+Alt+C/V`), Bypass je Clip, Vorher/Nachher (`Strg+Alt+B`), als Preset speichern. Presets liegen in `library.db` (SQLite, versionierte Migrationen) und lassen sich als `.kerfpreset` exportieren und geprüft importieren.
- **Mischmodi je Clip** (Normal, Multiplizieren, Negativ multiplizieren, Ineinanderkopieren, Addieren, Aufhellen, Abdunkeln, Differenz): Vorschau und Export mit derselben 8-Bit-Ganzzahlrechnung, `scripts/transition-parity.mjs` misst 0 Abweichung je Modus.
- **Masken-Übergänge** Iris rund und eckig, Uhrzeiger, Türen horizontal und vertikal, diagonal, Jalousie: eine Maskenformel für Shader und `geq`, 0 abweichende Pixel bei 10, 25, 50 und 80 % Fortschritt. Übergangs-Presets im Inspector.

**Typografie**
- **Schriften:** zwei mitgelieferte (OFL-1.1), Systemschriften (nur gelesen) und importierte Schriften. Import nur `.ttf`/`.otf`, geprüft durch Parsen, abgelegt in Kerfs eigenem Schriftordner (nach Inhalt benannt), **nicht systemweit installiert**; nur Kerfs WebView lädt sie per `@font-face`. Lizenz, Lizenz-URL, Gestalter und OS/2-Einbettungsrechte stammen aus der Schriftdatei und werden ohne rechtliche Bewertung angezeigt.
- **Fehlende Schriften** werden nicht still ersetzt: Der Inspector warnt, und vor dem Export fragt ein Dialog, ob mit der Ersatzschrift gerendert werden soll.
- **Textstil:** Laufweite, Schriftstärke 100 bis 900, Groß-/Kleinschreibung, Farbverlauf mit Winkel, Schattenfarbe, Deckkraft und Versatz (auch harter Schatten), Leuchten. Ältere Projekte laden unverändert (`serde(default)`).
- **Textanimation** je Zeichen, Wort oder Zeile: Einblenden, Schieben aus vier Richtungen, Skalieren, Schreibmaschine, Auseinanderlaufen; Eingang und Ausgang mit Dauer, Versatz und Kurve. Der Export rendert animierte Titel als PNG-Folge mit demselben Zeichencode (`ffconcat`, unveränderte Bilder einmal gezeichnet); Pipeline-Test `animated_title_frames_render`.
- **Titelvorlagen:** sieben eingebaute (Mitte, Bauchbinde, Oben, Kino, Schreibmaschine, Neon, Verlauf) und eigene, gespeichert als geprüfte `titleTemplate`-Presets.

**Stockmedien**
- **Anbieter:** Pexels (Fotos, Videos), GIPHY (GIFs, geladen als MP4), Freesound (HQ-MP3-Vorschau), Openverse (Bilder, Audio). Endpunkte, Parameter und Felder stammen aus den offiziellen Client-Bibliotheken der Anbieter (`pexels-javascript`, `giphy-js`, `freesound-python`) bzw. aus dem Quellcode der Openverse-API.
- **API-Schlüssel** liegen im Schlüsselspeicher des Betriebssystems (`keyring`: Keychain, Windows-Anmeldeinformationsverwaltung, Secret Service) oder auf Wunsch nur für die Sitzung im Speicher. Die Oberfläche bekommt sie nie zurück.
- **Downloads:** Das Frontend nennt nur Anbieter und Treffer-ID; die URL stammt aus der API-Antwort, die das Backend selbst geholt hat. Nur HTTPS, Datei-Hosts je Anbieter auf einer Allowlist (Openverse: Host der Quelle aus der Antwort), jede Weiterleitung wird neu geprüft, keine IP-Adressen oder lokalen Hosts, Größenlimits, Inhaltsprüfung über die ersten Bytes (Programme, Archive, HTML und SVG werden abgelehnt), Schreiben in eine `.part`-Datei und Umbenennen, Dateinamen nach Inhalt (kein doppelter Download), Abbruch, zwei gleichzeitig. Nichts Heruntergeladenes wird ausgeführt oder entpackt.
- **Lizenzen:** Creative-Commons-Codes nach der Gruppierung der Openverse-API (kommerziell nur ohne „NC“, Bearbeitung nur ohne „ND“); GIPHY immer „unklar“ für kommerzielle Nutzung; unbekannte Lizenzen nie „erlaubt“. Filter „Nur kommerziell nutzbar“ (bei Openverse zusätzlich `license_type=commercial` an die API).
- **Bibliothek** (SQLite): heruntergeladene Assets mit Lizenzdaten, Favoriten, Filter, Kennzeichnung fehlender Dateien, Löschen (Datei nur innerhalb von Kerfs Asset-Ordner).
- **Projekt:** „Zum Projekt“ nutzt den normalen Medienimport, „Am Playhead einfügen“ wartet auf die Analyse und setzt per Insert. Vor dem Export ein Hinweis, wenn heruntergeladene Medien keine kommerzielle Erlaubnis haben oder Namensnennung verlangen.
- **Lizenzbericht** des Projekts als HTML, TXT, CSV oder JSON: Lizenzangaben je Datei, Dateien ohne Daten als solche markiert, Liste der Namensnennungen. CSV gegen Formel-Injektion, HTML maskiert, nur http(s)-Links. Der Bericht ist ausdrücklich keine Rechtsberatung.

### Nicht geprüft, teilweise oder offen

- **Keine Live-Integration bestätigt.** In dieser Arbeitsumgebung lehnte der Netzwerk-Proxy `api.pexels.com`, `api.giphy.com` und `api.openverse.org` ab; `freesound.org` wurde nicht angefragt. Getestet ist alles gegen einen lokalen Mock-Server und gegen Beispielantworten im Format der offiziellen Clients. Kein Anbieter gilt deshalb als vollständig integriert, bis er mit echten Schlüsseln geprüft ist.
- **Pixabay** ist nicht umgesetzt: Die Dokumentation war hier nicht erreichbar, und ohne sie werden keine Endpunkte angenommen.
- **Freesound:** Mit API-Schlüssel sind nur die Vorschau-MP3s ladbar; Originaldateien brauchen OAuth2, das nicht umgesetzt ist.
- **Pexels-Datei-Hosts:** Die Allowlist erlaubt nur `*.pexels.com`. Liefert die API Video-Links auf anderen Hosts, wird der Download abgelehnt; das ist ungeprüft. Die Einstufung „kommerziell erlaubt“ folgt der Pexels-Lizenz, deren Seite in dieser Sitzung nicht abrufbar war; inhaltliche Einschränkungen (Personen, Marken) kann Kerf nicht prüfen.
- **GIPHY:** „Powered By GIPHY“ steht als Text unter den Treffern, nicht als offizielles Logo. Sticker und die Altersfreigabe als Einstellung fehlen (fest „g“).
- **Openverse:** Die Audiodauer aus der API wird nicht übernommen (Einheit nicht aus dem Quellcode belegbar); Kerf misst sie nach dem Import.
- **Linux:** Ohne laufenden Secret Service (GNOME Keyring, KWallet) lässt sich ein Schlüssel nur für die Sitzung merken.
- **Downloads** werden nicht fortgesetzt und überleben keinen Neustart. Sammlungen gibt es im Backend, aber noch ohne Oberfläche. Stockmedien lassen sich nicht direkt in die Timeline ziehen (Umweg über die Projektmedien oder „Am Playhead einfügen“).
- **Schriften:** Schriftsammlungen (`.ttc`/`.otc`) sind nicht importierbar; Systemschriften werden über ihren Namen von der WebView aufgelöst; Online-Schriften (z. B. Google Fonts) fehlen; variable Achsen außer der Stärke sind nicht einstellbar.
- **Effekte:** Effekt-Keyframes gibt es nur im Inspector (kein Gummiband in der Timeline, kein Kopieren/Einfügen einzelner Effekt-Keyframes, kein Kurveneditor für sie) und nur für einen ausgewählten Clip; Stufen, Auswahlen und Farben sind nicht animierbar. Die Punkte der Freiform-Maske sind nicht animierbar, nur ihr Versatz, und der Versatz wirkt in ganzen Pixeln. Ein animierter Weichzeichner-Radius bekommt im Export höchstens für 200 000 Bilder je Clip einen eigenen Wert, danach bleibt der letzte. Punkt-Parameter von Katalog-Effekten haben keine Auswahl im Monitor; Mischmodi wirken nicht innerhalb von Übergängen; optischer Fluss ist nicht umgesetzt.
- **Plugin-Grundlage** ist nicht umgesetzt.

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
- **Verschachtelte Sequenzen:** Sequenzen lassen sich wie Medien platzieren (Tab in die Timeline ziehen), *Verschachteln* packt die Auswahl samt verknüpfter Partner in eine neue Sequenz. Zyklusschutz, verwendete Sequenzen sind nicht löschbar, Doppelklick öffnet die innere Sequenz an der Stelle. *Verschachtelung auflösen* (Compound Clips) legt die Clips des gezeigten Bereichs zurück, jede innere Spur auf eine eigene Spur; abgelehnt wird mit Begründung, wo das Bild oder Ton ändern würde. Ein Pipeline-Test rendert zwei Ebenen verschachtelt und aufgelöst: höchstens 2 Stufen Abstand je Kanal (Mittel 0,06, nach H.264 mit CRF 12), gleicher Tonpegel.
- **Einstellungsebenen:** ein Medium ohne Datei (`MediaAsset::adjustment`), das als Clip auf einer Videospur das Komposit der Spuren darunter durch seine Farbkorrektur, Effekte, Deckkraft, Blenden und seinen Mischmodus schickt; die Bewegung wird ignoriert, Übergänge an der Ebene verwirft Kerf. Im Export teilt `split` das Komposit, die Kopie läuft durch die Kette des Clips und zurück per `overlay`; in einer verschachtelten Sequenz behält das Komposit seinen Alpha-Kanal. Die Vorschau kopiert das Komposit in eine Textur und zeichnet sie ebenso. Gemessen (Pipeline-Test, H.264): Grau 128 wird mit +1 EV, Vignette und 50 % Deckkraft zu 190,2, die Ecke zu 64,0, ein weißes Kästchen darüber bleibt 253,6; verschachtelt bleibt das Grau darunter 128,0, das abgedunkelte Kästchen ergibt 126,6 (mit Vignette 18,3). Der Compositor in Chromium (WebGL2, SwiftShader) liefert für dieselben Fälle 190,5, 64, 255, 128, 128 und 19,9. Segmentiert gleich einem Stück (schlechtestes Bild 45,99 dB PSNR). Eine Verschachtelung mit Einstellungsebene im gezeigten Bereich löst Kerf nicht auf. In der Tauri-App unter Windows noch nicht von Hand geprüft.
- **Multicam:** Gruppen aus mehreren Kameras einer Aufnahme, Synchronisation über den Ton (Einsatz-Hüllkurve per FFT-Kreuzkorrelation, auf Sample-Ebene verfeinert) oder am Anfang. Kamerawechsel ab dem Playhead mit `1`–`9` oder Klick im Multicam-Panel, auch live während der Wiedergabe; Keyframes wandern mit.

**Keyframes**
- Animierbar: Position, Skalierung, Rotation, Deckkraft, Lautstärke, Geschwindigkeit sowie **Belichtung, Kontrast, Sättigung, Temperatur und Tönung**.
- Interpolation linear, Ease-In/-Out/-In-Out, Halten und **eigene Bezier-Kurven** (wie CSS `cubic-bezier`) mit Kurveneditor, Vorgaben und Bewegungsvorschau. Rust und TypeScript rechnen identisch, geprüft gegen Referenzwerte der WebView2 (Web Animations API).
- Keyframes hängen an der Quellposition: Trimmen und Teilen verschieben sie nicht.
- **Lautstärke-Gummiband** auf Audioclips in der Timeline: die Lautstärke als Linie über der Wellenform (Höhe nach der Wurzel der Verstärkung wie die Wellenform: 0 dB auf halber Höhe, +12 dB oben, Stille unten). Linie ziehen ändert die Lautstärke, mit Keyframes die beiden Keyframes um die Stelle; Keyframe-Punkte einzeln ziehen; Strg+Klick setzt oder entfernt einen Keyframe; Umschalt fein. Werte über +12 dB (erlaubt bis +24 dB) liegen am oberen Rand.
- **Keyframes kopieren und einfügen:** Rechtsklick auf die Raute im Inspector (oder auf einen Lautstärke-Punkt in der Timeline) kopiert Wert und Interpolation; eingefügt wird am Playhead (Inspector) oder an der Klickstelle (Timeline), auch in einen anderen Clip.
- Export: Bewegung über `perspective`, Deckkraft und Farbe über `sendcmd`, Lautstärke über `volume`-Ausdrücke; Bezier-Kurven als stückweise lineare Ausdrücke (bis 32 Stücke).

**Effekte und Farbe**
- **Effekt-Stapel pro Videoclip** (rückgängig machbar): Weichzeichner, Schärfen, Vignette, **3D-LUT** (`.cube`, trilinear, Intensität), **Chroma-Key** (mit Pipette und Spill-Unterdrückung), **Farbräder** (Lift/Gamma/Gain) und **Kurven** (PCHIP, Master und je Kanal) im Farbe-Tab.
- Vorschau (WebGL2) und Export (FFmpeg) rechnen dieselbe Mathematik; die Kurven sind gegen die Tabellen von FFmpegs `curves` getestet.
- **Überwachte Ordner** (bis zu 16 je Projekt, im Projekt gespeichert, Hinzufügen und Entfernen rückgängig machbar): Die App liest die Ordner alle 3 s (`watch_scan`, höchstens 20 000 Einträge je Ordner, Unterordner bis 8 Ebenen) und importiert neue Mediendateien in die gewählte Ablage, wenn zwei Lesungen hintereinander dieselbe Größe und Änderungszeit zeigen. Jede Datei wird höchstens einmal von selbst importiert; was beim Öffnen schon im Ordner lag, wird gemeldet und mit *Abgleichen* importiert. Wird die Ablage gelöscht, gehen die Importe in die übergeordnete; Laden repariert doppelte Ordner und Verweise auf fehlende Ablagen. Geprüft mit Rust-Tests (Befehle, Undo, Reparatur, Auflisten echter Dateien), Fuzz-Test, 3 Vitest-Tests der Entscheidung und im Browser mit simuliertem Backend; in der Tauri-App unter Windows noch nicht von Hand.
- **Farbmatrix wie in der Vorschau, wählbar je Video:** Der Export liest Y'CbCr mit der Matrix, mit der die Vorschau dekodiert, und setzt dafür vor der RGB-Umrechnung `setparams`. In Chromium (Playwright-Build, Linux, Software-Dekodierung) mit einer einfarbigen Fläche gemessen: Ohne gültigen Tag dekodieren H.264 und VP8 ab 720 Zeilen als BT.709 (1280×718 schon als BT.601, 960×720 als BT.709), darunter als BT.601; VP9 und AV1 immer als BT.601. Einen Matrix-Tag beachtet VP9 auch allein, H.264, VP8 und AV1 nur zusammen mit Primärfarben und Übertragung. Proxys (H.264, höchstens 720 Zeilen) übernehmen die Tags der Quelle; zeigt die Vorschau den Proxy statt des Originals, gleicht ein 3×3-Shader (Programmmonitor) bzw. ein SVG-Farbfilter (Quellmonitor, Multicam) den Unterschied aus. Im Panel *Projekt › Metadaten* lässt sich je Video *Automatisch*, *BT.601* oder *BT.709* wählen (rückgängig machbar, auch für mehrere Videos), nicht für andere Tags wie BT.2020. Gemessen in Chromium mit Ziel BT.601 = 192/31/95 und BT.709 = 205/50/95 (FFmpeg-Dekodierung): Programmmonitor und Quellmonitor treffen jede Wahl auf höchstens 1 Stufe genau, auch für VP9 über den Proxy. Pipeline-Test `matrix_choice_reads_untagged_video`: Automatisch und BT.601 verschieben den Export genau um den Unterschied der Matrizen (±1,5), ungetaggtes VP9 bleibt BT.601.

**Titel und Untertitel**
- Titel als erzeugte Medien: Text, Schrift, Kontur, Schatten, Hintergrund, Vorlagen (Mitte, Bauchbinde, Oben). Vorschau und Export zeichnen mit demselben Code.
- Untertitel pro Sequenz: Panel mit Zeiten und Text, eigene Spur in der Timeline, Stil und Abstand. Import und Export von **SRT und WebVTT** (UTF-8 oder Windows-1252).
- Export: einbrennen (bildgenau), als `mov_text`-Spur einbetten oder als SRT/VTT-Datei neben dem Video.

**Übergänge**
- Blende, Abblende über Farbe, Wischen und Audio-Kreuzblende; Lage Mitte/ab/bis Schnitt, höchstens die halbe Länge jedes Clips. Standard-Übergang mit `Strg+Umschalt+D`, verknüpftes Audio bekommt eine Kreuzblende.
- Beide Clips laufen mit echten Handles in den Übergang (sonst stehendes erstes/letztes Bild). Parität Vorschau ↔ Export im Mittel 1,4–2,6 Tonwerte auf 9 Fällen.
- **Schieben (Push) und Hereingleiten (Slide)** in vier Richtungen: Der eingehende Clip folgt der Kante des gleichgerichteten Wischens (floor(Größe · Fortschritt) Pixel), beim Schieben bewegt sich der ausgehende Clip mit. Bewegt werden nur die beiden Clips, Spuren darunter bleiben stehen. Verschiebung in ganzen Pixeln; Vorschau gegen Definition bei 10, 25, 50 und 80 % ohne Abweichung (`scripts/transition-parity.mjs`), Export mit echtem FFmpeg in Pipeline-Test geprüft.

**Audio**
- **Clip- und Spureffekte:** parametrischer EQ (Hoch-/Tiefpass, Shelves, Glocke), Kompressor, Noise-Gate, Limiter. Die Vorschau rechnet mit Ports derselben FFmpeg-Filter im AudioWorklet (Abweichung < 1e-5 gegen FFmpegs Ausgabe).
- **Kanalzuordnung** pro Clip (Stereo, Mono, nur links/rechts, getauscht), Mono-Spuren, Panorama in Vorschau und Export gleich. Spuren mit Effekten oder Mono werden einzeln gemischt (Summe → Effekte → Regler).
- **Rauschunterdrückung** je Audioclip (FFmpeg `afftdn`, Inspector): Stärke, Rauschpegel, Nachführen und ein Rauschprofil (15 Bänder), das aus dem Bereich zwischen In- und Out-Punkt gelernt wird. Der entrauschte Ton wird einmal je Medium und Einstellung als WAV (32 Bit Gleitkomma) in den Medien-Cache gerechnet; Vorschau und Export lesen dieselbe Datei, der Export rechnet fehlende Dateien vorab (Fortschritt „Rauschunterdrückung“). Bis die Datei fertig ist, spielt die Vorschau den Originalton und sagt das an. Pipeline-Test `noise_reduction_renders_the_cached_sound` mit FFmpeg 6.1: Export gleich Cache-Datei (Abweichung höchstens 1,5/32768), Rauschen von −44,4 auf −52,8 dBFS bei unverändertem Ton (−21,1 dBFS), mit gelerntem Profil 5,4 dB weniger Rauschen als mit dem Standardprofil (−47,4 dBFS), zweiter Export ohne neue Berechnung. Chromium spielt die Cache-Datei ab; in WebView2 unter Windows noch nicht von Hand geprüft.
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
- **Stapel-Export:** mehrere Vorgaben (auch eigene) ankreuzen, einen Ordner wählen; je Vorgabe ein Auftrag in der Render-Warteschlange („<Sequenz> - <Vorgabe>.mp4/.mov“, eindeutige Namen). Vorhandene Dateien werden vor dem Start genannt und nur nach Bestätigung ersetzt; Speicherplatz wird für die Summe geprüft. In Headless-Chromium mit simuliertem Backend durchgespielt (3 Aufträge mit den Einstellungen der Vorgaben), nicht in der Tauri-App.
- Größenschätzung und Speicherplatzprüfung, Render-Warteschlange mit Fortschritt, Restzeit, Abbruch, Erneut versuchen, Datei öffnen, Im Explorer zeigen, Protokoll; **Prüfung nach dem Rendern** (Dauer, Auflösung, Bildrate, Codecs, Kanäle, EBU R128).

**Arbeitsumgebung**
- **Andockbare Panels:** Panels per Tab oder Titelzeile ziehen, in die Mitte oder Tableiste eines Bereichs (als Tab) oder an einen Rand (neuer Bereich daneben). Die Zielzone wird angezeigt, `Esc` bricht ab; leere Bereiche geben ihren Platz an den Nachbarn ab. Layouts bleiben gespeichert.
- Suche und Befehle (`Strg+P`), Einstellungen (`Strg+,`), Tastaturprofile mit Import/Export, eigenes dunkles Design, alle Menüpunkte an echte Aktionen gebunden.
- **Makros:** Befehle aus der Aktions-Registry aufzeichnen oder zusammenstellen, umbenennen, ordnen; ausführen über Befehlspalette, Dialog oder *Makro 1 ausführen* bis *Makro 9 ausführen*. Jeder Schritt wartet, bis die Änderungen des vorigen beim Backend angekommen sind, ist ein eigener Rückgängig-Schritt, und das Makro hält beim ersten Befehl an, der nicht möglich ist. In Headless-Chromium mit simuliertem Backend durchgespielt (Aufzeichnen, Speichern, Ausführen aus der Befehlspalette: Marker und Schnitt kamen in dieser Reihenfolge an), nicht in der Tauri-App.

**Verteilung und Updates**
- **Windows-Installer (NSIS)** auf diesem System installiert, aktualisiert und deinstalliert: Installation pro Benutzer ohne Adminrechte, Startmenü-Eintrag, Dateizuordnung. Die Deinstallation entfernt Programm, Startmenü-Eintrag, Uninstall-Eintrag und Dateityp und stellt eine vorher vorhandene Zuordnung von `.kerf` wieder her; Benutzerdaten (Wiederherstellung, Versionen) bleiben erhalten.
- **Automatische Updates** über GitHub-Releases, signiert mit einem eigenen Updater-Schlüssel (minisign). Ende-zu-Ende geprüft mit zwei signierten Builds (0.1.0 → 0.1.1) gegen einen lokalen Update-Server: Prüfung beim Start, Dialog mit Version, Datum und Hinweisen, Download, Signaturprüfung, Installation im passiven Modus, Neustart als 0.1.1. Ist beim Start schon ein Dialog offen (z. B. Wiederherstellung), erscheint das Angebot, sobald er geschlossen ist. Abschaltbar in den Einstellungen, *Hilfe › Nach Updates suchen …* prüft von Hand.
- **CI auf GitHub Actions** unter Windows: Typprüfung, Frontend-Tests, Clippy, alle Rust-Tests einschließlich der Pipeline-Tests mit echtem FFmpeg (ein fehlendes FFmpeg lässt den Lauf scheitern statt Tests zu überspringen) und der unsignierte Installer als Artefakt.
- **Release-Workflow:** Ein Tag `v…` oder ein manueller Lauf mit *publish* baut den Windows-Installer und veröffentlicht das Release nach erfolgreichem Build; fehlt das Tag, legt er es auf dem gebauten Commit an. Update-Paket und `latest.json` entstehen nur mit hinterlegtem Updater-Schlüssel, Code-Signing nur mit hinterlegtem Zertifikat. So entstand 0.1.0 (siehe *Release 0.1.0*).
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
| `kerf-core` Unit | 94 | Zeit/Timecode, alle Edit-Befehle (inkl. `addEffects`, `addMarkers`, `batch`), Verschachtelung auflösen (zurück an den Platz, Teilbereich, neue Spuren, Ablehnungen), Einstellungsebenen (Prüfung, keine Datei, keine Übergänge), überwachte Ordner, Farbmatrix der Vorschau je Codec und Tag (die in Chromium gemessenen Fälle) und ihre Wahl je Video, intelligente Ablagen und Reparatur kaputter Ablage-Verweise beim Laden, Effekt-Keyframes und Freiform-Masken, Ducking-Kurve, Archiv, Zeitabbildung (Rampen, Rückwärts), Übergänge und Masken, verschachtelte Sequenzen, Multicam, Untertitel, Textstil und Animation, Keyframes inkl. Bezier, Undo, Projektdatei inkl. unbekannter Felder und unterbrochenem Speichern |
| `kerf-core` Parität | 1 | Farbmatrix gegen gemeinsame Fixture |
| `kerf-core` Fuzz | 1 | Zufällige Befehlsfolgen über `History` (300 Seeds, `KERF_FUZZ_SEEDS` für mehr; 40 000 bestanden, nach dem Hinzufügen der Medien- und Ablagebefehle 5 000, mit *Verschachtelung auflösen* 20 000, mit Einstellungsebenen 20 000): nach jedem Schritt sortierte Clips, keine Übergänge an Einstellungsebenen, gültige Ablage-Verweise (auch der überwachten Ordner), jedes gezeigte Bild im Medium, gültige Geschwindigkeiten, Blenden, Keyframes, Übergänge, Marker und Untertitel, exaktes Undo/Redo, unverändertes Projekt nach Fehlern, verlustfreies JSON |
| `kerf-media` Unit | 38 | Probe-Parsing, FFmpeg-Versionserkennung, Filtergraph, Rauschunterdrückung (Filter, Cache-Name, Profil aus dem Protokoll), Rasterung der Freiform-Maske (Kreuzungsregel, weiche Kante, Verschiebung, Kante genau auf einem Pixel), CBR/Mono/Letterbox, EBU-R128-Parser, Teilgrenzen und Plan des segmentierten Exports, Titel-Folgen, Kapitel, Szenen/Stille/Beats/Momente an synthetischen Signalen |
| `kerf-media` Erkennung | 1 | Echtes FFmpeg: Schnitte bei 2 s und 4 s, Bereichsanalyse, Stille 1,5–3 s, Abbruch |
| `kerf-media` Pipeline | 21 | Echtes FFmpeg: Schnitt → Render → Pixelprüfung, Abbruch, Keyframes, animierte Farbe, Farbmatrix ungetaggter Videos (H.264 und VP9, automatisch und gewählt), Effekt-Stapel, animierte Effektparameter und Freiform-Masken je Bild, Lautheit, Untertitel, Übergänge inkl. Masken, Schieben und Hereingleiten, Mischmodi, animierte Titel, Audio-Effekte und Loudnorm, Rauschunterdrückung mit gelerntem Profil, Rückwärts und Rampen, verschachtelte Sequenzen (auch aufgelöst: derselbe Export), Einstellungsebenen (auch verschachtelt), Multicam-Synchronisation, segmentiert = ein Stück (inkl. Kapitel und Einstellungsebene) |
| `kerf-library` | 13 | Migrationen, Presets (Prüfung, Export/Import), Favoriten, Recents, Titelvorlagen, Assets und Sammlungen, Schriften (Import, Ablehnung, Entfernen) |
| `kerf-assets` | 10 | Anbieter-Parser, Lizenzzuordnung, URL-Regeln, Inhaltsprüfung, Berichte; Mock-Server: Suche, Schlüssel, Download, abgelehnte Inhalte und Weiterleitungen, Abbruch, 429 |
| App-Crate | 11 | Auflisten überwachter Ordner (ohne Kerfs eigene Ordner), Cache-Einstellungen und Aufräumen nach Größe, Versionen, Projektdatei-Argument, Endung beim Speichern, Untertitel-Kodierung, Datumsformat, Relink-Suche, Wiederherstellung nach Absturz |
| Frontend (Vitest) | 140 | Timecode, Importentscheidung der überwachten Ordner, Farbmatrix der Vorschau und ihre Korrektur, Regeln der intelligenten Ablagen, Dateinamen des Stapel-Exports, Timeline-Constraints, Lautstärke-Gummiband, Lernbereich des Rauschprofils, Keyframes/Easing/Bezier, Zeitabbildung, Effekte und Kurven, Effekt-Keyframes, Rasterung der Freiform-Maske mit den Werten der Rust-Tests, Audio-DSP gegen FFmpeg-Fixtures, Textsatz und Textanimation, Deltas, Docking, unscharfe Suche, Tastaturprofile, Assistenten-Befehle (Bereiche entfernen, Marker, Szenen), Projektprüfung (auch HDR-Erkennung), Beenden mit laufenden Aufträgen, unbekannte Projektfelder, Codec-Prüfung der Vorschau, Makros (Laden, Aufzeichnen, Ausführen mit Anhalten) |

In dieser Arbeitsumgebung lief die Pipeline mit FFmpeg 6.1 über einen Adapter für `-/filter_complex`: 20 von 21 bestanden, `reverse_and_speed_ramps_render` scheitert nur dort (Rampen-Frame 116 statt 115). Mit aktuellem FFmpeg in der CI unter Windows bestand dieser Test in jedem Lauf, zuletzt für Commit `9867ea9` mit damals 17 Pipeline-Tests. Zusätzlich gibt es einen Zeitmesstest für große Projekte (`cargo test -p kerf-core --release --test large_project -- --ignored --nocapture`).

Alle Tests laufen in der CI unter Windows.

**QA-Durchlauf Release-Vorbereitung** (installierte App): signierter Build installiert · Dateizuordnung im Registry geprüft · `.kerf` per Shell geöffnet bei laufendem und bei geschlossenem Kerf · Datei-Drop importiert · Update beim Start gefunden, installiert, Neustart als neue Version · Schließen mit ungespeicherten Änderungen fragt nach · Deinstallation mit und ohne vorher vorhandene Zuordnung.

**Gefundene und behobene Fehler (Phase 8 bis Release-Vorbereitung):** Ein segmentierter Teil begann ein Bild zu früh, weil `setpts` Verschiebungen abschneidet statt rundet (8,44 s = 210,99… Bilder); behoben in allen vier Ausdrücken, Regressionstest. Blenden, die vor dem Export-Bereich beginnen, starteten neu statt weiterzulaufen. Das Schärfen im Export lief über 8 Bit hinaus. Die Wiedergabe positionierte Elemente wegen der Seek-Latenz immer wieder neu. Nach einem Update merkte sich der Installer Kerfs eigenen Dateityp als „vorherige“ Zuordnung, die Deinstallation hinterließ dann einen verwaisten Eintrag (Installer-Hooks). Das Update-Angebot beim Start ging als kurze Meldung hinter dem Wiederherstellungsdialog unter.

## Bekannte Einschränkungen

- **Explorer-Drop und native Dateidialoge** wurden nicht mit echten Betriebssystem-Eingaben ferngesteuert (die Bildschirmsteuerung wurde für diesen Test nicht freigegeben). Geprüft sind der Drop-Handler mit Tauris Drop-Ereignis und die Aktionen hinter den Dialogen mit festen Pfaden.
- **Nur Windows:** macOS und Linux werden nicht gebaut und nicht getestet. Unter Linux spielte der Programmmonitor im Test keine Videos ab (siehe *Release 0.1.0*).
- **Code-Signing:** Der Installer von 0.1.0 ist nicht Authenticode-signiert (SmartScreen-Hinweis beim ersten Start). Die Update-Funktion installiert unabhängig davon nur Pakete mit gültiger Updater-Signatur.
- **Updates über GitHub:** 0.1.0 enthält keine Update-Daten. Wirksam wird der Weg erst mit einem späteren Release, das mit dem zum öffentlichen Schlüssel in `tauri.conf.json` passenden privaten Schlüssel gebaut wurde. Geprüft ist er gegen einen lokalen Server, über GitHub noch nicht.
- **Export:** weiterhin ein FFmpeg-Eingang pro Clipabschnitt. Segmentiertes Rendern verteilt die Arbeit, beschleunigt aber nur aufwendige Timelines; eine eigene GPU-Pipeline gibt es nicht (bewusst: FFmpeg segmentiert statt wgpu).
- **Ripple** betrifft die bearbeitete und verknüpfte Spuren; *Einfügen*, Extract und Standbild verschieben alle nicht gesperrten Spuren.
- **Keyframes:** In der Timeline gibt es das Gummiband nur für die Lautstärke; andere Parameter werden im Inspector animiert. Keyframes lassen sich in der Timeline nicht zeitlich verschieben.
- **Normalisieren** misst die Quelle ohne Blenden und Spurlautstärke.
- **Programmausgabe-Fenster:** Der Ton bleibt beim Hauptfenster; das Fenster zeigt nur etwas, solange der Programmmonitor im Arbeitsbereich sichtbar ist (es sagt das dann an).
- **Multicam-Synchronisation** über den Ton braucht gemeinsamen Ton der Kameras; sonst werden sie am Anfang ausgerichtet.
- **Farbmanagement:** Abweichende Primärfarben und Übertragungsfunktionen rechnet die Vorschau (Chromium) in die Anzeige um, der Export übernimmt nur die Matrix (gemessen: H.264 mit BT.470BG-Primärfarben und Gamma 2,8 zeigt Chromium als 183/10/71 statt 192/31/95). HDR (PQ, HLG) erkennt Kerf an der Kennzeichnung und warnt in Medienbrowser, Projektprüfung und vor dem Export; umgerechnet wird es nicht. Die Regeln, wie die Vorschau Material ohne gültigen Tag dekodiert, sind in Chromium unter Linux gemessen, nicht in WebView2 unter Windows; weicht WebView2 ab, lässt sich die Matrix je Video von Hand wählen.
- **Verworfene Frames:** gezählt werden Sprünge in der Bildfolge der Vorschau und Decoder-Drops; ob ein Videoelement einen Frame zu spät lieferte, sieht die Statistik nicht.

## Noch nicht umgesetzt

- Transkription, automatische Untertitel, Übersetzung, Smart Reframe, Tracking, KI-Masken (kein lokales Modell eingebunden)
- Spurgruppen
- AV1 und DNxHR als Export-Codecs
- Plugins, Skripte; universelle Suche über die Befehlspalette hinaus, visuelle Zwischenablage, Referenzmonitor, Brand Kits, Versionsvergleich
- HDR-Bearbeitung und Tonemapping (HDR-Material wird nur erkannt und gemeldet); Primärfarben und Übertragungsfunktion im Export wie in der Vorschau
- Native GPU-Pipeline (wgpu) für den Export
- Code-Signatur-Zertifikate (der Release-Workflow ist vorbereitet), Absturzberichte (bewusst ausgelassen)

Der Plan dafür steht in [ROADMAP.md](ROADMAP.md).
