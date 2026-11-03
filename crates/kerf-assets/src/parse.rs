//! Provider responses to [`RemoteAsset`]s. Field names follow the providers'
//! official clients: pexels-javascript (src/types.ts), giphy-js
//! (packages/types), freesound-python (freesound.py) and the Openverse API
//! serializers (api/serializers).

use serde_json::Value;

use crate::{license, invalid, RemoteAsset, RemoteFile, Result, SearchKind, SearchPage, PER_PAGE};

fn s(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.chars().filter(|c| !c.is_control()).take(2000).collect(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn n(v: &Value, k: &str) -> u64 {
    match v.get(k) {
        Some(Value::Number(x)) => x.as_u64().or_else(|| x.as_f64().filter(|f| f.is_finite() && *f >= 0.0).map(|f| f as u64)).unwrap_or(0),
        Some(Value::String(x)) => x.parse().unwrap_or(0),
        _ => 0,
    }
}

fn f(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).filter(|x| x.is_finite() && *x >= 0.0).unwrap_or(0.0)
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Web links only (http or https); the download policy is checked in `net`.
fn https(u: String) -> String {
    if u.starts_with("https://") || u.starts_with("http://") {
        u
    } else {
        String::new()
    }
}

/// Pexels `/v1/search` (photos) or `/videos/search` (videos).
pub fn pexels(v: &Value, kind: SearchKind, page: u32) -> Result<SearchPage> {
    let key = if kind == SearchKind::Video { "videos" } else { "photos" };
    let items = v.get(key).and_then(Value::as_array).ok_or_else(|| invalid("Unerwartete Antwort von Pexels"))?;
    let mut results = Vec::new();
    for it in items {
        let id = s(it, "id");
        if id.is_empty() {
            continue;
        }
        let mut a = RemoteAsset { provider: "pexels".into(), provider_id: id, page_url: https(s(it, "url")), width: n(it, "width") as u32, height: n(it, "height") as u32, ..Default::default() };
        a.license = license::pexels();
        if kind == SearchKind::Video {
            a.kind = "video".into();
            let user = it.get("user").cloned().unwrap_or(Value::Null);
            a.creator = s(&user, "name");
            a.creator_url = https(s(&user, "url"));
            a.thumb_url = https(s(it, "image"));
            a.duration_ms = n(it, "duration") * 1000;
            let mut files: Vec<RemoteFile> = arr(it, "video_files")
                .iter()
                .filter(|f| s(f, "file_type") == "video/mp4" && s(f, "quality") != "hls")
                .map(|f| RemoteFile {
                    url: https(s(f, "link")),
                    label: format!("{} {}×{}", s(f, "quality").to_uppercase(), n(f, "width"), n(f, "height")),
                    width: n(f, "width") as u32,
                    height: n(f, "height") as u32,
                    mime: "video/mp4".into(),
                    size: 0,
                })
                .filter(|f| !f.url.is_empty())
                .collect();
            files.sort_by_key(|f| std::cmp::Reverse(f.width as u64 * f.height as u64));
            a.files = files;
            a.license.attribution = format!("Video von {} auf Pexels", if a.creator.is_empty() { "unbekannt" } else { &a.creator });
        } else {
            a.kind = "photo".into();
            a.title = s(it, "alt");
            a.creator = s(it, "photographer");
            a.creator_url = https(s(it, "photographer_url"));
            let src = it.get("src").cloned().unwrap_or(Value::Null);
            a.thumb_url = https(s(&src, "medium"));
            for (k, label) in [("original", "Original"), ("large2x", "Groß"), ("large", "Mittel")] {
                let url = https(s(&src, k));
                if !url.is_empty() {
                    let (w, h) = if k == "original" { (a.width, a.height) } else { (0, 0) };
                    a.files.push(RemoteFile { url, label: label.into(), width: w, height: h, mime: String::new(), size: 0 });
                }
            }
            a.license.attribution = format!("Foto von {} auf Pexels", if a.creator.is_empty() { "unbekannt" } else { &a.creator });
        }
        if !a.files.is_empty() {
            results.push(a);
        }
    }
    let has_more = v.get("next_page").is_some_and(|x| !x.is_null());
    Ok(SearchPage { results, page, has_more, total: v.get("total_results").and_then(Value::as_u64), notice: String::new() })
}

/// GIPHY `/v1/gifs/search`. The MP4 rendition is downloaded (editable as video).
pub fn giphy(v: &Value, page: u32) -> Result<SearchPage> {
    let items = v.get("data").and_then(Value::as_array).ok_or_else(|| invalid("Unerwartete Antwort von GIPHY"))?;
    let mut results = Vec::new();
    for it in items {
        let id = s(it, "id");
        if id.is_empty() {
            continue;
        }
        let images = it.get("images").cloned().unwrap_or(Value::Null);
        let mp4 = images.get("original_mp4").cloned().unwrap_or(Value::Null);
        let orig = images.get("original").cloned().unwrap_or(Value::Null);
        let still = images.get("fixed_width_still").or_else(|| images.get("original_still")).cloned().unwrap_or(Value::Null);
        let mut files = Vec::new();
        let url = https(s(&mp4, "mp4"));
        if !url.is_empty() {
            files.push(RemoteFile { url, label: "MP4".into(), width: n(&mp4, "width") as u32, height: n(&mp4, "height") as u32, mime: "video/mp4".into(), size: n(&mp4, "mp4_size") });
        }
        let gif = https(s(&orig, "url"));
        if !gif.is_empty() {
            files.push(RemoteFile { url: gif, label: "GIF".into(), width: n(&orig, "width") as u32, height: n(&orig, "height") as u32, mime: "image/gif".into(), size: n(&orig, "size") });
        }
        if files.is_empty() {
            continue;
        }
        let user = it.get("user").cloned().unwrap_or(Value::Null);
        let creator = {
            let d = s(&user, "display_name");
            if d.is_empty() {
                s(it, "username")
            } else {
                d
            }
        };
        let mut lic = license::giphy();
        lic.attribution = if creator.is_empty() { "Powered By GIPHY".into() } else { format!("{creator} via GIPHY (Powered By GIPHY)") };
        results.push(RemoteAsset {
            provider: "giphy".into(),
            provider_id: id,
            kind: "gif".into(),
            title: s(it, "title"),
            creator,
            creator_url: https(s(&user, "profile_url")),
            page_url: https(s(it, "url")),
            thumb_url: https(s(&still, "url")),
            width: n(&orig, "width") as u32,
            height: n(&orig, "height") as u32,
            duration_ms: 0,
            tags: Vec::new(),
            files,
            license: lic,
            rating: s(it, "rating"),
        });
    }
    let p = v.get("pagination").cloned().unwrap_or(Value::Null);
    let total = n(&p, "total_count");
    let has_more = n(&p, "offset") + n(&p, "count") < total;
    Ok(SearchPage { results, page, has_more, total: Some(total), notice: String::new() })
}

/// Fields requested from Freesound's search.
pub const FREESOUND_FIELDS: &str = "id,name,tags,username,license,previews,duration,url";

/// Freesound `/apiv2/search/`. With an API key only the previews can be
/// downloaded (originals need OAuth2), so the HQ MP3 preview is the file.
pub fn freesound(v: &Value, page: u32) -> Result<SearchPage> {
    let items = v.get("results").and_then(Value::as_array).ok_or_else(|| invalid("Unerwartete Antwort von Freesound"))?;
    let mut results = Vec::new();
    for it in items {
        let id = s(it, "id");
        let prev = it.get("previews").cloned().unwrap_or(Value::Null);
        let mut files = Vec::new();
        for (k, label) in [("preview-hq-mp3", "Vorschau MP3 (hohe Qualität)"), ("preview-lq-mp3", "Vorschau MP3 (niedrige Qualität)")] {
            let url = https(s(&prev, k));
            if !url.is_empty() {
                files.push(RemoteFile { url, label: label.into(), mime: "audio/mpeg".into(), ..Default::default() });
            }
        }
        if id.is_empty() || files.is_empty() {
            continue;
        }
        let creator = s(it, "username");
        let mut lic = license::from_cc_url(&s(it, "license"));
        let title = s(it, "name");
        lic.attribution = format!("„{title}“ von {creator} (freesound.org), {}", lic.name);
        results.push(RemoteAsset {
            provider: "freesound".into(),
            provider_id: id,
            kind: "sfx".into(),
            title,
            creator,
            creator_url: String::new(),
            page_url: https(s(it, "url")),
            thumb_url: String::new(),
            width: 0,
            height: 0,
            duration_ms: (f(it, "duration") * 1000.0).round() as u64,
            tags: arr(it, "tags").iter().filter_map(Value::as_str).take(20).map(str::to_string).collect(),
            files,
            license: lic,
            rating: String::new(),
        });
    }
    Ok(SearchPage { results, page, has_more: v.get("next").is_some_and(|x| x.is_string()), total: v.get("count").and_then(Value::as_u64), notice: String::new() })
}

fn mime_of(filetype: &str, kind: SearchKind) -> String {
    match (kind, filetype.to_lowercase().as_str()) {
        (SearchKind::Audio, "mp3") => "audio/mpeg".into(),
        (SearchKind::Audio, "wav") => "audio/wav".into(),
        (SearchKind::Audio, "ogg") => "audio/ogg".into(),
        (SearchKind::Audio, "flac") => "audio/flac".into(),
        (_, "jpg" | "jpeg") => "image/jpeg".into(),
        (_, "png") => "image/png".into(),
        (_, "gif") => "image/gif".into(),
        (_, "webp") => "image/webp".into(),
        (_, "svg") => "image/svg+xml".into(),
        _ => String::new(),
    }
}

/// Openverse `/v1/images/` or `/v1/audio/`. Files live on the source site
/// the result names; the license comes from the result.
pub fn openverse(v: &Value, kind: SearchKind, page: u32) -> Result<SearchPage> {
    let items = v.get("results").and_then(Value::as_array).ok_or_else(|| invalid("Unerwartete Antwort von Openverse"))?;
    let mut results = Vec::new();
    for it in items {
        let id = s(it, "id");
        let url = https(s(it, "url"));
        if id.is_empty() || url.is_empty() {
            continue;
        }
        // SVG can carry scripts; Kerf only takes raster images and audio.
        let mime = mime_of(&s(it, "filetype"), kind);
        if mime == "image/svg+xml" {
            continue;
        }
        let mut lic = license::creative_commons(&s(it, "license"), &s(it, "license_version"), &s(it, "license_url"));
        lic.attribution = s(it, "attribution");
        let src = s(it, "source");
        results.push(RemoteAsset {
            provider: "openverse".into(),
            provider_id: id,
            kind: if kind == SearchKind::Audio { "audio" } else { "photo" }.into(),
            title: s(it, "title"),
            creator: s(it, "creator"),
            creator_url: https(s(it, "creator_url")),
            page_url: https(s(it, "foreign_landing_url")),
            thumb_url: https(s(it, "thumbnail")),
            width: n(it, "width") as u32,
            height: n(it, "height") as u32,
            duration_ms: 0,
            tags: arr(it, "tags").iter().map(|t| s(t, "name")).filter(|t| !t.is_empty()).take(20).collect(),
            files: vec![RemoteFile { url, label: if src.is_empty() { "Original".into() } else { format!("Original ({src})") }, width: n(it, "width") as u32, height: n(it, "height") as u32, mime, size: n(it, "filesize") }],
            license: lic,
            rating: if it.get("mature").and_then(Value::as_bool) == Some(true) { "mature".into() } else { String::new() },
        });
    }
    let pages = n(v, "page_count");
    Ok(SearchPage { results, page, has_more: (page as u64) < pages, total: v.get("result_count").and_then(Value::as_u64), notice: String::new() })
}

/// Results per page actually requested from each provider.
pub fn per_page() -> u32 {
    PER_PAGE
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pexels_photos_and_videos() {
        let v = json!({ "page": 1, "per_page": 2, "total_results": 50, "next_page": "https://api.pexels.com/v1/search/?page=2",
            "photos": [{ "id": 7, "width": 4000, "height": 3000, "url": "https://www.pexels.com/photo/x-7/", "alt": "Wald", "photographer": "Ann", "photographer_url": "https://www.pexels.com/@ann",
                "src": { "original": "https://images.pexels.com/photos/7/a.jpeg", "large2x": "https://images.pexels.com/photos/7/a.jpeg?w=1880", "large": "https://images.pexels.com/photos/7/a.jpeg?h=650", "medium": "https://images.pexels.com/photos/7/a.jpeg?h=350" } },
              { "id": 8, "src": { "original": "ftp://insecure.example/a.jpg" } }] });
        let p = pexels(&v, SearchKind::Photo, 1).unwrap();
        assert_eq!(p.results.len(), 1, "results without a web file are dropped");
        let a = &p.results[0];
        assert_eq!((a.provider_id.as_str(), a.kind.as_str(), a.creator.as_str(), a.files.len()), ("7", "photo", "Ann", 3));
        assert_eq!(a.files[0].width, 4000);
        assert_eq!(a.license.commercial, "yes");
        assert!(p.has_more);
        let v = json!({ "videos": [{ "id": 9, "width": 1920, "height": 1080, "duration": 12, "image": "https://images.pexels.com/v/9.jpg", "user": { "name": "Bo", "url": "https://www.pexels.com/@bo" },
            "video_files": [ { "quality": "sd", "file_type": "video/mp4", "width": 640, "height": 360, "link": "https://videos.pexels.com/9-sd.mp4" },
                             { "quality": "hd", "file_type": "video/mp4", "width": 1920, "height": 1080, "link": "https://videos.pexels.com/9-hd.mp4" },
                             { "quality": "hls", "file_type": "application/x-mpegURL", "link": "https://videos.pexels.com/9.m3u8" } ] }] });
        let p = pexels(&v, SearchKind::Video, 1).unwrap();
        let a = &p.results[0];
        assert_eq!((a.duration_ms, a.files.len(), a.files[0].width), (12000, 2, 1920));
        assert!(!p.has_more);
    }

    #[test]
    fn giphy_gifs() {
        let v = json!({ "data": [{ "id": "abc", "title": "Cat", "url": "https://giphy.com/gifs/abc", "username": "u1", "rating": "g",
            "user": { "display_name": "Studio" },
            "images": { "original": { "url": "https://media.giphy.com/media/abc/giphy.gif", "width": "480", "height": "270", "size": "1000" },
                        "original_mp4": { "mp4": "https://media.giphy.com/media/abc/giphy.mp4", "width": "480", "height": "270", "mp4_size": "500" },
                        "fixed_width_still": { "url": "https://media.giphy.com/media/abc/200w_s.gif" } } }],
            "pagination": { "total_count": 100, "count": 20, "offset": 0 } });
        let p = giphy(&v, 1).unwrap();
        let a = &p.results[0];
        assert_eq!((a.creator.as_str(), a.files[0].mime.as_str(), a.files[0].size, a.width), ("Studio", "video/mp4", 500, 480));
        assert_eq!(a.license.commercial, "unknown");
        assert!(a.license.attribution.contains("Powered By GIPHY"));
        assert!(p.has_more);
    }

    #[test]
    fn freesound_previews() {
        let v = json!({ "count": 1, "next": null, "results": [{ "id": 42, "name": "Door", "username": "fx", "duration": 1.25, "tags": ["door"],
            "license": "http://creativecommons.org/licenses/by-nc/4.0/",
            "previews": { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/42_hq.mp3", "preview-lq-mp3": "https://cdn.freesound.org/previews/0/42_lq.mp3" } }] });
        let p = freesound(&v, 1).unwrap();
        let a = &p.results[0];
        assert_eq!((a.duration_ms, a.license.commercial.as_str(), a.files.len()), (1250, "no", 2));
        assert!(!p.has_more);
    }

    #[test]
    fn openverse_results() {
        let v = json!({ "result_count": 30, "page_count": 2, "results": [
            { "id": "u-1", "title": "Tree", "url": "https://live.staticflickr.com/1/a.jpg", "foreign_landing_url": "https://www.flickr.com/photos/1", "creator": "C",
              "license": "by-nc", "license_version": "2.0", "license_url": "https://creativecommons.org/licenses/by-nc/2.0/", "filetype": "jpg", "source": "flickr",
              "attribution": "\"Tree\" by C is licensed under CC BY-NC 2.0.", "width": 800, "height": 600, "tags": [{ "name": "tree" }], "thumbnail": "https://api.openverse.org/v1/images/u-1/thumb/" },
            { "id": "u-2", "url": "https://example.org/x.svg", "filetype": "svg", "license": "cc0" } ] });
        let p = openverse(&v, SearchKind::Photo, 1).unwrap();
        assert_eq!(p.results.len(), 1, "svg is skipped");
        let a = &p.results[0];
        assert_eq!((a.license.commercial.as_str(), a.license.name.as_str(), a.files[0].mime.as_str()), ("no", "CC BY-NC 2.0", "image/jpeg"));
        assert!(a.license.attribution.contains("CC BY-NC"));
        assert!(p.has_more);
        assert!(openverse(&json!({ "detail": "x" }), SearchKind::Photo, 1).is_err());
    }
}
