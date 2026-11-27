// The Swift app's LocalPreviewSiteTests, ported: a local page reads itself
// and the assets it names, never the other files beside it (Daybreak finding 6
// and the reviews after it).
use super::*;
use std::fs;
use std::path::PathBuf;

#[test]
fn publishing_reads_only_the_utf8_bytes_that_were_previewed() {
    let folder = Folder::new();
    let file = folder.dir.join("publish.html");
    fs::write(&file, "<p>Before</p>").unwrap();
    let (_, before) = scan(&file).unwrap();
    assert_eq!(read_for_publish(&file, &before), Ok("<p>Before</p>".into()));
    fs::write(&file, "<p>After</p>").unwrap();
    assert!(read_for_publish(&file, &before)
        .unwrap_err()
        .contains("changed"));
    fs::write(&file, [0xff]).unwrap();
    let (_, invalid) = scan(&file).unwrap();
    assert!(read_for_publish(&file, &invalid)
        .unwrap_err()
        .contains("UTF-8"));
    fs::write(&file, vec![b'x'; MAX_PUBLISH_BYTES as usize + 1]).unwrap();
    let (_, large) = scan(&file).unwrap();
    assert!(read_for_publish(&file, &large)
        .unwrap_err()
        .contains("10 MB"));
}

struct Folder {
    base: PathBuf,
    dir: PathBuf,
    outside: PathBuf,
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

impl Folder {
    fn new() -> Folder {
        let base = std::env::temp_dir().join(format!(
            "local-preview-{}-{}",
            std::process::id(),
            rand_suffix()
        ));
        let dir = base.join("site");
        let outside = base.join("elsewhere");
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let f = Folder { base, dir, outside };
        f.write(
            "index.html",
            r#"<link rel="stylesheet" href="style.css?v=2">
<img src="pic.png" srcset="pic.png 1x, assets/pic@2x.png 2x">
<a href="about.html">About</a>
<img src=../elsewhere/out.png><img src="secret.env"><img src="notes.json"><img src="logo.png"><img src="away.png">
<img src="https://example.com/x.png"><img src="data:image/png;base64,AAAA">
<script src="app.js"></script>
<script>fetch("private.html"); const p = 'assets/inline.png'; document.body.style.background = "url(assets/js.png)";</script>
<div style="background: url('assets/styled.png')"></div>"#,
        );
        f.write("style.css", "@import 'theme.css'; body { background: url('assets/bg.png'); } @font-face { src: url(assets/font.woff2) }");
        f.write(
            "app.js",
            "const img = new Image(); img.src = `assets/late.png`;",
        );
        f.write("theme.css", "a { color: red }");
        for name in [
            "pic.png",
            "assets/pic@2x.png",
            "assets/bg.png",
            "assets/font.woff2",
            "assets/late.png",
            "about.html",
            "other.png",
            "notes.json",
            "private.html",
            "assets/inline.png",
            "assets/js.png",
            "assets/styled.png",
        ] {
            f.write(name, "x");
        }
        f.write(".env", "SECRET=1");
        f.write("secret.env", "SECRET=2");
        fs::write(f.outside.join("out.png"), "far away").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(f.dir.join(".env"), f.dir.join("logo.png")).unwrap();
            std::os::unix::fs::symlink(f.outside.join("out.png"), f.dir.join("away.png")).unwrap();
        }
        f
    }

    fn write(&self, name: &str, text: &str) {
        fs::write(self.dir.join(name), text).unwrap();
    }

    fn site(&self) -> Site {
        let site = Site::new(&self.dir.join("index.html"), None).expect("a site");
        assert_eq!(
            site.serve("/index.html").map(|s| s.mime),
            Some("text/html; charset=utf-8".to_owned())
        );
        site
    }
}

fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

#[cfg(unix)]
#[test]
fn unrelated_sibling_files_are_refused() {
    let f = Folder::new();
    let site = f.site();
    for refused in [
        "/other.png",
        "/.env",
        "/secret.env",
        "/notes.json",
        "/logo.png",
        "/away.png",
        "/../elsewhere/out.png",
        "/assets/../.env",
        "//index.html",
    ] {
        assert!(site.serve(refused).is_none(), "{refused}");
    }
}

#[cfg(unix)]
#[test]
fn named_styles_and_pictures_load() {
    let f = Folder::new();
    let site = f.site();
    assert_eq!(
        site.serve("/style.css").unwrap().mime,
        "text/css; charset=utf-8"
    );
    assert_eq!(site.serve("/pic.png").unwrap().mime, "image/png");
    for named in [
        "/assets/pic@2x.png",
        "/assets/bg.png",
        "/assets/font.woff2",
        "/theme.css",
        "/assets/styled.png",
    ] {
        assert!(site.serve(named).is_some(), "{named}");
    }
}

#[cfg(unix)]
#[test]
fn only_the_page_itself_and_passive_assets() {
    let f = Folder::new();
    f.write(
        "drawing.svg",
        "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>",
    );
    f.write("index.html", "<iframe src=about.html></iframe><iframe src=private.html></iframe><script src=app.js></script><img src=drawing.svg><img src=pic.png>");
    let site = f.site();
    for refused in ["/about.html", "/private.html", "/app.js", "/drawing.svg"] {
        assert!(site.serve(refused).is_none(), "{refused}");
    }
    assert!(site.serve("/pic.png").is_some());
    assert!(
        site.serve("/index.html").is_some(),
        "the page itself, again"
    );
}

#[cfg(unix)]
#[test]
fn scripts_name_nothing() {
    let f = Folder::new();
    let site = f.site();
    for refused in [
        "/private.html",
        "/assets/inline.png",
        "/assets/js.png",
        "/assets/late.png",
    ] {
        assert!(site.serve(refused).is_none(), "{refused}");
    }
}

#[cfg(unix)]
#[test]
fn no_symlink_is_followed() {
    let f = Folder::new();
    fs::create_dir_all(f.outside.join("assets")).unwrap();
    fs::write(f.outside.join("assets/bg.png"), "far").unwrap();
    f.write(
        "index.html",
        "<img src=pic.png><img src=alias.png><img src=linked/bg.png><img src=hard.png>",
    );
    std::os::unix::fs::symlink(f.dir.join("pic.png"), f.dir.join("alias.png")).unwrap();
    std::os::unix::fs::symlink(f.outside.join("assets"), f.dir.join("linked")).unwrap();
    fs::hard_link(f.outside.join("out.png"), f.dir.join("hard.png")).unwrap();
    let site = f.site();
    assert!(
        site.serve("/alias.png").is_none(),
        "a link, even to an allowed picture"
    );
    assert!(
        site.serve("/linked/bg.png").is_none(),
        "a folder on the way that's a link"
    );
    assert!(
        site.serve("/hard.png").is_none(),
        "a hard link to a file elsewhere"
    );
    assert_eq!(&*site.serve("/pic.png").unwrap().data, b"x");
    fs::remove_file(f.dir.join("pic.png")).unwrap();
    std::os::unix::fs::symlink(f.dir.join(".env"), f.dir.join("pic.png")).unwrap();
    assert!(
        site.serve("/pic.png").is_none(),
        "swapped for a link after being served once"
    );
}

#[cfg(unix)]
#[test]
fn nul_and_control_characters_are_refused() {
    let f = Folder::new();
    f.write("credentials.json", "{\"key\": \"secret\"}");
    f.write("index.html", r#"<iframe src="credentials.json%00.html"></iframe><img src="a%0Ab.png"><img src="x%2500.png">"#);
    let site = f.site();
    for refused in [
        "/credentials.json\0.html",
        "/a\nb.png",
        "/x%00.png",
        "/credentials.json",
    ] {
        assert!(site.serve(refused).is_none(), "{refused:?}");
    }
    assert!(resolve("credentials.json%00.html", "").is_none());
    assert!(resolve("a%7Fb.png", "").is_none());
    assert!(resolve("x%2500.png", "").is_none());
    assert!(safe_parts("a\0.html").is_none());
    assert!(safe_parts("a\u{85}.png").is_none());
    assert!(safe_parts("a\\b.png").is_none());
    assert!(safe_parts("my pic.png").is_some());
}

#[cfg(unix)]
#[test]
fn a_fifo_is_refused() {
    let f = Folder::new();
    f.write("index.html", "<img src=pipe.png>");
    let c = std::ffi::CString::new(f.dir.join("pipe.png").to_str().unwrap()).unwrap();
    // SAFETY: `c` is a NUL-terminated CString that outlives the call.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    let site = f.site();
    assert!(site.serve("/pipe.png").is_none());
}

#[cfg(unix)]
#[test]
fn nothing_is_allowed_before_the_page_is_served() {
    let f = Folder::new();
    let site = Site::new(&f.dir.join("index.html"), None).unwrap();
    assert!(site.serve("/style.css").is_none());
    assert!(site.serve("/pic.png").is_none());
}

#[test]
fn resolving_names() {
    assert_eq!(resolve("a/b/../c.png", "").as_deref(), Some("a/c.png"));
    assert_eq!(resolve("../c.png", "a").as_deref(), Some("c.png"));
    assert_eq!(resolve("../c.png", ""), None);
    assert_eq!(resolve("/c.png", "a").as_deref(), Some("c.png"));
    assert_eq!(resolve("my%20pic.png#x", "").as_deref(), Some("my pic.png"));
    assert_eq!(resolve("//cdn.example.com/x.png", ""), None);
    assert_eq!(resolve("file:///etc/x.png", ""), None);
    assert_eq!(resolve(".git/x.png", ""), None);
    assert_eq!(resolve("id_rsa", ""), None);
    assert_eq!(resolve("x.png%", ""), None);
}

#[test]
fn only_pages_can_be_the_page() {
    let f = Folder::new();
    for name in ["secret.env", ".env", "app.js", "pic.png"] {
        assert!(Site::new(&f.dir.join(name), None).is_none(), "{name}");
    }
}

#[test]
fn finding_scripts() {
    let yes = |s: &str| has_scripts(s.as_bytes());
    assert!(yes("<p>x</p><script>draw()</script>"));
    assert!(yes("<SCRIPT src=app.js></SCRIPT>"));
    assert!(!yes("<p>A script-free mockup</p>"));
    assert!(!yes(""));
    assert!(yes("<body onload=\"draw()\">"));
    assert!(yes("<body\n  onload = \"draw()\">"));
    assert!(!yes("<p>Do it once = twice</p>"), "words, not a handler");
    assert!(yes("<a href=\"javascript:go()\">go</a>"));
    assert!(!yes("<p>Turn it on now = later</p>"));
    assert!(yes("<p> x <img\nsrc=a.png ONERROR=go()>"));
    assert!(yes("<<< <div onclick=go()"), "an unclosed tag still counts");
    assert!(!yes("<p>a</p> onclick=go()"));
    assert!(yes("<!-- <script> -->"), "even in a comment");
    assert!(yes("<a href=\"JavaScript:go()\">"));
    assert!(yes("é <b onmouseover\t=x> 😀"));
    assert!(!yes("😀<b>😀</b> onmouseover=x"));
}

#[test]
fn stripping_scripts_and_reading_urls() {
    assert_eq!(
        without_script_contents("<script a>x<script>y</script ><p>"),
        "<script a></script ><p>"
    );
    assert_eq!(
        without_script_contents("<script>never closed"),
        "<script>never closed"
    );
    assert_eq!(
        without_script_contents("<scripts>x</script>"),
        "<scripts>x</script>",
        "not a script tag"
    );
    assert_eq!(
        without_script_contents("<script>var src = \"p.png\";</script/><p>"),
        "<script></script/><p>",
        "a closer the browser reads"
    );
    assert_eq!(
        without_script_contents("<script>var src = \"p.png\";</script foo><p>"),
        "<script></script foo><p>"
    );
    assert_eq!(
        without_script_contents("<script>a</scripty>b"),
        "<script>a</scripty>b",
        "not a closer"
    );
    assert_eq!(
        without_script_contents("<script>a</script><p><SCRIPT>b</SCRIPT>"),
        "<script></script><p><SCRIPT></SCRIPT>"
    );
    assert_eq!(
        css_urls(
            r#"a{b:url( "x y.png" )} c{d:url(z.png) url('w.png')} e{f:url(bad"quote)}"#,
            usize::MAX
        ),
        ["x y.png", "z.png", "w.png"]
    );
}

#[test]
fn reference_limits_stop_each_read() {
    let text =
        "<img src=a.png srcset=\"b.png 1x, c.png 2x\" style=\"background:url(d.png)\">".repeat(100);
    assert_eq!(html_references(&text, 7).len(), 7);
    assert_eq!(html_references(&text, 150).len(), 150);
    assert_eq!(html_references(&text, usize::MAX).len(), 400);
    assert_eq!(css_references(&text, 3), ["d.png", "d.png", "d.png"]);
    assert!(css_references(&text, 0).is_empty());
}

/// Pages and stylesheets that held the Swift app's first regexes for minutes
/// read in well under a second each (a generous bound for a debug build on a
/// busy check host).
#[test]
fn references_are_quick_on_pathological_text() {
    let size = 4 * 1024 * 1024;
    let texts = [
        "<script>".repeat(size / 8),
        "<script".repeat(size / 7),
        format!("url({}", " ".repeat(size)),
        format!("{}{}x", "url(".repeat(size / 8), " ".repeat(size / 2)),
        "url(\"".repeat(size / 5),
        format!("url(\"{}\"{}", " ".repeat(size), " ".repeat(size)),
        "src=\"".repeat(size / 5),
        "<".repeat(size),
        format!("<b{}onx", " ".repeat(size - 16)),
    ];
    for text in texts {
        let started = std::time::Instant::now();
        let _ = html_references(&text, MAX_REFERENCES_PER_FILE);
        let _ = css_references(&text, MAX_REFERENCES_PER_FILE);
        let _ = has_scripts(text.as_bytes());
        assert!(started.elapsed().as_secs() < 30, "{}...", &text[..12]);
    }
}

#[cfg(unix)]
#[test]
fn a_scan_never_blocks_on_a_fifo() {
    let f = Folder::new();
    let page = f.dir.join("drawn.html");
    fs::write(&page, "<script>draw()</script>").unwrap();
    let (scripts, found) = scan(&page).unwrap();
    assert!(scripts);
    assert_eq!(found, digest(b"<script>draw()</script>"));
    let fifo = f.dir.join("pipe.html");
    let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    // SAFETY: `c` is a NUL-terminated CString that outlives the call.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    assert!(scan(&fifo).is_none());
    assert!(scan(&f.dir.join("gone.html")).is_none());
}

#[cfg(unix)]
#[test]
fn a_page_with_a_digest_is_served_only_while_it_matches() {
    let f = Folder::new();
    let page = f.dir.join("drawn.html");
    fs::write(&page, "<script>draw()</script>").unwrap();
    let allowed = digest(b"<script>draw()</script>");
    let site = Site::new(&page, Some(allowed)).unwrap();
    assert!(site.serve("drawn.html").is_some());
    fs::write(&page, "<script>steal()</script>").unwrap();
    assert!(
        site.serve("drawn.html").is_none(),
        "rewritten: not what was allowed"
    );
    assert!(
        Site::new(&page, None)
            .unwrap()
            .serve("drawn.html")
            .is_some(),
        "the static view still shows it"
    );
}

#[test]
fn consent_is_for_those_bytes_of_that_file() {
    let mut consent = ScriptConsent::default();
    assert!(!consent.allows("/a/page.html", "1"));
    consent.allow("/a/page.html", "1");
    assert!(consent.allows("/a/page.html", "1"));
    assert!(!consent.allows("/a/page.html", "2"), "changed");
    assert!(
        !consent.allows("/b/page.html", "1"),
        "another file with the same bytes"
    );
    consent.allow("/a/page.html", "2");
    assert!(!consent.allows("/a/page.html", "1"), "one version per file");
    for n in 0..300 {
        consent.allow(&format!("/p{n}.html"), "x");
    }
    assert_eq!(consent.0.len(), ScriptConsent::LIMIT);
    assert!(
        consent.allows("/p299.html", "x") && !consent.allows("/p0.html", "x"),
        "the oldest go first"
    );
}

#[cfg(unix)]
#[test]
fn only_the_start_of_a_page_is_read_for_names() {
    let f = Folder::new();
    let line = "<p>words words words</p>\n";
    let filler = line.repeat(SCAN_BYTES / line.len() + 1);
    f.write(
        "index.html",
        &format!("<img src=\"early.png\">{filler}<img src=\"late.png\">"),
    );
    let site = f.site();
    assert!(site.allows("early.png"));
    assert!(!site.allows("late.png"), "named past SCAN_BYTES");
}

#[cfg(unix)]
#[test]
fn names_kept_are_per_file_and_in_all_capped() {
    let f = Folder::new();
    let many: String = (0..5_000)
        .map(|n| format!("<img src=\"p{n}.png\">"))
        .collect();
    let links: String = (0..8)
        .map(|n| format!("<link rel=stylesheet href=\"s{n}.css\">"))
        .collect();
    f.write("index.html", &format!("{many}{links}"));
    for n in 0..8 {
        f.write(
            &format!("s{n}.css"),
            &(0..3_000)
                .map(|m| format!("a{{b:url(s{n}-{m}.png)}}"))
                .collect::<String>(),
        );
    }
    let first = f.site();
    assert_eq!(first.allowed_count(), 1 + MAX_REFERENCES_PER_FILE);
    assert!(first.allows("p1999.png") && !first.allows("p2000.png") && !first.allows("s0.css"));
    f.write("index.html", &links);
    let next = f.site();
    for n in 0..8 {
        assert!(next.serve(&format!("s{n}.css")).is_some(), "s{n}.css");
    }
    assert_eq!(next.allowed_count(), MAX_ALLOWED);
}

#[cfg(unix)]
#[test]
fn the_gate_shows_only_this_macs_real_pages() {
    use crate::open_policy::Origin;
    let f = Folder::new();
    let page = f.dir.join("index.html");
    assert_eq!(
        decide_page(page.to_str().unwrap(), Origin::ThisMac).unwrap(),
        fs::canonicalize(&page).unwrap()
    );
    assert!(
        decide_page(page.to_str().unwrap(), Origin::OtherMac).is_err(),
        "another Mac's"
    );
    assert!(
        decide_page("index.html", Origin::ThisMac).is_err(),
        "not absolute"
    );
    std::os::unix::fs::symlink(f.dir.join(".env"), f.dir.join("notes.html")).unwrap();
    assert!(
        decide_page(f.dir.join("notes.html").to_str().unwrap(), Origin::ThisMac).is_err(),
        "a page's name on a link to a secret"
    );
    std::os::unix::fs::symlink(&page, f.dir.join("alias.html")).unwrap();
    assert_eq!(
        decide_page(f.dir.join("alias.html").to_str().unwrap(), Origin::ThisMac).unwrap(),
        fs::canonicalize(&page).unwrap(),
        "a link to a page is that page"
    );
    fs::create_dir(f.dir.join("folder.html")).unwrap();
    assert!(
        decide_page(f.dir.join("folder.html").to_str().unwrap(), Origin::ThisMac).is_err(),
        "a folder"
    );
}

/// Daybreak 118: `srcset=` inside a bare `src` value was read as another
/// attribute, and its value read again to the end of the page.
#[test]
fn a_value_is_read_once() {
    assert_eq!(
        html_references("<img src=srcset=one.png>", usize::MAX),
        ["srcset=one.png"]
    );
    assert_eq!(
        html_references(
            "<img alt=\"src=a.png\" title='srcset=b.png 2x'>",
            usize::MAX
        ),
        Vec::<String>::new()
    );
    assert_eq!(
        html_references(
            "<img srcset=\"a.png 1x,\n b.png 2x\" src=c.png>",
            usize::MAX
        ),
        ["a.png", "b.png", "c.png"]
    );
}

/// One budget for a page's names: `srcset` isn't read once it's spent, and
/// a name longer than `MAX_REFERENCE_BYTES` is skipped, not kept.
#[test]
fn every_name_shares_one_budget_and_long_ones_are_skipped() {
    let full: String = (0..10)
        .map(|n| format!("<img src=p{n}.png>"))
        .collect::<String>()
        + "<img srcset=\"late.png 1x\" style=\"background:url(css.png)\">";
    assert_eq!(html_references(&full, 10).len(), 10);
    assert!(!html_references(&full, 10)
        .iter()
        .any(|r| r == "late.png" || r == "css.png"));
    let long = "a".repeat(MAX_REFERENCE_SOURCE_BYTES);
    let text = format!("<img src=\"{long}.png\" srcset=\"{long}.png 1x, ok1.png 2x\" style=\"background:url({long}.png)\"><link href='{long}.css'><img src=ok2.png>");
    assert_eq!(html_references(&text, usize::MAX), ["ok1.png", "ok2.png"]);
    let css = format!("@import '{long}.css'; @import 'ok.css'; a{{b:url({long}.png)}}");
    assert_eq!(css_references(&css, usize::MAX), ["ok.css"]);
}

/// This thread's CPU seconds (other tests run beside it).
fn cpu_seconds() -> f64 {
    crate::html_tags::tests::cpu_seconds()
}

/// Daybreak 118's page, at the full 4 MiB a page is read for names:
/// `<img `, 2,000 `src=srcset=`, padding, `.png>`. It made 15.6 GiB of
/// names and aborted the core under 512 MiB; now it names one file, the
/// site keeps a bounded amount, and it reads quickly.
#[cfg(unix)]
#[test]
fn the_amplifying_page_is_served_with_bounded_names() {
    let f = Folder::new();
    let head = format!("<img {}", "src=srcset=".repeat(2_000));
    let page = format!("{head}{}.png>", "x".repeat(SCAN_BYTES - head.len() - 5));
    assert_eq!(page.len(), SCAN_BYTES);
    let started = cpu_seconds();
    let refs = html_references(&page, MAX_REFERENCES_PER_FILE);
    let spent = cpu_seconds() - started;
    assert!(
        refs.is_empty(),
        "one value, longer than any name: {}",
        refs.len()
    );
    // Linear work over 4 MiB in a debug build: well under the seconds the
    // old scan took before it ran out of memory. 0.5 s was too tight for
    // the cloud check host, which took 0.52 s on 18 Nov and failed a
    // landing that didn't touch this code.
    assert!(spent < 2.0, "reading the page's names took {spent}s");
    f.write("index.html", &page);
    let site = f.site();
    assert_eq!(site.allowed_count(), 1, "the page alone");
}

/// However many names the files of a site give, what it keeps stays under
/// `MAX_ALLOWED_BYTES`.
#[cfg(unix)]
#[test]
fn what_a_site_keeps_is_bounded_in_bytes() {
    let f = Folder::new();
    let name = |n: usize| format!("{n:0>1000}.png");
    let links: String = (0..8)
        .map(|n| format!("<link rel=stylesheet href=\"s{n}.css\">"))
        .collect();
    f.write("index.html", &links);
    for n in 0..8 {
        f.write(
            &format!("s{n}.css"),
            &(0..2_000)
                .map(|m| format!("a{{b:url({})}}", name(n * 2_000 + m)))
                .collect::<String>(),
        );
    }
    let site = f.site();
    for n in 0..8 {
        let _ = site.serve(&format!("s{n}.css"));
    }
    let kept = site.allowed_count();
    // The page and eight stylesheets, then 1,004-byte names up to the budget.
    assert!(
        (2_000..=9 + MAX_ALLOWED_BYTES / 1_004).contains(&kept),
        "kept {kept}"
    );
    assert!(site.allows(&name(0)) && !site.allows(&name(15_999)));
}

/// A path in Japanese folders, every byte `%XX`, is longer as written than
/// the path it names: the limit is on the path (Codex's review).
#[cfg(unix)]
#[test]
fn an_encoded_name_is_limited_by_the_path_it_names() {
    let f = Folder::new();
    let folder = "\u{3042}".repeat(60);
    let encoded = "%E3%81%82".repeat(60);
    fs::create_dir_all(f.dir.join(&folder).join(&folder)).unwrap();
    f.write(&format!("{folder}/{folder}/photo.png"), "x");
    let src = format!("{encoded}/{encoded}/photo.png");
    assert!(src.len() > MAX_REFERENCE_BYTES);
    f.write("index.html", &format!("<img src=\"{src}\">"));
    let site = f.site();
    assert!(site
        .serve(&format!("/{folder}/{folder}/photo.png"))
        .is_some());
    let too_long = format!("<img src=\"{}.png\">", "%61".repeat(MAX_REFERENCE_BYTES));
    assert!(
        html_references(&too_long, 10).len() == 1
            && resolve(&html_references(&too_long, 10)[0], "")
                .is_some_and(|p| p.len() > MAX_REFERENCE_BYTES)
    );
    f.write("index.html", &too_long);
    assert_eq!(
        f.site().allowed_count(),
        1,
        "a decoded path past MAX_REFERENCE_BYTES isn't kept"
    );
}

#[cfg(unix)]
#[test]
fn a_live_page_reads_only_itself() {
    let f = Folder::new();
    let page = std::fs::read(f.dir.join("index.html")).unwrap();
    let site = Site::page_only(&f.dir.join("index.html"), digest(&page)).unwrap();
    assert!(site.serve("index.html").is_some());
    // Named in its markup, and served to the side pane's preview, but not here.
    for named in [
        "style.css",
        "pic.png",
        "assets/pic@2x.png",
        "assets/styled.png",
        "logo.png",
    ] {
        assert!(site.serve(named).is_none(), "{named}");
    }
    assert_eq!(site.allowed_count(), 1);
    // Rewritten after Run: nothing.
    f.write("index.html", "<p>changed</p>");
    assert!(site.serve("index.html").is_none());
}

// Daybreak 168 (22 Nov 2026): a small page naming one allowed picture under
// thousands of query strings had each one read and sent in full.

#[cfg(unix)]
#[test]
fn query_spellings_of_one_file_are_capped() {
    let f = Folder::new();
    let refs: String = (0..2_000)
        .map(|i| format!("<img src=\"big.png?{i}\">"))
        .collect();
    f.write("index.html", &refs);
    f.write("big.png", "picture");
    let site = f.site();
    let mut served = 0;
    for i in 0..2_000 {
        if site
            .serve_asked(&format!("/big.png?{i}"), "/big.png")
            .is_some()
        {
            served += 1;
        }
    }
    assert_eq!(
        served, MAX_VARIANTS_PER_FILE,
        "only the first few spellings"
    );
    assert!(
        site.serve_asked("/big.png?0", "/big.png").is_some(),
        "a spelling already answered still is"
    );
    assert!(
        site.serve_asked("/index.html", "/index.html").is_some(),
        "the page itself is untouched"
    );
}

#[cfg(unix)]
#[test]
fn a_preview_has_a_request_budget() {
    let f = Folder::new();
    f.write("index.html", "<img src=pic.png>");
    let site = f.site();
    for _ in 0..MAX_REQUESTS - 2 {
        site.serve_asked("/nothing.png", "/nothing.png");
    }
    assert!(
        site.serve("/pic.png").is_some(),
        "the last request in budget"
    );
    assert!(site.serve("/pic.png").is_none(), "refused past it");
    assert!(site.serve("/index.html").is_none(), "the page too");
}

#[cfg(unix)]
#[test]
fn a_preview_has_a_byte_budget() {
    let f = Folder::new();
    let pics = MAX_SERVED_BYTES / MAX_BYTES + 2;
    let refs: String = (0..pics).map(|i| format!("<img src=p{i}.png>")).collect();
    f.write("index.html", &refs);
    let site = f.site();
    // Sparse files: 64 MB each on paper, nothing on disk.
    for i in 0..pics {
        let file = fs::File::create(f.dir.join(format!("p{i}.png"))).unwrap();
        file.set_len(MAX_BYTES).unwrap();
    }
    let mut served = 0u64;
    for i in 0..pics {
        if let Some(s) = site.serve(&format!("/p{i}.png")) {
            served += s.data.len() as u64;
        }
    }
    assert!(served <= MAX_SERVED_BYTES, "served {served}");
    assert!(served >= MAX_SERVED_BYTES - MAX_BYTES, "served {served}");
    assert!(site.serve(&format!("/p{}.png", pics - 1)).is_none());
}

#[cfg(unix)]
#[test]
fn an_unchanged_file_is_not_read_again() {
    let f = Folder::new();
    f.write("index.html", "<img src=pic.png?a><img src=pic.png?b>");
    f.write("pic.png", "first");
    let site = f.site();
    let a = site.serve_asked("/pic.png?a", "/pic.png").unwrap();
    let b = site.serve_asked("/pic.png?b", "/pic.png").unwrap();
    assert!(Arc::ptr_eq(&a.data, &b.data), "the same bytes, read once");
    // Rewritten in place (same inode): read again.
    std::thread::sleep(std::time::Duration::from_millis(5));
    f.write("pic.png", "second!");
    assert_eq!(
        &*site.serve_asked("/pic.png?a", "/pic.png").unwrap().data,
        b"second!"
    );
    // Replaced by a link: refused, cache or not.
    fs::remove_file(f.dir.join("pic.png")).unwrap();
    std::os::unix::fs::symlink(f.dir.join(".env"), f.dir.join("pic.png")).unwrap();
    assert!(site.serve_asked("/pic.png?a", "/pic.png").is_none());
}

#[cfg(unix)]
#[test]
fn an_ordinary_page_loads_whole() {
    let f = Folder::new();
    let site = f.site();
    for asked in [
        "/index.html",
        "/style.css?v=2",
        "/pic.png",
        "/assets/pic@2x.png",
        "/theme.css",
        "/assets/bg.png",
        "/assets/font.woff2",
        "/assets/styled.png",
    ] {
        let path = asked.split('?').next().unwrap();
        assert!(site.serve_asked(asked, path).is_some(), "{asked}");
    }
    // Reloaded a few times, and a video seeked: all still served.
    for _ in 0..20 {
        assert!(site.serve_asked("/pic.png", "/pic.png").is_some());
    }
}

/// Codex's review: on a disk that ignores case (a Mac's, by default) every
/// spelling of a name is the same file, and each got its own count and read.
#[cfg(unix)]
#[test]
fn spellings_are_counted_by_the_file_they_open() {
    let f = Folder::new();
    let names: Vec<String> = (0..64)
        .map(|i| {
            "bigpic"
                .chars()
                .enumerate()
                .map(|(k, c)| {
                    if i >> k & 1 == 1 {
                        c.to_ascii_uppercase()
                    } else {
                        c
                    }
                })
                .collect::<String>()
                + ".png"
        })
        .collect();
    let refs: String = names.iter().map(|n| format!("<img src={n}>")).collect();
    f.write("index.html", &refs);
    f.write("bigpic.png", "picture");
    let site = f.site();
    let ignores_case = f.dir.join("BIGPIC.png").exists();
    let served = names
        .iter()
        .filter(|n| site.serve(&format!("/{n}")).is_some())
        .count();
    if ignores_case {
        assert_eq!(
            served, MAX_VARIANTS_PER_FILE,
            "one file, however it's spelled"
        );
    } else {
        assert_eq!(served, 1, "only the one that exists");
    }
}

/// The byte budget counts what's charged from the open file before it's
/// read, the page's own bytes too.
#[cfg(unix)]
#[test]
fn the_byte_budget_is_charged_before_reading() {
    let f = Folder::new();
    let pics = MAX_SERVED_BYTES / MAX_BYTES;
    let refs: String = (0..pics).map(|i| format!("<img src=p{i}.png>")).collect();
    f.write("index.html", &refs);
    let site = f.site();
    for i in 0..pics {
        let file = fs::File::create(f.dir.join(format!("p{i}.png"))).unwrap();
        file.set_len(MAX_BYTES).unwrap();
    }
    for i in 0..pics - 1 {
        assert!(site.serve(&format!("/p{i}.png")).is_some());
    }
    // The page's own bytes took a little: the last whole picture doesn't fit.
    assert!(site.serve(&format!("/p{}.png", pics - 1)).is_none());
}

/// Gemini's review: the same stylesheet by another spelling, on a disk that
/// ignores case, still names its assets from the folder it was asked from.
#[cfg(unix)]
#[test]
fn a_stylesheet_by_another_spelling_still_names_its_assets() {
    let f = Folder::new();
    fs::create_dir_all(f.dir.join("sub")).unwrap();
    f.write(
        "index.html",
        r#"<link rel=stylesheet href="sub/look.css"><link rel=stylesheet href="SUB/look.css">"#,
    );
    f.write("sub/look.css", "body { background: url(bg.png) }");
    f.write("sub/bg.png", "x");
    let site = f.site();
    assert!(site.serve("/sub/look.css").is_some());
    if f.dir.join("SUB/look.css").exists() {
        assert!(site.serve("/SUB/look.css").is_some());
        assert!(site.allows("SUB/bg.png"));
    }
}

/// A request refused for the byte budget doesn't use up one of the file's
/// spellings.
#[cfg(unix)]
#[test]
fn a_refusal_uses_up_no_spelling() {
    let f = Folder::new();
    f.write("index.html", "<img src=pic.png>");
    f.write("pic.png", "x");
    let site = f.site();
    site.budget.lock().unwrap().bytes = MAX_SERVED_BYTES;
    for i in 0..20 {
        assert!(site
            .serve_asked(&format!("/pic.png?{i}"), "/pic.png")
            .is_none());
    }
    site.budget.lock().unwrap().bytes = 0;
    assert!(site.serve_asked("/pic.png?100", "/pic.png").is_some());
}

/// Gemini's review: making room lets the least recently used go, not
/// everything.
#[cfg(unix)]
#[test]
fn the_cache_lets_the_least_recently_used_go() {
    let f = Folder::new();
    let n = MAX_CACHED_BYTES / (64 * 1024 * 1024) + 1;
    let refs: String = (0..n).map(|i| format!("<img src=p{i}.png>")).collect();
    f.write("index.html", &refs);
    let site = f.site();
    for i in 0..n {
        let file = fs::File::create(f.dir.join(format!("p{i}.png"))).unwrap();
        file.set_len(64 * 1024 * 1024).unwrap();
    }
    let first: Vec<_> = (0..n)
        .map(|i| site.serve(&format!("/p{i}.png")).unwrap().data)
        .collect();
    // p0 went to make room for the last; the others are still the same bytes.
    for (i, data) in first.iter().enumerate().skip(1) {
        let again = site.serve(&format!("/p{i}.png")).unwrap().data;
        assert!(Arc::ptr_eq(data, &again), "p{i} kept");
    }
}

/// Gemini's review: a stylesheet asked for again and again is read for
/// names once, not every time.
#[cfg(unix)]
#[test]
fn a_file_asked_for_again_is_read_for_names_once() {
    let f = Folder::new();
    f.write("index.html", "<link rel=stylesheet href=look.css>");
    f.write("look.css", "body { background: url(bg.png) }");
    let site = f.site();
    for _ in 0..50 {
        assert!(site.serve("/look.css").is_some());
    }
    let facts = site.facts.lock().unwrap();
    let scans: usize = facts.values().map(|k| k.scanned.len()).sum();
    assert_eq!(scans, 2, "the page and the stylesheet, once each");
}
