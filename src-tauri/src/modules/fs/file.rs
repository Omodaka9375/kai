use std::io::Write;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadResult {
    Text {
        content: String,
        size: u64,
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
pub fn fs_read_file(path: String, workspace: Option<WorkspaceEnv>) -> Result<ReadResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let meta = std::fs::metadata(&p).map_err(|e| {
        log::debug!("fs_read_file stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

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
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            return match String::from_utf16(&words) {
                Ok(content) => Ok(ReadResult::Text { content, size }),
                Err(_) => Ok(ReadResult::Binary { size }),
            };
        }
        if bytes[0] == 0xFE && bytes[1] == 0xFF {
            // UTF-16 BE
            let words: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            return match String::from_utf16(&words) {
                Ok(content) => Ok(ReadResult::Text { content, size }),
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
        Ok(content) => Ok(ReadResult::Text { content, size }),
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

    Ok(())
}

#[tauri::command]
pub fn fs_canonicalize(path: String, workspace: Option<WorkspaceEnv>) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let canon = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
    // Strip the Windows `\\?\` extended-length prefix so the frontend's
    // path comparator sees the same form regardless of OS.
    let s = canon.to_string_lossy().to_string();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
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

/// Write raw binary bytes — used by the document generator in the frontend.
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

    Ok(())
}
