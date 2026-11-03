//! FFmpeg filters for the catalogue effects (`kerf_core::fx`).
//!
//! Every effect here has a WebGL twin in `src/engine/fx.ts` that computes the
//! same numbers:
//!
//! * per-channel tone functions run through `lutrgb`; the preview evaluates
//!   the identical formula into a 256-entry table (`fixtures/effects/tables.json`
//!   checks both produce the same bytes),
//! * colour matrices run through `colorchannelmixer`,
//! * everything that needs other channels or other pixels is a `geq`
//!   expression. `geq` samples bilinearly with coordinates clamped to
//!   `[0, size - 2]` and truncates its result, so every expression rounds and
//!   clamps itself (`+0.5`, `clip`) and the shaders sample the same way.
//!
//! Expressions work in 0..255 and pixel indices (X, Y from the top left).

use std::collections::BTreeMap;
use std::f64::consts::PI;

use kerf_core::fx::{self, Params};

/// A number for an expression, exactly (shortest round-trip decimal).
fn n(v: f64) -> String {
    if v == 0.0 {
        "0".into()
    } else {
        format!("{v}")
    }
}

/// Luma (Rec.709) of the pixel at (x, y) as an expression.
fn luma_at(x: &str, y: &str) -> String {
    format!("(0.2126*r({x},{y})+0.7152*g({x},{y})+0.0722*b({x},{y}))")
}

fn geq(r: &str, g: &str, b: &str, a: &str) -> String {
    format!("geq=r='{r}':g='{g}':b='{b}':a='{a}'")
}

/// The same coordinate remap for all four channels.
fn remap(prelude: &str, x: &str, y: &str) -> String {
    let ch = |f: &str| format!("{prelude}{f}({x},{y})");
    geq(&ch("r"), &ch("g"), &ch("b"), &ch("alpha"))
}

/// Per-channel tone curve y = f(x), x and y in 0..1, as a `lutrgb` expression
/// (lutrgb truncates, hence +0.5). `body` uses `@` for val/maxval.
pub fn lut_expr(body: &str) -> String {
    format!("({})*255+0.5", body.replace('@', "(val/255)"))
}

/// `lutrgb` with one body for all channels.
fn lut_all(body: &str) -> String {
    let e = lut_expr(body);
    format!("lutrgb=r='{e}':g='{e}':b='{e}'")
}

/// Tone function body (in `@`) of a per-channel effect, or None for effects that
/// are not tables. Mirrors `toneBody` in `src/engine/fx.ts`.
pub fn tone_bodies(id: &str, p: &Params) -> Option<[String; 3]> {
    let same = |b: String| Some([b.clone(), b.clone(), b]);
    match id {
        "brightnessContrast" => same(format!("(@+{}-0.5)*{}+0.5", n(p.get("brightness")), n(1.0 + p.get("contrast")))),
        "levels" => {
            let span = (p.get("inWhite") - p.get("inBlack")).max(0.001);
            same(format!(
                "{}+{}*pow(clip((@-{})/{},0,1),{})",
                n(p.get("outBlack")),
                n(p.get("outWhite") - p.get("outBlack")),
                n(p.get("inBlack")),
                n(span),
                n(1.0 / p.get("gamma"))
            ))
        }
        "tone" => same(format!(
            "@+1.6875*({}*@*(1-@)*(1-@)+{}*@*@*(1-@))+0.25*({}*pow(1-@,4)+{}*pow(@,4))",
            n(p.get("shadows")),
            n(p.get("highlights")),
            n(p.get("blacks")),
            n(p.get("whites"))
        )),
        "colorBalance" => {
            let ch = |c: &str| {
                format!(
                    "@+0.25*({}*(1-@)*(1-@)+{}*4*@*(1-@)+{}*@*@)",
                    n(p.get(&format!("shadows{c}"))),
                    n(p.get(&format!("mid{c}"))),
                    n(p.get(&format!("high{c}")))
                )
            };
            Some([ch("R"), ch("G"), ch("B")])
        }
        "invert" => same(format!("@+{}*(1-2*@)", n(p.get("amount")))),
        "posterize" => {
            let k = p.get("levels") - 1.0;
            same(format!("floor(@*{k}+0.5)/{k}", k = n(k)))
        }
        "solarize" => same(format!("if(gt(@,{t}),1-@,@)", t = n(p.get("threshold")))),
        _ => None,
    }
}

/// Bright-pass of the glow (per channel).
pub fn glow_body(threshold: f64) -> String {
    let t = threshold.min(0.999);
    format!("max(@-{},0)/{}", n(t), n(1.0 - t))
}

/// Row-major 3×3 colour matrix of the matrix effects. Mirrors `fxMatrix` in fx.ts.
pub fn matrix(id: &str, p: &Params) -> Option<[[f64; 3]; 3]> {
    const L: [f64; 3] = [0.2126, 0.7152, 0.0722];
    let mix = |m: [[f64; 3]; 3], a: f64| {
        let mut o = [[0.0; 3]; 3];
        for (r, row) in o.iter_mut().enumerate() {
            for (c, v) in row.iter_mut().enumerate() {
                *v = (1.0 - a) * if r == c { 1.0 } else { 0.0 } + a * m[r][c];
            }
        }
        o
    };
    match id {
        "blackWhite" => Some(mix([L, L, L], p.get("amount"))),
        "sepia" => Some(mix([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]], p.get("amount"))),
        "colorize" => {
            let c = hsv(p.get("hue"), p.get("saturation"));
            let lc = (L[0] * c[0] + L[1] * c[1] + L[2] * c[2]).max(1e-6);
            let m = [0, 1, 2].map(|r| L.map(|l| c[r] / lc * l));
            Some(mix(m, p.get("amount")))
        }
        "hueShift" => Some(hue_rotation(p.get("angle").to_radians())),
        _ => None,
    }
}

/// RGB of hue (degrees) and saturation at full value.
pub fn hsv(hue: f64, sat: f64) -> [f64; 3] {
    let h = (hue.rem_euclid(360.0)) / 60.0;
    let f = |k: f64| {
        let k = (k + h) % 6.0;
        1.0 - sat * (k.min(4.0 - k)).clamp(0.0, 1.0)
    };
    [f(5.0), f(3.0), f(1.0)]
}

/// Rotation about the grey axis.
pub fn hue_rotation(theta: f64) -> [[f64; 3]; 3] {
    let (c, s) = (theta.cos(), theta.sin());
    let t = (1.0 - c) / 3.0;
    let q = (1.0f64 / 3.0).sqrt() * s;
    [[c + t, t - q, t + q], [t + q, c + t, t - q], [t - q, t + q, c + t]]
}

fn mixer(m: [[f64; 3]; 3]) -> String {
    format!(
        "colorchannelmixer=rr={}:rg={}:rb={}:gr={}:gg={}:gb={}:br={}:bg={}:bb={}",
        n(m[0][0]),
        n(m[0][1]),
        n(m[0][2]),
        n(m[1][0]),
        n(m[1][1]),
        n(m[1][2]),
        n(m[2][0]),
        n(m[2][1]),
        n(m[2][2])
    )
}

/// Integer hash used by grain and glitch, identical to `hash` in fx.ts:
/// two rounds of h = (h² + c) mod 65521 (values stay below 2³²).
fn hash_expr(seed: &str) -> String {
    format!("mod(pow(mod(pow(mod({seed},65521),2)+31337,65521),2)+7,65521)/65521")
}

/// Taps of the line, spin and zoom blurs.
const TAPS: i32 = 13;

/// Filters for catalogue effect `id`. `k`, `j` make labels unique; `rate` is
/// the frame rate and `frame0` the clip-local index of the first frame this
/// stream renders, for effects that change with every frame.
pub fn filters(id: &str, params: &BTreeMap<String, f32>, k: usize, j: usize, rate: f64, frame0: i64) -> Vec<String> {
    let Some(def) = fx::def(id) else { return Vec::new() };
    let p = Params::new(def, params);
    let l = |s: &str| format!("fx{k}e{j}{s}");
    let (a, b, c) = (l("a"), l("b"), l("c"));
    if let Some([r, g, bl]) = tone_bodies(id, &p) {
        return vec![format!("lutrgb=r='{}':g='{}':b='{}'", lut_expr(&r), lut_expr(&g), lut_expr(&bl))];
    }
    if let Some(m) = matrix(id, &p) {
        return vec![mixer(m)];
    }
    let frame = format!("mod(floor(T*{}+0.5)+{},65521)", n(rate), frame0);
    let center = || (format!("({}*W)", n(p.get("centerX"))), format!("({}*H)", n(p.get("centerY"))));
    let round = |e: &str| format!("clip({e}+0.5,0,255)");
    match id {
        "vibrance" => {
            let pre = "st(0,r(X,Y));st(1,g(X,Y));st(2,b(X,Y));st(3,0.2126*ld(0)+0.7152*ld(1)+0.0722*ld(2));st(4,1+AMT*(1-(max(ld(0),max(ld(1),ld(2)))-min(ld(0),min(ld(1),ld(2))))/255));"
                .replace("AMT", &n(p.get("amount")));
            let ch = |i: usize| format!("{pre}{}", round(&format!("ld(3)+(ld({i})-ld(3))*ld(4)")));
            vec![geq(&ch(0), &ch(1), &ch(2), "alpha(X,Y)")]
        }
        "hslSecondary" => {
            let soft = p.get("softness").max(0.001);
            let pre = format!(
                "st(0,r(X,Y));st(1,g(X,Y));st(2,b(X,Y));\
                 st(3,max(ld(0),max(ld(1),ld(2)))-min(ld(0),min(ld(1),ld(2))));\
                 st(4,atan2(1.7320508*(ld(1)-ld(2)),2*ld(0)-ld(1)-ld(2))*57.2957795);\
                 st(5,1-clip((abs(mod(ld(4)-{hue}+180,360)-180)-{range})/{soft},0,1));\
                 st(5,ld(5)*ld(5)*(3-2*ld(5))*clip(ld(3)/25.5,0,1));\
                 st(6,ld(5)*{shift});st(7,cos(ld(6)));st(8,0.57735027*sin(ld(6)));st(9,(1-ld(7))/3);\
                 st(3,(ld(7)+ld(9))*ld(0)+(ld(9)-ld(8))*ld(1)+(ld(9)+ld(8))*ld(2));\
                 st(4,(ld(9)+ld(8))*ld(0)+(ld(7)+ld(9))*ld(1)+(ld(9)-ld(8))*ld(2));\
                 st(6,(ld(9)-ld(8))*ld(0)+(ld(9)+ld(8))*ld(1)+(ld(7)+ld(9))*ld(2));\
                 st(0,0.2126*ld(3)+0.7152*ld(4)+0.0722*ld(6));",
                hue = n(p.get("hue")),
                range = n(p.get("range")),
                soft = n(soft),
                shift = n(p.get("shift").to_radians()),
            );
            let sat = n(p.get("saturation"));
            let light = p.get("lightness");
            let ch = |reg: usize| {
                let v = format!("st(1,ld(0)+(ld({reg})-ld(0))*(1+ld(5)*{sat}));");
                let lit = if light > 0.0 { format!("ld(1)+(255-ld(1))*ld(5)*{}", n(light)) } else { format!("ld(1)*(1+ld(5)*{})", n(light)) };
                format!("{pre}{v}{}", round(&lit))
            };
            vec![geq(&ch(3), &ch(4), &ch(6), "alpha(X,Y)")]
        }
        "lumaKey" => {
            let t = p.get("threshold");
            let s = p.get("softness");
            let l = format!("{}/255", luma_at("X", "Y"));
            let m = match (s > 0.0, p.on("invert")) {
                (true, false) => format!("clip(({l}-{})/{},0,1)", n(t), n(s)),
                (true, true) => format!("clip(({}-{l})/{},0,1)", n(t), n(s)),
                (false, false) => format!("gt({l},{})", n(t)),
                (false, true) => format!("lte({l},{})", n(t)),
            };
            vec![geq("r(X,Y)", "g(X,Y)", "b(X,Y)", &round(&format!("alpha(X,Y)*{m}")))]
        }
        "boxBlur" => {
            let r = p.get("radius") as i64;
            vec![format!("avgblur=sizeX={r}:sizeY={r}")]
        }
        "directionalBlur" => {
            let th = p.get("angle").to_radians();
            let len = p.get("length");
            let taps: Vec<(f64, f64)> = (0..TAPS).map(|i| (i - TAPS / 2) as f64 / (TAPS - 1) as f64 * len).map(|d| (d * th.cos(), d * th.sin())).collect();
            let ch = |f: &str| {
                let sum: Vec<String> = taps.iter().map(|(dx, dy)| format!("{f}(X+{},Y+{})", n(*dx), n(*dy))).collect();
                round(&format!("({})/{TAPS}", sum.join("+")))
            };
            vec![geq(&ch("r"), &ch("g"), &ch("b"), &ch("alpha"))]
        }
        "radialBlur" | "zoomBlur" => {
            let (cx, cy) = center();
            let ch = |f: &str| {
                let sum: Vec<String> = (0..TAPS)
                    .map(|i| {
                        if id == "radialBlur" {
                            let th = p.get("angle").to_radians() * (i - TAPS / 2) as f64 / (TAPS - 1) as f64;
                            let (co, si) = (n(th.cos()), n(th.sin()));
                            format!("{f}({cx}+(X-{cx})*{co}-(Y-{cy})*{si},{cy}+(X-{cx})*{si}+(Y-{cy})*{co})")
                        } else {
                            let s = n(1.0 - p.get("amount") * i as f64 / (TAPS - 1) as f64);
                            format!("{f}({cx}+(X-{cx})*{s},{cy}+(Y-{cy})*{s})")
                        }
                    })
                    .collect();
                round(&format!("({})/{TAPS}", sum.join("+")))
            };
            vec![geq(&ch("r"), &ch("g"), &ch("b"), &ch("alpha"))]
        }
        "tiltShift" => {
            let m = format!("clip((abs(Y/H-{})-{})/{},0,1)", n(p.get("focus")), n(p.get("width") / 2.0), n(p.get("feather")));
            vec![format!(
                "split[{a}][{b}];[{b}]gblur=sigma={}:steps=4[{c}];[{a}][{c}]blend=all_expr='A+(B-A)*{m}+0.5'",
                n(p.get("radius"))
            )]
        }
        "softFocus" => {
            let e = format!("A+(max(A,B)-A)*{}+0.5", n(p.get("amount")));
            vec![format!(
                "split[{a}][{b}];[{b}]gblur=sigma={}:steps=4[{c}];[{a}][{c}]blend=c0_expr='{e}':c1_expr='{e}':c2_expr='{e}':c3_expr='A'",
                n(p.get("radius"))
            )]
        }
        "glow" => {
            let e = format!("clip(A+B*{}+0.5,0,255)", n(p.get("intensity")));
            vec![format!(
                "split[{a}][{b}];[{b}]{},gblur=sigma={}:steps=4[{c}];[{a}][{c}]blend=c0_expr='{e}':c1_expr='{e}':c2_expr='{e}':c3_expr='A'",
                lut_all(&glow_body(p.get("threshold"))),
                n(p.get("radius"))
            )]
        }
        "chromaticAberration" => {
            let d = p.get("amount") as i64;
            vec![if p.on("vertical") { format!("rgbashift=rv={d}:bv={}", -d) } else { format!("rgbashift=rh={d}:bh={}", -d) }]
        }
        "wave" => {
            let amp = n(p.get("amplitude"));
            let k = n(2.0 * PI / p.get("wavelength"));
            let ph = n(p.get("phase").to_radians());
            if p.on("vertical") {
                vec![remap("", "X", &format!("Y+{amp}*sin(X*{k}+{ph})"))]
            } else {
                vec![remap("", &format!("X+{amp}*sin(Y*{k}+{ph})"), "Y")]
            }
        }
        "twirl" => {
            let (cx, cy) = center();
            let pre = format!(
                "st(0,X-{cx});st(1,Y-{cy});st(2,1-clip(sqrt(ld(0)*ld(0)+ld(1)*ld(1))/({}*min(W,H)),0,1));st(2,{}*ld(2)*ld(2));",
                n(p.get("radius")),
                n(p.get("angle").to_radians())
            );
            vec![remap(&pre, &format!("{cx}+ld(0)*cos(ld(2))-ld(1)*sin(ld(2))"), &format!("{cy}+ld(0)*sin(ld(2))+ld(1)*cos(ld(2))"))]
        }
        "bulge" => {
            let (cx, cy) = center();
            let rr = format!("({}*min(W,H))", n(p.get("radius")));
            let e = n(2f64.powf(p.get("amount")));
            let pre = format!("st(0,X-{cx});st(1,Y-{cy});st(2,sqrt(ld(0)*ld(0)+ld(1)*ld(1)));st(3,if(lt(ld(2),{rr})*gt(ld(2),0),{rr}*pow(ld(2)/{rr},{e})/ld(2),1));");
            vec![remap(&pre, &format!("{cx}+ld(0)*ld(3)"), &format!("{cy}+ld(1)*ld(3)"))]
        }
        "lensDistortion" => {
            let k = p.get("amount") * 0.5;
            let pre = format!("st(0,X-W/2);st(1,Y-H/2);st(2,(1+{}*(ld(0)*ld(0)+ld(1)*ld(1))/(0.25*(W*W+H*H)))/{});", n(k), n(1.0 + k));
            vec![remap(&pre, "W/2+ld(0)*ld(2)", "H/2+ld(1)*ld(2)")]
        }
        "kaleidoscope" => {
            let seg = 2.0 * PI / p.get("segments");
            let rot = n(p.get("angle").to_radians());
            let pre = format!(
                "st(0,X-W/2);st(1,Y-H/2);st(2,sqrt(ld(0)*ld(0)+ld(1)*ld(1)));st(3,mod(atan2(ld(1),ld(0))-{rot},{s}));st(3,if(gt(ld(3),{h}),{s}-ld(3),ld(3))+{rot});",
                s = n(seg),
                h = n(seg / 2.0)
            );
            vec![remap(&pre, "W/2+ld(2)*cos(ld(3))", "H/2+ld(2)*sin(ld(3))")]
        }
        "mirror" => {
            let (x, y) = match p.get("mode") as i64 {
                0 => ("if(gt(X,(W-1)/2),W-1-X,X)", "Y"),
                1 => ("if(lt(X,(W-1)/2),W-1-X,X)", "Y"),
                2 => ("X", "if(gt(Y,(H-1)/2),H-1-Y,Y)"),
                _ => ("X", "if(lt(Y,(H-1)/2),H-1-Y,Y)"),
            };
            vec![remap("", x, y)]
        }
        "pixelate" => {
            let s = n(p.get("size"));
            vec![remap("", &format!("floor(X/{s})*{s}+({s}-1)/2"), &format!("floor(Y/{s})*{s}+({s}-1)/2"))]
        }
        "scanlines" => {
            let sp = p.get("spacing");
            let f = format!("(1-{}*lt(mod(Y,{}),{}))", n(p.get("darkness")), n(sp), n(sp / 2.0));
            let ch = |c: &str| round(&format!("{c}(X,Y)*{f}"));
            vec![geq(&ch("r"), &ch("g"), &ch("b"), "alpha(X,Y)")]
        }
        "filmGrain" => {
            let s = n(p.get("size"));
            let amt = n(p.get("amount") * 255.0);
            let color = p.on("color");
            let ch = |f: &str, i: usize| {
                let ci = if color { i } else { 0 };
                let seed = format!("floor(X/{s})*1103+floor(Y/{s})*2903+{frame}*3851+{}", ci * 7919 + 12345);
                round(&format!("{f}(X,Y)+({}-0.5)*{amt}", hash_expr(&seed)))
            };
            vec![geq(&ch("r", 0), &ch("g", 1), &ch("b", 2), "alpha(X,Y)")]
        }
        "glitch" => {
            let blk = n(p.get("block"));
            let seed = format!("floor(Y/{blk})*2903+{frame}*3851+{}", p.get("seed") as i64 * 7 + 101);
            let pre = format!(
                "st(0,lt({},{}));st(1,ld(0)*floor(({}-0.5)*2*{}+0.5));st(2,ld(0)*{});",
                hash_expr(&seed),
                n(p.get("amount")),
                hash_expr(&format!("{seed}+17")),
                n(p.get("shift")),
                n(p.get("split"))
            );
            let ch = |f: &str, off: &str| format!("{pre}{f}(X+ld(1){off},Y)");
            vec![geq(&ch("r", "-ld(2)"), &ch("g", ""), &ch("b", "+ld(2)"), &ch("alpha", ""))]
        }
        "edgeDetect" => {
            let lum = |dx: i32, dy: i32| luma_at(&format!("X+{dx}"), &format!("Y+{dy}"));
            let gx = format!("({}+2*{}+{}-{}-2*{}-{})", lum(1, -1), lum(1, 0), lum(1, 1), lum(-1, -1), lum(-1, 0), lum(-1, 1));
            let gy = format!("({}+2*{}+{}-{}-2*{}-{})", lum(-1, 1), lum(0, 1), lum(1, 1), lum(-1, -1), lum(0, -1), lum(1, -1));
            let mag = format!("st(0,{gx});st(1,{gy});st(2,clip(sqrt(ld(0)*ld(0)+ld(1)*ld(1))*{}/4,0,255));", n(p.get("amount")));
            let v = if p.on("invert") { format!("{mag}{}", round("255-ld(2)")) } else { format!("{mag}{}", round("ld(2)")) };
            vec![geq(&v, &v, &v, "alpha(X,Y)")]
        }
        "matte" => {
            let choke = p.get("choke") as i64;
            let mut f = vec!["format=gbrap".to_string()];
            let op = if choke > 0 { "erosion" } else { "dilation" };
            for _ in 0..choke.unsigned_abs() {
                f.push(format!("{op}=threshold0=0:threshold1=0:threshold2=0"));
            }
            if p.get("feather") > 0.0 {
                f.push(format!("gblur=sigma={}:steps=4:planes=8", n(p.get("feather"))));
            }
            f.push("format=rgba".into());
            vec![f.join(",")]
        }
        "flip" => {
            let mut f = Vec::new();
            if p.on("horizontal") {
                f.push("hflip".to_string());
            }
            if p.on("vertical") {
                f.push("vflip".to_string());
            }
            f
        }
        "shapeMask" => {
            let (cx, cy) = center();
            let (hw, hh) = (format!("({}*W/2)", n(p.get("width"))), format!("({}*H/2)", n(p.get("height"))));
            let d = if p.get("shape") >= 0.5 {
                format!("(1-sqrt(pow((X-{cx})/{hw},2)+pow((Y-{cy})/{hh},2)))*min({hw},{hh})")
            } else {
                format!("min({hw}-abs(X-{cx}),{hh}-abs(Y-{cy}))")
            };
            let fe = p.get("feather");
            let m = if fe > 0.0 { format!("clip(({d})/{},0,1)", n(fe)) } else { format!("gt({d},0)") };
            let m = if p.on("invert") { format!("(1-{m})") } else { m };
            vec![geq("r(X,Y)", "g(X,Y)", "b(X,Y)", &round(&format!("alpha(X,Y)*{m}")))]
        }
        "border" => {
            let w = n(p.get("width"));
            let inside = format!("lt(min(min(X,Y),min(W-1-X,H-1-Y)),{w})");
            let [cr, cg, cb] = p.rgb("color").map(|v| n((v * 255.0).round()));
            vec![geq(
                &format!("if({inside},{cr},r(X,Y))"),
                &format!("if({inside},{cg},g(X,Y))"),
                &format!("if({inside},{cb},b(X,Y))"),
                &format!("if({inside},255,alpha(X,Y))"),
            )]
        }
        "stroke" => {
            let [cr, cg, cb] = p.rgb("color").map(|v| (v * 255.0).round());
            let mut f = vec!["format=gbrap".to_string()];
            for _ in 0..(p.get("width") as i64) {
                f.push("dilation=threshold0=0:threshold1=0:threshold2=0".into());
            }
            f.push(format!("format=rgba,lutrgb=r={}:g={}:b={}", n(cr), n(cg), n(cb)));
            vec![format!("split[{a}][{b}];[{b}]{}[{c}];[{c}][{a}]overlay=format=rgb", f.join(","))]
        }
        "dropShadow" => {
            let th = p.get("angle").to_radians();
            let (dx, dy) = ((p.get("distance") * th.cos()).round(), (p.get("distance") * th.sin()).round());
            let [cr, cg, cb] = p.rgb("color").map(|v| n((v * 255.0).round()));
            let (sx, sy) = (format!("X-{}", n(dx)), format!("Y-{}", n(dy)));
            let a_expr = round(&format!("if(between({sx},0,W-1)*between({sy},0,H-1),alpha({sx},{sy}),0)*{}", n(p.get("opacity"))));
            let mut shadow = geq(&cr, &cg, &cb, &a_expr);
            if p.get("softness") > 0.0 {
                shadow.push_str(&format!(",gblur=sigma={}:steps=4", n(p.get("softness"))));
            }
            vec![format!("split[{a}][{b}];[{b}]{shadow}[{c}];[{c}][{a}]overlay=format=rgb")]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Evaluates a lutrgb body for x like FFmpeg's expression evaluator (the
    /// subset the tone bodies use).
    fn eval(body: &str, x: f64) -> f64 {
        crate::exprtest::eval(&lut_expr(body), "val", x * 255.0)
    }

    /// Writes the per-channel tables the preview must reproduce byte for byte
    /// (checked by src/engine/fx.test.ts).
    #[test]
    fn writes_tone_table_fixture() {
        let cases: Vec<(&str, Vec<(&str, f32)>)> = vec![
            ("brightnessContrast", vec![("brightness", 0.1), ("contrast", 0.35)]),
            ("levels", vec![("inBlack", 0.05), ("inWhite", 0.9), ("gamma", 1.4), ("outBlack", 0.02), ("outWhite", 0.97)]),
            ("tone", vec![("shadows", 0.6), ("highlights", -0.4), ("blacks", -0.3), ("whites", 0.2)]),
            ("colorBalance", vec![("shadowsR", 0.3), ("midG", -0.2), ("highB", 0.4)]),
            ("invert", vec![("amount", 0.75)]),
            ("posterize", vec![("levels", 5.0)]),
            ("solarize", vec![("threshold", 0.42)]),
        ];
        let mut out = Vec::new();
        for (id, ps) in cases {
            let params: BTreeMap<String, f32> = ps.iter().map(|(k, v)| (k.to_string(), *v)).collect();
            let def = fx::def(id).unwrap();
            let params = fx::sanitize(def, &params).unwrap();
            let p = Params::new(def, &params);
            // As the UI receives them over IPC (f32 written as its shortest decimal).
            let shown: BTreeMap<&String, f64> = params.keys().map(|k| (k, p.get(k))).collect();
            let bodies = tone_bodies(id, &p).unwrap();
            let tables: Vec<Vec<u8>> = bodies.iter().map(|b| (0..256).map(|v| eval(b, v as f64 / 255.0).trunc().clamp(0.0, 255.0) as u8).collect()).collect();
            out.push(serde_json::json!({ "fx": id, "params": shown, "tables": tables }));
        }
        let glow: Vec<u8> = (0..256).map(|v| eval(&glow_body(0.6), v as f64 / 255.0).trunc().clamp(0.0, 255.0) as u8).collect();
        let json = serde_json::to_string(&serde_json::json!({ "tone": out, "glow06": glow })).unwrap() + "\n";
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/effects/tables.json");
        if std::fs::read_to_string(&path).unwrap_or_default() != json {
            std::fs::write(&path, &json).unwrap();
            assert!(std::env::var("CI").is_err(), "fixtures/effects/tables.json was stale; regenerated");
        }
    }

    #[test]
    fn matrices_keep_grey_where_they_should() {
        let def = fx::def("hueShift").unwrap();
        let mut m = BTreeMap::new();
        m.insert("angle".to_string(), 77.0);
        let r = matrix("hueShift", &Params::new(def, &m)).unwrap();
        for row in r {
            assert!((row.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        }
        assert_eq!(hsv(0.0, 1.0), [1.0, 0.0, 0.0]);
        assert_eq!(hsv(120.0, 1.0), [0.0, 1.0, 0.0]);
    }

    #[test]
    fn every_catalog_effect_has_filters() {
        for d in fx::CATALOG {
            let params = fx::defaults(d);
            if fx::is_identity(d.id, &params) {
                continue;
            }
            assert!(!filters(d.id, &params, 0, 0, 25.0, 0).is_empty(), "{}", d.id);
        }
    }
}
