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
    let tmp = std::env::temp_dir().join("kai-ocr-input.bin");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let tmp_out = std::env::temp_dir().join("kai-ocr-output.txt");
    let exe = find_tesseract()?;
    let output = Command::new(exe)
        .arg(&tmp)
        .arg(&tmp)
        .arg(&tmp_out)
        .arg("-l")
        .arg("eng")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("tesseract exited non-zero".to_string());
    }
    let text = std::fs::read_to_string(&tmp_out).map_err(|e| e.to_string())?;
    std::fs::remove_file(&tmp).ok();
    std::fs::remove_file(&tmp_out).ok();
    Ok(text)
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
