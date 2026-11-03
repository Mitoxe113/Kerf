//! Search and download against a local mock server (no real provider is
//! contacted). The responses imitate the providers' formats; passing these
//! tests says nothing about the live APIs.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use kerf_assets::net::Net;
use kerf_assets::{AssetError, Provider, SearchKind, SearchRequest};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xD9];

async fn serve() -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let b = base.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { break };
            let base = b.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = req.lines().next().unwrap_or("").to_string();
                let path = line.split(' ').nth(1).unwrap_or("/").to_string();
                let auth = req.lines().find(|l| l.to_lowercase().starts_with("authorization:")).map(|l| l[14..].trim().to_string());
                let (status, ctype, body, extra): (&str, &str, Vec<u8>, String) = if path.starts_with("/v1/search") {
                    if auth.as_deref() != Some("KEY") {
                        ("401 Unauthorized", "application/json", br#"{"error":"bad key"}"#.to_vec(), String::new())
                    } else {
                        let j = format!(
                            r#"{{"page":1,"per_page":20,"total_results":2,"photos":[
                            {{"id":1,"width":10,"height":10,"url":"https://www.pexels.com/photo/1/","photographer":"Ann","src":{{"original":"{base}/files/a.jpg"}}}},
                            {{"id":2,"width":10,"height":10,"photographer":"Eve","src":{{"original":"{base}/files/evil.jpg"}}}},
                            {{"id":3,"width":10,"height":10,"photographer":"Rex","src":{{"original":"{base}/redirect"}}}}]}}"#
                        );
                        ("200 OK", "application/json", j.into_bytes(), String::new())
                    }
                } else if path.starts_with("/v1/images/") {
                    if path.contains("q=busy") {
                        ("429 Too Many Requests", "application/json", b"{}".to_vec(), String::new())
                    } else {
                        assert!(path.contains("license_type=commercial"), "commercial filter is sent: {path}");
                        let j = format!(
                            r#"{{"result_count":2,"page_count":1,"results":[
                            {{"id":"o1","url":"{base}/files/a.jpg","license":"cc0","filetype":"jpg","title":"Free"}},
                            {{"id":"o2","url":"{base}/files/a.jpg","license":"by-nc","filetype":"jpg","title":"NC"}}]}}"#
                        );
                        ("200 OK", "application/json", j.into_bytes(), String::new())
                    }
                } else if path == "/files/a.jpg" {
                    ("200 OK", "image/jpeg", JPEG.to_vec(), String::new())
                } else if path == "/files/evil.jpg" {
                    ("200 OK", "image/jpeg", b"MZ\x90\0\x03\0\0\0\x04\0\0\0\xFF\xFF\0\0 this is not a picture".to_vec(), String::new())
                } else if path == "/redirect" {
                    ("302 Found", "text/plain", Vec::new(), "Location: https://evil.example/a.jpg\r\n".into())
                } else {
                    ("404 Not Found", "text/plain", b"nope".to_vec(), String::new())
                };
                let head = format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len());
                let _ = s.write_all(head.as_bytes()).await;
                let _ = s.write_all(&body).await;
            });
        }
    });
    base
}

#[tokio::test(flavor = "multi_thread")]
async fn search_and_download_with_checks() {
    let base = serve().await;
    let net = Net::for_tests(HashMap::from([(Provider::Pexels, base.clone()), (Provider::Openverse, base.clone())])).unwrap();
    let req = SearchRequest { provider: Provider::Pexels, kind: SearchKind::Photo, query: "wald".into(), page: 1, commercial_only: false };

    assert!(matches!(net.search(&req, None).await, Err(AssetError::MissingKey(_))));
    assert!(matches!(net.search(&req, Some("WRONG")).await, Err(AssetError::Http { status: 401, .. })));
    let page = net.search(&req, Some("KEY")).await.unwrap();
    assert_eq!(page.results.len(), 3);

    let dir = std::env::temp_dir().join(format!("kerf-assets-{}", uuid::Uuid::new_v4()));
    let cancel = AtomicBool::new(false);
    let mut seen = 0;
    let d = net.download(&page.results[0], 0, &dir, &cancel, |done, _| seen = done).await.unwrap();
    assert_eq!((d.mime.as_str(), d.size, seen), ("image/jpeg", JPEG.len() as u64, JPEG.len() as u64));
    assert_eq!(std::fs::read(&d.path).unwrap(), JPEG);
    // The same content again: same file, no second copy.
    let again = net.download(&page.results[0], 0, &dir, &cancel, |_, _| {}).await.unwrap();
    assert_eq!(again.path, d.path);

    // An executable behind a .jpg URL is refused and leaves nothing behind.
    let e = net.download(&page.results[1], 0, &dir, &cancel, |_, _| {}).await.unwrap_err();
    assert!(matches!(e, AssetError::Refused(_)), "{e}");
    // A redirect to a host that is not Pexels' is refused.
    let e = net.download(&page.results[2], 0, &dir, &cancel, |_, _| {}).await.unwrap_err();
    assert!(matches!(e, AssetError::Refused(ref m) if m.contains("evil.example")), "{e}");
    let files: Vec<_> = std::fs::read_dir(dir.join("pexels")).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(files.len(), 1, "only the good file, no .part leftovers: {files:?}");

    // A cancelled download leaves nothing behind.
    let cancelled = AtomicBool::new(true);
    let e = net.download(&page.results[0], 0, &dir.join("c"), &cancelled, |_, _| {}).await.unwrap_err();
    assert!(matches!(e, AssetError::Cancelled));
    assert_eq!(std::fs::read_dir(dir.join("c").join("pexels")).unwrap().count(), 0);

    // Openverse: commercial filter sent to the API and applied to results.
    let ov = SearchRequest { provider: Provider::Openverse, kind: SearchKind::Photo, query: "baum".into(), page: 1, commercial_only: true };
    let p = net.search(&ov, None).await.unwrap();
    assert_eq!(p.results.len(), 1);
    assert_eq!(p.results[0].license.commercial, "yes");
    assert!(!p.notice.is_empty());
    let busy = SearchRequest { query: "busy".into(), ..ov };
    assert!(matches!(net.search(&busy, None).await, Err(AssetError::RateLimited(_))));

    // GIPHY never claims commercial use.
    let g = SearchRequest { provider: Provider::Giphy, kind: SearchKind::Gif, query: "x".into(), page: 1, commercial_only: true };
    let p = net.search(&g, Some("k")).await.unwrap();
    assert!(p.results.is_empty() && !p.notice.is_empty());
    std::fs::remove_dir_all(dir).ok();
}
