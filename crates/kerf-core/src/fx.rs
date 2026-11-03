//! The catalogue of generic video effects (`EffectKind::Fx`).
//!
//! Each entry declares its parameters (ids, ranges, defaults, UI kind), a
//! category and a version. The catalogue is the single source of truth: the
//! core sanitizes stored parameters against it, the export renderer turns an
//! entry into FFmpeg filters (`kerf_media::fx`) and the preview compositor has
//! a WebGL pass per id (`src/engine/fx.ts`). The UI builds its controls from
//! the catalogue, which the app serves over IPC.
//!
//! Effects are data, never code: a preset or project can only name an id from
//! this list and give numbers for its parameters.

use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FxCategory {
    Color,
    Blur,
    Light,
    Distort,
    Stylize,
    Keying,
    Transform,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ParamKind {
    /// Continuous value; `unit` is shown after the number, `scale` converts
    /// the stored value to the shown one (e.g. 100 for percent).
    Float { unit: &'static str, scale: f32 },
    /// Whole numbers.
    Int,
    /// Degrees.
    Angle,
    /// 0 or 1.
    Toggle,
    /// Index into `options`.
    Choice { options: &'static [&'static str] },
    /// RGB 0..1, stored as `<id>R`, `<id>G`, `<id>B`.
    Color,
    /// Position 0..1 of the frame (picked on the monitor), stored as `<id>X`, `<id>Y`.
    Point,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDef {
    pub id: &'static str,
    pub label: &'static str,
    pub min: f32,
    pub max: f32,
    /// For colours and points the default of every component.
    pub default: f32,
    #[serde(flatten)]
    pub kind: ParamKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxDef {
    pub id: &'static str,
    /// Bumped when the meaning of a parameter changes.
    pub version: u32,
    pub category: FxCategory,
    pub label: &'static str,
    pub description: &'static str,
    pub params: &'static [ParamDef],
    /// Rough export cost: true when the export evaluates a per-pixel
    /// expression (`geq`), which is much slower than a native filter.
    pub heavy: bool,
}

const PCT: ParamKind = ParamKind::Float { unit: " %", scale: 100.0 };
const PX: ParamKind = ParamKind::Float { unit: " px", scale: 1.0 };
const NUM: ParamKind = ParamKind::Float { unit: "", scale: 1.0 };

const fn p(id: &'static str, label: &'static str, min: f32, max: f32, default: f32, kind: ParamKind) -> ParamDef {
    ParamDef { id, label, min, max, default, kind }
}

const CENTER: ParamDef = p("center", "Mittelpunkt", 0.0, 1.0, 0.5, ParamKind::Point);

pub const CATALOG: &[FxDef] = &[
    // --- colour -------------------------------------------------------------------
    FxDef {
        id: "brightnessContrast",
        version: 1,
        category: FxCategory::Color,
        label: "Helligkeit und Kontrast",
        description: "Hebt oder senkt alle Tonwerte und spreizt sie um das mittlere Grau.",
        params: &[p("brightness", "Helligkeit", -1.0, 1.0, 0.0, PCT), p("contrast", "Kontrast", -1.0, 1.0, 0.0, PCT)],
        heavy: false,
    },
    FxDef {
        id: "levels",
        version: 1,
        category: FxCategory::Color,
        label: "Tonwerte",
        description: "Eingangs-Schwarz und -Weiß, Gamma und Ausgangsbereich je Kanal gleich.",
        params: &[
            p("inBlack", "Eingang Schwarz", 0.0, 1.0, 0.0, PCT),
            p("inWhite", "Eingang Weiß", 0.0, 1.0, 1.0, PCT),
            p("gamma", "Gamma", 0.1, 5.0, 1.0, NUM),
            p("outBlack", "Ausgang Schwarz", 0.0, 1.0, 0.0, PCT),
            p("outWhite", "Ausgang Weiß", 0.0, 1.0, 1.0, PCT),
        ],
        heavy: false,
    },
    FxDef {
        id: "tone",
        version: 1,
        category: FxCategory::Color,
        label: "Lichter und Tiefen",
        description: "Hebt oder senkt Tiefen, Lichter, Schwarz- und Weißbereich getrennt.",
        params: &[
            p("shadows", "Tiefen", -1.0, 1.0, 0.0, PCT),
            p("highlights", "Lichter", -1.0, 1.0, 0.0, PCT),
            p("blacks", "Schwarz", -1.0, 1.0, 0.0, PCT),
            p("whites", "Weiß", -1.0, 1.0, 0.0, PCT),
        ],
        heavy: false,
    },
    FxDef {
        id: "colorBalance",
        version: 1,
        category: FxCategory::Color,
        label: "Farbbalance",
        description: "Verschiebt Rot, Grün und Blau getrennt in Tiefen, Mitten und Lichtern.",
        params: &[
            p("shadowsR", "Tiefen Rot", -1.0, 1.0, 0.0, PCT),
            p("shadowsG", "Tiefen Grün", -1.0, 1.0, 0.0, PCT),
            p("shadowsB", "Tiefen Blau", -1.0, 1.0, 0.0, PCT),
            p("midR", "Mitten Rot", -1.0, 1.0, 0.0, PCT),
            p("midG", "Mitten Grün", -1.0, 1.0, 0.0, PCT),
            p("midB", "Mitten Blau", -1.0, 1.0, 0.0, PCT),
            p("highR", "Lichter Rot", -1.0, 1.0, 0.0, PCT),
            p("highG", "Lichter Grün", -1.0, 1.0, 0.0, PCT),
            p("highB", "Lichter Blau", -1.0, 1.0, 0.0, PCT),
        ],
        heavy: false,
    },
    FxDef {
        id: "vibrance",
        version: 1,
        category: FxCategory::Color,
        label: "Dynamik",
        description: "Sättigt schwach gesättigte Farben stärker als kräftige.",
        params: &[p("amount", "Stärke", -1.0, 1.0, 0.3, PCT)],
        heavy: true,
    },
    FxDef {
        id: "hueShift",
        version: 1,
        category: FxCategory::Color,
        label: "Farbton drehen",
        description: "Dreht alle Farbtöne um die Grauachse.",
        params: &[p("angle", "Winkel", -180.0, 180.0, 0.0, ParamKind::Angle)],
        heavy: false,
    },
    FxDef {
        id: "hslSecondary",
        version: 1,
        category: FxCategory::Color,
        label: "HSL-Sekundärkorrektur",
        description: "Ändert Farbton, Sättigung und Helligkeit nur in einem gewählten Farbtonbereich (selektive Farbe).",
        params: &[
            p("hue", "Farbton", 0.0, 360.0, 120.0, ParamKind::Angle),
            p("range", "Bereich", 1.0, 180.0, 30.0, ParamKind::Angle),
            p("softness", "Weichheit", 0.0, 180.0, 20.0, ParamKind::Angle),
            p("shift", "Farbton verschieben", -180.0, 180.0, 0.0, ParamKind::Angle),
            p("saturation", "Sättigung", -1.0, 1.0, 0.0, PCT),
            p("lightness", "Helligkeit", -1.0, 1.0, 0.0, PCT),
        ],
        heavy: true,
    },
    FxDef {
        id: "blackWhite",
        version: 1,
        category: FxCategory::Color,
        label: "Schwarzweiß",
        description: "Entsättigt nach Rec.709-Luma.",
        params: &[p("amount", "Stärke", 0.0, 1.0, 1.0, PCT)],
        heavy: false,
    },
    FxDef {
        id: "sepia",
        version: 1,
        category: FxCategory::Color,
        label: "Sepia",
        description: "Warmer, bräunlicher Altbild-Ton.",
        params: &[p("amount", "Stärke", 0.0, 1.0, 1.0, PCT)],
        heavy: false,
    },
    FxDef {
        id: "colorize",
        version: 1,
        category: FxCategory::Color,
        label: "Einfärben",
        description: "Ersetzt die Farbe durch einen Farbton, die Helligkeit bleibt.",
        params: &[
            p("hue", "Farbton", 0.0, 360.0, 30.0, ParamKind::Angle),
            p("saturation", "Sättigung", 0.0, 1.0, 0.6, PCT),
            p("amount", "Stärke", 0.0, 1.0, 1.0, PCT),
        ],
        heavy: false,
    },
    FxDef {
        id: "invert",
        version: 1,
        category: FxCategory::Color,
        label: "Umkehren",
        description: "Negativ der Farben.",
        params: &[p("amount", "Stärke", 0.0, 1.0, 1.0, PCT)],
        heavy: false,
    },
    FxDef {
        id: "posterize",
        version: 1,
        category: FxCategory::Color,
        label: "Tontrennung",
        description: "Reduziert jeden Kanal auf wenige Stufen.",
        params: &[p("levels", "Stufen", 2.0, 32.0, 5.0, ParamKind::Int)],
        heavy: false,
    },
    FxDef {
        id: "solarize",
        version: 1,
        category: FxCategory::Color,
        label: "Solarisation",
        description: "Kehrt Tonwerte oberhalb der Schwelle um.",
        params: &[p("threshold", "Schwelle", 0.0, 1.0, 0.5, PCT)],
        heavy: false,
    },
    // --- blur ---------------------------------------------------------------------
    FxDef {
        id: "boxBlur",
        version: 1,
        category: FxCategory::Blur,
        label: "Rechteck-Weichzeichner",
        description: "Mittelwert über ein Quadrat, waagrecht und senkrecht getrennt.",
        params: &[p("radius", "Radius", 0.0, 60.0, 4.0, ParamKind::Int)],
        heavy: false,
    },
    FxDef {
        id: "directionalBlur",
        version: 1,
        category: FxCategory::Blur,
        label: "Richtungs-Weichzeichner",
        description: "Bewegungsunschärfe entlang eines Winkels.",
        params: &[p("angle", "Winkel", -180.0, 180.0, 0.0, ParamKind::Angle), p("length", "Länge", 0.0, 200.0, 20.0, PX)],
        heavy: true,
    },
    FxDef {
        id: "radialBlur",
        version: 1,
        category: FxCategory::Blur,
        label: "Kreisförmiger Weichzeichner",
        description: "Dreht die Unschärfe um einen Mittelpunkt.",
        params: &[p("angle", "Winkel", 0.0, 45.0, 6.0, ParamKind::Angle), CENTER],
        heavy: true,
    },
    FxDef {
        id: "zoomBlur",
        version: 1,
        category: FxCategory::Blur,
        label: "Zoom-Weichzeichner",
        description: "Unschärfe strahlenförmig vom Mittelpunkt.",
        params: &[p("amount", "Stärke", 0.0, 0.5, 0.1, PCT), CENTER],
        heavy: true,
    },
    FxDef {
        id: "tiltShift",
        version: 1,
        category: FxCategory::Blur,
        label: "Tilt-Shift",
        description: "Scharfer waagrechter Streifen, darüber und darunter Gauß-Unschärfe.",
        params: &[
            p("focus", "Fokuslage", 0.0, 1.0, 0.5, PCT),
            p("width", "Scharfer Bereich", 0.0, 1.0, 0.25, PCT),
            p("feather", "Übergang", 0.01, 1.0, 0.2, PCT),
            p("radius", "Radius", 0.0, 60.0, 8.0, PX),
        ],
        heavy: false,
    },
    FxDef {
        id: "softFocus",
        version: 1,
        category: FxCategory::Blur,
        label: "Weichzeichnen (Soft Focus)",
        description: "Hellt mit einer weichgezeichneten Kopie auf (Aufhellen-Mischung).",
        params: &[p("amount", "Stärke", 0.0, 1.0, 0.5, PCT), p("radius", "Radius", 0.5, 60.0, 10.0, PX)],
        heavy: false,
    },
    // --- light --------------------------------------------------------------------
    FxDef {
        id: "glow",
        version: 1,
        category: FxCategory::Light,
        label: "Leuchten",
        description: "Helle Bereiche über der Schwelle werden weichgezeichnet und addiert (auch Bloom).",
        params: &[
            p("threshold", "Schwelle", 0.0, 1.0, 0.6, PCT),
            p("radius", "Radius", 0.5, 80.0, 12.0, PX),
            p("intensity", "Intensität", 0.0, 3.0, 1.0, PCT),
        ],
        heavy: false,
    },
    FxDef {
        id: "chromaticAberration",
        version: 1,
        category: FxCategory::Light,
        label: "Chromatische Aberration",
        description: "Verschiebt Rot und Blau gegeneinander (RGB-Versatz).",
        params: &[p("amount", "Versatz", -30.0, 30.0, 4.0, ParamKind::Int), p("vertical", "Senkrecht", 0.0, 1.0, 0.0, ParamKind::Toggle)],
        heavy: false,
    },
    // --- distort ------------------------------------------------------------------
    FxDef {
        id: "wave",
        version: 1,
        category: FxCategory::Distort,
        label: "Welle",
        description: "Sinusförmige Verschiebung der Zeilen oder Spalten.",
        params: &[
            p("amplitude", "Amplitude", 0.0, 200.0, 12.0, PX),
            p("wavelength", "Wellenlänge", 4.0, 2000.0, 120.0, PX),
            p("phase", "Phase", -180.0, 180.0, 0.0, ParamKind::Angle),
            p("vertical", "Senkrecht", 0.0, 1.0, 0.0, ParamKind::Toggle),
        ],
        heavy: true,
    },
    FxDef {
        id: "twirl",
        version: 1,
        category: FxCategory::Distort,
        label: "Strudel",
        description: "Dreht das Bild zur Mitte hin stärker.",
        params: &[p("angle", "Winkel", -720.0, 720.0, 120.0, ParamKind::Angle), p("radius", "Radius", 0.05, 1.0, 0.5, PCT), CENTER],
        heavy: true,
    },
    FxDef {
        id: "bulge",
        version: 1,
        category: FxCategory::Distort,
        label: "Wölben und Kneifen",
        description: "Positiv wölbt nach außen, negativ kneift nach innen.",
        params: &[p("amount", "Stärke", -1.0, 1.0, 0.5, PCT), p("radius", "Radius", 0.05, 1.0, 0.4, PCT), CENTER],
        heavy: true,
    },
    FxDef {
        id: "lensDistortion",
        version: 1,
        category: FxCategory::Distort,
        label: "Objektivverzerrung",
        description: "Tonne (positiv, Fischauge) oder Kissen (negativ).",
        params: &[p("amount", "Stärke", -1.0, 1.0, 0.3, PCT)],
        heavy: true,
    },
    FxDef {
        id: "kaleidoscope",
        version: 1,
        category: FxCategory::Distort,
        label: "Kaleidoskop",
        description: "Spiegelt Kreissegmente um die Mitte.",
        params: &[p("segments", "Segmente", 2.0, 16.0, 6.0, ParamKind::Int), p("angle", "Drehung", -180.0, 180.0, 0.0, ParamKind::Angle)],
        heavy: true,
    },
    FxDef {
        id: "mirror",
        version: 1,
        category: FxCategory::Distort,
        label: "Spiegeln",
        description: "Spiegelt eine Bildhälfte auf die andere.",
        params: &[p("mode", "Richtung", 0.0, 3.0, 0.0, ParamKind::Choice { options: &["Links nach rechts", "Rechts nach links", "Oben nach unten", "Unten nach oben"] })],
        heavy: true,
    },
    FxDef {
        id: "pixelate",
        version: 1,
        category: FxCategory::Stylize,
        label: "Verpixeln (Mosaik)",
        description: "Blöcke in der Farbe ihrer Mitte.",
        params: &[p("size", "Blockgröße", 2.0, 200.0, 16.0, ParamKind::Int)],
        heavy: true,
    },
    // --- stylize ------------------------------------------------------------------
    FxDef {
        id: "scanlines",
        version: 1,
        category: FxCategory::Stylize,
        label: "Zeilenraster",
        description: "Abgedunkelte Zeilen wie auf einem Röhrenmonitor.",
        params: &[p("spacing", "Abstand", 2.0, 40.0, 4.0, ParamKind::Int), p("darkness", "Abdunkeln", 0.0, 1.0, 0.4, PCT)],
        heavy: true,
    },
    FxDef {
        id: "filmGrain",
        version: 1,
        category: FxCategory::Stylize,
        label: "Filmkorn",
        description: "Korn, das sich mit jedem Bild ändert; Muster in Vorschau und Export identisch.",
        params: &[
            p("amount", "Stärke", 0.0, 1.0, 0.15, PCT),
            p("size", "Korngröße", 1.0, 8.0, 1.0, ParamKind::Int),
            p("color", "Farbiges Korn", 0.0, 1.0, 0.0, ParamKind::Toggle),
        ],
        heavy: true,
    },
    FxDef {
        id: "glitch",
        version: 1,
        category: FxCategory::Stylize,
        label: "Glitch",
        description: "Zufällig verschobene Bildstreifen mit RGB-Versatz, wechselt mit jedem Bild.",
        params: &[
            p("amount", "Häufigkeit", 0.0, 1.0, 0.3, PCT),
            p("shift", "Verschiebung", 0.0, 400.0, 60.0, PX),
            p("block", "Streifenhöhe", 2.0, 200.0, 24.0, ParamKind::Int),
            p("split", "RGB-Versatz", 0.0, 40.0, 6.0, ParamKind::Int),
            p("seed", "Variante", 0.0, 999.0, 1.0, ParamKind::Int),
        ],
        heavy: true,
    },
    FxDef {
        id: "edgeDetect",
        version: 1,
        category: FxCategory::Stylize,
        label: "Kanten finden",
        description: "Sobel-Kanten der Helligkeit, hell auf dunkel.",
        params: &[p("amount", "Verstärkung", 0.1, 8.0, 1.0, NUM), p("invert", "Dunkel auf hell", 0.0, 1.0, 0.0, ParamKind::Toggle)],
        heavy: true,
    },
    // --- keying -------------------------------------------------------------------
    FxDef {
        id: "lumaKey",
        version: 1,
        category: FxCategory::Keying,
        label: "Luma-Key",
        description: "Macht dunkle (oder helle) Bereiche transparent.",
        params: &[
            p("threshold", "Schwelle", 0.0, 1.0, 0.1, PCT),
            p("softness", "Weichheit", 0.0, 1.0, 0.1, PCT),
            p("invert", "Helles entfernen", 0.0, 1.0, 0.0, ParamKind::Toggle),
        ],
        heavy: true,
    },
    FxDef {
        id: "matte",
        version: 1,
        category: FxCategory::Keying,
        label: "Maske bereinigen",
        description: "Schrumpft (positiv) oder erweitert (negativ) die Alphamaske und macht ihre Kante weich.",
        params: &[p("choke", "Schrumpfen", -20.0, 20.0, 0.0, ParamKind::Int), p("feather", "Weiche Kante", 0.0, 40.0, 0.0, PX)],
        heavy: false,
    },
    // --- transform / compositing ---------------------------------------------------
    FxDef {
        id: "flip",
        version: 1,
        category: FxCategory::Transform,
        label: "Spiegeln (Achse)",
        description: "Kippt das Bild waagrecht und/oder senkrecht.",
        params: &[p("horizontal", "Waagrecht", 0.0, 1.0, 1.0, ParamKind::Toggle), p("vertical", "Senkrecht", 0.0, 1.0, 0.0, ParamKind::Toggle)],
        heavy: false,
    },
    FxDef {
        id: "shapeMask",
        version: 1,
        category: FxCategory::Transform,
        label: "Formmaske",
        description: "Rechteck- oder Ellipsenmaske mit weicher Kante, auch umgekehrt.",
        params: &[
            p("shape", "Form", 0.0, 1.0, 1.0, ParamKind::Choice { options: &["Rechteck", "Ellipse"] }),
            CENTER,
            p("width", "Breite", 0.01, 1.0, 0.6, PCT),
            p("height", "Höhe", 0.01, 1.0, 0.6, PCT),
            p("feather", "Weiche Kante", 0.0, 400.0, 20.0, PX),
            p("invert", "Umkehren", 0.0, 1.0, 0.0, ParamKind::Toggle),
        ],
        heavy: true,
    },
    FxDef {
        id: "border",
        version: 1,
        category: FxCategory::Transform,
        label: "Rahmen",
        description: "Farbiger Rand innerhalb der Clipfläche.",
        params: &[p("width", "Breite", 0.0, 200.0, 12.0, ParamKind::Int), p("color", "Farbe", 0.0, 1.0, 1.0, ParamKind::Color)],
        heavy: true,
    },
    FxDef {
        id: "stroke",
        version: 1,
        category: FxCategory::Transform,
        label: "Kontur",
        description: "Farbige Kontur um die nicht transparenten Bereiche (z. B. Titel, freigestellte Personen).",
        params: &[p("width", "Breite", 1.0, 30.0, 4.0, ParamKind::Int), p("color", "Farbe", 0.0, 1.0, 0.0, ParamKind::Color)],
        heavy: false,
    },
    FxDef {
        id: "dropShadow",
        version: 1,
        category: FxCategory::Transform,
        label: "Schlagschatten",
        description: "Weicher Schatten der Alphaform, versetzt unter dem Bild (innerhalb der Clipfläche).",
        params: &[
            p("distance", "Abstand", 0.0, 200.0, 12.0, ParamKind::Int),
            p("angle", "Richtung", -180.0, 180.0, 45.0, ParamKind::Angle),
            p("softness", "Weichheit", 0.0, 60.0, 8.0, PX),
            p("opacity", "Deckkraft", 0.0, 1.0, 0.6, PCT),
            p("color", "Farbe", 0.0, 1.0, 0.0, ParamKind::Color),
        ],
        heavy: true,
    },
];

pub fn def(id: &str) -> Option<&'static FxDef> {
    CATALOG.iter().find(|d| d.id == id)
}

/// The stored keys of a parameter (colours and points have several).
pub fn keys(p: &ParamDef) -> Vec<String> {
    match p.kind {
        ParamKind::Color => ["R", "G", "B"].iter().map(|c| format!("{}{c}", p.id)).collect(),
        ParamKind::Point => ["X", "Y"].iter().map(|c| format!("{}{c}", p.id)).collect(),
        _ => vec![p.id.to_string()],
    }
}

/// Default parameters of `def`.
pub fn defaults(def: &FxDef) -> BTreeMap<String, f32> {
    def.params.iter().flat_map(|p| keys(p).into_iter().map(move |k| (k, p.default))).collect()
}

/// Every parameter of `def`, clamped to its range (integers, toggles and
/// choices rounded); missing ones take the default, unknown ones are dropped.
/// `None` for non-finite values.
pub fn sanitize(def: &FxDef, params: &BTreeMap<String, f32>) -> Option<BTreeMap<String, f32>> {
    let mut out = BTreeMap::new();
    for p in def.params {
        for k in keys(p) {
            let v = params.get(&k).copied().unwrap_or(p.default);
            if !v.is_finite() {
                return None;
            }
            let v = v.clamp(p.min, p.max);
            let v = match p.kind {
                ParamKind::Int | ParamKind::Toggle | ParamKind::Choice { .. } => v.round(),
                _ => v,
            };
            out.insert(k, v);
        }
    }
    Some(out)
}

/// Read access to sanitized parameters with the catalogue defaults as fallback.
pub struct Params<'a> {
    def: &'static FxDef,
    values: &'a BTreeMap<String, f32>,
}

impl<'a> Params<'a> {
    pub fn new(def: &'static FxDef, values: &'a BTreeMap<String, f32>) -> Self {
        Self { def, values }
    }

    /// The value as the UI sees it: the shortest decimal of the stored f32
    /// read as f64 (0.1f32 is 0.1, not 0.10000000149…), so preview and export
    /// compute with the same numbers.
    pub fn get(&self, key: &str) -> f64 {
        let v = match self.values.get(key) {
            Some(v) => *v,
            None => self.def.params.iter().find(|p| keys(p).iter().any(|k| k == key)).map_or(0.0, |p| p.default),
        };
        format!("{v}").parse().unwrap_or(v as f64)
    }

    pub fn on(&self, key: &str) -> bool {
        self.get(key) >= 0.5
    }

    pub fn rgb(&self, key: &str) -> [f64; 3] {
        [self.get(&format!("{key}R")), self.get(&format!("{key}G")), self.get(&format!("{key}B"))]
    }
}

/// True when `params` of effect `id` leave every pixel unchanged.
pub fn is_identity(id: &str, params: &BTreeMap<String, f32>) -> bool {
    let Some(d) = def(id) else { return true };
    let v = Params::new(d, params);
    let zero = |keys: &[&str]| keys.iter().all(|k| v.get(k) == 0.0);
    match id {
        "brightnessContrast" => zero(&["brightness", "contrast"]),
        "levels" => v.get("inBlack") == 0.0 && v.get("inWhite") == 1.0 && v.get("gamma") == 1.0 && v.get("outBlack") == 0.0 && v.get("outWhite") == 1.0,
        "tone" => zero(&["shadows", "highlights", "blacks", "whites"]),
        "colorBalance" => zero(&["shadowsR", "shadowsG", "shadowsB", "midR", "midG", "midB", "highR", "highG", "highB"]),
        "vibrance" | "blackWhite" | "sepia" | "colorize" | "invert" | "softFocus" => zero(&["amount"]),
        "hueShift" => zero(&["angle"]),
        "hslSecondary" => zero(&["shift", "saturation", "lightness"]),
        "boxBlur" => zero(&["radius"]),
        "directionalBlur" => zero(&["length"]),
        "radialBlur" | "twirl" => zero(&["angle"]),
        "zoomBlur" | "bulge" | "lensDistortion" | "filmGrain" => zero(&["amount"]),
        "tiltShift" => zero(&["radius"]),
        "glow" => zero(&["intensity"]),
        "chromaticAberration" => zero(&["amount"]),
        "wave" => zero(&["amplitude"]),
        "scanlines" => zero(&["darkness"]),
        "glitch" => zero(&["amount"]) || (zero(&["shift"]) && zero(&["split"])),
        "matte" => zero(&["choke", "feather"]),
        "flip" => zero(&["horizontal", "vertical"]),
        "border" => zero(&["width"]),
        "dropShadow" => zero(&["opacity"]),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_unique_and_defaults_in_range() {
        let mut ids: Vec<_> = CATALOG.iter().map(|d| d.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len());
        for d in CATALOG {
            for p in d.params {
                assert!(p.min <= p.default && p.default <= p.max, "{}.{}", d.id, p.id);
            }
            let def_params = defaults(d);
            assert_eq!(sanitize(d, &def_params).as_ref(), Some(&def_params), "{}", d.id);
        }
    }

    #[test]
    fn sanitize_clamps_rounds_and_drops_unknown() {
        let d = def("posterize").unwrap();
        let mut m = BTreeMap::new();
        m.insert("levels".to_string(), 99.6);
        m.insert("evil".to_string(), 1.0);
        let s = sanitize(d, &m).unwrap();
        assert_eq!(s.get("levels"), Some(&32.0));
        assert!(!s.contains_key("evil"));
        m.insert("levels".to_string(), f32::NAN);
        assert!(sanitize(d, &m).is_none());
    }

    #[test]
    fn colour_and_point_params_expand() {
        let d = def("dropShadow").unwrap();
        let s = defaults(d);
        assert!(s.contains_key("colorR") && s.contains_key("colorB"));
        let d = def("twirl").unwrap();
        assert!(defaults(d).contains_key("centerY"));
    }

    #[test]
    fn writes_the_catalog_fixture() {
        // The UI checks it has a WebGL pass for every id (src/engine/fx.test.ts).
        let json = serde_json::to_string_pretty(CATALOG).unwrap() + "\n";
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/effects/catalog.json");
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        if current != json {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &json).unwrap();
            assert!(std::env::var("CI").is_err(), "fixtures/effects/catalog.json was stale; regenerated");
        }
    }
}
