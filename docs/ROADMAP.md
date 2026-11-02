# Roadmap

Die Phasen folgen dem ursprünglichen Auftrag. Jede Phase endet mit Tests in Rust und TypeScript und einem Durchlauf in der echten App.

## Phase 1–2 · Fundament ✅

Datenmodell, Zeitmodell, Befehle, Undo, Projektdatei, Medienanalyse, Proxys, UI-Shell, Designsystem, Arbeitsbereiche, Tastaturbelegung.

## Phase 3 · Schnitt ✅

Mehrspur-Timeline mit acht Werkzeugen, Snapping, Marker, verknüpfte Clips, Insert/Overwrite, Ripple-Löschen, Undo, Echtzeit-Wiedergabe mit Audio, J/K/L, Scopes, Export mit Hardware-Encodern und Render-Warteschlange.

## Phase 7 · Professional Polish ✅

Zuverlässigkeit: Deltas statt Gesamtzustand, geteilte Undo-Schnappschüsse, Autosave-Intervall, Versionen, Speicherstatus, Absturz-Wiederherstellung geprüft. Schnitt: Quellmonitor mit Dreipunktschnitt, Match Frame, Lift/Extract, Clip ersetzen, Standbild, Spurhöhen und -farben, Clip-Beschriftungen, Auto-Scroll, Verlauf-Panel, J/L-Hinweis. Keyframes mit Easing für Bewegung, Deckkraft und Lautstärke inkl. Export. Audio: Normalisieren nach Peak/True Peak/LUFS, Übersteuerungsanzeige. Monitor: Raster, Masken, verworfene Frames. Export: Plattform- und eigene Vorgaben, VBR/CBR, Mono, Speicherplatzprüfung, Protokoll, Wiederholen, Prüfung nach dem Rendern. Bedienung: Suche/Befehlspalette, Einstellungen, Tastaturprofile mit Import/Export, Startbildschirm, Dateizuordnung `.kerf`. Details in [STATUS.md](STATUS.md).

## Als Nächstes · Phase 8 · Titel, Übergänge, Effekte

1. **Titel und Untertitel:** Text-Clips (Schrift, Größe, Farbe, Kontur, Schatten, Hintergrund) als eigene Medienart. Vorschau per Canvas2D → Textur, Export als PNG-Sequenz oder `drawtext`, Parität per Pixelvergleich. SRT/VTT importieren und exportieren, Untertitelspur.
2. **Übergänge:** Überblendung, Blende über Schwarz, Wischen. Modell: Übergang am Schnittpunkt mit Dauer und Ausrichtung; braucht Handles aus den Quellen, die beim Anlegen geprüft werden.
3. **Effekt-Stapel:** Ein Effekt = Parameterbeschreibung + GLSL-Fragment (Vorschau) + FFmpeg-Filterfragment (Export) + Paritätstest. Erste Effekte: Weichzeichner, Schärfen, Vignette, LUT (`.cube`), Chroma-Key, Masken. Parameter über das bestehende Keyframe-System animierbar.
4. **Farbe:** Farbräder (Lift/Gamma/Gain), Kurven, animierbare Farbkorrektur.
5. **Keyframes ausbauen:** Bezier-Griffe, Keyframe-Editor in der Timeline (Gummiband für Lautstärke), Keyframes einzeln kopieren.

## Phase 9 · Audio

- Spur- und Clip-Effekte: EQ, Kompressor, Limiter, Rauschgate (WebAudio-Knoten in der Vorschau, FFmpeg-Filter im Export)
- Lautheit beim Export normalisieren (zweistufiges `loudnorm`), Lautheitsmessung live während der Wiedergabe
- Mono/Stereo-Spurtypen, Kanalzuordnung

## Phase 10 · Skalierung und Arbeitsumgebung

- **Native Render-Pipeline:** wgpu-Compositor in Rust für den Export, damit lange Timelines nicht einen FFmpeg-Eingang pro Clip brauchen.
- Verschachtelte Sequenzen, Multicam, Geschwindigkeitsrampen und Rückwärts-Clips
- Andockbare Panels (zwischen Bereichen ziehen), zweites Fenster für den Programmmonitor auf einem weiteren Bildschirm
- Medienverwaltung: Smart Bins, Metadaten-Editor, Projekt archivieren (Medien sammeln), Cache-Verwaltung
- Farbmanagement für ungetaggte Quellen (wählbare Matrix im Vorschau-Shader), HDR-Metadaten
- Installer-Signatur, automatische Updates, macOS- und Linux-Builds
