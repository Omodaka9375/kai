//! Screen capture for the `look_at_screen` agent tool.
//!
//! Pure reads: list monitors, capture one monitor to a JPEG in the temp dir.
//! The frontend never receives raw pixels over IPC — it gets the file path +
//! metadata, reads it via `fs_read_file_bytes` when a vision model needs it,
//! and the temp file is owned by the tool (deleted after the model round-trip
//! in the frontend tool executor).
//!
//! Multi-display semantics ("left/right screen") are resolved HERE, not in
//! the model: monitors are ordered by virtual-desktop X coordinate, so
//! "left" = smallest x, "right" = largest x. With a single monitor every
//! selector resolves to it.

use serde::Serialize;
use xcap::Monitor;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// Stable selector for this session: "0", "1", ... (index in x-order).
    pub id: String,
    /// Human-readable monitor name (manufacturer/model or "Display 1").
    pub name: String,
    pub is_primary: bool,
    /// Position + size on the virtual desktop, in logical points.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCapture {
    /// Absolute path to the JPEG (forward slashes).
    pub path: String,
    pub monitor: MonitorInfo,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
}

fn monitor_infos() -> Result<Vec<(Monitor, MonitorInfo)>, String> {
    let monitors =
        Monitor::all().map_err(|e| format!("failed to enumerate monitors: {e}"))?;
    let mut pairs: Vec<(Monitor, MonitorInfo)> = Vec::new();
    for m in monitors {
        let x = m.x().map_err(|e| format!("monitor x: {e}"))?;
        let y = m.y().map_err(|e| format!("monitor y: {e}"))?;
        let w = m.width().map_err(|e| format!("monitor width: {e}"))?;
        let h = m.height().map_err(|e| format!("monitor height: {e}"))?;
        let name = m.friendly_name().unwrap_or_else(|_| "Display".to_string());
        let is_primary = m.is_primary().unwrap_or(false);
        pairs.push((
            m,
            MonitorInfo {
                id: String::new(), // assigned after sort
                name,
                is_primary,
                x,
                y,
                width: w,
                height: h,
            },
        ));
    }
    // Order by virtual-desktop position: leftmost first. This IS the "left /
    // right" semantic. Y breaks ties for vertically stacked displays.
    pairs.sort_by_key(|(_, i)| (i.x, i.y));
    for (i, (_, info)) in pairs.iter_mut().enumerate() {
        info.id = i.to_string();
    }
    Ok(pairs)
}

#[tauri::command]
pub fn screen_list_monitors() -> Result<Vec<MonitorInfo>, String> {
    Ok(monitor_infos()?.into_iter().map(|(_, info)| info).collect())
}

/// Resolve a user/model-facing selector against the x-ordered monitor list.
/// "left"/"right" are positional; a numeric id is the index; anything that
/// fuzzy-matches a monitor name (case-insensitive substring) wins last.
fn resolve_monitor<'a>(
    pairs: &'a [(Monitor, MonitorInfo)],
    selector: Option<&str>,
) -> Result<(&'a Monitor, &'a MonitorInfo), String> {
    let Some(sel) = selector.filter(|s| !s.is_empty()) else {
        // Default: the primary monitor; first one if nothing is flagged.
        let (m, i) = pairs
            .iter()
            .find(|(_, i)| i.is_primary)
            .or_else(|| pairs.first())
            .ok_or("no monitors found")?;
        return Ok((m, i));
    };
    let s = sel.trim().to_lowercase();
    match s.as_str() {
        "primary" | "main" => {
            let (m, i) = pairs
                .iter()
                .find(|(_, i)| i.is_primary)
                .ok_or("no primary monitor found")?;
            return Ok((m, i));
        }
        "left" | "leftmost" | "first" => {
            let (m, i) = pairs
                .first()
                .ok_or_else(|| "no monitors found".to_string())?;
            return Ok((m, i));
        }
        "right" | "rightmost" | "last" => {
            let (m, i) = pairs
                .last()
                .ok_or_else(|| "no monitors found".to_string())?;
            return Ok((m, i));
        }
        "all" => {
            return Err(
                "\"all\" captures every display — call screen_capture once per \
                 display id instead (screens are analyzed separately)."
                    .to_string(),
            );
        }
        _ => {}
    }
    // Numeric index.
    if let Ok(idx) = s.parse::<usize>() {
        let (m, i) = pairs
            .get(idx)
            .ok_or_else(|| format!("no monitor with index {idx} (found {})", pairs.len()))?;
        return Ok((m, i));
    }
    // Name substring, case-insensitive (e.g. "dell", "HDMI-1").
    if let Some((m, i)) = pairs
        .iter()
        .find(|(_, i)| i.name.to_lowercase().contains(&s))
    {
        return Ok((m, i));
    }
    let ids = pairs
        .iter()
        .map(|(_, i)| format!("\"{}\" ({})", i.name, i.id))
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "no monitor matches \"{sel}\". Available: {ids}. Also valid: primary/left/right or a numeric index."
    ))
}

#[tauri::command]
pub fn screen_capture(selector: Option<String>) -> Result<ScreenCapture, String> {
    let pairs = monitor_infos()?;
    let (monitor, info) = resolve_monitor(&pairs, selector.as_deref())?;

    let image = monitor
        .capture_image()
        .map_err(|e| format!("screen capture failed: {e}"))?;
    // xcap yields RGBA8; JPEG has no alpha channel — flatten to RGB8 first
    // (the encoder rejects Rgba8 with UnsupportedError).
    let rgb = image::DynamicImage::ImageRgba8(image).to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());

    // JPEG: screenshots compress extremely well and the payload goes to a
    // vision model / base64; PNG of a 4K desktop is 5-10 MB, JPEG is ~300 KB.
    let mut buf = std::io::Cursor::new(Vec::new());
    rgb.write_to(&mut buf, image::ImageFormat::Jpeg)
        .map_err(|e| format!("failed to encode screenshot as JPEG: {e}"))?;
    let bytes = buf.into_inner();

    // All-black frame heuristic: macOS TCC denial (or a locked session)
    // produces a valid but empty capture — surface it instead of letting the
    // model analyze a black rectangle.
    let black = bytes
        .windows(64)
        .step_by(1024)
        .take(32)
        .all(|w| w.iter().all(|&b| b < 8));
    if black {
        return Err(
            "capture looks empty (all black). If on macOS: grant Screen \
             Recording permission to this app in System Settings → Privacy & \
             Security, then retry. A locked/logged-out session also captures black."
                .to_string(),
        );
    }

    let dir = std::env::temp_dir().join("kai-screens");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create capture dir: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("screen-{}-{}.jpg", info.id, stamp));
    std::fs::write(&path, &bytes).map_err(|e| format!("failed to write screenshot: {e}"))?;

    let path_str = path.to_string_lossy().replace('\\', "/");
    Ok(ScreenCapture {
        path: path_str,
        monitor: MonitorInfo {
            id: info.id.clone(),
            name: info.name.clone(),
            is_primary: info.is_primary,
            x: info.x,
            y: info.y,
            width: info.width,
            height: info.height,
        },
        width: w,
        height: h,
        size_bytes: bytes.len() as u64,
    })
}

/// Sweep capture temps older than one hour (crash leftovers). Called once at
/// startup — the tool deletes its own files after use in the happy path.
pub fn sweep_stale_screens() {
    let dir = std::env::temp_dir().join("kai-screens");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if let Ok(modified) = meta.modified() {
            if modified < cutoff {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
