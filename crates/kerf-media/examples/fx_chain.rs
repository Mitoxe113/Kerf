//! Prints the export's FFmpeg filter chain for each effect of a JSON list
//! (stdin: `[EffectKind, ...]`, stdout: one chain per line). Used by
//! `scripts/fx-parity.mjs`.
//!
//! Arguments `WIDTH HEIGHT DIR`: the chains are for pictures of that size, and
//! the mask images they read (freeform masks) are written under `DIR`.

use std::io::Read;
use std::path::PathBuf;

use kerf_core::model::EffectKind;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (size, root) = match args.as_slice() {
        [w, h, dir] => ((w.parse().expect("width"), h.parse().expect("height")), PathBuf::from(dir)),
        _ => ((0, 0), PathBuf::new()),
    };
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let effects: Vec<EffectKind> = serde_json::from_str(&input).expect("JSON list of effects");
    for e in effects {
        let e = e.sanitized().expect("valid effect");
        let (chain, masks) = kerf_media::render::effect_chain_sized(&e, 25.0, 0, size, &root);
        for m in &masks {
            kerf_media::mask::render(m).expect("mask image");
        }
        println!("{chain}");
    }
}
