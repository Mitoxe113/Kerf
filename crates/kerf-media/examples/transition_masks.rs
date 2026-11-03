//! Prints the mask transitions' FFmpeg conditions as JSON (camelCase kind ->
//! expression), for scripts/transition-parity.mjs.
use kerf_core::model::TransitionKind as K;

fn main() {
    let kinds = [K::IrisRound, K::IrisBox, K::Clock, K::BarnDoorH, K::BarnDoorV, K::WipeDiagonal, K::Blinds];
    let map: serde_json::Map<String, serde_json::Value> = kinds
        .iter()
        .map(|k| {
            let name = serde_json::to_value(k).unwrap().as_str().unwrap().to_string();
            (name, serde_json::Value::String(k.mask().unwrap().to_string()))
        })
        .collect();
    println!("{}", serde_json::Value::Object(map));
}
