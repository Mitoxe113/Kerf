# Changelog

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionen nach [Semantic Versioning](https://semver.org/lang/de/).

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
- Effekt-Katalog (38 Effekte), Presets, Favoriten, Bypass, Vorher/Nachher; Mischmodi; Übergänge mit Masken
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
- Code-Signing des Installers greift nur mit einem als Secret hinterlegten Zertifikat; ohne Zertifikat warnt Windows SmartScreen beim ersten Start (*Weitere Informationen › Trotzdem ausführen*). Update-Pakete sind unabhängig davon mit dem Updater-Schlüssel signiert und werden vor der Installation geprüft
- Keine Builds für macOS und Linux
