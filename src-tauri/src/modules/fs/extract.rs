//! Binary-file text extraction for the AI `read_file` tool.
//!
//! PDF / DOCX stay in the JS frontend (pdf.js / mammoth). Here we add:
//!  - archives: zip/jar/apk/cbz/nupkg → entry listing + small text-file previews
//!  - audio: mp3/flac/m4a/ogg/wav → metadata card (tags, duration, bitrate)
//!  - images: png/jpg/webp/gif/tiff → dimensions + OCR when tesseract is available
//!
//! OCR runs through the system `tesseract` binary when available.

use std::io::{Cursor, Read};
use std::path::Path;

use super::ocr;

#[derive(serde::Serialize)]
pub struct ExtractMeta {
    /// Format label.
    pub format: String,
    /// Extra metadata (e.g. entries, dimensions).
    pub meta: Vec<(String, String)>,
    /// Extracted content or metadata text.
    pub content: String,
    /// Total bytes of the source file.
    pub size: u64,
}

/// Extract from a binary file path. Returns Ok(None) for kinds we don't handle.
pub fn extract(path: &Path) -> Result<Option<ExtractMeta>, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let kind = detect_by_ext(&ext).or_else(|| detect_by_magic(path));
    let Some(kind) = kind else {
        return Ok(None);
    };
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let size = bytes.len() as u64;
    match kind.as_str() {
        "archive" => archive(Cursor::new(bytes), size),
        "audio" => audio(path, size),
        "image" => image(path, ext.as_str(), size),
        other => Ok(Some(ExtractMeta {
            format: other.to_string().to_string().to_string(),
            meta: vec![],
            content: String::new(),
            size,
        })),
    }
}

fn detect_by_ext(ext: &str) -> Option<String> {
    let t = match ext {
        "zip" | "jar" | "apk" | "cbz" | "nupkg" => "archive",
        "mp3" | "flac" | "m4a" | "ogg" | "wav" => "audio",
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "tif" | "tiff" => "image",
        _ => return None,
    };
    Some(t.to_string())
}

/// Magic-byte fallback when the extension is missing or misleading.
fn detect_by_magic(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 12];
    if f.read_exact(&mut buf).is_err() {
        return None;
    }
    if buf.starts_with(b"PK\x03\x04") || buf.starts_with(b"PK\x05\x06") {
        return Some("archive".to_string());
    }
    if buf[..4].starts_with(b"RIFF") && buf[8..12] == *b"WAVE" {
        return Some("audio".to_string());
    }
    if buf.starts_with(b"ID3")
        || buf.starts_with(b"\xff\xfb")
        || buf.starts_with(b"fLaC")
        || buf.starts_with(b"OggS")
    {
        return Some("audio".to_string());
    }
    if buf[4..8] == *b"ftyp" {
        return Some("image".to_string());
    }
    None
}

fn archive(cursor: Cursor<Vec<u8>>, size: u64) -> Result<Option<ExtractMeta>, String> {
    let mut z = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    let meta = vec![("entries".to_string(), z.len().to_string())];
    let mut content = String::new();
    for i in 0..z.len() {
        let name = z
            .by_index(i)
            .ok()
            .map(|f| f.name().to_string())
            .unwrap_or_else(|| "?".to_string());
        let sz = z.by_index(i).ok().map(|f| f.size()).unwrap_or(0);
        content.push_str(&format!("\n--- {} ({})\n", name, sz));
        if looks_texty(&name) && sz > 0 && sz <= 8192_u64 {
            if let Ok(fd) = z.by_index(i) {
                let mut fdf = fd;
                let mut buf = vec![0u8; 8192];
                if let Ok(n) = fdf.read(&mut buf) {
                    if let Ok(text) = std::str::from_utf8(&buf[..n]) {
                        content.push_str(text);
                        content.push('\n');
                    }
                }
            }
        }
        if content.len() > 64 * 1024 {
            content.push_str("\n… truncated");
            break;
        }
    }
    Ok(Some(ExtractMeta {
        format: "archive".to_string(),
        meta,
        content,
        size,
    }))
}

fn looks_texty(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".txt")
        || n.ends_with(".md")
        || n.ends_with(".json")
        || n.ends_with(".xml")
        || n.ends_with(".yaml")
        || n.ends_with(".yml")
        || n.ends_with(".csv")
        || n.ends_with(".html")
        || n.ends_with(".py")
        || n.ends_with(".js")
        || n.ends_with(".ts")
        || n.ends_with(".rs")
        || n.ends_with(".c")
        || n.ends_with(".h")
        || n.ends_with(".cpp")
        || n.ends_with(".css")
}

fn audio(path: &Path, size: u64) -> Result<Option<ExtractMeta>, String> {
    use lofty::file::{AudioFile, TaggedFileExt};
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let meta: Vec<(String, String)> = Vec::new();
    let mut content = String::new();
    for tag in tagged.tags() {
        for item in tag.items() {
            content.push_str(&format!(
                "\n{:?}: {}",
                item.key(),
                item.value().text().unwrap_or_default()
            ));
            if content.len() > 32 * 1024 {
                content.push_str("\n… truncated");
                break;
            }
        }
    }
    let dur = tagged.properties().duration();
    if let Some(br) = tagged.properties().audio_bitrate() {
        content.push_str(&format!("\nbitrate: {} kbps", br));
    }
    content.push_str(&format!("\nduration: {}s", dur.as_secs()));
    Ok(Some(ExtractMeta {
        format: "audio".to_string(),
        meta,
        content,
        size,
    }))
}

fn image(path: &Path, _ext: &str, size: u64) -> Result<Option<ExtractMeta>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut meta: Vec<(String, String)> = Vec::new();
    let mut content = String::new();
    if let Ok(img) = image::load_from_memory(&bytes) {
        meta.push(("width".to_string(), img.width().to_string()));
        meta.push(("height".to_string(), img.height().to_string()));
        content.push_str(&format!(
            "\nwidth: {}\nheight: {}",
            img.width(),
            img.height()
        ));
    }
    if let Ok(text) = ocr::get_ocr_text(&bytes) {
        if !text.is_empty() {
            content.push_str(&format!("\nOCR text:\n{}", text));
        }
    }
    Ok(Some(ExtractMeta {
        format: "image".to_string(),
        meta,
        content,
        size,
    }))
}
