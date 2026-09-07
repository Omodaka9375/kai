use crate::modules::git::types::{GitChangedFile, GitStashEntry};

#[derive(Default)]
pub struct PorcelainV2 {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub is_detached: bool,
    pub files: Vec<GitChangedFile>,
}

pub fn parse_porcelain_v2(stdout: &str) -> PorcelainV2 {
    let mut out = PorcelainV2 {
        branch: "HEAD".into(),
        ..Default::default()
    };
    let mut tokens = stdout.split('\0').filter(|t| !t.is_empty()).peekable();
    while let Some(tok) = tokens.next() {
        if let Some(rest) = tok.strip_prefix("# branch.head ") {
            out.branch = rest.to_string();
            out.is_detached = rest == "(detached)";
            continue;
        }
        if let Some(rest) = tok.strip_prefix("# branch.upstream ") {
            out.upstream = Some(rest.to_string());
            continue;
        }
        if let Some(rest) = tok.strip_prefix("# branch.ab ") {
            let mut parts = rest.split_ascii_whitespace();
            if let Some(a) = parts.next() {
                out.ahead = a.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(b) = parts.next() {
                out.behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
            continue;
        }
        if tok.starts_with("# ") {
            continue;
        }
        if let Some(rest) = tok.strip_prefix("1 ") {
            if let Some(file) = parse_ordinary(rest) {
                out.files.push(file);
            }
            continue;
        }
        if let Some(rest) = tok.strip_prefix("2 ") {
            let orig = tokens.next().unwrap_or("").to_string();
            if let Some(file) = parse_renamed(rest, orig) {
                out.files.push(file);
            }
            continue;
        }
        if let Some(rest) = tok.strip_prefix("u ") {
            if let Some(file) = parse_unmerged(rest) {
                out.files.push(file);
            }
            continue;
        }
        if let Some(rest) = tok.strip_prefix("? ") {
            out.files.push(make_file('?', '?', rest, None));
            continue;
        }
    }
    out
}

fn skip_fields(s: &str, n: usize) -> Option<&str> {
    let mut rest = s;
    for _ in 0..n {
        let idx = rest.find(' ')?;
        rest = &rest[idx + 1..];
    }
    Some(rest)
}

fn parse_ordinary(rest: &str) -> Option<GitChangedFile> {
    let xy = rest.get(..2)?;
    let path = skip_fields(rest, 7)?;
    let (i, w) = xy_chars(xy);
    Some(make_file(i, w, path, None))
}

fn parse_renamed(rest: &str, orig_path: String) -> Option<GitChangedFile> {
    let xy = rest.get(..2)?;
    let after = skip_fields(rest, 8)?;
    let (i, w) = xy_chars(xy);
    Some(make_file(i, w, after, Some(orig_path)))
}

fn parse_unmerged(rest: &str) -> Option<GitChangedFile> {
    let xy = rest.get(..2)?;
    let path = skip_fields(rest, 9)?;
    let (i, w) = xy_chars(xy);
    Some(make_file(i, w, path, None))
}

// porcelain v2 uses '.' to mean "unchanged"; downstream logic mirrors v1 spaces.
fn xy_chars(xy: &str) -> (char, char) {
    let mut it = xy.chars();
    let to_space = |c: char| if c == '.' { ' ' } else { c };
    (
        to_space(it.next().unwrap_or(' ')),
        to_space(it.next().unwrap_or(' ')),
    )
}

fn make_file(
    index_status: char,
    worktree_status: char,
    path: &str,
    original_path: Option<String>,
) -> GitChangedFile {
    GitChangedFile {
        path: path.to_string(),
        original_path,
        index_status: index_status.to_string(),
        worktree_status: worktree_status.to_string(),
        staged: is_staged(index_status, worktree_status),
        unstaged: is_unstaged(index_status, worktree_status),
        untracked: index_status == '?' && worktree_status == '?',
        status_label: status_label(index_status, worktree_status),
    }
}

fn is_staged(index_status: char, worktree_status: char) -> bool {
    index_status != ' ' && !(index_status == '?' && worktree_status == '?')
}

fn is_unstaged(index_status: char, worktree_status: char) -> bool {
    worktree_status != ' ' || (index_status == '?' && worktree_status == '?')
}

/// Parse the output of `git stash list --format=%gd%x1f%h%x1f%gs`.
///
/// The `%gd` (e.g. `stash@{0}`) encodes the position, `%h` the short commit
/// sha, and `%gs` the free-form stash message. `stash@{0}` is the most recent.
/// Malformed lines are skipped rather than erroring, matching the forgiving
/// posture of the porcelain parser.
pub fn parse_stash_list(stdout: &str) -> Vec<GitStashEntry> {
    let mut entries: Vec<GitStashEntry> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\x1f');
        let ref_name = parts.next().unwrap_or("");
        let short_sha = parts.next().unwrap_or("");
        let subject = parts.next().unwrap_or("").to_string();

        let Some(index) = parse_stash_index(ref_name) else {
            continue;
        };
        if !sha_is_safe(short_sha) {
            continue;
        }
        entries.push(GitStashEntry {
            index,
            short_sha: short_sha.to_string(),
            subject,
            ref_name: ref_name.to_string(),
        });
    }
    entries
}

/// Extract the `n` from `stash@{n}`. Returns `None` for anything else.
fn parse_stash_index(ref_name: &str) -> Option<u32> {
    let inner = ref_name.strip_prefix("stash@{")?.strip_suffix('}')?;
    inner.parse::<u32>().ok()
}

/// Mirrors the commit-sha safety check in `operations.rs` (hex-only, ≤64).
fn sha_is_safe(sha: &str) -> bool {
    !sha.is_empty() && sha.len() <= 64 && sha.chars().all(|c| c.is_ascii_hexdigit())
}

fn status_label(index_status: char, worktree_status: char) -> String {
    match (index_status, worktree_status) {
        ('?', '?') => "Untracked".into(),
        ('A', _) => "Added".into(),
        ('M', _) | (_, 'M') => "Modified".into(),
        ('D', _) | (_, 'D') => "Deleted".into(),
        ('R', _) | (_, 'R') => "Renamed".into(),
        ('C', _) | (_, 'C') => "Copied".into(),
        ('U', _) | (_, 'U') => "Unmerged".into(),
        _ => "Changed".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_porcelain_v2, parse_stash_list};

    #[test]
    fn stash_list_parses_entries_in_order() {
        let stdout = concat!(
            "stash@{0}\x1fabc1234\x1fWIP on main: 8db5c7f fix ai fencing\n",
            "stash@{1}\x1fdef5678\x1fOn feature: wip\n",
        );
        let entries = parse_stash_list(stdout);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].index, 0);
        assert_eq!(entries[0].short_sha, "abc1234");
        assert_eq!(entries[0].ref_name, "stash@{0}");
        assert_eq!(entries[0].subject, "WIP on main: 8db5c7f fix ai fencing");
        assert_eq!(entries[1].index, 1);
        assert_eq!(entries[1].short_sha, "def5678");
    }

    #[test]
    fn stash_list_skips_malformed_lines() {
        let stdout = concat!(
            "stash@{0}\x1fabc1234\x1fvalid\n",
            "not-a-stash\x1fzzz\x1fgarbage\n",
            "stash@{1}\x1fNOTHEX\x1fbad sha\n",
            "stash@{2}\x1f1234567\x1f\n", // empty subject still valid
        );
        let entries = parse_stash_list(stdout);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].index, 0);
        assert_eq!(entries[1].index, 2);
    }

    #[test]
    fn stash_list_handles_empty_output() {
        assert!(parse_stash_list("").is_empty());
    }

    #[test]
    fn stash_index_rejects_garbage() {
        assert_eq!(super::parse_stash_index("stash@{0}"), Some(0));
        assert_eq!(super::parse_stash_index("stash@{12}"), Some(12));
        assert_eq!(super::parse_stash_index("stash@{x}"), None);
        assert_eq!(super::parse_stash_index("stash@{}"), None);
        assert_eq!(super::parse_stash_index("stash@{0"), None);
        assert_eq!(super::parse_stash_index("refs/stash"), None);
    }

    #[test]
    fn porcelain_v2_parses_branch_and_files() {
        let stdout = concat!(
            "# branch.oid abc123\0",
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 .M N... 100644 100644 100644 abc def src/a.rs\0",
            "2 R. N... 100644 100644 100644 abc def R100 src/new.rs\0src/old.rs\0",
            "? src/untracked.rs\0",
        );
        let parsed = parse_porcelain_v2(stdout);
        assert_eq!(parsed.branch, "main");
        assert_eq!(parsed.upstream.as_deref(), Some("origin/main"));
        assert_eq!(parsed.ahead, 2);
        assert_eq!(parsed.behind, 1);
        assert!(!parsed.is_detached);
        assert_eq!(parsed.files.len(), 3);
        assert_eq!(parsed.files[0].path, "src/a.rs");
        assert!(parsed.files[0].unstaged);
        assert_eq!(parsed.files[1].path, "src/new.rs");
        assert_eq!(parsed.files[1].original_path.as_deref(), Some("src/old.rs"));
        assert!(parsed.files[1].staged);
        assert_eq!(parsed.files[2].path, "src/untracked.rs");
        assert!(parsed.files[2].untracked);
    }

    #[test]
    fn porcelain_v2_handles_detached_head() {
        let stdout = "# branch.oid abc\0# branch.head (detached)\0";
        let parsed = parse_porcelain_v2(stdout);
        assert!(parsed.is_detached);
        assert_eq!(parsed.branch, "(detached)");
        assert!(parsed.upstream.is_none());
    }
}
