use xcap::Monitor;

#[test]
fn live_capture_smoke() {
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
    let primary = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .expect("a monitor");
    let img = primary.capture_image().expect("capture");
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    println!(
        "captured {}x{} -> encoding jpeg",
        rgb.width(),
        rgb.height()
    );
    let mut buf = std::io::Cursor::new(Vec::new());
    rgb.write_to(&mut buf, image::ImageFormat::Jpeg)
        .expect("encode jpeg");
    let bytes = buf.into_inner();
    println!("jpeg bytes: {}", bytes.len());
    assert!(bytes.len() > 10_000, "suspiciously small capture");
    assert!(
        bytes.len() < 4 * 1024 * 1024,
        "suspiciously large jpeg"
    );
}
