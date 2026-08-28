//! OCR. Returns text when a recognizer is available; error otherwise.
//!
//! The recognizer pipeline is:
//! 1. `tesseract` CLI from PATH (portable, all OSes, no deps).
//! 2. Windows-native PowerShell `Get-WinRT File` Invoking OCR via the WinRT
//!    API over ctypes would be far heavier; tesseract covers the same image
//!    formats natively. Path lookup first is enough because the user already
//!    has it installed across machines with built-in OCR needs.

use std::process::Command;

/// Extract visible text from image bytes (PNG/JPG/etc.).
/// Returns Err when OCR is unavailable.
pub fn get_ocr_text(bytes: &[u8]) -> Result<String, String> {
    // Unique temp paths so concurrent OCR calls never race on the same files.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let unique = format!("kai-ocr-{}-{}", std::process::id(), stamp);
    let input = std::env::temp_dir().join(format!("{unique}.bin"));
    // tesseract syntax is `tesseract <input> <output-stem>` — it writes
    // `<output-stem>.txt` itself. We must NOT pass the .txt path as an arg
    // (passing it made tesseract treat it as a stray config filename and
    // never write the file).
    let output_stem = std::env::temp_dir().join(&unique);
    std::fs::write(&input, bytes).map_err(|e| e.to_string())?;
    let exe = find_tesseract()?;
    let result = Command::new(exe)
        .arg(&input)
        .arg(&output_stem)
        .arg("-l")
        .arg("eng")
        .output()
        .map_err(|e| e.to_string());

    // Best-effort cleanup regardless of outcome.
    let text_path = output_stem.with_extension("txt");
    let text = result.and_then(|output| {
        if !output.status.success() {
            return Err("tesseract exited non-zero".to_string());
        }
        std::fs::read_to_string(&text_path)
            .map_err(|e| format!("failed to read OCR output: {e}"))
    });
    std::fs::remove_file(&input).ok();
    std::fs::remove_file(&text_path).ok();
    text
}

fn find_tesseract() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "windows")]
    let candidates = [r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"];
    #[cfg(target_os = "macos")]
    let candidates = ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"];
    #[cfg(target_os = "linux")]
    let candidates = ["/usr/bin/tesseract", "/usr/local/bin/tesseract"];
    for c in candidates {
        let p = std::path::Path::new(c);
        if p.exists() {
            return Ok(p.to_path_buf());
        }
    }
    Err("tesseract not found".to_string())
}