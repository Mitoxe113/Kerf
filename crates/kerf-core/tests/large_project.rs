//! Timing of save, load and the unknown-field check for a large project.
//! Not part of the normal run: `cargo test -p kerf-core --release --test large_project -- --ignored --nocapture`

use std::time::Instant;

use kerf_core::history::History;
use kerf_core::model::*;
use kerf_core::ops::{ClipPatch, EditCommand};
use uuid::Uuid;

fn asset(i: usize) -> MediaAsset {
    MediaAsset {
        id: Uuid::new_v4(),
        path: format!("/medien/clip_{i:04}.mp4").into(),
        name: format!("clip_{i:04}"),
        kind: MediaKind::Video,
        status: MediaStatus::Analyzing,
        info: None,
        bin: None,
        favorite: false,
        label: Default::default(),
        tags: Vec::new(),
        note: String::new(),
        imported_at: 0,
        derived: Derived::default(),
        marks: Default::default(),
        matrix: Default::default(),
        title: None,
        adjustment: false,
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

#[test]
#[ignore]
fn large_project_timings() {
    let (media, per_track, tracks) = (500, 1000, 6);
    let mut p = Project::new("Groß", 0);
    p.media = (0..media).map(asset).collect();
    let seq = &mut p.sequences[0];
    seq.tracks.clear();
    for t in 0..tracks {
        let mut track = Track::new(if t < 3 { TrackKind::Video } else { TrackKind::Audio }, format!("Spur {t}"));
        track.clips = (0..per_track).map(|i| Clip::new(p.media[i % media].id, format!("c{i}"), (i * 50) as i64, 48, 0)).collect();
        seq.tracks.push(track);
    }
    let clips = per_track * tracks;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gross.kerf");

    let save: Vec<f64> = (0..5).map(|_| { let t = Instant::now(); kerf_core::io::save(&p, &path).unwrap(); t.elapsed().as_secs_f64() * 1e3 }).collect();
    let size = std::fs::metadata(&path).unwrap().len();
    let load: Vec<f64> = (0..5).map(|_| { let t = Instant::now(); kerf_core::io::load(&path).unwrap(); t.elapsed().as_secs_f64() * 1e3 }).collect();
    let bytes = std::fs::read(&path).unwrap();
    let check: Vec<f64> = (0..5).map(|_| { let t = Instant::now(); assert!(kerf_core::io::unknown_fields(&bytes).is_empty()); t.elapsed().as_secs_f64() * 1e3 }).collect();

    let mut loaded = kerf_core::io::load(&path).unwrap();
    let seq_id = loaded.sequences[0].id;
    let clip = loaded.sequences[0].tracks[0].clips[500].id;
    let mut h = History::default();
    let edit: Vec<f64> = (0..50)
        .map(|i| {
            let t = Instant::now();
            h.apply(&mut loaded, &EditCommand::UpdateClips { sequence: seq_id, clips: vec![clip], patch: ClipPatch { name: Some(format!("n{i}")), ..Default::default() } }).unwrap();
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();

    println!("{clips} Clips, {media} Medien, Datei {:.1} MB", size as f64 / 1e6);
    println!("speichern  {:.1} ms (Median aus 5)", median(save));
    println!("laden      {:.1} ms (Median aus 5)", median(load));
    println!("Feldprüfung {:.1} ms (Median aus 5)", median(check));
    println!("Bearbeitung über History {:.2} ms (Median aus 50)", median(edit));
}
