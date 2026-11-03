//! Prints the export's FFmpeg filter chain for each effect of a JSON list
//! (stdin: `[EffectKind, ...]`, stdout: one chain per line). Used by
//! `scripts/fx-parity.mjs`.

use std::io::Read;

use kerf_core::model::EffectKind;

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let effects: Vec<EffectKind> = serde_json::from_str(&input).expect("JSON list of effects");
    for e in effects {
        let e = e.sanitized().expect("valid effect");
        println!("{}", kerf_media::render::effect_chain(&e, 25.0, 0));
    }
}
