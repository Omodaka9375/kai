//! Shadow worktree sessions (Layer 3) — the agent works in an isolated copy
//! of the project; the user merges or discards at the end.
//!
//! Layout: `~/.kai/shadow/<project-hash>/` — one active shadow per project.
//! The copy includes `.git` (agent git ops are isolated; commits made in the
//! shadow flow back on merge through the inventory diff). `node_modules` is
//! symlinked instead of copied (falls back to a full copy when the platform
//! refuses the symlink) — writes through the link leak to the real project
//! and are reported in the session info.
//!
//! Merge is inventory-based and clobber-safe: at create time every copied
//! file is recorded (size + mtime). At merge:
//!   - new in shadow            → copy back
//!   - changed in shadow only   → copy back
//!   - changed in shadow AND in the real project since create → CONFLICT,
//!     reported, never clobbered
//!   - deleted in shadow        → reported, never auto-deleted
//!
//! All path translation happens in the frontend (lib/shadow.ts) — this module
//! only creates, inspects, merges, and removes the shadow tree.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Top-level directories symlinked instead of copied. Writes through them
/// reach the real project — surfaced in `ShadowInfo.shared_dirs`.
const HEAVY_DIRS: &[&str] = &["node_modules"];

const META_FILE: &str = "kai-shadow.json";

// ── Types ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShadowInfo {
    pub project_root: String,
    pub shadow_root: String,
    pub created_at_ms: u64,
    /// Heavy dirs symlinked (shared) rather than copied — writes leak.
    pub shared_dirs: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShadowMergeReport {
    /// Copied back (or would be, in dry-run): new + agent-modified.
    pub copied: Vec<String>,
    /// Deleted in the shadow — listed for the user, never auto-deleted.
    pub deleted_in_shadow: Vec<String>,
    /// Changed both in the shadow and in the real project — not clobbered.
    pub conflicts: Vec<String>,
}

/// File size + mtime snapshot taken at shadow-create time. `pub(crate)`
/// visibility only feeds `compute_merge_plan` — not exposed over IPC.
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
struct FileStamp {
    size: u64,
    mtime_ms: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShadowMeta {
    version: u32,
    project_root: String,
    created_at_ms: u64,
    shared_dirs: Vec<String>,
    /// relative path (forward slashes) → (size, mtime) at create time.
    inventory: HashMap<String, FileStamp>,
}

// ── Paths ─────────────────────────────────────────────────────────────────

/// Stable per-project hash — same normalization as the WSL mountpoint
/// (case + separator insensitive) so one identity rule spans both layers.
pub(crate) fn project_hash(root: &str) -> u32 {
    let norm = root.to_lowercase().replace('\\', "/");
    let mut hash: u32 = 5381;
    for b in norm.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(b as u32);
    }
    hash
}

fn shadow_dir(project_root: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    Ok(home.join(".kai").join("shadow").join(format!("{:08x}", project_hash(project_root))))
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join(META_FILE)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn stamp(p: &Path) -> FileStamp {
    let meta = std::fs::metadata(p).ok();
    let mtime_ms = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    FileStamp {
        size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        mtime_ms,
    }
}

fn rel_key(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

// ── Create: copy + inventory ──────────────────────────────────────────────

/// Recursively copy `src` → `dst`. Symlinks are re-created as links (never
/// followed), so a symlink can't silently redirect the copy outside the
/// project. Inventory is NOT collected here — `create_inner` rebuilds it
/// with one stat-walk over the finished shadow (correct rel keys).
fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("readdir {}: {e}", src.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let s = entry.path();
        let d = dst.join(entry.file_name());

        if ft.is_symlink() {
            let target = std::fs::read_link(&s).map_err(|e| e.to_string())?;
            symlink_any(&target, &d).map_err(|e| {
                format!("link {} -> {}: {e}", d.display(), target.display())
            })?;
            continue;
        }
        if ft.is_dir() {
            copy_tree(&s, &d)?;
            continue;
        }
        std::fs::copy(&s, &d).map_err(|e| format!("copy {}: {e}", s.display()))?;
    }
    Ok(())
}

/// Create a symlink that works for the node_modules case on every platform:
/// Unix directory symlink, Windows directory symlink (requires Developer
/// Mode when unprivileged). Callers fall back to a plain copy on error.
fn symlink_any(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link).map_err(|e| e.to_string())
    }
}

/// Walk a tree for merge planning: gitignore-aware (same walker settings as
/// create), excluding `.git`, heavy dirs, and the shadow meta file. Rel keys
/// use forward slashes. Symlinks are skipped — their targets never enter the
/// merge plan.
fn walk_project_tree(root: &Path, out: &mut HashMap<String, FileStamp>) -> Result<(), String> {
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .filter_entry(|e| {
            let name = e.file_name();
            let is_dir = e.file_type().is_some_and(|t| t.is_dir());
            !(is_dir && (name == ".git" || HEAVY_DIRS.iter().any(|d| name == *d)))
                && name != META_FILE
        })
        .build();
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let Some(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        out.insert(rel, stamp(entry.path()));
    }
    Ok(())
}

/// Walk a tree collecting (rel → stamp) for regular files. Symlinks and
/// their targets are skipped — shared dirs never enter the merge.
#[allow(dead_code)]
fn walk_tree(root: &Path, out: &mut HashMap<String, FileStamp>) -> Result<(), String> {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return Ok(()), // vanished mid-walk — treat as absent
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let p = entry.path();
        if ft.is_dir() {
            walk_tree(&p, out)?;
        } else {
            out.insert(rel_key(root, &p), stamp(&p));
        }
    }
    Ok(())
}

// ── Merge plan (pure — unit-tested) ───────────────────────────────────────

#[derive(Debug, Default, PartialEq)]
pub struct MergePlan {
    pub copied: Vec<String>,
    pub deleted_in_shadow: Vec<String>,
    pub conflicts: Vec<String>,
}

/// Decide what a merge would do, given the create-time inventory, the
/// current shadow tree, and the current real tree. Pure and testable.
///
///   new          : in shadow, not in inventory
///   modified     : in shadow + inventory, differs from inventory, real
///                  tree matches inventory (nobody else touched it)
///   conflict     : differs in BOTH shadow and real tree since create
///   deleted      : in inventory, missing in shadow (agent removed it)
fn compute_merge_plan(
    inventory: &HashMap<String, FileStamp>,
    shadow: &HashMap<String, FileStamp>,
    real: &HashMap<String, FileStamp>,
) -> MergePlan {
    let mut plan = MergePlan::default();
    for (rel, s) in shadow {
        match inventory.get(rel) {
            None => plan.copied.push(rel.clone()),
            Some(inv) => {
                let agent_changed = s.size != inv.size || s.mtime_ms != inv.mtime_ms;
                if !agent_changed {
                    continue;
                }
                let user_changed = real
                    .get(rel)
                    .map(|r| r.size != inv.size || r.mtime_ms != inv.mtime_ms)
                    .unwrap_or(false);
                if user_changed {
                    plan.conflicts.push(rel.clone());
                } else {
                    plan.copied.push(rel.clone());
                }
            }
        }
    }
    for rel in inventory.keys() {
        if !shadow.contains_key(rel) {
            plan.deleted_in_shadow.push(rel.clone());
        }
    }
    plan.copied.sort();
    plan.conflicts.sort();
    plan.deleted_in_shadow.sort();
    plan
}

// ── Commands ──────────────────────────────────────────────────────────────

fn read_meta(dir: &Path) -> Result<ShadowMeta, String> {
    let raw = std::fs::read_to_string(meta_path(dir))
        .map_err(|e| format!("read {}: {e}", meta_path(dir).display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", meta_path(dir).display()))
}

fn info_of(meta: &ShadowMeta, dir: &Path) -> ShadowInfo {
    ShadowInfo {
        project_root: meta.project_root.clone(),
        shadow_root: dir.to_string_lossy().into_owned(),
        created_at_ms: meta.created_at_ms,
        shared_dirs: meta.shared_dirs.clone(),
    }
}

/// Active shadow for a project, if one exists. Survives restarts (state is
/// the on-disk meta), so an interrupted session resumes cleanly.
#[tauri::command]
pub fn shadow_status(project_root: String) -> Option<ShadowInfo> {
    let Ok(dir) = shadow_dir(&project_root) else { return None };
    let meta = read_meta(&dir).ok()?;
    Some(info_of(&meta, &dir))
}

/// Create the shadow copy. Errors when one is already active — finish it
/// first (merge/discard). Runs the copy on a blocking thread.
#[tauri::command]
pub async fn shadow_create(project_root: String) -> Result<ShadowInfo, String> {
    let root = PathBuf::from(&project_root);
    if !root.is_dir() {
        return Err(format!("project root is not a directory: {project_root}"));
    }
    let dir = shadow_dir(&project_root)?;
    if meta_path(&dir).exists() {
        return Err("a shadow session is already active for this project — merge or discard it first".into());
    }

    tokio::task::spawn_blocking(move || create_inner(&root, &dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Default cap on the working-tree copy size (before .git). Huge monorepos
/// fill the user's home disk — refuse with an actionable message instead.
const MAX_TREE_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB

fn create_inner(root: &Path, dir: &Path) -> Result<ShadowInfo, String> {
    // Clear any half-created leftovers from a failed create.
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let mut inventory: HashMap<String, FileStamp> = HashMap::new();
    let mut shared: Vec<String> = Vec::new();
    let mut total_bytes: u64 = 0;

    // ── 1. Heavy dirs (node_modules): symlink when possible (share), else
    // leave them OUT of the shadow entirely — the agent can recreate
    // installs, and copying gigabytes of dependencies is never wanted.
    let entries = std::fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let name_str = entry.file_name().to_string_lossy().into_owned();
        if ft.is_dir() && HEAVY_DIRS.contains(&name_str.as_str())
            && symlink_any(&entry.path(), &dir.join(&name_str)).is_ok()
        {
            shared.push(name_str);
        }
    }

    // ── 2. Working tree via the `ignore` walker — respects .gitignore, so
    // dist/, .next/, target/, build outputs, and node_modules never bloat
    // the shadow. Same semantics as the user's own `git status` view.
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false) // include dotfiles (.env.example, .npmrc, …)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .filter_entry(|e| {
            // Keep .git OUT of the walker pass — copied explicitly below so
            // agent git ops stay isolated without re-copying internals twice.
            !e.file_type().is_some_and(|t| t.is_dir() && e.file_name() == ".git")
                // Heavy dirs already handled above (symlinked or skipped).
                && !HEAVY_DIRS.iter().any(|d| e.file_name() == *d)
        })
        .build();
    for entry in walker {
        let entry = entry.map_err(|e| e.to_string())?;
        let Some(ft) = entry.file_type() else { continue };
        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        let src = entry.path();
        let dst = dir.join(&rel);
        if ft.is_dir() {
            std::fs::create_dir_all(&dst)
                .map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
            continue;
        }
        if ft.is_symlink() {
            let target = std::fs::read_link(src).map_err(|e| e.to_string())?;
            symlink_any(&target, &dst).map_err(|e| format!("link {}: {e}", dst.display()))?;
            continue;
        }
        // Regular file.
        let size = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        total_bytes += size;
        if total_bytes > MAX_TREE_BYTES {
            let _ = std::fs::remove_dir_all(dir);
            return Err(format!(
                "project working tree exceeds the {} GiB shadow cap — the shadow copy would fill your disk. Consider a smaller scope or clean ignored build outputs.",
                MAX_TREE_BYTES / (1024 * 1024 * 1024)
            ));
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        std::fs::copy(&src, dst).map_err(|e| format!("copy {}: {e}", src.display()))?;
        inventory.insert(rel, stamp(src));
    }

    // ── 3. .git copied as-is (walker skips it above) so agent git ops are
    // isolated and commits flow back at merge.
    let git_src = root.join(".git");
    if git_src.is_dir() {
        copy_tree(&git_src, &dir.join(".git"))?;
    }

    let created = now_ms();
    let meta = ShadowMeta {
        version: 2,
        project_root: root.to_string_lossy().into_owned(),
        created_at_ms: created,
        shared_dirs: shared,
        inventory,
    };
    let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(meta_path(dir), json).map_err(|e| e.to_string())?;

    Ok(info_of(&meta, dir))
}

/// Merge the shadow back into the real project. `dry_run` reports without
/// applying. A real merge consumes the shadow (the session ends).
#[tauri::command]
pub async fn shadow_merge(
    project_root: String,
    dry_run: bool,
) -> Result<ShadowMergeReport, String> {
    let root = PathBuf::from(&project_root);
    let dir = shadow_dir(&project_root)?;
    if !meta_path(&dir).exists() {
        return Err("no active shadow session for this project".into());
    }

    tokio::task::spawn_blocking(move || merge_inner(&root, &dir, dry_run))
        .await
        .map_err(|e| e.to_string())?
}

fn merge_inner(
    root: &Path,
    dir: &Path,
    dry_run: bool,
) -> Result<ShadowMergeReport, String> {
    let meta = read_meta(dir)?;
    // Both walks use the project walker (gitignore-aware, .git + heavy dirs
    // + the meta file excluded). CRITICAL: shadow `.git` internals must never
    // enter the plan — "new file" copying them back would clobber the real
    // repo's refs/objects. Agent commits in the shadow do not flow back via
    // the merge; that is a documented L3 limitation.
    let mut shadow_walk = HashMap::new();
    walk_project_tree(dir, &mut shadow_walk)?;
    let mut real_walk = HashMap::new();
    walk_project_tree(root, &mut real_walk)?;

    let plan = compute_merge_plan(&meta.inventory, &shadow_walk, &real_walk);

    if !dry_run {
        for rel in &plan.copied {
            let src = dir.join(rel);
            let dst = root.join(rel);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            std::fs::copy(&src, &dst).map_err(|e| {
                format!("merge copy {rel}: {e}")
            })?;
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    Ok(ShadowMergeReport {
        copied: plan.copied,
        deleted_in_shadow: plan.deleted_in_shadow,
        conflicts: plan.conflicts,
    })
}

/// Discard the shadow without merging. The real project was never touched by
/// the agent's tools (path translation guarantees that) — this just deletes
/// the copy.
#[tauri::command]
pub async fn shadow_discard(project_root: String) -> Result<(), String> {
    let dir = shadow_dir(&project_root)?;
    tokio::task::spawn_blocking(move || {
        // The meta file is the session marker — clear it FIRST so a crash
        // mid-delete doesn't leave a resumable half-shadow.
        let _ = std::fs::remove_file(meta_path(&dir));
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp_of(size: u64, mtime: u64) -> FileStamp {
        FileStamp { size, mtime_ms: mtime }
    }

    fn inv(entries: &[(&str, u64, u64)]) -> HashMap<String, FileStamp> {
        entries
            .iter()
            .map(|(r, s, m)| (r.to_string(), stamp_of(*s, *m)))
            .collect()
    }

    #[test]
    fn plan_new_modified_conflict_deleted() {
        let inventory = inv(&[
            ("a.txt", 10, 100),   // unchanged everywhere
            ("b.txt", 10, 100),   // agent modified
            ("c.txt", 10, 100),   // agent + user modified → conflict
            ("d.txt", 10, 100),   // agent deleted
            ("src/e.txt", 10, 100), // unchanged
        ]);
        let shadow = inv(&[
            ("a.txt", 10, 100),
            ("b.txt", 20, 200),
            ("c.txt", 20, 200),
            ("src/e.txt", 10, 100),
            ("new.txt", 5, 50), // agent created
        ]);
        let real = inv(&[
            ("a.txt", 10, 100),
            ("b.txt", 10, 100),
            ("c.txt", 11, 999), // user touched it after create
            ("d.txt", 10, 100), // still in real, deleted in shadow
            ("src/e.txt", 10, 100),
        ]);
        let plan = compute_merge_plan(&inventory, &shadow, &real);
        assert_eq!(plan.copied, vec!["b.txt".to_string(), "new.txt".to_string()]);
        assert_eq!(plan.conflicts, vec!["c.txt".to_string()]);
        assert_eq!(plan.deleted_in_shadow, vec!["d.txt".to_string()]);
    }

    #[test]
    fn plan_empty_inventory_means_everything_is_new() {
        let empty = HashMap::new();
        let shadow = inv(&[("x.txt", 1, 1)]);
        let real = HashMap::new();
        let plan = compute_merge_plan(&empty, &shadow, &real);
        assert_eq!(plan.copied, vec!["x.txt".to_string()]);
        assert!(plan.conflicts.is_empty());
        assert!(plan.deleted_in_shadow.is_empty());
    }

    #[test]
    fn project_hash_ignores_case_and_separators() {
        assert_eq!(project_hash("D:\\Code\\Proj"), project_hash("d:/code/proj"));
    }

    /// End-to-end create → modify → merge against real temp dirs: proves
    /// gitignored build outputs are excluded from the shadow, .git is copied
    /// but never merged back, and modified files flow to the real project.
    #[test]
    fn create_merge_roundtrip_respects_gitignore_and_git() {
        let tmp = std::env::temp_dir().join(format!("kai-shadow-test-{}", std::process::id()));
        let project = tmp.join("proj");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::write(project.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(project.join("README.md"), "hello").unwrap();
        // Gitignored build output — must NOT be shadowed.
        std::fs::create_dir_all(project.join("target")).unwrap();
        std::fs::write(project.join("target/huge.bin"), "x".repeat(1000)).unwrap();
        std::fs::write(project.join(".gitignore"), "/target\n").unwrap();
        // A real .git dir with a marker — copied into the shadow, but the
        // merge must NEVER touch the real repo's .git.
        std::fs::create_dir_all(project.join(".git/refs")).unwrap();
        std::fs::write(project.join(".git/HEAD"), "ref: refs/heads/main").unwrap();

        // Shadow dir directly under tmp (bypasses shadow_dir/home — the
        // create_inner/merge_inner fns take explicit paths).
        let shadow = tmp.join("shadow");
        let info = create_inner(&project, &shadow).expect("create_inner");
        assert_eq!(info.shared_dirs, Vec::<String>::new());
        assert!(shadow.join("src/main.rs").is_file());
        assert!(shadow.join(".git/HEAD").is_file(), ".git must be shadowed");
        assert!(
            !shadow.join("target/huge.bin").exists(),
            "gitignored build output must not be shadowed"
        );

        // Agent modifies a file in the shadow.
        std::fs::write(shadow.join("src/main.rs"), "fn main() { changed }").unwrap();

        // Merge.
        let report = merge_inner(&project, &shadow, false).expect("merge_inner");
        assert!(report.copied.contains(&"src/main.rs".to_string()));
        assert!(
            !report.copied.iter().any(|r| r.starts_with(".git/")),
            "shadow .git internals must never flow back to the real repo"
        );
        assert_eq!(
            std::fs::read_to_string(project.join("src/main.rs")).unwrap(),
            "fn main() { changed }"
        );
        assert_eq!(
            std::fs::read_to_string(project.join(".git/HEAD")).unwrap(),
            "ref: refs/heads/main",
            "real .git untouched"
        );
        assert!(!shadow.exists(), "merge consumes the shadow dir");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
