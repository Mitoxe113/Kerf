//! Preview/export parity: the WebGL compositor (src/engine/math.ts) and the
//! export filter graph (ColorAdjust::matrix) must agree on the colour math.
//! Both test suites check the same fixture file.

use kerf_core::model::ColorAdjust;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    adjust: ColorAdjust,
    matrix: [[f32; 3]; 3],
    contrast_slope: f32,
}

#[test]
fn colour_matrix_matches_fixture() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("../../../fixtures/parity/color.json")).unwrap();
    assert!(cases.len() >= 4);
    for c in cases {
        let m = c.adjust.matrix();
        for r in 0..3 {
            for col in 0..3 {
                assert!(
                    (m[r][col] - c.matrix[r][col]).abs() < 1e-5,
                    "{:?}: m[{r}][{col}] = {} expected {}",
                    c.adjust,
                    m[r][col],
                    c.matrix[r][col]
                );
            }
        }
        assert!((c.adjust.contrast_slope() - c.contrast_slope).abs() < 1e-6);
    }
}
