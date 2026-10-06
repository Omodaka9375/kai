//! Live capture smoke test. Requires a real display — SKIPS on headless
//! machines (CI runners, SSH sessions) so `cargo test` never fails there.
//! Run locally with: cargo test --test screen_smoke -- --nocapture

use xcap::Monitor;

fn headless() -> bool {
    // No DISPLAY on Linux, no SSH_SESSION on macOS — good-enough heuristics.
    std::env::var("DISPLAY").is_err() && std::env::var("SSH_SESSION").is_ok()
        || std::env::var("CI").is_ok_and(|v| v == "true")
}

#[test]
fn live_capture_smoke() {
    if headless() {
        eprintln!("skipping: headless environment (no display)");
        return;
    }
    let monitors = Monitor::all().expect("enumerate");
    println!("monitors: {}", monitors.len());
    for m in &monitors {
        println!(
            "  {:?} x={} y={} {}x{} primary={}",
            m.friendly_name(),
            m.x().unwrap_or(0),
            m.y().unwrap_or(0),
            m.width().unwrap_or(0),
            m.height().unwrap_or(0),
            m.is_primary().unwrap_or(false)
        );
    }
    assert!(!monitors.is_empty(), "expected at least one monitor");

    let primary = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .expect("a monitor");
    let img = primary.capture_image().expect("capture");
    // xcap yields RGBA8; JPEG has no alpha — flatten (same as production code).
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    println!("captured {}x{} -> encoding jpeg", rgb.width(), rgb.height());
    let mut buf = std::io::Cursor::new(Vec::new());
    rgb.write_to(&mut buf, image::ImageFormat::Jpeg)
        .expect("encode jpeg");
    let bytes = buf.into_inner();
    println!("jpeg bytes: {}", bytes.len());
    assert!(bytes.len() > 10_000, "suspiciously small capture");
    assert!(bytes.len() < 4 * 1024 * 1024, "suspiciously large jpeg");
}
