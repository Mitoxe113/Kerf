# Changelog

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionen nach [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

### Hinzugefügt
- Lautstärke-Gummiband auf Audioclips in der Timeline: Linie und Keyframes ziehen, Strg+Klick setzt oder entfernt Keyframes.
- Keyframes einzeln kopieren und einfügen (Inspector und Timeline).
- Übergänge Schieben (Push) und Hereingleiten (Slide) in vier Richtungen; Spuren darunter bleiben stehen.
- Rauschunterdrückung für Audioclips (FFmpeg `afftdn`) mit Stärke, Rauschpegel, Nachführen und einem aus In/Out gelernten Rauschprofil. Vorschau und Export lesen denselben entrauschten Ton aus dem Cache.
- Keyframes für Effektparameter: Radius des Gaußschen Weichzeichners, Stärke der Vignette und Parameter von 11 Katalog-Effekten (u. a. Strudel, Welle, Luma-Key, Formmaske), im Inspector mit Stoppuhr und Rauten.
- Freiform-Maske (3 bis 32 Punkte) mit Punkte-Editor im Programmmonitor, weicher Kante, Umkehren und animierbarem Versatz; Vorschau und Export rastern dieselbe Maske.

### Behoben
- Schnitt: Teilen und Slip runden die Quellposition nicht mehr auf; ein Teil konnte sonst ein Bild über das Clipende oder das Medium hinausreichen.
- Trimm- und Slip-Grenzen messen vom ungerundeten Bereichsende; in Zeitlupe vor einer Rampe ließ sich sonst weit über das Medium hinaus trimmen.
- Rückwärts-Clips zeigen kein Bild mehr hinter dem Medienende (Umschalten auf rückwärts, Tempoänderung).
- Bildratenwechsel der Sequenz rechnet Keyframes, Übergänge, Marker und Untertitel mit um und hält Clips ohne Überlappung im Medium.
- Einfügen in eine Sequenz mit anderer Bildrate rechnet die Clips um; Einfügen prüft Medium und Spurart.
- Gleitkommawerte bleiben beim Speichern und Laden exakt erhalten.
- Export: LUT-Pfade mit Apostroph brachen den Filtergraphen ab.
- Export: Eine Zieldatei, die im Projekt als Medium verwendet wird, wird abgelehnt, statt das Original zu ersetzen.
- Speichern unter „Film v1.2“ ergab „Film v1.kerf“; die Endung wird jetzt angehängt.

- Doku: Der Effekt-Katalog hat 39 Effekte (nicht 38); die Paritätsangabe nennt jetzt die vier Effekte mit größeren Ausreißern.

### Geändert
- Schriften werden mit `skrifa` statt `ttf-parser` gelesen (RUSTSEC-2026-0192: nicht mehr gepflegt). An 109 Systemschriften und einer Schrift mit Variationsachsen liefern beide dieselben Angaben.

## [0.1.0] (2026-11-03)

Erste Veröffentlichung, nur für Windows (64 Bit). Kerf braucht ein installiertes FFmpeg 7 oder neuer. Projektdateien haben `schemaVersion` 1.

### Schnitt
- Mehrspur-Timeline mit Auswahl, Rasierklinge, Ripple, Rollen, Slip, Slide, Einrasten, Spuren sperren, stumm und solo
- Quellmonitor mit Dreipunktschnitt, Match Frame, Standbilder
- Keyframes mit Ease-Kurven und Bezier, Geschwindigkeitsrampen, Rückwärts-Clips
- Verschachtelte Sequenzen, Multicam mit Ton-Synchronisation
- Marker mit Kategorie, Bereich und Kapitel; Marker-Panel
- Assistent: Szenen, Stille, Beats und Momente lokal erkennen; Ducking

### Bild, Ton, Text
- Effekt-Katalog (39 Effekte), Presets, Favoriten, Bypass, Vorher/Nachher; Mischmodi; Übergänge mit Masken
- Farbkorrektur, Farbräder, Kurven, LUTs, Scopes
- Audio: EQ, Kompressor, Gate, Limiter, Mixer, LUFS, Loudness-Normalisierung
- Titel mit Schriften, Stil, Animation und Vorlagen; Untertitel (SRT, WebVTT)

### Export
- H.264, HEVC, ProRes 422/HQ in MP4 und MOV, Hardware-Encoder mit Testkodierung, segmentiertes Rendern
- Untertitel einbrennen, einbetten oder als Datei; Kapitel; Prüfung der fertigen Datei; Protokoll je Auftrag

### Projekt und Medien
- Atomares Speichern mit `.bak`, automatische Sicherung und Wiederherstellung, Versionen
- Proxys, Offline-Erkennung, Neu verknüpfen (auch per Ordnersuche), Projektprüfung, Archiv, Cache-Verwaltung, Metadaten
- Stockmedien von Pexels, GIPHY, Freesound und Openverse mit Lizenzangaben

### Stabilität und Sicherheit (Release-Vorbereitung)
- Beenden fragt nach laufenden Exporten und Downloads und stoppt alle Hintergrundprozesse kontrolliert
- Unbekannte Angaben in Projektdateien werden gemeldet statt beim Speichern stillschweigend verworfen
- Fehler der Oberfläche landen im Protokoll; eine Fehlergrenze hält das Fenster bedienbar
- `open_path` öffnet nur in dieser Sitzung exportierte Dateien
- Datenschutz-Übersicht in den Einstellungen, Build-Kennung und Protokollordner unter *Über Kerf*
- Lizenzübersicht aller Abhängigkeiten (`docs/LICENSES.md`)
- Ein FFmpeg älter als 7 wird in Statusleiste und Export-Panel markiert; ein daran gescheiterter Export nennt den Grund
- Vorschau-Medien, die nicht laden, landen im Protokoll statt nur einen schwarzen Monitor zu hinterlassen

### Bekannte Einschränkungen
- Code-Signing des Installers greift nur mit einem als Secret hinterlegten Zertifikat; ohne Zertifikat warnt Windows SmartScreen beim ersten Start (*Weitere Informationen › Trotzdem ausführen*). Unabhängig davon installiert die Update-Funktion nur Pakete, deren Signatur zum Updater-Schlüssel in der App passt
- Keine Builds für macOS und Linux
