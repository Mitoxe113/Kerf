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
- **Panel Projekt:** *Prüfung* (fehlende Medien und Schriften, leere Bereiche, ungewöhnliche Bildraten u. a.), *Verknüpfen* (fehlende Medien in Ordnern suchen), *Archiv* (Projekt mit allen Medien in einen leeren Ordner kopieren), *Cache* (Größe und Leeren), *Ordner* (überwachte Ordner), *Metadaten* (Name, Favorit, Farbe, Tags, Notiz und Farbmatrix bearbeiten, technische Angaben der Datei).

## Medien

- Unterstützt wird, was FFmpeg lesen kann; der Import-Dialog filtert auf gängige Video-, Audio- und Bildformate.
- Nach dem Import erzeugt Kerf Vorschaubild, Filmstreifen und Wellenform. Kann die Vorschau einen Codec nicht abspielen (z. B. HEVC, ProRes, 10 Bit), entsteht automatisch ein Proxy; der Export liest immer das Original.
- **Offline-Medien** (Datei verschoben oder gelöscht) sind markiert. Rechtsklick › *Neu verknüpfen* oder im Panel *Projekt › Verknüpfen* mehrere auf einmal suchen.
- **Quellmonitor:** Doppelklick auf ein Medium, In/Out setzen, mit `,` (Einfügen) oder `.` (Überschreiben) in die Timeline.
- **Ablagen:** *Neue Ablage* legt einen Ordner an; Medien per Ziehen oder Rechtsklick › *In Ablage verschieben* hineinlegen.
- **Intelligente Ablagen:** *Neue intelligente Ablage* (Knopf mit Lupe im Medienbrowser) zeigt alle Medien, die alle gesetzten Regeln erfüllen: Typ, Text in Name, Notiz oder Tag, Tags, Farbe, nur Favoriten, in Sequenzen verwendet oder nicht, nur offline. Rechtsklick › *Regeln bearbeiten*. Sie enthält selbst nichts; Medien bleiben, wo sie sind.
- **Metadaten:** Rechtsklick auf ein Medium › *Metadaten bearbeiten* öffnet *Projekt › Metadaten*. Tags werden mit Komma getrennt. Sind mehrere Medien ausgewählt, gelten Favorit und Farbe für alle, Tags lassen sich bei allen hinzufügen oder entfernen. Die Suche im Medienbrowser durchsucht Namen, Notizen und Tags.
- **Überwachte Ordner:** Rechtsklick in den Medienbrowser › *Ordner überwachen …* (oder auf eine Ablage › *Ordner in diese Ablage überwachen …*). Solange das Projekt geöffnet ist, sieht Kerf alle 3 Sekunden in den Ordner (auf Wunsch mit Unterordnern) und importiert neue Video-, Audio- und Bilddateien in die gewählte Ablage, sobald eine Datei zwei Mal hintereinander gleich groß ist; eine Datei, die noch kopiert wird, wartet also. Jede Datei wird nur einmal importiert, auch wenn du sie danach aus dem Projekt entfernst. Dateien, die schon vor dem Öffnen des Projekts im Ordner lagen, importiert Kerf nicht von selbst, sondern meldet sie; *Projekt › Ordner › Abgleichen* importiert sie. Dort lässt sich die Überwachung auch beenden (die Medien bleiben).
- **Farbmatrix:** Für Videos ohne gültigen Farbraum-Tag (oder mit BT.601- bzw. BT.709-Tag) wählt *Projekt › Metadaten › Farbmatrix*, wie Kerf die Y'CbCr-Werte liest: *Automatisch* (so, wie die Vorschau die Datei dekodiert; der Hinweis darunter nennt die Matrix und ob sie aus dem Tag stammt oder geschätzt ist), *BT.601* oder *BT.709*. Die Wahl gilt in Vorschau und Export. Wirken die Farben eines Videos gegenüber der Kamera oder einem anderen Programm verschoben, hilft meist die andere Matrix.

## Timeline

- Werkzeuge: Auswahl `V`, Rasierklinge `C`, Ripple `B`, Rollen `N`, Slip `Y`, Slide `U`, Hand `H`, Zoom `Z`.
- Spuren lassen sich sperren, stummschalten, solo schalten und ausblenden; Einrasten mit `S`.
- Marker mit `M`; das Panel *Marker* listet sie, filtert nach Kategorie und markiert Kapitel für den Export.
- Verschachtelte Sequenzen, Multicam (Panel *Multicam*, Kamerawechsel mit `1` … `9`), Geschwindigkeitsrampen und Rückwärts-Clips.
- Compound Clips: *Verschachteln …* (Kontextmenü eines Clips) packt die Auswahl in eine neue Sequenz und legt sie als einen Clip zurück. *Verschachtelung auflösen* legt die Clips wieder an seine Stelle, jede Spur der inneren Sequenz auf eine eigene Spur darüber (freie Spuren werden genutzt, sonst neue eingefügt); die innere Sequenz bleibt im Projekt. Kerf löst nur auf, wenn Bild und Ton gleich bleiben: Der verschachtelte Clip darf nicht verändert sein (Tempo, Keyframes, Effekte, Blenden, Bewegung, Deckkraft, Farbe, Ton), seine Grenzen dürfen keinen Übergang und keine Blende anschneiden, Clips darin keinen Mischmodus nutzen, im gezeigten Bereich darf keine Einstellungsebene liegen, beteiligte Spuren nicht ausgeblendet, stumm, solo oder mit Spureffekten sein, und beide Sequenzen brauchen dieselbe Bildrate und Größe. Sonst nennt eine Meldung den Grund.
- Einstellungsebenen: *Sequenz › Einstellungsebene einfügen* legt am Playhead eine 5 s lange Einstellungsebene auf die erste freie Videospur über allen Clips dort (sonst auf eine neue Spur) und öffnet ihre Farbkorrektur. Farbe, Effekte, Deckkraft (auch mit Keyframes und Blenden) und Mischmodus der Ebene wirken auf alles, was auf den Spuren darunter liegt; Spuren darüber bleiben unberührt. Länge und Lage ändert man wie bei jedem Clip; Bewegung, Zuschnitt und Übergänge gibt es für sie nicht. In einer verschachtelten Sequenz wirkt sie nur auf deren Spuren, durchsichtige Stellen bleiben durchsichtig.
- Rückgängig `Strg+Z`, Wiederholen `Strg+Umschalt+Z`; das Panel *Verlauf* zeigt alle Schritte.
- **Assistent** (Panel): Szenen, Stille, Beats und Momente lokal erkennen, Ergebnisse prüfen und als ein Rückgängig-Schritt übernehmen; Ducking senkt Musik unter Sprache ab.
- Nicht vorhanden: Spurgruppen.

## Effekte, Übergänge, Text

- Panel *Effekte*: Katalog mit Suche, Favoriten und Presets; Effekte auf Clips ziehen, im Inspector einstellen, einzeln abschalten (Bypass), Reihenfolge ändern, kopieren und einfügen. Vorschau (WebGL2) und Export (FFmpeg) rechnen dieselben Formeln.
- Übergänge: an Schnitten, mit Standard-Übergang `Strg+Umschalt+D`.
- Titel: Schrift, Stil, Animation und Vorlagen; importierte Schriften lädt nur Kerf, sie werden nicht systemweit installiert.
- Untertitel: Panel *Untertitel*, Import und Export von SRT und WebVTT; beim Export einbrennen, als Spur einbetten oder als Datei schreiben.
- Masken: Rechteck und Ellipse mit dem Effekt *Formmaske*, freie Formen mit *Freiform-Maske* (Punkte im Programmmonitor setzen: *Im Monitor bearbeiten*, Punkte ziehen, Doppelklick auf eine Kante fügt einen ein, Rechtsklick entfernt ihn).
- Animierte Effekte: Bei Parametern mit Stoppuhr setzt ein Klick darauf einen Keyframe am Playhead; danach setzt jede Änderung einen Keyframe an der Playhead-Position.
- Nicht vorhanden: Tracking, automatische Untertitel (keine Spracherkennung).

## Audio

- Lautstärke, Pan und Keyframes je Clip; Mixer und Pegel mit LUFS-Anzeige.
- Effekte: EQ, Kompressor, Noise-Gate, Limiter, in Vorschau und Export gleich berechnet.
- Lautheit beim Export normalisieren (EBU R128, zwei Durchgänge).
- Rauschunterdrückung je Audioclip im Inspector, mit Rauschprofil aus einem In/Out-Bereich.
- Nicht vorhanden: Stem-Export.

## Farbe

- Arbeitsbereich *Farbe*: Belichtung, Kontrast, Sättigung, Temperatur, Tönung, Farbräder, Kurven, LUTs (`.cube`).
- Scopes: Luma-Wellenform, RGB-Parade, Vektorskop, Histogramm.
- Masken wirken auf die Deckkraft eines Clips (Effekte *Formmaske* und *Freiform-Maske*), nicht als Auswahl für eine Farbkorrektur.
- HDR: Videos mit PQ- oder HLG-Kennzeichnung zeigt der Medienbrowser als *HDR (PQ)* bzw. *HDR (HLG)*, die Projektprüfung nennt sie, und vor dem Export fragt Kerf nach. Kerf rechnet HDR nicht in SDR um: Der Export schreibt SDR (BT.709) mit den unveränderten Werten, Helligkeit und Farben weichen ab. Solches Material vorher in SDR umwandeln.
- Nicht vorhanden: Qualifier für die Farbkorrektur, HDR-Bearbeitung und Tonemapping.

## Export

- Panel *Export*: Voreinstellungen, H.264, HEVC, ProRes 422/HQ in MP4 oder MOV; Auflösung, Bildrate, Ratensteuerung (Qualität, VBR, CBR), Ton.
- **Stapel-Export:** Im Abschnitt *Stapel-Export* mehrere Vorgaben ankreuzen und einen Ordner wählen. Jede Vorgabe wird ein eigener Auftrag („Sequenzname - Vorgabe“); Bereich, Untertitel, Kapitel und Lautheit gelten wie oben eingestellt. Gibt es eine Datei schon, fragt Kerf vor dem Ersetzen.
- Hardware-Encoder (NVENC, QSV, AMF), sofern eine Testkodierung gelingt; sonst Software.
- Bereich In bis Out, Untertitel, Kapitelmarker, Lautheit, segmentiertes Rendern für aufwendige Timelines.
- Aufträge laufen nacheinander in einer Warteschlange; jeder behält ein Protokoll. Ein abgebrochener Export hinterlässt keine Datei; die Ausgabe heißt bis zum Erfolg `….partial`.
- Nach dem Export prüft Kerf die Datei (Dauer, Auflösung, Bildrate, Kanäle, True Peak).
- Nicht vorhanden: AV1, DNxHR, Fortsetzen abgebrochener Exporte.

## Stockmedien

- Panel *Stockmedien*: Pexels, GIPHY, Freesound (je eigener, kostenloser API-Schlüssel) und Openverse (ohne Schlüssel).
- Schlüssel liegen im Schlüsselspeicher des Systems oder nur für die Sitzung. Downloads werden geprüft, mit Lizenz gespeichert; der Lizenzbericht listet die Nachweise eines Projekts.

## Makros

Ein Makro ist eine benannte Folge von Befehlen aus den Menüs und Tastaturbefehlen.

- **Aufzeichnen:** *Bearbeiten › Makro aufzeichnen*, dann die Befehle ausführen (Tastenkürzel, Menü oder Befehlspalette). Die Statusleiste zeigt *Makro-Aufzeichnung* mit der Zahl der Schritte; ein Klick darauf oder erneut *Makro aufzeichnen* beendet die Aufzeichnung und fragt nach dem Namen. Aufgezeichnet werden Befehle, nicht Mausbewegungen: Ziehen in der Timeline oder Werte im Inspector gehören nicht dazu.
- **Bearbeiten:** *Bearbeiten › Makros …* listet alle Makros. Dort lassen sich Makros anlegen, umbenennen, ordnen und löschen und Schritte hinzufügen, verschieben und entfernen.
- **Ausführen:** in der Befehlspalette (`Strg+P`) nach dem Namen suchen, im Dialog *Ausführen* wählen oder für die ersten neun Makros *Makro 1 ausführen* bis *Makro 9 ausführen* verwenden; diesen Befehlen lässt sich unter *Bearbeiten › Tastaturbefehle …* ein Kürzel geben.
- Jeder Schritt wirkt auf die Auswahl und den Playhead zum Zeitpunkt des Schritts und ist ein eigener Rückgängig-Schritt. Ist ein Befehl gerade nicht möglich (im Menü ausgegraut, z. B. *Einfügen (Insert)* ohne gewählte Medien) oder lehnt der Kern die Änderung ab, hält das Makro dort an und meldet den Schritt. Befehle, die ohne passende Auswahl einfach nichts tun, laufen ohne Meldung durch.
- Makros werden pro Benutzer gespeichert, nicht im Projekt (bis zu 50 Makros mit je 100 Schritten).

## Erweiterungen

Kerf hat kein Plugin- oder Skriptsystem.

## Einstellungen

`Strg+,`: Sichern, Vorschauqualität und Proxys, Timeline, Updates, Tastatur, Datenschutz, System (FFmpeg, Encoder) und Cache.

**Cache:** *Ändern …* wählt einen anderen Ordner für Vorschaubilder, Wellenformen, Proxys und aufbereiteten Ton; er gilt ab dem nächsten Start, der bisherige Ordner bleibt mit seinen Dateien liegen (vorher unter *Projekt › Cache* leeren, wenn er nicht mehr gebraucht wird). *Höchstens* begrenzt die Größe: Kerf löscht dann die am längsten nicht geschriebenen Einträge, sofort und danach alle zehn Minuten, aber nie, was die Medien des geöffneten Projekts brauchen.

## Fehlerbehebung

| Problem | Lösung |
| --- | --- |
| „FFmpeg nicht gefunden“ | FFmpeg 7+ installieren oder `KERF_FFMPEG_DIR` auf den Ordner mit `ffmpeg` und `ffprobe` setzen, Kerf neu starten. |
| FFmpeg „(zu alt)“ in der Statusleiste | Kerf braucht FFmpeg 7 oder neuer; mit 6.x schlägt jeder Export fehl. Neueres FFmpeg installieren oder einen statischen Build über `KERF_FFMPEG_DIR` einbinden. |
| Medium offline | Rechtsklick › *Neu verknüpfen* oder *Projekt › Verknüpfen*. |
| Vorschau ruckelt | Vorschauqualität auf ½ oder ¼ (Einstellungen › Vorschau), Proxys einschalten. |
| Export schlägt fehl | Export-Protokoll öffnen (Symbol am Auftrag); es enthält Befehlszeile, Filtergraph und FFmpeg-Meldungen. |
| Oberfläche zeigt einen Fehler | *Oberfläche neu laden*; das Projekt liegt in der Engine und bleibt erhalten. Danach speichern. |
| Projektdatei beschädigt | Kerf lädt automatisch die `.bak`. Sonst *Datei › Versionen* oder die Wiederherstellung beim Start. |
| Cache zu groß | *Projekt › Cache*: Arten einzeln leeren; Kerf erzeugt Benötigtes neu. Dauerhaft: *Einstellungen › Cache › Höchstens* oder einen Ordner auf einem anderen Laufwerk wählen. |

**Protokoll für Fehlerberichte:** *Hilfe › Über Kerf* zeigt Version, Build-Kennung und den Protokollordner (Datei `kerf.log`). Das Protokoll enthält keine API-Schlüssel.
