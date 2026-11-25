use std::io::Write;

use serde::Serialize;
use tauri::{Emitter, Manager};

use super::extract;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// Emit `fs-changed` so open editor tabs can reload (or warn) when a file
/// they display changed on disk. Fire-and-forget — listeners are best
/// effort and must never fail the write itself. Path is normalized to
/// forward slashes to match the frontend canonical form.
fn emit_fs_changed(path: &std::path::Path) {
    let Some(app) = fs_changed_app_handle() else {
        return;
    };
    let _ = app.emit(
        "fs-changed",
        serde_json::json!({ "path": path.to_string_lossy().replace('\\', "/") }),
    );
}

/// Process-global handle set once in `Builder::setup` — lets sync fs commands
/// emit events without threading `AppHandle` through every signature.
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn set_fs_changed_app_handle(app: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app);
}

fn fs_changed_app_handle() -> Option<tauri::AppHandle> {
    APP_HANDLE.get().cloned()
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadResult {
    Text {
        content: String,
        size: u64,
        /// Extraction format for handled binary kinds (archive/audio/image).
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<String>,
    },
    Binary {
        size: u64,
    },
    /// File exceeds MAX_READ_BYTES. UI decides whether to offer "open anyway".
    TooLarge {
        size: u64,
        limit: u64,
    },
}

#[tauri::command]
/// `extract: Some(true)` opts in to binary extraction (archive listing /
/// audio metadata / image dimensions + OCR). Only the AI `read_file` tool
/// passes it; the editor omits the param so images come back as `Binary`
/// and render as a preview instead of an OCR/metadata text card.
pub fn fs_read_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    extract: Option<bool>,
) -> Result<ReadResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let meta = std::fs::metadata(&p).map_err(|e| {
        log::debug!("fs_read_file stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    // Handle extractable binary formats (archive/audio/image) before the
    // generic size/binary sniff. `extract::extract` returns Ok(None) for
    // unrecognized kinds and the sniff runs as before.
    if extract == Some(true) {
        if let Ok(Some(ex)) = extract::extract(&p) {
            return Ok(ReadResult::Text {
                content: ex.content,
                size: meta.len(),
                format: Some(ex.format),
            });
        }
    }

    let size = meta.len();
    if size > MAX_READ_BYTES {
        return Ok(ReadResult::TooLarge {
            size,
            limit: MAX_READ_BYTES,
        });
    }

    let bytes = std::fs::read(&p).map_err(|e| {
        log::debug!("fs_read_file read({}) failed: {e}", p.display());
        e.to_string()
    })?;

    // UTF-16 BOM detection: transcode to UTF-8 before the null-byte check.
    // Windows tools (PowerShell ISE, Notepad) default to UTF-16 LE for .ps1
    // and .txt files, which would otherwise be rejected as binary.
    if bytes.len() >= 2 {
        if bytes[0] == 0xFF && bytes[1] == 0xFE {
            // UTF-16 LE
            let words: Vec<u16> = bytes[2..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            return match String::from_utf16(&words) {
                Ok(content) => Ok(ReadResult::Text {
                    content,
                    size,
                    format: None,
                }),
                Err(_) => Ok(ReadResult::Binary { size }),
            };
        }
        if bytes[0] == 0xFE && bytes[1] == 0xFF {
            // UTF-16 BE
            let words: Vec<u16> = bytes[2..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_be_bytes(*c))
                .collect();
            return match String::from_utf16(&words) {
                Ok(content) => Ok(ReadResult::Text {
                    content,
                    size,
                    format: None,
                }),
                Err(_) => Ok(ReadResult::Binary { size }),
            };
        }
    }

    // Null-byte sniff on the first chunk — catches binary files cheaply.
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0) {
        return Ok(ReadResult::Binary { size });
    }

    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadResult::Text {
            content,
            size,
            format: None,
        }),
        Err(_) => Ok(ReadResult::Binary { size }),
    }
}

/// Atomic write: stage into a sibling temp file, then rename over the target.
/// Prevents partial writes from leaving a half-saved file on crash/power loss.
#[tauri::command]
pub fn fs_write_file(
    path: String,
    content: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_path(&path, &workspace);
    let parent = target
        .parent()
        .ok_or_else(|| "path has no parent".to_string())?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "path has no file name".to_string())?;

    let tmp = parent.join(format!(".{file_name}.KAI.tmp"));

    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| {
            log::debug!("fs_write_file create({}) failed: {e}", tmp.display());
            e.to_string()
        })?;
        f.write_all(content.as_bytes()).map_err(|e| {
            log::debug!("fs_write_file write({}) failed: {e}", tmp.display());
            e.to_string()
        })?;
        f.sync_all().map_err(|e| e.to_string())?;
    }

    std::fs::rename(&tmp, &target).map_err(|e| {
        log::warn!(
            "fs_write_file rename({} -> {}) failed: {e}",
            tmp.display(),
            target.display()
        );
        // Best-effort cleanup of the staged temp.
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;

    emit_fs_changed(&target);

    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceExactResult {
    pub replacements: usize,
    pub bytes_written: usize,
}

/// Count non-overlapping literal byte matches, retaining at most `keep`
/// offsets. KMP avoids quadratic behavior on large files/repetitive needles.
fn exact_byte_matches(haystack: &[u8], needle: &[u8], keep: usize) -> (usize, Vec<usize>) {
    let mut prefix = vec![0usize; needle.len()];
    let mut matched = 0usize;
    for i in 1..needle.len() {
        while matched > 0 && needle[i] != needle[matched] {
            matched = prefix[matched - 1];
        }
        if needle[i] == needle[matched] {
            matched += 1;
        }
        prefix[i] = matched;
    }

    let mut count = 0usize;
    let mut offsets = Vec::new();
    let mut i = 0usize;
    let mut j = 0usize;
    while i < haystack.len() {
        while j > 0 && haystack[i] != needle[j] {
            j = prefix[j - 1];
        }
        if haystack[i] == needle[j] {
            j += 1;
        }
        if j == needle.len() {
            let start = i + 1 - needle.len();
            count += 1;
            if offsets.len() < keep {
                offsets.push(start);
            }
            // Non-overlapping occurrence semantics, matching String.indexOf.
            j = 0;
        }
        i += 1;
    }
    (count, offsets)
}

fn replace_exact_bytes(
    original: &[u8],
    old_string: &str,
    new_string: &str,
    expected_occurrences: usize,
) -> Result<(Vec<u8>, usize), String> {
    if old_string.is_empty() {
        return Err("old_string cannot be empty".into());
    }
    if old_string == new_string {
        return Err("old_string and new_string are identical; nothing to change".into());
    }
    if !(1..=1000).contains(&expected_occurrences) {
        return Err("expected_occurrences must be between 1 and 1000".into());
    }
    // This is deliberately a UTF-8 TEXT recovery tool, not a binary editor.
    // Validate the complete file, not just a sniff window, and reject NULs.
    if std::str::from_utf8(original).is_err() || original.contains(&0) {
        return Err("replace_exact requires a valid UTF-8 text file without NUL bytes".into());
    }

    // `read_file` strips a leading UTF-8 BOM for display. Preserve the raw
    // BOM but exclude it from the needle domain so an anchor copied from
    // that view can still replace the file's first bytes. An explicit BOM
    // remains matchable at offset 0 via the fallback domain.
    let bom_len = usize::from(original.starts_with(b"\xEF\xBB\xBF")) * 3;
    let explicit_bom = old_string.starts_with('\u{FEFF}');
    let (old, new, offsets, count) = if bom_len > 0 && !explicit_bom {
        let (count, mut offsets) = exact_byte_matches(
            &original[bom_len..],
            old_string.as_bytes(),
            usize::MAX,
        );
        for offset in &mut offsets {
            *offset += bom_len;
        }
        (old_string.as_bytes(), new_string.as_bytes(), offsets, count)
    } else {
        let (count, offsets) = exact_byte_matches(original, old_string.as_bytes(), usize::MAX);
        (old_string.as_bytes(), new_string.as_bytes(), offsets, count)
    };
    if count != expected_occurrences {
        let locations = if offsets.is_empty() {
            String::new()
        } else {
            format!(
                " (byte offsets: {})",
                offsets
                    .iter()
                    .map(usize::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        return Err(format!(
            "old_string matched {count} exact UTF-8 byte occurrence(s){locations}; expected {expected_occurrences}. Nothing was changed."
        ));
    }

    let mut replaced = Vec::with_capacity(
        original
            .len()
            .saturating_add(new.len().saturating_sub(old.len()).saturating_mul(count)),
    );
    let mut cursor = 0usize;
    for offset in offsets {
        replaced.extend_from_slice(&original[cursor..offset]);
        replaced.extend_from_slice(new);
        cursor = offset + old.len();
    }
    replaced.extend_from_slice(&original[cursor..]);
    Ok((replaced, count))
}

/// Recovery-only literal replacement for UTF-8 text. No EOL/whitespace
/// normalization happens: every byte outside the exact match is preserved.
#[tauri::command]
pub fn fs_replace_exact(
    path: String,
    old_string: String,
    new_string: String,
    expected_occurrences: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<ReplaceExactResult, String> {
    let env = WorkspaceEnv::from_option(workspace.clone());
    let target = resolve_path(&path, &env);
    let size = std::fs::metadata(&target)
        .map_err(|e| e.to_string())?
        .len();
    if size > MAX_READ_BYTES {
        return Err(format!(
            "file too large ({size} bytes, limit {MAX_READ_BYTES})"
        ));
    }
    let original = std::fs::read(&target).map_err(|e| e.to_string())?;
    let (replaced, replacements) = replace_exact_bytes(
        &original,
        &old_string,
        &new_string,
        expected_occurrences.unwrap_or(1),
    )?;
    let bytes_written = replaced.len();
    fs_write_file_bytes(path, replaced, workspace)?;
    Ok(ReplaceExactResult {
        replacements,
        bytes_written,
    })
}

#[cfg(test)]
mod replace_exact_tests {
    use super::replace_exact_bytes;

    #[test]
    fn preserves_bom_mixed_eols_trailing_whitespace_and_eof_state() {
        let original = b"\xEF\xBB\xBFfirst\r\n  keep  \nthird \xE2\x80\x94 dash\r\nlast";
        let (out, count) = replace_exact_bytes(original, "keep", "KEPT", 1).unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            out,
            b"\xEF\xBB\xBFfirst\r\n  KEPT  \nthird \xE2\x80\x94 dash\r\nlast"
        );
    }

    #[test]
    fn display_view_anchors_match_bom_prefixed_files() {
        let original = b"\xEF\xBB\xBFfirst\r\n";
        let (out, count) = replace_exact_bytes(original, "first", "FIRST", 1).unwrap();
        assert_eq!(count, 1);
        assert_eq!(out, b"\xEF\xBB\xBFFIRST\r\n");

        // An explicit BOM is still a literal needle at byte offset zero.
        let (out, count) = replace_exact_bytes(original, "\u{FEFF}first", "FIRST", 1).unwrap();
        assert_eq!(count, 1);
        assert_eq!(out, b"FIRST\r\n");
    }

    #[test]
    fn never_relaxes_punctuation_or_line_endings() {
        let original = b"a \xE2\x80\x94 b\r\n";
        assert!(replace_exact_bytes(original, "a - b\n", "x", 1).is_err());
        assert_eq!(original, b"a \xE2\x80\x94 b\r\n");
    }

    #[test]
    fn enforces_the_exact_occurrence_count() {
        let err = replace_exact_bytes(b"x x", "x", "y", 1).unwrap_err();
        assert!(err.contains("matched 2"), "{err}");
        assert!(err.contains("byte offsets: 0, 2"), "{err}");
        let (out, count) = replace_exact_bytes(b"x x", "x", "y", 2).unwrap();
        assert_eq!(count, 2);
        assert_eq!(out, b"y y");
    }

    #[test]
    fn uses_non_overlapping_matches() {
        let err = replace_exact_bytes(b"aaaa", "aa", "b", 4).unwrap_err();
        assert!(err.contains("matched 2"), "{err}");
        assert!(err.contains("byte offsets: 0, 2"), "{err}");
        let (out, count) = replace_exact_bytes(b"aaaa", "aa", "b", 2).unwrap();
        assert_eq!(count, 2);
        assert_eq!(out, b"bb");
    }

    #[test]
    fn rejects_binary_noops_and_bad_counts() {
        assert!(replace_exact_bytes(&[0xFF, 0xFE], "x", "y", 1).is_err());
        assert!(replace_exact_bytes(b"a\0b", "a", "y", 1).is_err());
        assert!(replace_exact_bytes(b"same", "same", "same", 1).is_err());
        assert!(replace_exact_bytes(b"x", "x", "y", 0).is_err());
    }

    // NOTE: no Rust unit test may call the `#[tauri::command]` wrappers
    // (fs_replace_exact included). A #[test] fn is a linker root even under
    // #[ignore], and one command call roots emit_fs_changed → tauri
    // AppHandle::emit → the whole tauri/tao/muda runtime. The lib test
    // binary gets no SxS manifest, so comctl32 v6 entrypoints
    // (TaskDialogIndirect) fail to resolve and the exe dies at load with
    // STATUS_ENTRYPOINT_NOT_FOUND — killing EVERY cargo test on Windows.
    // The matcher logic is covered by the pure tests below; the command
    // wrapper (metadata/size guard/read/write/emit) is covered end-to-end
    // by replaceExact.test.ts against the native client.
}

#[tauri::command]
pub fn fs_canonicalize(path: String, workspace: Option<WorkspaceEnv>) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let canon = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
    // Strip the Windows extended-length prefixes so the frontend's path
    // comparator sees the same form regardless of OS. `\\?\UNC\` (network
    // paths, incl. WSL mounts) becomes `\\`; `\\?\` (long local paths) is
    // removed entirely. Mirror git/utils.rs canonical_dir.
    let s = canon.to_string_lossy().to_string();
    let s = s
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| s.strip_prefix(r"\\?\").map(String::from))
        .unwrap_or(s);
    Ok(s.replace('\\', "/"))
}

/// Read raw file bytes — used by the document parser (PDF, DOCX) in the frontend.
/// Returns bytes as a Vec<u8> (serialized as JSON array of numbers).
#[tauri::command]
pub fn fs_read_file_bytes(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<u8>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "file too large ({} bytes, limit {})",
            meta.len(),
            MAX_READ_BYTES
        ));
    }
    std::fs::read(&p).map_err(|e| e.to_string())
}

/// Read CHANGELOG.md for the updater popup.
/// CHANGELOG.md for the updater dialog's release-notes fallback.
///
/// Resolution order (2.0.0 regression: installed apps rendered NO changelog
/// because the release `latest.json` carried an empty `notes` field AND this
/// loader only tried the CWD / exe directory, where no bundled copy exists):
///
/// 1. BUNDLED RESOURCE (tauri.conf.json `bundle.resources`) via the Tauri
///    resource dir - the only path that exists in an INSTALLED app
///    (Contents/Resources on macOS, exe dir on Windows, /usr/lib/<bundle>
///    on Linux).
/// 2. Working directory - dev mode (repo root).
/// 3. Executable directory - legacy layouts.
#[tauri::command]
pub fn fs_read_changelog() -> Result<String, String> {
    // 1. Bundled resource through the process-global handle (set in
    //    Builder::setup; in unit-test contexts it is unset and we fall
    //    through to the CWD).
    if let Some(app) = fs_changed_app_handle() {
        if let Ok(resource) = app
            .path()
            .resolve("CHANGELOG.md", tauri::path::BaseDirectory::Resource)
        {
            if let Ok(content) = std::fs::read_to_string(&resource) {
                return Ok(content);
            }
        }
    }
    // 2. Working directory (dev mode - repo root).
    if let Ok(content) = std::fs::read_to_string("CHANGELOG.md") {
        return Ok(content);
    }
    // 3. Executable directory (legacy).
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let asset = exe.parent().map(|p| p.join("CHANGELOG.md"));
    if let Some(p) = asset {
        std::fs::read_to_string(p).map_err(|e| e.to_string())
    } else {
        Err("".to_string())
    }
}

// Write raw binary bytes — used by the document generator in the frontend.
#[tauri::command]
pub fn fs_write_file_bytes(
    path: String,
    bytes: Vec<u8>,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_path(&path, &workspace);
    let parent = target
        .parent()
        .ok_or_else(|| "path has no parent".to_string())?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "path has no file name".to_string())?;

    let tmp = parent.join(format!(".{file_name}.KAI.tmp"));

    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| {
            log::debug!("fs_write_file_bytes create({}) failed: {e}", tmp.display());
            e.to_string()
        })?;
        f.write_all(&bytes).map_err(|e| {
            log::debug!("fs_write_file_bytes write({}) failed: {e}", tmp.display());
            e.to_string()
        })?;
        f.sync_all().map_err(|e| e.to_string())?;
    }

    std::fs::rename(&tmp, &target).map_err(|e| {
        log::warn!(
            "fs_write_file_bytes rename({} -> {}) failed: {e}",
            tmp.display(),
            target.display()
        );
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;

    emit_fs_changed(&target);

    Ok(())
}

// ── HTML → PDF via headless Edge/Chrome (emoji-capable renderer) ───────

/// Locate a Chromium-family browser able to `--print-to-pdf`.
///
/// EMOJI FIX (2026-11-17 user report): the jsPDF renderer maps emoji to the
/// wrong glyphs because its Standard-14 fonts (helvetica/courier) carry no
/// emoji coverage AT ALL and cannot embed any. A real browser rasterizes
/// with the OS font stack (Windows: Segoe UI Emoji) and embeds those glyphs
/// into the PDF as vectors, so the result renders in every PDF viewer.
/// Edge is the primary target — it ships with Windows.
fn find_chromium_browser() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for env_key in ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"] {
            if let Some(root) = std::env::var_os(env_key) {
                candidates.push(
                    std::path::PathBuf::from(root)
                        .join("Microsoft")
                        .join("Edge")
                        .join("Application")
                        .join("msedge.exe"),
                );
            }
        }
        candidates.push(
            std::path::Path::new(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe").into(),
        );
        candidates.push(
            std::path::Path::new(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
                .into(),
        );
        for env_key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(env_key) {
                candidates.push(
                    std::path::PathBuf::from(root)
                        .join("Google")
                        .join("Chrome")
                        .join("Application")
                        .join("chrome.exe"),
                );
            }
        }
        // PATH lookup last — covers winget/choco layouts.
        candidates.extend(which_on_path(&["msedge.exe", "chrome.exe", "chromium.exe"]));
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into(),
        );
        candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into());
        candidates.push("/Applications/Chromium.app/Contents/MacOS/Chromium".into());
        candidates.extend(which_on_path(&["microsoft-edge", "chrome", "chromium"]));
    }
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "windows")))]
    {
        candidates.extend(which_on_path(&[
            "microsoft-edge",
            "microsoft-edge-stable",
            "chrome",
            "chromium",
            "chromium-browser",
        ]));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Resolve bare executables through PATH without pulling a `which` crate.
fn which_on_path(names: &[&str]) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let Some(path) = std::env::var_os("PATH") else {
        return out;
    };
    for dir in std::env::split_paths(&path) {
        for name in names {
            let cand = dir.join(name);
            if cand.is_file() {
                out.push(cand);
            }
        }
    }
    out
}

fn file_url(p: &std::path::Path) -> String {
    let s = p.display().to_string();
    #[cfg(target_os = "windows")]
    {
        let s = s.replace('\\', "/");
        // file:///C:/dir/x.html — the absolute-path form browsers accept.
        format!("file:///{s}")
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("file://{s}")
    }
}

/// Render an HTML string to a PDF using a headless Chromium-family browser.
///
/// `html_content` is written to a private temp file (never the user's
/// project), the browser prints it to a temp PDF, and the PDF is moved to
/// `target_path` (parent dirs created). The temp profile dir isolates the
/// headless run from any running browser instance (Edge refuses
/// --print-to-pdf when it has to join an existing profile).
///
/// Err on EVERY failure mode (no browser, timeout, empty/short output) so
/// the caller can fall back to the jsPDF renderer instead of reporting a
/// success that produced no file.
#[tauri::command]
// Async: the headless browser render polls for up to 60 seconds. As a
// sync command it ran on the MAIN thread and froze the entire UI for the
// whole render (the classic "PDF conversion froze the app" report);
// async commands run on the runtime's worker pool.
pub async fn fs_render_html_to_pdf(
    html_content: String,
    target_path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let browser = find_chromium_browser().ok_or("no Edge/Chrome found for PDF rendering")?;
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_path(&target_path, &workspace);
    let parent = target
        .parent()
        .ok_or_else(|| "path has no parent".to_string())?;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    );
    let tmp_dir = std::env::temp_dir().join(format!("kai-pdf-{unique}"));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let html_file = tmp_dir.join("render.html");
    let pdf_file = tmp_dir.join("out.pdf");
    let profile_dir = tmp_dir.join("profile");

    let result = (|| -> Result<(), String> {
        std::fs::write(&html_file, html_content.as_bytes())
            .map_err(|e| format!("temp html write failed: {e}"))?;

        let mut cmd = Command::new(&browser);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.arg("--headless=new")
            .arg("--disable-gpu")
            .arg("--no-pdf-header-footer")
            .arg(format!(
                "--user-data-dir={}",
                profile_dir.display()
            ))
            .arg(format!(
                "--virtual-time-budget={}",
                10_000
            ))
            .arg(format!("--print-to-pdf={}", pdf_file.display()))
            .arg(file_url(&html_file))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("browser spawn failed: {e}"))?;

        // Poll to a hard deadline: headless Chromium occasionally hangs on
        // a locked profile; a blocked wait() would wedge the IPC thread.
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => {
                    if !status.success() {
                        let stderr = {
                            let mut buf = String::new();
                            if let Some(mut err) = child.stderr.take() {
                                let _ = std::io::Read::read_to_string(&mut err, &mut buf);
                            }
                            buf
                        };
                        return Err(format!(
                            "browser exited with {status}: {}",
                            stderr.trim().get(..400).unwrap_or("")
                        ));
                    }
                    break;
                }
                None => {
                    if Instant::now() > deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("browser render timed out (60s)".into());
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }

        let meta = std::fs::metadata(&pdf_file).map_err(|_| {
            "browser produced no PDF (profile conflict or sandbox restriction)".to_string()
        })?;
        // Smallest plausible 1-page PDF is a few KB; anything tinier is a
        // write failure, not a render result.
        if meta.len() < 512 {
            return Err("browser PDF output is empty".into());
        }

        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        // rename fails across volumes (temp on C:, target on D:) — fall back
        // to copy.
        if std::fs::rename(&pdf_file, &target).is_err() {
            std::fs::copy(&pdf_file, &target).map_err(|e| e.to_string())?;
        }
        emit_fs_changed(&target);
        Ok(())
    })();

    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

// ── Spreadsheet parsing (calamine) ─────────────────────────────────────

use calamine::Reader;

/// One worksheet: name + rows of cell values (strings; empty cells are
/// empty strings) + used dimensions. Cell coordinates are 0-based.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetSheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    /// 0-based index of the first used row / column in the sheet.
    pub start_row: u32,
    pub start_col: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetData {
    pub sheet_names: Vec<String>,
    pub active_sheet: usize,
    pub sheets: Vec<SpreadsheetSheet>,
}

fn data_to_string(v: calamine::Data) -> String {
    use calamine::Data;
    match v {
        Data::Empty => String::new(),
        Data::String(s) => s,
        Data::Float(f) => {
            // Render integral values without a trailing .0 (Excel parity).
            if f.fract() == 0.0 && f.is_finite() && f.abs() < 1e15 {
                format!("{}", f as i64)
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => format!("{i}"),
        Data::Bool(b) => if b { "TRUE".into() } else { "FALSE".into() },
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) => s,
        Data::DurationIso(s) => s,
        Data::Error(e) => format!("#{e:?}#"),
    }
}

/// Hard cap on cells returned per sheet — a misbehaving spreadsheet must not
/// wedge the IPC bridge with a multi-million-cell payload.
const MAX_CELLS_PER_SHEET: usize = 200_000;

fn sheet_to_struct(name: String, range: &calamine::Range<calamine::Data>) -> SpreadsheetSheet {
    let (start_row, start_col) = range.start().unwrap_or((0, 0));
    let mut rows: Vec<Vec<String>> = Vec::with_capacity(range.height());
    for row in range.rows() {
        let out: Vec<String> = row.iter().map(|c| data_to_string(c.clone())).collect();
        rows.push(out);
    }
    // Enforce the cell cap by truncating trailing rows (keeps the header
    // region, which is what both the model and a human scan first).
    let mut cells = rows.iter().map(|r| r.len()).sum::<usize>();
    while cells > MAX_CELLS_PER_SHEET {
        let dropped = rows.pop().map(|r| r.len()).unwrap_or(0);
        cells -= dropped;
    }
    SpreadsheetSheet {
        name,
        rows,
        start_row,
        start_col,
    }
}

/// Parse a spreadsheet (xlsx/xlsm/xlsb/xls/ods) into plain cell strings.
/// Used by the editor preview and the AI read_file tool. Read-only.
#[tauri::command]
// Async: workbook decode can take seconds on large files. Sync would
// block the main thread for that whole span.
pub async fn fs_parse_spreadsheet(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<SpreadsheetData, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "file too large ({} bytes, limit {})",
            meta.len(),
            MAX_READ_BYTES
        ));
    }
    // Sheets auto-detects the reader from the file content (xlsx/xls/xlsb/ods).
    let mut workbook: calamine::Sheets<_> =
        calamine::open_workbook_auto(&p).map_err(|e| format!("cannot open spreadsheet: {e}"))?;
    let names: Vec<String> = workbook.sheet_names().to_vec();
    let mut sheets = Vec::with_capacity(names.len());
    for name in &names {
        match workbook.worksheet_range(name) {
            Ok(range) => sheets.push(sheet_to_struct(name.clone(), &range)),
            Err(e) => {
                return Err(format!("failed to read sheet '{name}': {e}"));
            }
        }
    }
    Ok(SpreadsheetData {
        sheet_names: names.clone(),
        active_sheet: 0,
        sheets,
    })
}

/// Bytes-in variant for attachments (the composer only has a File, no path).
/// Parses from an in-memory cursor — no temp file, no fs write.
#[tauri::command]
// Async: same multi-second workbook decode as the path variant.
pub async fn fs_parse_spreadsheet_bytes(bytes: Vec<u8>) -> Result<SpreadsheetData, String> {
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(format!(
            "file too large ({} bytes, limit {})",
            bytes.len(),
            MAX_READ_BYTES
        ));
    }
    let cursor = std::io::Cursor::new(bytes);
    let mut workbook: calamine::Sheets<_> = calamine::open_workbook_auto_from_rs(cursor)
        .map_err(|e| format!("cannot open spreadsheet: {e}"))?;
    let names: Vec<String> = workbook.sheet_names().to_vec();
    let mut sheets = Vec::with_capacity(names.len());
    for name in &names {
        match workbook.worksheet_range(name) {
            Ok(range) => sheets.push(sheet_to_struct(name.clone(), &range)),
            Err(e) => {
                return Err(format!("failed to read sheet '{name}': {e}"));
            }
        }
    }
    Ok(SpreadsheetData {
        sheet_names: names.clone(),
        active_sheet: 0,
        sheets,
    })
}

// ── Image conversion (image crate) ─────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertImageResult {
    pub path: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
}

/// One image transformation, deserialized from the tool's `operations`
/// array (serde internally tagged on `type`, camelCase). Applied in order.
#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ImageOp {
    /// Exact resize — width/height are honored as given (aspect NOT
    /// preserved; pass aspect-correct values for that).
    Resize {
        width: u32,
        height: u32,
        #[serde(default)]
        filter: Option<String>,
    },
    Crop {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    /// Quarter turns only: 90, 180, or 270 (clockwise).
    Rotate { degrees: u32 },
    /// "h" mirrors left-right, "v" flips top-bottom.
    Flip { axis: String },
    /// Gaussian blur; sigma is the radius in pixels.
    Blur { sigma: f32 },
    /// Unsharp mask (sharpen): sigma radius + threshold below which
    /// differences are ignored (0 = sharpen everything).
    Sharpen { sigma: f32, threshold: i32 },
    /// -255..=255; negative darkens.
    Brighten { amount: i32 },
    /// 1.0 = unchanged, <1 reduces, >1 increases.
    Contrast { factor: f32 },
    /// Hue shift in degrees.
    HueRotate { degrees: i32 },
    Grayscale,
    Invert,
}

fn parse_filter(name: &Option<String>) -> image::imageops::FilterType {
    match name.as_deref().map(str::to_ascii_lowercase).as_deref() {
        Some("nearest") => image::imageops::FilterType::Nearest,
        Some("triangle") | Some("bilinear") => image::imageops::FilterType::Triangle,
        Some("catmullrom") | Some("catmull-rom") => image::imageops::FilterType::CatmullRom,
        Some("gaussian") => image::imageops::FilterType::Gaussian,
        // Default and "lanczos3" — the high-quality choice.
        _ => image::imageops::FilterType::Lanczos3,
    }
}

fn apply_image_ops(
    mut img: image::DynamicImage,
    ops: &[ImageOp],
) -> Result<image::DynamicImage, String> {
    use image::GenericImageView;
    for op in ops {
        match op {
            ImageOp::Resize {
                width,
                height,
                filter,
            } => {
                if *width == 0 || *height == 0 {
                    return Err("resize: width and height must be >= 1".into());
                }
                img = img.resize_exact(*width, *height, parse_filter(filter));
            }
            ImageOp::Crop {
                x,
                y,
                width,
                height,
            } => {
                let (w, h) = img.dimensions();
                if x.saturating_add(*width) > w || y.saturating_add(*height) > h {
                    return Err(format!(
                        "crop {x},{y} {width}x{height} is out of bounds for {w}x{h}"
                    ));
                }
                img = img.crop_imm(*x, *y, *width, *height);
            }
            ImageOp::Rotate { degrees } => {
                img = match degrees {
                    90 => img.rotate90(),
                    180 => img.rotate180(),
                    270 => img.rotate270(),
                    d => return Err(format!("rotate: degrees must be 90, 180, or 270, got {d}")),
                };
            }
            ImageOp::Flip { axis } => {
                img = match axis.to_ascii_lowercase().as_str() {
                    "h" | "horizontal" => img.fliph(),
                    "v" | "vertical" => img.flipv(),
                    a => return Err(format!("flip: axis must be \"h\" or \"v\", got {a:?}")),
                };
            }
            ImageOp::Blur { sigma } => {
                if *sigma < 0.0 {
                    return Err("blur: sigma must be >= 0".into());
                }
                img = img.blur(*sigma);
            }
            ImageOp::Sharpen { sigma, threshold } => {
                if *sigma < 0.0 {
                    return Err("sharpen: sigma must be >= 0".into());
                }
                img = img.unsharpen(*sigma, *threshold);
            }
            ImageOp::Brighten { amount } => img = img.brighten(*amount),
            ImageOp::Contrast { factor } => img = img.adjust_contrast(*factor),
            ImageOp::HueRotate { degrees } => img = img.huerotate(*degrees),
            ImageOp::Grayscale => img = img.grayscale(),
            ImageOp::Invert => img.invert(),
        }
    }
    Ok(img)
}

/// Composite an RGBA image onto a white background — JPEG (and BMP) have no
/// alpha channel; a plain channel-drop would render transparent pixels black.
fn flatten_onto_white(img: image::DynamicImage) -> image::DynamicImage {
    use image::{DynamicImage, GenericImageView, ImageBuffer, Rgb, Rgba};
    if !img.color().has_alpha() {
        return img;
    }
    let (w, h) = img.dimensions();
    let rgba = img.to_rgba8();
    let mut out = ImageBuffer::<Rgb<u8>, Vec<u8>>::new(w, h);
    for (x, y, px) in rgba.enumerate_pixels() {
        let Rgba([r, g, b, a]) = *px;
        let blend = |c: u8| -> u8 {
            ((u16::from(c) * u16::from(a) + 255 * (255 - u16::from(a))) / 255) as u8
        };
        out.put_pixel(x, y, Rgb([blend(r), blend(g), blend(b)]));
    }
    DynamicImage::ImageRgb8(out)
}

/// Pure bytes→bytes conversion used by `fs_convert_image`. Kept separate from
/// the command wrapper so tests can exercise it without touching the fs.
fn convert_image_bytes(
    bytes: &[u8],
    format: image::ImageFormat,
    quality: Option<u8>,
    max_width: Option<u32>,
    max_height: Option<u32>,
    operations: &[ImageOp],
) -> Result<Vec<u8>, String> {
    let mut img = image::load_from_memory(bytes)
        .map_err(|e| format!("cannot decode source image: {e}"))?;

    if operations.is_empty() {
        // Legacy downscale — fits within the bounding box, aspect preserved.
        if let (Some(mw), Some(mh)) = (max_width, max_height) {
            if mw > 0 && mh > 0 && (img.width() > mw || img.height() > mh) {
                img = img.thumbnail(mw, mh);
            }
        }
    } else {
        // Explicit operations own the geometry: apply in order. (When both
        // are given, operations win — maxWidth/maxHeight are ignored.)
        img = apply_image_ops(img, operations)?;
    }

    // Alpha-carrying pixels must not turn black when the target has no alpha.
    if matches!(
        format,
        image::ImageFormat::Jpeg | image::ImageFormat::Bmp
    ) {
        img = flatten_onto_white(img);
    }

    let mut buf: Vec<u8> = Vec::new();
    if format == image::ImageFormat::Jpeg {
        let q = quality.unwrap_or(90).clamp(1, 100);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, q);
        img.write_with_encoder(encoder)
            .map_err(|e| format!("jpeg encoding failed: {e}"))?;
    } else {
        img.write_to(&mut std::io::Cursor::new(&mut buf), format)
            .map_err(|e| format!("{format:?} encoding failed: {e}"))?;
    }
    Ok(buf)
}

/// Convert an image between formats (png/jpg/jpeg/bmp/gif/webp) with an
/// optional ordered pipeline of resize/crop/rotate/effect operations.
/// The output format is inferred from the TARGET extension. Read → decode →
/// [ops] → encode → write; overwriting the source is safe (input is fully
/// in memory first).
#[tauri::command]
// Async: decode + resize + re-encode of large images can take seconds. As a
// sync command it ran on the MAIN thread and froze the entire UI for the
// whole pipeline; async commands run on the runtime's worker pool.
pub async fn fs_convert_image(
    src: String,
    dst: String,
    quality: Option<u8>,
    max_width: Option<u32>,
    max_height: Option<u32>,
    operations: Option<Vec<serde_json::Value>>,
    workspace: Option<WorkspaceEnv>,
) -> Result<ConvertImageResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let src_path = resolve_path(&src, &workspace);
    let dst_path = resolve_path(&dst, &workspace);

    let format = image::ImageFormat::from_path(&dst_path)
        .map_err(|_| format!("unsupported target image format: {dst}"))?;
    if !matches!(
        format,
        image::ImageFormat::Png
            | image::ImageFormat::Jpeg
            | image::ImageFormat::Bmp
            | image::ImageFormat::Gif
            | image::ImageFormat::WebP
    ) {
        return Err(format!("target format {format:?} is not supported for conversion"));
    }

    let ops: Vec<ImageOp> = operations
        .unwrap_or_default()
        .iter()
        .map(|v| {
            serde_json::from_value(v.clone())
                .map_err(|e| format!("invalid image operation: {e}"))
        })
        .collect::<Result<_, _>>()?;

    let meta = std::fs::metadata(&src_path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "source image too large ({} bytes, limit {})",
            meta.len(),
            MAX_READ_BYTES
        ));
    }
    let bytes = std::fs::read(&src_path).map_err(|e| e.to_string())?;

    let out = convert_image_bytes(&bytes, format, quality, max_width, max_height, &ops)?;
    // Report the FINAL dimensions — after ops, before encoding.
    let (w, h) = {
        use image::GenericImageView;
        let mut img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        if !ops.is_empty() {
            img = apply_image_ops(img, &ops)?;
        } else if let (Some(mw), Some(mh)) = (max_width, max_height) {
            if mw > 0 && mh > 0 && (img.width() > mw || img.height() > mh) {
                img = img.thumbnail(mw, mh);
            }
        }
        img.dimensions()
    };

    if let Some(parent) = dst_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&dst_path, &out).map_err(|e| e.to_string())?;
    emit_fs_changed(&dst_path);

    Ok(ConvertImageResult {
        path: dst_path.to_string_lossy().into_owned(),
        format: format!("{format:?}").to_lowercase(),
        width: w,
        height: h,
        size_bytes: out.len() as u64,
    })
}

#[cfg(test)]
mod spreadsheet_tests {
    use super::*;

    #[test]
    fn converts_png_rgba_to_jpeg_flattened() {
        // 8x8 RGBA: fully-transparent corners, opaque red center-ish pixel.
        // After flattening onto white, the center stays red and a formerly
        // transparent pixel must be WHITE (not black — the bug this guards).
        let img = image::RgbaImage::from_fn(8, 8, |x, y| {
            if (3..5).contains(&x) && (3..5).contains(&y) {
                image::Rgba([255, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 0, 0])
            }
        });
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();

        let jpeg =
            convert_image_bytes(&png, image::ImageFormat::Jpeg, Some(95), None, None, &[])
                .expect("png→jpeg conversion");
        assert!(jpeg.starts_with(&[0xFF, 0xD8, 0xFF]), "JPEG magic bytes");
        // Decode back and verify the flatten: the formerly-transparent pixel
        // is light (white-ish), never black.
        let back = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        let corner = back.get_pixel(0, 0);
        assert!(
            u16::from(corner[0]) + u16::from(corner[1]) + u16::from(corner[2]) > 600,
            "transparent pixel must flatten to white, got {corner:?}"
        );
        let center = back.get_pixel(4, 4);
        assert!(center[0] > 180 && center[1] < 80, "red pixel survives, got {center:?}");
    }

    #[test]
    fn applies_operation_pipeline() {
        use serde_json::json;
        let img = image::RgbaImage::from_fn(64, 32, |_x, _y| {
            image::Rgba([128, 64, 32, 255])
        });
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();

        // resize (exact, non-square) -> rotate 90 -> grayscale
        let ops: Vec<ImageOp> = vec![
            serde_json::from_value(json!({"type": "resize", "width": 32, "height": 16})).unwrap(),
            serde_json::from_value(json!({"type": "rotate", "degrees": 90})).unwrap(),
            serde_json::from_value(json!({"type": "grayscale"})).unwrap(),
        ];
        let out =
            convert_image_bytes(&png, image::ImageFormat::Png, None, None, None, &ops)
                .expect("pipeline converts");
        let back = image::load_from_memory(&out).unwrap();
        // 32x16 rotated 90° -> 16x32.
        assert_eq!((back.width(), back.height()), (16, 32));
        // Grayscale: R == G == B on every pixel.
        let rgb = back.to_rgb8();
        for p in rgb.pixels() {
            assert_eq!(p[0], p[1]);
            assert_eq!(p[1], p[2]);
        }

        // Out-of-bounds crop is a hard error, not a panic.
        let bad: ImageOp =
            serde_json::from_value(json!({"type": "crop", "x": 10, "y": 10, "width": 100, "height": 100})).unwrap();
        let err = convert_image_bytes(&png, image::ImageFormat::Png, None, None, None, &[bad]);
        assert!(err.is_err());

        // Unknown rotate degrees rejected.
        let bad2: ImageOp =
            serde_json::from_value(json!({"type": "rotate", "degrees": 45})).unwrap();
        assert!(convert_image_bytes(&png, image::ImageFormat::Png, None, None, None, &[bad2]).is_err());

        // Malformed op JSON is rejected at deserialization.
        assert!(serde_json::from_value::<ImageOp>(json!({"type": "teleport"})).is_err());
    }

    #[test]
    fn converts_png_to_webp_and_back() {
        let img = image::GrayImage::from_fn(16, 16, |x, _| {
            image::Luma([(x * 16) as u8])
        });
        let mut png = Vec::new();
        image::DynamicImage::ImageLuma8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let webp =
            convert_image_bytes(&png, image::ImageFormat::WebP, None, None, None, &[])
                .expect("png→webp conversion");
        let back = image::load_from_memory(&webp).expect("webp decodes");
        assert_eq!((back.width(), back.height()), (16, 16));
    }

    /// Minimal-but-valid OOXML workbook (inline strings + one numeric cell),
    /// built as a ZIP in memory. Exercises the same code path as the
    /// fs_parse_spreadsheet* commands (open_workbook_auto_from_rs).
    #[test]
    fn parses_xlsx_from_bytes() {
        let ct = br#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#;
        let rels = br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;
        let wb = br#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let wbrels = br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#;
        let s1 = br#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Score</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>alice</t></is></c><c r="B2"><v>42</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>bob</t></is></c><c r="B3"><v>3.5</v></c></row></sheetData></worksheet>"#;

        let mut zip_bytes: Vec<u8> = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_bytes));
            let opts: zip::write::SimpleFileOptions = Default::default();
            zip.start_file("[Content_Types].xml", opts).unwrap();
            zip.write_all(ct).unwrap();
            zip.start_file("_rels/.rels", opts).unwrap();
            zip.write_all(rels).unwrap();
            zip.start_file("xl/workbook.xml", opts).unwrap();
            zip.write_all(wb).unwrap();
            zip.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
            zip.write_all(wbrels).unwrap();
            zip.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
            zip.write_all(s1).unwrap();
            zip.finish().unwrap();
        }

        let cursor = std::io::Cursor::new(zip_bytes);
        let mut workbook: calamine::Sheets<_> =
            calamine::open_workbook_auto_from_rs(cursor).expect("workbook should parse");
        assert_eq!(workbook.sheet_names(), &["Data".to_string()]);
        let range = workbook
            .worksheet_range("Data")
            .expect("sheet range should read");
        let sheet = sheet_to_struct("Data".into(), &range);
        assert_eq!(sheet.rows.len(), 3);
        assert_eq!(sheet.rows[0][0], "Name");
        assert_eq!(sheet.rows[0][1], "Score");
        assert_eq!(sheet.rows[1][0], "alice");
        assert_eq!(sheet.rows[1][1], "42"); // integral float renders without .0
        assert_eq!(sheet.rows[2][0], "bob");
        assert_eq!(sheet.rows[2][1], "3.5");
    }
}
