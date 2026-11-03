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

## Phase 9 · Audio ✅

- Clip- und Spureffekte: EQ, Kompressor, Noise-Gate, Limiter (FFmpeg im Export, Ports derselben Filter in der Vorschau)
- Loudness-Normalisierung beim Export (zweistufiges `loudnorm`), LUFS-Anzeige am Master, Limiter beim Normalisieren
- Mono-Spuren und Kanalzuordnung

## Phase 10 · Skalierung und Arbeitsumgebung ✅

- Segmentierter Export (Bild in Teilen parallel, Ton daneben, verlustfrei zusammengefügt) statt einer eigenen GPU-Pipeline
- Verschachtelte Sequenzen, Multicam mit Ton-Synchronisation, Geschwindigkeitsrampen und Rückwärts-Clips
- Andockbare Panels, Programmausgabe in eigenem Fenster für einen zweiten Bildschirm
- Installer getestet, automatische Updates (signiert, über GitHub-Releases), CI und Installer für Windows, macOS und Linux, Lizenz GPL-3.0-or-later

## Kreativ-Ökosystem ◐

- ✅ Effekt-Katalog (38 Effekte), Effekt-Browser, Presets, Favoriten, Kopieren/Einfügen, Bypass, Vorher/Nachher
- ✅ Mischmodi je Clip, Masken-Übergänge, Übergangs-Presets
- ✅ Schriften (System, importiert, mitgeliefert) mit Lizenzangaben aus der Datei, erweiterter Textstil, Textanimation, Titelvorlagen
- ◐ Stockmedien: Pexels, GIPHY, Freesound, Openverse mit geprüften Downloads, Bibliothek und Lizenzbericht; **noch nicht live mit echten Schlüsseln geprüft**
- ☐ Pixabay, Freesound-Originale (OAuth2), Online-Schriften, Plugin-Grundlage, keyframebare Effektparameter, Push/Slide-Übergänge

## Werkzeuge und Projektverwaltung ◐

- ✅ Szenen, Stille, Beats und Momente lokal erkennen, prüfen und als ein Undo-Schritt übernehmen; Ducking als Lautstärke-Keyframes
- ✅ Marker mit Kategorie, Bereich und Kapitel, Marker-Panel, Kapitel im Export
- ✅ Projektprüfung, Relink-Suche, Projekt archivieren, portable Pfade, Cache-Verwaltung, Metadaten
- ☐ Transkription und automatische Untertitel (lokales Sprachmodell nötig), Smart Reframe
- ☐ Render-Warteschlange, Einstellungsebenen, Compound Clips, überwachte Ordner, Plugins und Makros

## Als Nächstes

1. **Stockmedien live prüfen:** mit eigenen Schlüsseln für Pexels, GIPHY und Freesound sowie anonym für Openverse je eine Suche und einen Download in der App durchspielen; Pexels-Video-Hosts und GIPHY-Logo-Vorgaben gegen die Anbieterdokumentation prüfen.
2. **Erstes Release:** Updater-Schlüssel als Secrets hinterlegen, Version taggen, Entwurf prüfen und veröffentlichen. Danach den Update-Weg über GitHub einmal mit einer installierten Vorversion durchspielen.
3. **Code-Signierung:** Zertifikate für Windows (Authenticode) und macOS (Developer ID, Notarisierung) besorgen und als Secrets hinterlegen; der Release-Workflow ist dafür vorbereitet.
4. **macOS und Linux von Hand prüfen:** Dateizuordnung (unter macOS über `RunEvent::Opened`), Drag & Drop, Dialoge, Wiedergabe in WKWebView bzw. WebKitGTK (andere Codecs als WebView2).
5. **Keyframes:** Keyframe-Editor in der Timeline (Gummiband für Lautstärke), Keyframes einzeln kopieren und einfügen.
6. **Assistenten in der App durchspielen:** Szenen, Stille, Beats, Ducking, Archiv, Relink und Cache mit echten Projekten in der Tauri-App bedienen; Kapitel in einem Abspieler prüfen.
7. **Effekte:** Masken (Rechteck, Ellipse, Freiform, animierbar), Rauschunterdrückung (`afftdn` im Export, Gegenstück in der Vorschau).

## Später

- Medienverwaltung: Smart Bins, Metadaten-Editor, überwachte Ordner
- Farbmanagement: wählbare Matrix für ungetaggte Quellen, HDR-Metadaten
- Native Render-Pipeline (wgpu), falls der segmentierte Export bei sehr langen Timelines nicht reicht
