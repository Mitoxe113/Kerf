# Hilfe

Kurzanleitung zu allen Bereichen von Kerf. Sie beschreibt nur, was die App tatsächlich kann; was fehlt, steht am Ende jedes Abschnitts und in [STATUS.md](STATUS.md). Die Tastaturbefehle stehen vollständig in der App unter *Bearbeiten › Tastaturbefehle …* (`Strg+Alt+K`), die wichtigsten im [README](../README.md#bedienung-in-kürze).

## Erste Schritte

1. FFmpeg 7 oder neuer installieren (siehe [README](../README.md#installieren)). Die Statusleiste zeigt rot an, wenn Kerf kein FFmpeg findet; ohne FFmpeg lassen sich Medien weder analysieren noch exportieren.
2. Kerf starten. Der Startbildschirm bietet *Neues Projekt*, *Projekt öffnen* und die zuletzt geöffneten Projekte.
3. Medien importieren: Dateien oder Ordner ins Fenster ziehen oder *Datei › Medien importieren …* (`Strg+I`).
4. Ein Medium in die Timeline ziehen, schneiden, mit `Strg+S` speichern und mit `Strg+M` exportieren.

Ein Konto, eine Anmeldung oder eine Internetverbindung braucht Kerf dafür nicht.

## Projekte

- **Speichern:** `Strg+S`; das Projekt ist eine `.kerf`-Datei (JSON). Kerf schreibt atomar über eine temporäre Datei und behält die vorige Fassung als `.bak`. Ist die Projektdatei beschädigt, lädt Kerf automatisch die `.bak` und sagt das an.
- **Automatische Sicherung:** Ungespeicherte Änderungen werden in einem einstellbaren Abstand (Einstellungen › Sichern, Standard 30 s) in einen Wiederherstellungsordner geschrieben. Die Projektdatei selbst ändert sich dabei nicht.
- **Wiederherstellen:** Endete Kerf nicht sauber (Absturz, Stromausfall), bietet der nächste Start die gesicherten Stände an.
- **Versionen:** Jedes Speichern legt eine Version an (*Datei › Versionen*), Anzahl in den Einstellungen.
- **Beenden:** Kerf fragt nach ungespeicherten Änderungen und nach laufenden Exporten und Downloads. Beim Beenden werden laufende Aufträge abgebrochen, unvollständige Dateien gelöscht.
- **Neuere Projektdateien:** Enthält eine Datei Angaben, die diese Version nicht kennt, warnt Kerf beim Öffnen und fragt vor dem Überschreiben.
- **Panel Projekt:** *Prüfung* (fehlende Medien und Schriften, leere Bereiche, ungewöhnliche Bildraten u. a.), *Verknüpfen* (fehlende Medien in Ordnern suchen), *Archiv* (Projekt mit allen Medien in einen leeren Ordner kopieren), *Cache* (Größe und Leeren), *Metadaten*.

## Medien

- Unterstützt wird, was FFmpeg lesen kann; der Import-Dialog filtert auf gängige Video-, Audio- und Bildformate.
- Nach dem Import erzeugt Kerf Vorschaubild, Filmstreifen und Wellenform. Kann die Vorschau einen Codec nicht abspielen (z. B. HEVC, ProRes, 10 Bit), entsteht automatisch ein Proxy; der Export liest immer das Original.
- **Offline-Medien** (Datei verschoben oder gelöscht) sind markiert. Rechtsklick › *Neu verknüpfen* oder im Panel *Projekt › Verknüpfen* mehrere auf einmal suchen.
- **Quellmonitor:** Doppelklick auf ein Medium, In/Out setzen, mit `,` (Einfügen) oder `.` (Überschreiben) in die Timeline.

## Timeline

- Werkzeuge: Auswahl `V`, Rasierklinge `C`, Ripple `B`, Rollen `N`, Slip `Y`, Slide `U`, Hand `H`, Zoom `Z`.
- Spuren lassen sich sperren, stummschalten, solo schalten und ausblenden; Einrasten mit `S`.
- Marker mit `M`; das Panel *Marker* listet sie, filtert nach Kategorie und markiert Kapitel für den Export.
- Verschachtelte Sequenzen, Multicam (Panel *Multicam*, Kamerawechsel mit `1` … `9`), Geschwindigkeitsrampen und Rückwärts-Clips.
- Rückgängig `Strg+Z`, Wiederholen `Strg+Umschalt+Z`; das Panel *Verlauf* zeigt alle Schritte.
- **Assistent** (Panel): Szenen, Stille, Beats und Momente lokal erkennen, Ergebnisse prüfen und als ein Rückgängig-Schritt übernehmen; Ducking senkt Musik unter Sprache ab.
- Nicht vorhanden: Einstellungsebenen, Compound Clips, Spurgruppen.

## Effekte, Übergänge, Text

- Panel *Effekte*: Katalog mit Suche, Favoriten und Presets; Effekte auf Clips ziehen, im Inspector einstellen, einzeln abschalten (Bypass), Reihenfolge ändern, kopieren und einfügen. Vorschau (WebGL2) und Export (FFmpeg) rechnen dieselben Formeln.
- Übergänge: an Schnitten, mit Standard-Übergang `Strg+Umschalt+D`.
- Titel: Schrift, Stil, Animation und Vorlagen; importierte Schriften lädt nur Kerf, sie werden nicht systemweit installiert.
- Untertitel: Panel *Untertitel*, Import und Export von SRT und WebVTT; beim Export einbrennen, als Spur einbetten oder als Datei schreiben.
- Nicht vorhanden: Masken, Tracking, automatische Untertitel (keine Spracherkennung).

## Audio

- Lautstärke, Pan und Keyframes je Clip; Mixer und Pegel mit LUFS-Anzeige.
- Effekte: EQ, Kompressor, Noise-Gate, Limiter, in Vorschau und Export gleich berechnet.
- Lautheit beim Export normalisieren (EBU R128, zwei Durchgänge).
- Nicht vorhanden: Rauschunterdrückung, Stem-Export.

## Farbe

- Arbeitsbereich *Farbe*: Belichtung, Kontrast, Sättigung, Temperatur, Tönung, Farbräder, Kurven, LUTs (`.cube`).
- Scopes: Luma-Wellenform, RGB-Parade, Vektorskop, Histogramm.
- Nicht vorhanden: sekundäre Korrektur, Qualifier, Masken, HDR.

## Export

- Panel *Export*: Voreinstellungen, H.264, HEVC, ProRes 422/HQ in MP4 oder MOV; Auflösung, Bildrate, Ratensteuerung (Qualität, VBR, CBR), Ton.
- Hardware-Encoder (NVENC, QSV, AMF), sofern eine Testkodierung gelingt; sonst Software.
- Bereich In bis Out, Untertitel, Kapitelmarker, Lautheit, segmentiertes Rendern für aufwendige Timelines.
- Aufträge laufen nacheinander in einer Warteschlange; jeder behält ein Protokoll. Ein abgebrochener Export hinterlässt keine Datei; die Ausgabe heißt bis zum Erfolg `….partial`.
- Nach dem Export prüft Kerf die Datei (Dauer, Auflösung, Bildrate, Kanäle, True Peak).
- Nicht vorhanden: AV1, DNxHR, Stapel-Export mehrerer Profile, Fortsetzen abgebrochener Exporte.

## Stockmedien

- Panel *Stockmedien*: Pexels, GIPHY, Freesound (je eigener, kostenloser API-Schlüssel) und Openverse (ohne Schlüssel).
- Schlüssel liegen im Schlüsselspeicher des Systems oder nur für die Sitzung. Downloads werden geprüft, mit Lizenz gespeichert; der Lizenzbericht listet die Nachweise eines Projekts.

## Erweiterungen

Kerf hat kein Plugin-, Makro- oder Skriptsystem.

## Einstellungen

`Strg+,`: Sichern, Vorschauqualität und Proxys, Timeline, Updates, Tastatur, Datenschutz, System (FFmpeg, Encoder, Cache-Ordner).

## Fehlerbehebung

| Problem | Lösung |
| --- | --- |
| „FFmpeg nicht gefunden“ | FFmpeg 7+ installieren oder `KERF_FFMPEG_DIR` auf den Ordner mit `ffmpeg` und `ffprobe` setzen, Kerf neu starten. |
| Medium offline | Rechtsklick › *Neu verknüpfen* oder *Projekt › Verknüpfen*. |
| Vorschau ruckelt | Vorschauqualität auf ½ oder ¼ (Einstellungen › Vorschau), Proxys einschalten. |
| Export schlägt fehl | Export-Protokoll öffnen (Symbol am Auftrag); es enthält Befehlszeile, Filtergraph und FFmpeg-Meldungen. |
| Oberfläche zeigt einen Fehler | *Oberfläche neu laden*; das Projekt liegt in der Engine und bleibt erhalten. Danach speichern. |
| Projektdatei beschädigt | Kerf lädt automatisch die `.bak`. Sonst *Datei › Versionen* oder die Wiederherstellung beim Start. |
| Cache zu groß | *Projekt › Cache*: Arten einzeln leeren; Kerf erzeugt Benötigtes neu. |

**Protokoll für Fehlerberichte:** *Hilfe › Über Kerf* zeigt Version, Build-Kennung und den Protokollordner (Datei `kerf.log`). Das Protokoll enthält keine API-Schlüssel.
