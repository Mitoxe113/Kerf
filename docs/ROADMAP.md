# Roadmap

Die Phasen folgen dem ursprünglichen Auftrag. Jede Phase endet mit Tests in Rust und TypeScript und einem Durchlauf in der echten App. Details zum aktuellen Stand in [STATUS.md](STATUS.md).

## Phase 1–2 · Fundament ✅

Datenmodell, Zeitmodell, Befehle, Undo, Projektdatei, Medienanalyse, Proxys, UI-Shell, Designsystem, Arbeitsbereiche, Tastaturbelegung.

## Phase 3 · Schnitt ✅

Mehrspur-Timeline mit acht Werkzeugen, Snapping, Marker, verknüpfte Clips, Insert/Overwrite, Ripple-Löschen, Undo, Echtzeit-Wiedergabe mit Audio, J/K/L, Scopes, Export mit Hardware-Encodern und Render-Warteschlange.

## Phase 7 · Professional Polish ✅

Zuverlässigkeit (Deltas, geteilte Undo-Schnappschüsse, Autosave, Versionen, Wiederherstellung), Quellmonitor mit Dreipunktschnitt, Match Frame, Lift/Extract, Keyframes mit Easing, Normalisieren, Plattform-Vorgaben, Prüfung nach dem Rendern, Befehlspalette, Tastaturprofile, Startbildschirm, Dateizuordnung.

## Phase 8 · Titel, Übergänge, Effekte ✅

- Titel (Schrift, Kontur, Schatten, Hintergrund, Vorlagen) und Untertitel mit SRT/VTT-Import und -Export, einbrennen oder einbetten
- Übergänge: Blende, Abblende, Wischen, Audio-Kreuzblende
- Effekt-Stapel mit gemeinsamer Mathematik in Vorschau und Export: Weichzeichner, Schärfen, Vignette, 3D-LUT, Chroma-Key
- Farbe: Farbräder, Kurven, animierbare Farbkorrektur
- Bezier-Keyframes mit Kurveneditor; Quellmonitor-Marken im Projekt; Farbparität für Material ohne Tag
- Lautstärke-Gummiband in der Timeline; Keyframes einzeln kopieren und einfügen

## Phase 9 · Audio ✅

- Clip- und Spureffekte: EQ, Kompressor, Noise-Gate, Limiter (FFmpeg im Export, Ports derselben Filter in der Vorschau)
- Loudness-Normalisierung beim Export (zweistufiges `loudnorm`), LUFS-Anzeige am Master, Limiter beim Normalisieren
- Mono-Spuren und Kanalzuordnung
- Rauschunterdrückung (`afftdn`) mit gelerntem Rauschprofil, Vorschau und Export aus derselben Cache-Datei

## Phase 10 · Skalierung und Arbeitsumgebung ✅

- Segmentierter Export (Bild in Teilen parallel, Ton daneben, verlustfrei zusammengefügt) statt einer eigenen GPU-Pipeline
- Verschachtelte Sequenzen, Multicam mit Ton-Synchronisation, Geschwindigkeitsrampen und Rückwärts-Clips
- Andockbare Panels, Programmausgabe in eigenem Fenster für einen zweiten Bildschirm
- Installer getestet, automatische Updates (signiert, über GitHub-Releases), CI und Installer (seit 0.1.0 nur noch für Windows), Lizenz GPL-3.0-or-later

## Kreativ-Ökosystem ◐

- ✅ Effekt-Katalog (39 Effekte), Effekt-Browser, Presets, Favoriten, Kopieren/Einfügen, Bypass, Vorher/Nachher
- ✅ Keyframebare Effektparameter (Weichzeichner, Vignette, 11 Katalog-Effekte), Freiform-Maske mit Punkte-Editor im Monitor und animierbarem Versatz; Rechteck- und Ellipsen-Maske über die animierbare Formmaske
- ✅ Mischmodi je Clip, Masken-Übergänge, Schiebe- und Gleit-Übergänge, Übergangs-Presets
- ✅ Schriften (System, importiert, mitgeliefert) mit Lizenzangaben aus der Datei, erweiterter Textstil, Textanimation, Titelvorlagen
- ◐ Stockmedien: Pexels, GIPHY, Freesound, Openverse mit geprüften Downloads, Bibliothek und Lizenzbericht; **noch nicht live mit echten Schlüsseln geprüft**
- ☐ Pixabay, Freesound-Originale (OAuth2), Online-Schriften, Plugin-Grundlage

## Werkzeuge und Projektverwaltung ◐

- ✅ Szenen, Stille, Beats und Momente lokal erkennen, prüfen und als ein Undo-Schritt übernehmen; Ducking als Lautstärke-Keyframes
- ✅ Marker mit Kategorie, Bereich und Kapitel, Marker-Panel, Kapitel im Export
- ✅ Projektprüfung, Relink-Suche, Projekt archivieren, portable Pfade, Cache-Verwaltung, Metadaten
- ✅ Intelligente Ablagen (Smart Bins) mit Regeln, Metadaten-Editor (Tags, Notiz, Farbe, Favorit, auch für mehrere Medien)
- ☐ Transkription und automatische Untertitel (lokales Sprachmodell nötig), Smart Reframe
- ✅ Stapel-Export: mehrere Vorgaben in einem Schritt in die Render-Warteschlange
- ✅ Überwachte Ordner: neue Mediendateien landen automatisch in einer Ablage
- ✅ Farbmatrix je Video wählbar; Vorschau-Regel je Codec in Chromium gemessen
- ✅ Compound Clips: Auswahl verschachteln und Verschachtelung wieder auflösen; der Export ist vor und nach dem Auflösen gemessen gleich
- ☐ Einstellungsebenen, Plugins und Makros

## Als Nächstes

1. **Stockmedien live prüfen:** mit eigenen Schlüsseln für Pexels, GIPHY und Freesound sowie anonym für Openverse je eine Suche und einen Download in der App durchspielen; Pexels-Video-Hosts und GIPHY-Logo-Vorgaben gegen die Anbieterdokumentation prüfen.
2. **Updates über GitHub einschalten:** 0.1.0 ist ohne Update-Daten veröffentlicht. Den privaten Updater-Schlüssel (passend zum öffentlichen in `tauri.conf.json`) und sein Passwort als Secrets `TAURI_SIGNING_PRIVATE_KEY` und `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` hinterlegen, dann bekommt 0.1.1 ein `latest.json`. Den Weg 0.1.0 → 0.1.1 über GitHub einmal mit einer installierten 0.1.0 durchspielen.
3. **Code-Signierung:** Ein Authenticode-Zertifikat für Windows besorgen und als Secret hinterlegen; der Release-Workflow ist dafür vorbereitet. Bis dahin warnt SmartScreen beim Installer.
4. **macOS und Linux (derzeit nicht geplant):** Vor einer Rückkehr müsste unter Linux die Wiedergabe über das `asset:`-Protokoll in WebKitGTK gelöst werden (siehe STATUS, *Release 0.1.0*); unter macOS Dateizuordnung über `RunEvent::Opened`, Dialoge und Wiedergabe in WKWebView prüfen.
5. **Assistenten in der App durchspielen:** Szenen, Stille, Beats, Ducking, Archiv, Relink, Cache, intelligente Ablagen, überwachte Ordner (Dateien während des Kopierens) und den Metadaten-Editor mit echten Projekten in der Tauri-App bedienen; Kapitel in einem Abspieler prüfen.
6. **Effekt-Keyframes und Freiform-Maske in der App durchspielen:** im Programmmonitor der Tauri-App (WebView2) Punkte setzen, animieren und gegen den Export vergleichen.
7. **Farbmatrix in WebView2 prüfen:** Die Regeln für Material ohne gültigen Tag sind in Chromium unter Linux gemessen. Unter Windows einfarbige Testclips erzeugen, z. B. `ffmpeg -f lavfi -i color=c=0xC02060:s=1280x720:r=25:d=2 -vf format=yuv420p -c:v libx264 h264.mp4` und dasselbe mit `-c:v libvpx-vp9 -b:v 1M vp9.webm`, importieren und die Farbe im Programmmonitor (Pipette eines Bildschirmfotos) mit 205/50/95 (BT.709) und 192/31/95 (BT.601) vergleichen: erwartet sind BT.709 für H.264 und BT.601 für VP9. Weicht WebView2 ab, die Regel in `VideoInfo::webview_ycc` und `src/engine/ycc.ts` anpassen.

## Später

- Farbmanagement: Primärfarben und Übertragung im Export wie in der Vorschau, HDR-Metadaten
- Native Render-Pipeline (wgpu), falls der segmentierte Export bei sehr langen Timelines nicht reicht
