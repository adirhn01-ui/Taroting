//! The `asset:` protocol, served off the UI thread.
//!
//! Every `<video>`, `<img>` and `fetch` of a local file goes through
//! `asset://localhost/<percent-encoded path>` (`convertFileSrc`). Tauri's own
//! handler (tauri 2.11.5 `src/protocol/asset.rs`) is SYNCHRONOUS: wry calls it
//! from WebView2's `WebResourceRequested` event on the window's UI thread, so
//! every byte it reads is read there. A whole-file request — a large PNG or
//! TIFF still, a photo `fetch` for an image export — blocks the window for the
//! full read, and preview video stalls while any of it runs.
//!
//! This is the same protocol answered asynchronously: the UI thread only
//! clones what the work needs and hands it to the blocking pool, where the
//! scope check (which canonicalizes, so it touches the disk too), the open,
//! the reads and the response are all done; `respond` then posts the answer
//! back to the window's thread (wry `webview2/mod.rs` 1012-1016,
//! `dispatch_handler`).
//!
//! **It replaces the built-in, it does not sit beside it.** The app's schemes
//! are registered on the webview first and their names recorded (tauri
//! `manager/webview.rs` 230-242); the built-in asset handler is installed only
//! `if !registered_scheme_protocols.contains(&"asset".into())` (same file,
//! 336-347). `Builder::register_asynchronous_uri_scheme_protocol` puts the
//! handler in that map (`app.rs` 2206-2211, handed to the manager at 2258,
//! stored at `manager/mod.rs` 260 and 295).
//!
//! Kept from the built-in, because the page depends on it: the
//! `assetProtocol.scope` allow check and the `..` refusal (empty 403), a
//! missing file (empty 404), single Range requests capped at 1000 KiB per
//! answer with `206` + `Content-Range`, `416` + `bytes */len` for a range that
//! cannot be met, the content-sniffed MIME type (`tauri::utils::mime_type`),
//! HEAD, and `Access-Control-Allow-Origin` set to the window's own origin,
//! never an echoed `Origin`.
//!
//! Where the built-in is itself wrong, this does the right thing instead: the
//! 416 carries the CORS header (without it a `fetch` of it is blocked rather
//! than resolved as not-ok); `Content-Length` counts the bytes actually read;
//! a ranged HEAD sends no body; a multi-range answer is a well-formed
//! `multipart/byteranges` with ONE content type and a bounded total; a body
//! too large to hold is refused with an empty 413 instead of being buffered;
//! and nothing here can panic (with `panic = "abort"`, a panic in a protocol
//! handler ends the app mid-playback). Device, non-file and relative paths are
//! refused like an out-of-scope one: nothing the page loads is any of those,
//! and `media::source` refuses the same shapes before ffmpeg sees them.
//!
//! What this does NOT remove: wry copies the finished body into a COM memory
//! stream on the UI thread (`SHCreateMemStream`, `webview2/mod.rs` 1127). That
//! is one memcpy, not a read from disk, and only a whole-file answer is large.

use std::collections::hash_map::RandomState;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::header::{
    ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE, RANGE,
};
use tauri::http::{response, Method, Request, Response, StatusCode};
use tauri::path::SafePathBuf;
use tauri::utils::config::FrontendDist;
use tauri::utils::mime_type::MimeType;
use tauri::{Manager, Runtime, Url};

use crate::media::source::{is_device_path, is_file_namespace, may_touch};

/// The most bytes one ranged answer carries: the built-in's `MAX_LEN`. A media
/// element asks again from where the last answer ended, so this bounds each
/// read without limiting what can be played.
const MAX_RANGE_LEN: u64 = 1000 * 1024;

/// The largest file served whole (a request without a Range). It matches the
/// largest still the app writes itself (`image_save::MAX_IMAGE_BYTES`), so a
/// photo Taroting saved can always be opened again as a layer. Past it the
/// answer is an empty 413: the body would be held in memory here, copied once
/// more into WebView2's stream and again into the page, and no decoder the
/// page has can use a still that size anyway. Media elements never land here:
/// they always send a Range.
const MAX_WHOLE_LEN: u64 = crate::image_save::MAX_IMAGE_BYTES;

/// Bytes read to sniff the MIME type, as the built-in does. A file shorter
/// than this is answered from that same read.
const MAGIC_LEN: u64 = 8192;

/// The most parts one multi-range answer carries. Chromium's media stack never
/// asks for more than one range; this only stops a long header from turning
/// into thousands of part headers.
const MAX_PARTS: usize = 16;

/// Installs the handler on the app builder. It must run before `.run()`, so
/// the scheme is in the app's map when the main webview is prepared.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("asset", |ctx, request, responder| {
        // On the UI thread: nothing that touches the disk. The config is
        // already in memory and the scope is an Arc clone.
        let app = ctx.app_handle();
        let origin = window_origin(&app.config(), ctx.webview_label());
        let scope = app.asset_protocol_scope();
        tauri::async_runtime::spawn_blocking(move || {
            let allowed = |path: &str| scope.is_allowed(path);
            responder.respond(respond_to(&request, &allowed, &origin, MAX_WHOLE_LEN));
        });
    })
}

/* ---------------- the window's origin ---------------- */

/// The origin the built-in puts in `Access-Control-Allow-Origin` for the
/// webview `label`: the origin of the URL a `WebviewUrl::App` window loads
/// (`http://localhost:1420` under `tauri dev`, `http://tauri.localhost` in a
/// release build on Windows).
fn window_origin(config: &tauri::Config, label: &str) -> String {
    let https = config
        .app
        .windows
        .iter()
        .find(|w| w.label == label)
        .is_some_and(|w| w.use_https_scheme);
    let dist_url = match config.build.frontend_dist.as_ref() {
        Some(FrontendDist::Url(url)) => Some(url),
        _ => None,
    };
    let url = app_url(tauri::is_dev(), config.build.dev_url.as_ref(), dist_url, https);
    origin_of(url.as_ref(), https)
}

/// tauri `manager/mod.rs` `get_app_url` (353-367) and `tauri_protocol_url`
/// (339-346). Its `#[cfg(dev)]` is set by tauri's build script as
/// `!custom-protocol` (`build.rs` 257-259), which is exactly `tauri::is_dev()`.
/// `None` only if a constant URL failed to parse, which cannot happen; the
/// origin is then "null" rather than a panic.
fn app_url(is_dev: bool, dev_url: Option<&Url>, dist_url: Option<&Url>, https: bool) -> Option<Url> {
    let configured = if is_dev { dev_url } else { dist_url };
    if let Some(url) = configured {
        return Some(url.clone());
    }
    let fallback = if cfg!(windows) || cfg!(target_os = "android") {
        if https {
            "https://tauri.localhost"
        } else {
            "http://tauri.localhost"
        }
    } else {
        "tauri://localhost"
    };
    Url::parse(fallback).ok()
}

/// tauri `manager/webview.rs` 244-265: the window URL reduced to an origin.
fn origin_of(url: Option<&Url>, https: bool) -> String {
    let Some(url) = url else {
        return "null".into();
    };
    let scheme = url.scheme();
    if scheme == "data" {
        "null".into()
    } else if (cfg!(windows) || cfg!(target_os = "android")) && scheme != "http" && scheme != "https"
    {
        let proto = if https { "https" } else { "http" };
        format!("{proto}://{scheme}.localhost")
    } else if let Some(host) = url.host() {
        let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
        format!("{scheme}://{host}{port}")
    } else {
        "null".into()
    }
}

/* ---------------- the answer ---------------- */

/// The whole answer to one request. It never fails and never panics: an I/O
/// error becomes the built-in's 500 with the error's text.
fn respond_to(
    request: &Request<Vec<u8>>,
    allowed: &dyn Fn(&str) -> bool,
    origin: &str,
    max_whole: u64,
) -> Response<Vec<u8>> {
    match get_response(request, allowed, origin, max_whole) {
        Ok(response) => response,
        Err(e) => Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header(CONTENT_TYPE, "text/plain")
            .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .body(e.to_string().into_bytes())
            .unwrap_or_else(|_| bare(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

fn get_response(
    request: &Request<Vec<u8>>,
    allowed: &dyn Fn(&str) -> bool,
    origin: &str,
    max_whole: u64,
) -> io::Result<Response<Vec<u8>>> {
    // `convertFileSrc` puts the whole path, separators included, into the URL
    // path as one percent-encoded segment after the leading `/`.
    let raw = request.uri().path();
    let path = percent_decode_lossy(raw.strip_prefix('/').unwrap_or(raw).as_bytes());

    // Refused before the scope is even asked: a `..` (the built-in's
    // SafePathBuf check) and anything that is not a full path to a file.
    if !plausible_file_path(&path) || SafePathBuf::new(PathBuf::from(&path)).is_err() {
        return Ok(empty(StatusCode::FORBIDDEN, origin));
    }
    if !allowed(&path) {
        return Ok(empty(StatusCode::FORBIDDEN, origin));
    }

    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(empty(StatusCode::NOT_FOUND, origin))
        }
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            return Ok(empty(StatusCode::FORBIDDEN, origin))
        }
        Err(e) => return Err(e),
    };
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Ok(empty(StatusCode::NOT_FOUND, origin));
    }
    let len = meta.len();

    // Sniff the type from the first bytes, as the built-in does. A file
    // shorter than the sniff window is answered from this same read.
    let mut magic = Vec::with_capacity(len.min(MAGIC_LEN) as usize);
    (&mut file).take(MAGIC_LEN).read_to_end(&mut magic)?;
    let mime = MimeType::parse(&magic, &path);
    let head = request.method() == Method::HEAD;

    if let Some(range) = request.headers().get(RANGE).and_then(|r| r.to_str().ok()) {
        let ranges = match parse_ranges(range, len) {
            Ok(ranges) if !ranges.is_empty() => ranges,
            _ => return Ok(not_satisfiable(len, origin)),
        };
        if ranges.len() > 1 {
            return multipart(&mut file, &ranges, len, &mime, origin, head);
        }
        let (start, mut end) = capped(ranges[0], len, MAX_RANGE_LEN);
        let mut body = Vec::new();
        if !head {
            body = read_at(&mut file, start, end + 1 - start)?;
            if body.is_empty() {
                // The file shrank since the stat.
                return Ok(not_satisfiable(len, origin));
            }
            end = start + body.len() as u64 - 1;
        }
        return build(
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
                .header(CONTENT_TYPE, &mime)
                .header(ACCEPT_RANGES, "bytes")
                .header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range")
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(CONTENT_LENGTH, end + 1 - start),
            body,
        );
    }

    if len > max_whole {
        return Ok(empty(StatusCode::PAYLOAD_TOO_LARGE, origin));
    }
    let ok = Response::builder()
        .status(StatusCode::OK)
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .header(CONTENT_TYPE, &mime);
    if head {
        return build(ok.header(CONTENT_LENGTH, len), Vec::new());
    }
    let body = if len < MAGIC_LEN {
        magic
    } else {
        // Bounded by `max_whole` above, and by `take`, so a file that grew
        // since the stat cannot make this read more than was measured.
        let Some(mut buf) = whole_buffer(len) else {
            return Ok(empty(StatusCode::SERVICE_UNAVAILABLE, origin));
        };
        file.seek(SeekFrom::Start(0))?;
        (&mut file).take(len).read_to_end(&mut buf)?;
        buf
    };
    build(ok.header(CONTENT_LENGTH, body.len()), body)
}

/// Room for a whole-file answer of `len` bytes, or `None` when the memory is
/// not there. Up to 2 GiB, several at once (each request has its own
/// thread): `Vec::with_capacity` on a machine short of memory does not fail,
/// it ABORTS the process (`handle_alloc_error`), with no panic and no note —
/// the app simply vanished. Refused, one picture fails to load instead.
fn whole_buffer(len: u64) -> Option<Vec<u8>> {
    let len = usize::try_from(len).ok()?;
    let mut buf = Vec::new();
    buf.try_reserve_exact(len).ok()?;
    Some(buf)
}

/// A multi-range request: one `multipart/byteranges` body whose parts carry
/// at most `MAX_RANGE_LEN` bytes IN TOTAL (the built-in capped each part, so
/// one header could ask for any number of 1000 KiB parts) and at most
/// `MAX_PARTS` parts.
fn multipart(
    file: &mut File,
    ranges: &[(u64, u64)],
    len: u64,
    mime: &str,
    origin: &str,
    head: bool,
) -> io::Result<Response<Vec<u8>>> {
    let boundary = random_boundary();
    let mut body = Vec::new();
    let mut budget = MAX_RANGE_LEN;
    for &range in ranges.iter().take(MAX_PARTS) {
        if budget == 0 {
            break;
        }
        let (start, end) = capped(range, len, budget);
        let buf = read_at(file, start, end + 1 - start)?;
        if buf.is_empty() {
            continue;
        }
        let end = start + buf.len() as u64 - 1;
        budget -= buf.len() as u64;
        let part = format!(
            "\r\n--{boundary}\r\nContent-Type: {mime}\r\nContent-Range: bytes {start}-{end}/{len}\r\n\r\n"
        );
        body.extend_from_slice(part.as_bytes());
        body.extend_from_slice(&buf);
    }
    if body.is_empty() {
        return Ok(not_satisfiable(len, origin));
    }
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let body_len = body.len();
    if head {
        body = Vec::new();
    }
    build(
        Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(CONTENT_TYPE, format!("multipart/byteranges; boundary={boundary}"))
            .header(ACCEPT_RANGES, "bytes")
            .header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range")
            .header(CONTENT_LENGTH, body_len),
        body,
    )
}

/// `(start, end)` (inclusive, as parsed, so `start < len`) with `end` held to
/// the file and to `max` bytes from `start`: the built-in's
/// `start + (end - start).min(len - start).min(MAX_LEN - 1)`.
fn capped((start, end): (u64, u64), len: u64, max: u64) -> (u64, u64) {
    let end = end.min(len.saturating_sub(1)).max(start);
    (start, start + (end - start).min(max.saturating_sub(1)))
}

/// Up to `n` bytes from `start`. Every caller passes at most `MAX_RANGE_LEN`,
/// and the allocation is clamped to it as well, so a range read is bounded
/// whatever the file.
fn read_at(file: &mut File, start: u64, n: u64) -> io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(n.min(MAX_RANGE_LEN) as usize);
    file.seek(SeekFrom::Start(start))?;
    file.take(n).read_to_end(&mut buf)?;
    Ok(buf)
}

fn not_satisfiable(len: u64, origin: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range")
        .header(CONTENT_RANGE, format!("bytes */{len}"))
        .body(Vec::new())
        .unwrap_or_else(|_| bare(StatusCode::RANGE_NOT_SATISFIABLE))
}

/// An empty answer carrying only the CORS header: the built-in's 403 and 404.
fn empty(status: StatusCode, origin: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .body(Vec::new())
        .unwrap_or_else(|_| bare(status))
}

/// The last resort when a header value is refused: the status and nothing
/// else. Every header here is ASCII built by this file, so it is not expected
/// to run; it exists so that nothing on this path can panic.
fn bare(status: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = status;
    response
}

fn build(builder: response::Builder, body: Vec<u8>) -> io::Result<Response<Vec<u8>>> {
    builder.body(body).map_err(io::Error::other)
}

/// Whether `path` could be a file the page loads: spelled in full, on a drive
/// or a share, and not a device (`\\.\pipe\…`, `\\?\GLOBALROOT\…`). A relative
/// path would resolve against the app's working directory.
fn plausible_file_path(path: &str) -> bool {
    if path.is_empty() || path.contains('\0') || is_device_path(path) {
        return false;
    }
    let p = Path::new(path);
    p.is_absolute() && is_file_namespace(p) && may_touch(p)
}

/// `percent_encoding::percent_decode(..).decode_utf8_lossy()`, which the
/// built-in uses: `%XX` with two hex digits becomes that byte, anything else
/// (a lone `%`, a `+`) is kept as it is, and the bytes are then read as UTF-8
/// with invalid sequences replaced.
fn percent_decode_lossy(input: &[u8]) -> String {
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' && i + 2 < input.len() {
            if let (Some(hi), Some(lo)) = (hex(input[i + 1]), hex(input[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(input[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `http_range::HttpRange::parse` (0.1.5) — the parser the built-in uses —
/// step for step, as inclusive `(start, end)` pairs. `Err` stands for the
/// crate's `InvalidRange` and `NoOverlap` alike (both a 416 here); an empty
/// header yields an empty list, which the caller also answers with a 416.
fn parse_ranges(header: &str, size: u64) -> Result<Vec<(u64, u64)>, ()> {
    let header = header.as_bytes();
    if header.is_empty() {
        return Ok(Vec::new());
    }
    let Some(specs) = header.strip_prefix(b"bytes=") else {
        return Err(());
    };
    let mut no_overlap = false;
    let mut ranges = Vec::new();
    for spec in specs.split(|b| *b == b',') {
        let spec = trim(spec);
        if spec.is_empty() {
            continue;
        }
        match parse_single_range(spec, size)? {
            Some(range) => ranges.push(range),
            None => no_overlap = true,
        }
    }
    if no_overlap && ranges.is_empty() {
        return Err(());
    }
    Ok(ranges)
}

fn parse_single_range(spec: &[u8], size: u64) -> Result<Option<(u64, u64)>, ()> {
    let mut parts = spec.splitn(2, |b| *b == b'-');
    let start = trim(parts.next().ok_or(())?);
    let end = trim(parts.next().ok_or(())?);
    if start.is_empty() {
        // `-N`: the last N bytes.
        if end.is_empty() || end[0] == b'-' {
            return Err(());
        }
        let length = parse_u64(end)?.min(size);
        if length == 0 {
            return Ok(None);
        }
        return Ok(Some((size - length, size - 1)));
    }
    let start = parse_u64(start)?;
    if start >= size {
        return Ok(None);
    }
    let end = if end.is_empty() {
        size - 1
    } else {
        let end = parse_u64(end)?;
        if start > end {
            return Err(());
        }
        end.min(size - 1)
    };
    Ok(Some((start, end)))
}

fn trim(bytes: &[u8]) -> &[u8] {
    let blank = |b: &u8| *b == b' ' || *b == b'\t';
    match (bytes.iter().position(|b| !blank(b)), bytes.iter().rposition(|b| !blank(b))) {
        (Some(first), Some(last)) => &bytes[first..=last],
        _ => &[],
    }
}

fn parse_u64(bytes: &[u8]) -> Result<u64, ()> {
    if bytes.is_empty() {
        return Err(());
    }
    bytes.iter().try_fold(0u64, |acc, &b| {
        if b.is_ascii_digit() {
            acc.checked_mul(10).and_then(|v| v.checked_add(u64::from(b - b'0'))).ok_or(())
        } else {
            Err(())
        }
    })
}

/// A multipart boundary the page cannot predict: two independently keyed std
/// hashers (each `RandomState` draws fresh keys). It only has to avoid
/// colliding with the bytes it separates.
fn random_boundary() -> String {
    let a = RandomState::new().build_hasher().finish();
    let b = RandomState::new().build_hasher().finish();
    format!("{a:016x}{b:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A whole-file buffer the allocator cannot give is refused, never an
    /// abort. `isize::MAX + 1` bytes is more than any allocator can hand out
    /// (the capacity check refuses it before asking), and is what
    /// `with_capacity` turns into a panic — an abort in a release build.
    #[test]
    fn a_whole_file_buffer_that_does_not_fit_is_refused_not_an_abort() {
        assert!(whole_buffer(isize::MAX as u64 + 1).is_none());
        assert!(whole_buffer(u64::MAX).is_none());
        let small = whole_buffer(4096).expect("a small buffer fits");
        assert!(small.capacity() >= 4096 && small.is_empty());
    }
    use std::cell::{Cell, RefCell};

    const ORIGIN: &str = "http://tauri.localhost";
    /// Not a multiple of the sniff window or of the range cap, so an
    /// off-by-one against either shows up.
    const BIG: usize = 3_000_017;

    /// A byte pattern in which every offset is distinguishable from its
    /// neighbours over any short window, so a wrong seek is caught.
    fn pattern(n: usize) -> Vec<u8> {
        (0..n).map(|i| ((i * 7 + 3) % 251) as u8).collect()
    }

    /// A folder of its own per test (other test runs share %TEMP%, and a
    /// shared name would race), removed again when the test ends.
    struct Scratch(PathBuf);

    impl std::ops::Deref for Scratch {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn dir(name: &str) -> Scratch {
        let d = std::env::temp_dir().join(format!("taroting asset-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Scratch(d)
    }

    /// `encodeURIComponent`, which is what `convertFileSrc` applies.
    fn encode(path: &str) -> String {
        let mut out = String::new();
        for b in path.bytes() {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out
    }

    fn request(method: Method, path: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut b = Request::builder()
            .method(method)
            .uri(format!("asset://localhost/{}", encode(path)));
        if let Some(r) = range {
            b = b.header(RANGE, r);
        }
        b.body(Vec::new()).unwrap()
    }

    fn get(path: &Path, range: Option<&str>) -> Response<Vec<u8>> {
        let req = request(Method::GET, path.to_str().unwrap(), range);
        respond_to(&req, &|_: &str| true, ORIGIN, MAX_WHOLE_LEN)
    }

    fn header<'a>(r: &'a Response<Vec<u8>>, name: tauri::http::header::HeaderName) -> &'a str {
        r.headers().get(name).map(|v| v.to_str().unwrap()).unwrap_or("")
    }

    fn big_file(name: &str) -> (Scratch, PathBuf, Vec<u8>) {
        let d = dir(name);
        let p = d.join("clip.bin");
        let data = pattern(BIG);
        std::fs::write(&p, &data).unwrap();
        (d, p, data)
    }

    /// The http-range 0.1.5 semantics, case by case.
    #[test]
    fn range_header_parses_like_http_range() {
        let size = 10_007;
        let ok: &[(&str, &[(u64, u64)])] = &[
            ("", &[]),
            ("bytes=0-0", &[(0, 0)]),
            ("bytes=123-4567", &[(123, 4567)]),
            ("bytes=9000-", &[(9000, 10_006)]),
            ("bytes=9000-99999", &[(9000, 10_006)]),
            ("bytes=-300", &[(9707, 10_006)]),
            ("bytes=-99999", &[(0, 10_006)]),
            ("bytes= 5 - 9 ,\t20-29", &[(5, 9), (20, 29)]),
            ("bytes=5-9,,", &[(5, 9)]),
            // One satisfiable range keeps the request alive.
            ("bytes=20000-,4-6", &[(4, 6)]),
        ];
        for (header, want) in ok {
            assert_eq!(parse_ranges(header, size), Ok(want.to_vec()), "{header:?}");
        }
        let refused = [
            "items=0-5",
            "bytes=5",
            "bytes=9-5",
            "bytes=a-5",
            "bytes=--5",
            "bytes=-",
            "bytes=10007-",
            "bytes=-0",
            "bytes=18446744073709551616-",
        ];
        for header in refused {
            assert_eq!(parse_ranges(header, size), Err(()), "{header:?}");
        }
        // An empty file has no byte to point at.
        assert_eq!(parse_ranges("bytes=0-", 0), Err(()));
    }

    #[test]
    fn a_middle_range_is_the_exact_slice() {
        let (_d, p, data) = big_file("middle");
        let r = get(&p, Some("bytes=1234-5677"));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body().as_slice(), &data[1234..=5677]);
        assert_eq!(header(&r, CONTENT_RANGE), format!("bytes 1234-5677/{BIG}"));
        assert_eq!(header(&r, CONTENT_LENGTH), "4444");
        assert_eq!(header(&r, ACCEPT_RANGES), "bytes");
        assert_eq!(header(&r, ACCESS_CONTROL_EXPOSE_HEADERS), "content-range");
        assert_eq!(header(&r, ACCESS_CONTROL_ALLOW_ORIGIN), ORIGIN);
        assert_eq!(header(&r, CONTENT_TYPE), "application/octet-stream");
    }

    /// `bytes=N-` (what a media element sends) is answered with at most
    /// 1000 KiB, and the headers say exactly which bytes they are.
    #[test]
    fn an_open_range_is_capped_at_1000_kib() {
        let (_d, p, data) = big_file("open");
        let start = 100_003usize;
        let r = get(&p, Some("bytes=100003-"));
        let end = start + MAX_RANGE_LEN as usize - 1;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body().len(), MAX_RANGE_LEN as usize);
        assert_eq!(r.body().as_slice(), &data[start..=end]);
        assert_eq!(header(&r, CONTENT_RANGE), format!("bytes {start}-{end}/{BIG}"));
        assert_eq!(header(&r, CONTENT_LENGTH), MAX_RANGE_LEN.to_string());
    }

    #[test]
    fn a_range_past_the_end_stops_at_the_last_byte() {
        let (_d, p, data) = big_file("tail");
        let r = get(&p, Some("bytes=2999990-3999999"));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body().as_slice(), &data[2_999_990..]);
        assert_eq!(header(&r, CONTENT_RANGE), format!("bytes 2999990-3000016/{BIG}"));
        assert_eq!(header(&r, CONTENT_LENGTH), "27");

        let r = get(&p, Some("bytes=-777"));
        assert_eq!(r.body().as_slice(), &data[BIG - 777..]);
        assert_eq!(header(&r, CONTENT_RANGE), format!("bytes 2999240-3000016/{BIG}"));
    }

    /// A range that cannot be met is a 416 naming the length — and, unlike
    /// the built-in's, it carries the CORS header so a `fetch` resolves.
    #[test]
    fn an_unsatisfiable_range_is_416_with_the_length() {
        let (_d, p, _) = big_file("unsat");
        for range in [format!("bytes={BIG}-"), "items=0-5".into(), "bytes=".into()] {
            let r = get(&p, Some(&range));
            assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE, "{range}");
            assert_eq!(header(&r, CONTENT_RANGE), format!("bytes */{BIG}"), "{range}");
            assert_eq!(header(&r, ACCESS_CONTROL_ALLOW_ORIGIN), ORIGIN, "{range}");
            assert!(r.body().is_empty(), "{range}");
        }
    }

    #[test]
    fn head_sends_headers_and_no_body() {
        let (_d, p, _) = big_file("head");
        let path = p.to_str().unwrap();
        let ranged = respond_to(
            &request(Method::HEAD, path, Some("bytes=5000-5999")),
            &|_: &str| true,
            ORIGIN,
            MAX_WHOLE_LEN,
        );
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(header(&ranged, CONTENT_RANGE), format!("bytes 5000-5999/{BIG}"));
        assert_eq!(header(&ranged, CONTENT_LENGTH), "1000");
        assert!(ranged.body().is_empty());

        let whole =
            respond_to(&request(Method::HEAD, path, None), &|_: &str| true, ORIGIN, MAX_WHOLE_LEN);
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(header(&whole, CONTENT_LENGTH), BIG.to_string());
        assert!(whole.body().is_empty());
    }

    /// A short file is answered whole from the sniff read, once, typed by
    /// its content (PNG magic in a file whose extension says nothing).
    #[test]
    fn a_short_file_is_served_whole_and_typed_by_content() {
        let d = dir("short");
        let p = d.join("still.dat");
        let mut data = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        data.extend(pattern(5_003));
        std::fs::write(&p, &data).unwrap();
        let r = get(&p, None);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), &data);
        assert_eq!(header(&r, CONTENT_LENGTH), data.len().to_string());
        assert_eq!(header(&r, CONTENT_TYPE), "image/png");
        assert_eq!(header(&r, ACCESS_CONTROL_ALLOW_ORIGIN), ORIGIN);

        // No magic, so the extension decides (svg is never sniffed).
        let svg = d.join("icon.svg");
        std::fs::write(&svg, b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        assert_eq!(header(&get(&svg, None), CONTENT_TYPE), "image/svg+xml");
    }

    #[test]
    fn a_long_file_is_served_whole_exactly() {
        let d = dir("long");
        let p = d.join("photo.bin");
        let data = pattern(20_011);
        std::fs::write(&p, &data).unwrap();
        let r = get(&p, None);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), &data);
        assert_eq!(header(&r, CONTENT_LENGTH), "20011");
    }

    /// The whole-file cap: past it the answer is an empty 413 (HEAD agrees
    /// with GET); exactly at it the file is served; and a Range request is
    /// never subject to it.
    #[test]
    fn a_whole_file_past_the_cap_is_413() {
        let d = dir("cap");
        let p = d.join("huge.bin");
        let data = pattern(10_007);
        std::fs::write(&p, &data).unwrap();
        let path = p.to_str().unwrap();
        let all = |_: &str| true;

        for method in [Method::GET, Method::HEAD] {
            let r = respond_to(&request(method.clone(), path, None), &all, ORIGIN, 4_099);
            assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE, "{method}");
            assert!(r.body().is_empty());
            assert_eq!(header(&r, ACCESS_CONTROL_ALLOW_ORIGIN), ORIGIN);
        }

        let at_cap = respond_to(&request(Method::GET, path, None), &all, ORIGIN, 10_007);
        assert_eq!(at_cap.status(), StatusCode::OK);
        assert_eq!(at_cap.body(), &data);

        let ranged =
            respond_to(&request(Method::GET, path, Some("bytes=6000-")), &all, ORIGIN, 4_099);
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.body().as_slice(), &data[6000..]);
    }

    /// The scope is asked with the DECODED path, and its "no" is an empty
    /// 403 even for a file that exists.
    #[test]
    fn a_path_outside_the_scope_is_403() {
        let (_d, p, _) = big_file("scope");
        let path = p.to_str().unwrap();
        let asked = RefCell::new(Vec::<String>::new());
        let deny = |q: &str| {
            asked.borrow_mut().push(q.to_owned());
            false
        };
        let r = respond_to(&request(Method::GET, path, Some("bytes=0-99")), &deny, ORIGIN, MAX_WHOLE_LEN);
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        assert!(r.body().is_empty());
        assert_eq!(header(&r, ACCESS_CONTROL_ALLOW_ORIGIN), ORIGIN);
        assert_eq!(header(&r, CONTENT_RANGE), "");
        assert_eq!(asked.borrow().as_slice(), &[path.to_owned()]);
    }

    /// `..`, devices, the object namespace and relative names are refused
    /// before the scope is even asked.
    #[test]
    fn traversal_device_and_relative_paths_are_403_unasked() {
        let (_d, p, _) = big_file("shapes");
        let d = p.parent().unwrap();
        let traversal = format!("{}\\..\\{}\\clip.bin", d.display(), d.file_name().unwrap().to_str().unwrap());
        let asked = Cell::new(0);
        let allow = |_: &str| {
            asked.set(asked.get() + 1);
            true
        };
        for path in [
            traversal.as_str(),
            r"\\.\pipe\taroting",
            "//./PhysicalDrive0",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\x.bin",
            r"\\?\pipe\taroting",
            "clip.bin",
            r"src\main.rs",
            "",
        ] {
            let r = respond_to(&request(Method::GET, path, None), &allow, ORIGIN, MAX_WHOLE_LEN);
            assert_eq!(r.status(), StatusCode::FORBIDDEN, "{path:?}");
            assert!(r.body().is_empty(), "{path:?}");
        }
        assert_eq!(asked.get(), 0, "the scope must not be consulted for these");
        // The same file spelled without `..` is served, so the refusal above
        // was the traversal and not the file.
        assert_eq!(get(&p, Some("bytes=0-9")).status(), StatusCode::PARTIAL_CONTENT);
    }

    #[test]
    fn a_missing_file_is_404_and_a_folder_is_not_served() {
        let d = dir("missing");
        let r = get(&d.join("gone.mp4"), None);
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        assert!(r.body().is_empty());
        assert_eq!(header(&r, ACCESS_CONTROL_ALLOW_ORIGIN), ORIGIN);

        let r = get(&d, None);
        assert!(
            r.status() == StatusCode::FORBIDDEN || r.status() == StatusCode::NOT_FOUND,
            "a folder must be refused, got {}",
            r.status()
        );
        assert!(r.body().is_empty());
    }

    #[test]
    fn percent_decoding_matches_percent_encoding() {
        let cases = [
            ("C%3A%5Cdir%5Cna%C3%AFve%20file.bin", "C:\\dir\\na\u{ef}ve file.bin"),
            ("100%zz", "100%zz"),
            ("a%4", "a%4"),
            ("a%", "a%"),
            ("%41+b", "A+b"),
            ("%ff", "\u{fffd}"),
            ("plain", "plain"),
        ];
        for (input, want) in cases {
            assert_eq!(percent_decode_lossy(input.as_bytes()), want, "{input:?}");
        }
    }

    /// End to end: a name with a space and a non-ASCII letter, encoded the way
    /// `convertFileSrc` encodes it, opens the right file.
    #[test]
    fn an_encoded_name_reaches_the_file() {
        let d = dir("encoded");
        let p = d.join("na\u{ef}ve clip #1.bin");
        let data = pattern(321);
        std::fs::write(&p, &data).unwrap();
        let r = get(&p, None);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), &data);
    }

    /// Two ranges make one well-formed multipart body: one content type
    /// header, each part's bytes and range, and the closing delimiter.
    #[test]
    fn two_ranges_are_one_multipart_body() {
        let (_d, p, data) = big_file("multi");
        let r = get(&p, Some("bytes=10-19,4000-4009"));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers().get_all(CONTENT_TYPE).iter().count(), 1);
        let ctype = header(&r, CONTENT_TYPE);
        let boundary = ctype.strip_prefix("multipart/byteranges; boundary=").unwrap();
        assert_eq!(boundary.len(), 32);
        let body = r.body();
        assert_eq!(header(&r, CONTENT_LENGTH), body.len().to_string());

        let mut want = Vec::new();
        for (s, e) in [(10usize, 19usize), (4000, 4009)] {
            want.extend_from_slice(
                format!(
                    "\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes {s}-{e}/{BIG}\r\n\r\n"
                )
                .as_bytes(),
            );
            want.extend_from_slice(&data[s..=e]);
        }
        want.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        assert_eq!(body, &want);
    }

    /// The multipart total is bounded: two open ranges share ONE 1000 KiB
    /// budget, and a long list stops at `MAX_PARTS` parts.
    #[test]
    fn multipart_is_bounded_in_bytes_and_parts() {
        let (_d, p, _) = big_file("multicap");
        let r = get(&p, Some("bytes=0-,7-"));
        let body = String::from_utf8_lossy(r.body()).into_owned();
        assert_eq!(body.matches("Content-Range: ").count(), 1);
        assert!(body.contains(&format!("Content-Range: bytes 0-1023999/{BIG}")));
        assert!(r.body().len() < MAX_RANGE_LEN as usize + 512);

        let many: Vec<String> = (0..40).map(|i| format!("{}-{}", i * 100, i * 100 + 9)).collect();
        let r = get(&p, Some(&format!("bytes={}", many.join(","))));
        let body = String::from_utf8_lossy(r.body()).into_owned();
        assert_eq!(body.matches("Content-Range: ").count(), MAX_PARTS);
    }

    #[test]
    fn the_cors_origin_is_the_windows_own() {
        let dev: Url = "http://localhost:1420".parse().unwrap();
        let dist: Url = "https://app.example.test:8443/ui/".parse().unwrap();
        // `tauri dev`: the dev server's origin.
        assert_eq!(origin_of(app_url(true, Some(&dev), None, false).as_ref(), false), "http://localhost:1420");
        // A release build serving the bundled frontend.
        let release = origin_of(app_url(false, Some(&dev), None, false).as_ref(), false);
        let release_https = origin_of(app_url(false, None, None, true).as_ref(), true);
        if cfg!(windows) {
            assert_eq!(release, "http://tauri.localhost");
            assert_eq!(release_https, "https://tauri.localhost");
        } else {
            assert_eq!(release, "tauri://localhost");
        }
        // A frontend served from a URL in release.
        assert_eq!(
            origin_of(app_url(false, None, Some(&dist), false).as_ref(), false),
            "https://app.example.test:8443"
        );
        // Opaque origins.
        let data: Url = "data:text/html,hi".parse().unwrap();
        assert_eq!(origin_of(Some(&data), false), "null");
        assert_eq!(origin_of(None, false), "null");
    }
}
