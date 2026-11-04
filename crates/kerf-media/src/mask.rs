//! Freeform masks (`EffectKind::PolygonMask`) for the export.
//!
//! FFmpeg has no filter that fills a polygon, so the export rasterises the
//! mask here, once per shape and size, into an 8-bit greyscale PGM in the
//! cache, and the filter graph multiplies the clip's alpha by it. The
//! preview (`maskPixels` in `src/engine/effects.ts`) rasterises the same
//! image with the same arithmetic:
//!
//! * pixel (X, Y) is the pixel index, the outline runs through the points
//!   (x · width + dx, y · height + dy) for a mask moved by whole pixels,
//!   rounded to 1/256 pixel ([`GRID`]),
//! * inside by the crossing rule (an edge counts when exactly one of its ends
//!   lies below the pixel's row and the pixel lies left of the crossing),
//!   decided with integers, so it is exact and a mask moved by whole pixels
//!   is the same image moved,
//! * `d` = distance to the nearest edge, `m` = clip(d / feather, 0, 1)
//!   inside (1 without feather) and 0 outside,
//! * stored as round(255 · m), inverted (255 − value) for an inverted mask.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::analysis::fnv1a;
use crate::MediaError;

/// Bumped when the rasterisation changes, so old cache files are not reused.
const VERSION: u32 = 2;

/// Outline points are rounded to 1/GRID pixel.
pub const GRID: i64 = 256;

/// One mask image an export needs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskJob {
    pub out: PathBuf,
    /// Size of the image.
    pub width: u32,
    pub height: u32,
    /// Size of the frame the outline is given in.
    pub frame: (u32, u32),
    /// Pixel position of the frame's top left corner in the image (a moved
    /// mask, or the margin around one that moves during the clip).
    pub origin: (i64, i64),
    /// Outline in 0..1 of the frame.
    pub points: Vec<[f32; 2]>,
    pub feather: f32,
    pub invert: bool,
}

impl MaskJob {
    /// The mask of a `frame`-sized picture, moved by `origin` pixels, in an
    /// image of `size`.
    pub fn new(root: &Path, size: (u32, u32), frame: (u32, u32), origin: (i64, i64), points: Vec<[f32; 2]>, feather: f32, invert: bool) -> Self {
        let mut key = format!("v{VERSION}|{}x{}|{}x{}|{},{}|{feather}|{invert}", size.0, size.1, frame.0, frame.1, origin.0, origin.1);
        for p in &points {
            key.push_str(&format!("|{},{}", p[0], p[1]));
        }
        let out = root.join("masks").join(format!("mask_{:016x}.pgm", fnv1a(key.as_bytes())));
        Self { out, width: size.0, height: size.1, frame, origin, points, feather, invert }
    }
}

/// The outline of `job` in 1/[`GRID`] pixels of its image.
pub fn outline(job: &MaskJob) -> Vec<(i64, i64)> {
    let (fw, fh) = (job.frame.0 as f64, job.frame.1 as f64);
    let g = GRID as f64;
    job.points
        .iter()
        .map(|p| ((p[0] as f64 * fw * g + 0.5).floor() as i64 + job.origin.0 * GRID, (p[1] as f64 * fh * g + 0.5).floor() as i64 + job.origin.1 * GRID))
        .collect()
}

/// Mask value 0..1 at pixel (x, y) of an outline in 1/[`GRID`] pixels.
pub fn coverage(pts: &[(i64, i64)], feather: f64, x: i64, y: i64) -> f64 {
    let (gx, gy) = (x * GRID, y * GRID);
    let n = pts.len();
    let mut inside = false;
    for i in 0..n {
        let (ax, ay) = pts[i];
        let (bx, by) = pts[(i + 1) % n];
        if (ay > gy) != (by > gy) {
            // gx < ax + (gy − ay)(bx − ax)/(by − ay), multiplied out.
            let (l, r) = ((gx - ax) * (by - ay), (gy - ay) * (bx - ax));
            if (by > ay && l < r) || (by < ay && l > r) {
                inside = !inside;
            }
        }
    }
    if !inside {
        return 0.0;
    }
    if feather <= 0.0 {
        return 1.0;
    }
    let g = GRID as f64;
    let (x, y) = (x as f64, y as f64);
    let mut d2 = f64::INFINITY;
    for i in 0..n {
        let (ax, ay) = (pts[i].0 as f64 / g, pts[i].1 as f64 / g);
        let (bx, by) = (pts[(i + 1) % n].0 as f64 / g, pts[(i + 1) % n].1 as f64 / g);
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let t = if len2 > 0.0 { (((x - ax) * dx + (y - ay) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
        let (ex, ey) = (x - ax - t * dx, y - ay - t * dy);
        d2 = d2.min(ex * ex + ey * ey);
    }
    (d2.sqrt() / feather).clamp(0.0, 1.0)
}

/// The 8-bit mask of `job`, row by row from the top.
pub fn pixels(job: &MaskJob) -> Vec<u8> {
    let (w, h) = (job.width as usize, job.height as usize);
    let pts = outline(job);
    let feather = job.feather as f64;
    let outside = if job.invert { 255 } else { 0 };
    let mut out = vec![outside; w * h];
    if pts.len() < 3 {
        return out;
    }
    // Only pixels inside the bounding box can be inside (the crossing count
    // of a closed outline is even left of it).
    let lo = |v: i64| v.div_euclid(GRID).max(0) as usize;
    let hi = |v: i64, n: usize| ((v + GRID - 1).div_euclid(GRID).max(0) as usize).min(n);
    let (x0, x1) = (lo(pts.iter().map(|p| p.0).min().unwrap()), hi(pts.iter().map(|p| p.0).max().unwrap(), w));
    let (y0, y1) = (lo(pts.iter().map(|p| p.1).min().unwrap()), hi(pts.iter().map(|p| p.1).max().unwrap(), h));
    for y in y0..y1 {
        for x in x0..x1 {
            let v = (coverage(&pts, feather, x as i64, y as i64) * 255.0 + 0.5).floor() as u8;
            out[y * w + x] = if job.invert { 255 - v } else { v };
        }
    }
    out
}

/// Writes the mask of `job` unless the cache holds it; returns its path.
pub fn render(job: &MaskJob) -> Result<PathBuf, MediaError> {
    if job.out.is_file() {
        return Ok(job.out.clone());
    }
    if job.points.len() < 3 || job.width == 0 || job.height == 0 {
        return Err(MediaError::Unsupported("mask without area".into()));
    }
    let dir = job.out.parent().expect("cache folder");
    fs::create_dir_all(dir)?;
    let mut data = format!("P5\n{} {}\n255\n", job.width, job.height).into_bytes();
    data.extend(pixels(job));
    let partial = dir.join(format!("partial_{}.pgm", Uuid::new_v4()));
    fs::write(&partial, data)?;
    fs::rename(&partial, &job.out)?;
    Ok(job.out.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(points: Vec<[f32; 2]>, feather: f32, invert: bool) -> MaskJob {
        MaskJob::new(Path::new("/cache"), (10, 10), (10, 10), (0, 0), points, feather, invert)
    }

    #[test]
    fn square_mask_follows_the_crossing_rule_and_feathers_inwards() {
        // Square from 2.5 to 7.5 px (0.25..0.75 of 10 px, exact in f32).
        let sq = vec![[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]];
        let hard = pixels(&job(sq.clone(), 0.0, false));
        let inside: Vec<(usize, usize)> = (0..100).filter(|i| hard[*i] == 255).map(|i| (i % 10, i / 10)).collect();
        // Rows and columns 3..=7: one end above the row, the crossing right of the pixel.
        assert_eq!(inside.len(), 25);
        assert!(inside.iter().all(|(x, y)| (3..8).contains(x) && (3..8).contains(y)));
        assert!(hard.iter().all(|v| *v == 0 || *v == 255));
        // Feather 2 px: 0.5 px inside gives 0.25, 1.5 px 0.75, 2.5 px 1.
        let soft = pixels(&job(sq.clone(), 2.0, false));
        assert_eq!(soft[2 * 10 + 5], 0, "outside");
        assert_eq!(soft[3 * 10 + 5], 64, "0.5 px inside");
        assert_eq!(soft[4 * 10 + 5], 191, "1.5 px inside");
        assert_eq!(soft[5 * 10 + 5], 255, "2.5 px inside");
        let inv = pixels(&job(sq.clone(), 2.0, true));
        assert!(soft.iter().zip(&inv).all(|(a, b)| *a as u16 + *b as u16 == 255));
        // Moved one pixel right and down in an image with a 1 px margin: the
        // margin is outside, the square sits 2 px further.
        let moved = pixels(&MaskJob::new(Path::new("/cache"), (12, 12), (10, 10), (2, 2), sq, 2.0, false));
        assert!((0..12).all(|i| moved[i] == 0 && moved[i * 12] == 0));
        assert_eq!(moved[4 * 12 + 7], 0);
        assert_eq!(moved[5 * 12 + 7], 64);
        assert_eq!(moved[6 * 12 + 7], 191);
        assert_eq!(moved[7 * 12 + 7], 255);
        // Whole-pixel moves move the image: the margin version equals the
        // plain one shifted.
        let tri = vec![[0.1, 0.1], [0.8, 0.2], [0.45, 0.85]];
        for feather in [0.0, 3.0] {
            let plain = pixels(&MaskJob::new(Path::new("/c"), (40, 30), (40, 30), (3, -2), tri.clone(), feather, true));
            let wide = pixels(&MaskJob::new(Path::new("/c"), (50, 40), (40, 30), (5, 5), tri.clone(), feather, true));
            for y in 0..30 {
                for x in 0..40 {
                    let (sx, sy) = (x as i64 - 3 + 5, y as i64 + 2 + 5);
                    assert_eq!(plain[y * 40 + x], wide[sy as usize * 50 + sx as usize], "({x}, {y}), feather {feather}");
                }
            }
        }
    }

    #[test]
    fn crossing_on_a_pixel_is_decided_exactly() {
        // The edge (136, 16.2)-(80, 78.6) of 160×96 passes within 1/256 px of
        // pixel (129, 24), where f32 and f64 arithmetic disagree; on the grid
        // the crossing is at 128.9996, so 128 is inside and 129 outside.
        let tri = vec![[0.1, 0.1], [0.8, 0.2], [0.45, 0.85]];
        let j = MaskJob::new(Path::new("/c"), (160, 96), (160, 96), (8, -3), tri, 0.0, false);
        let px = pixels(&j);
        let pts = outline(&j);
        assert_eq!(pts[1], (136 * 256, (0.2f32 as f64 * 96.0 * 256.0 + 0.5).floor() as i64 - 3 * 256));
        assert_eq!(px[24 * 160 + 128], 255);
        assert_eq!(px[24 * 160 + 129], 0);
    }

    #[test]
    fn cache_name_follows_shape_and_size() {
        let tri = vec![[0.1, 0.1], [0.9, 0.2], [0.5, 0.9]];
        let a = job(tri.clone(), 4.0, false);
        assert_ne!(a.out, job(tri.clone(), 5.0, false).out);
        assert_ne!(a.out, MaskJob::new(Path::new("/cache"), (12, 10), (12, 10), (0, 0), tri.clone(), 4.0, false).out);
        assert_ne!(a.out, MaskJob::new(Path::new("/cache"), (10, 10), (10, 10), (1, 0), tri.clone(), 4.0, false).out);
        assert_eq!(a.out, job(tri, 4.0, false).out);
        assert!(a.out.starts_with("/cache/masks"));
    }

    #[test]
    fn writes_a_pgm() {
        let dir = tempfile::tempdir().unwrap();
        let j = MaskJob::new(dir.path(), (4, 3), (4, 3), (0, 0), vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]], 0.0, false);
        let path = render(&j).unwrap();
        let data = fs::read(&path).unwrap();
        assert!(data.starts_with(b"P5\n4 3\n255\n"));
        assert_eq!(data.len(), 11 + 12);
        assert_eq!(render(&j).unwrap(), path, "found in the cache");
    }
}
