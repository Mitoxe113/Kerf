# Drittanbieter-Hinweise

Kerf steht unter der **GNU General Public License v3.0 oder später** ([LICENSE](LICENSE)). Es enthält oder nutzt die folgenden Werke Dritter. Ihre Lizenzen gelten für die jeweiligen Teile weiter.

## Aus FFmpeg abgeleiteter Code

`src/engine/dsp.ts` (Equalizer, Kompressor, Gate und Limiter der Vorschau) ist eine Portierung der FFmpeg-Filter `af_biquads.c`, `af_sidechaincompress.c` (acompressor), `af_agate.c` und `af_alimiter.c`, damit die Vorschau Sample für Sample dasselbe berechnet wie der Export. Die Originale stehen unter der GNU Lesser General Public License 2.1 oder später, die nach ihrem Abschnitt 3 als GPL weitergegeben werden darf:

- Copyright (c) 2013 Paul B Mahol
- Copyright (c) 2006-2008 Rob Sykes
- Copyright (C) 2001-2010 Krzysztof Foltman, Markus Schmidt, Thor Harald Johansen, Damien Zammit and others
- Copyright (c) 2015 Paul B Mahol

Quelle: <https://github.com/FFmpeg/FFmpeg/tree/master/libavfilter>

## FFmpeg (separates Programm)

Kerf bringt **kein** FFmpeg mit. Es ruft ein auf dem Rechner installiertes `ffmpeg`/`ffprobe` als eigenständiges Programm auf (Suche: `KERF_FFMPEG_DIR`, Programmordner, `PATH`, WinGet, `C:\ffmpeg\bin`). Für dieses FFmpeg gilt dessen eigene Lizenz (LGPL oder, je nach Build, GPL). Die Nutzung von Codecs wie H.264, HEVC oder AAC kann in manchen Ländern Patentlizenzen berühren; das betrifft das verwendete FFmpeg bzw. den Hardware-Encoder, nicht Kerfs Code.

## Schriften (in der App enthalten)

**Inter**: Copyright 2016 The Inter Project Authors (<https://github.com/rsms/inter>)
**JetBrains Mono**: Copyright 2020 The JetBrains Mono Project Authors (<https://github.com/JetBrains/JetBrainsMono>)

Beide stehen unter der SIL Open Font License 1.1 (<https://openfontlicense.org>). Der vollständige Lizenztext liegt den Paketen `@fontsource-variable/inter` und `@fontsource-variable/jetbrains-mono` bei.

## JavaScript-Bibliotheken (in der App enthalten)

| Paket | Lizenz |
| --- | --- |
| React, React DOM, scheduler | MIT, Copyright (c) Meta Platforms, Inc. and affiliates |
| Zustand | MIT, Copyright (c) 2019 Paul Henschel |
| Lucide (lucide-react) | ISC, Copyright (c) Cole Bemis 2013-2022 (Feather, MIT) und Lucide Contributors 2022 |
| @tauri-apps/api, @tauri-apps/plugin-dialog | Apache-2.0 oder MIT, Copyright (c) 2017 - Present Tauri Apps Contributors; 2019-2022 The Tauri Programme in the Commons Conservancy |

## Rust-Crates (in der App enthalten)

Direkt eingebunden für das Kreativ-Ökosystem: `rusqlite` 0.32 (MIT) mit gebündeltem **SQLite** (gemeinfrei) über `libsqlite3-sys` (MIT), `ttf-parser` 0.25 (MIT oder Apache-2.0), `sha2` 0.10 (MIT oder Apache-2.0), `reqwest` 0.13 (MIT oder Apache-2.0), `rustls` 0.23 (Apache-2.0, ISC oder MIT) mit `ring` 0.17 (Apache-2.0 und ISC), `url` 2 (MIT oder Apache-2.0), `keyring` 3.6 (MIT oder Apache-2.0; unter Linux mit `dbus-secret-service`, MIT oder Apache-2.0, und `dbus`, Apache-2.0/MIT).

Kerf baut auf Tauri 2 und rund 450 weiteren Crates auf (je nach Zielplattform). Sie stehen fast alle unter MIT und/oder Apache-2.0, einige unter BSD-3-Clause, ISC, Zlib, Unicode-3.0, CC0/Unlicense oder MPL-2.0 (Dateiebene, unverändert genutzt). Alle sind mit der GPL-3.0 vereinbar. Die genaue Liste mit Versionen und Lizenzen erzeugt:

```bash
cargo metadata --format-version 1
```

Die Lizenztexte liegen den Crates im Cargo-Register bei.
