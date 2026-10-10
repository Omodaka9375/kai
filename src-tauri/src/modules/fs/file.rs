use std::io::Write;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::Emitter;

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

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64,
    pub kind: StatKind,
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

#[tauri::command]
pub fn fs_stat(path: String, workspace: Option<WorkspaceEnv>) -> Result<FileStat, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    // Use symlink_metadata so we can detect symlinks. std::fs::metadata
    // follows symlinks, making is_symlink() always return false.
    let sym_meta = std::fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
    let kind = if sym_meta.is_symlink() {
        StatKind::Symlink
    } else if sym_meta.is_dir() {
        StatKind::Dir
    } else {
        StatKind::File
    };
    // For size/mtime, follow the symlink to get the target's metadata.
    let meta = std::fs::metadata(&p).unwrap_or(sym_meta);
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat {
        size: meta.len(),
        mtime,
        kind,
    })
}

/// Read CHANGELOG.md for the updater popup.
/// Prefers the bundled copy; falls back to the working directory.
#[tauri::command]
pub fn fs_read_changelog() -> Result<String, String> {
    match std::fs::read_to_string("CHANGELOG.md") {
        Ok(content) => Ok(content),
        Err(_) => {
            // Bundled copy — read from same directory as the executable.
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let asset = exe.parent().map(|p| p.join("CHANGELOG.md"));
            if let Some(p) = asset {
                std::fs::read_to_string(p).map_err(|e| e.to_string())
            } else {
                Err("".to_string())
            }
        }
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
pub fn fs_parse_spreadsheet(
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
pub fn fs_parse_spreadsheet_bytes(bytes: Vec<u8>) -> Result<SpreadsheetData, String> {
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

#[cfg(test)]
mod spreadsheet_tests {
    use super::*;

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
