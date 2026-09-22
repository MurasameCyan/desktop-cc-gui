use git2::{Repository, StatusOptions};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted" | "renamed" | "typechange"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub staged: Vec<GitFileEntry>,
    pub unstaged: Vec<GitFileEntry>,
    pub untracked: Vec<GitFileEntry>,
    /// Commits the branch is ahead of / behind its upstream; `None` when the
    /// branch has no upstream (or HEAD is detached/unborn).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<usize>,
}

/// Compact status for a directory that is itself a Git worktree root,
/// rendered inline in the file tree. Unlike `GitStatus` it carries no file
/// paths or diff stats — only the branch plus change counts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySummary {
    pub path: String,
    pub branch: String,
    pub changed: usize,
    pub untracked: usize,
}

/// Open `path` only when that directory is itself a worktree root. Standard
/// worktrees have a `.git` directory; linked worktrees carry a `.git` file.
/// The cheap `.git` existence guard avoids `Repository::discover` walking up
/// and mislabeling every ordinary folder under the workspace repo. The
/// canonicalized comparison then rejects a parent repo opened through a
/// stale/odd `.git` layout.
fn open_exact_repo(path: &std::path::Path) -> Option<Repository> {
    if !path.join(".git").exists() {
        return None;
    }
    let repo = Repository::open(path).ok()?;
    let workdir = repo.workdir()?;
    let expected = std::fs::canonicalize(path).ok()?;
    let actual = std::fs::canonicalize(workdir).ok()?;
    (actual == expected).then_some(repo)
}

fn exact_repository_summary(path: &std::path::Path) -> Option<RepositorySummary> {
    let repo = open_exact_repo(path)?;
    let branch = repo
        .head()
        .ok()
        .and_then(|head| head.shorthand().map(str::to_string))
        .unwrap_or_else(|| "HEAD".to_string());
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).ok()?;
    // Paths can appear both staged and worktree-modified; count each file
    // once per bucket so `M1` means one modified file, not one diff.
    let mut changed = std::collections::HashSet::new();
    let mut untracked = std::collections::HashSet::new();
    for entry in statuses.iter() {
        let Some(file) = entry
            .path()
            .filter(|file| !file.is_empty())
            .map(str::to_string)
        else {
            continue;
        };
        let status = entry.status();
        if status.contains(git2::Status::WT_NEW) && !status.contains(git2::Status::INDEX_NEW) {
            untracked.insert(file);
        } else {
            changed.insert(file);
        }
    }
    Some(RepositorySummary {
        path: path.to_string_lossy().into_owned(),
        branch,
        changed: changed.len(),
        untracked: untracked.len(),
    })
}

/// Sync body of `git_repository_summaries`: one batch answers one loaded
/// tree level, so a status walk per candidate stays off the IPC thread.
fn repository_summaries_blocking(paths: Vec<String>) -> Vec<RepositorySummary> {
    paths
        .iter()
        .filter_map(|path| exact_repository_summary(std::path::Path::new(path)))
        .collect()
}

#[tauri::command]
pub async fn git_repository_summaries(paths: Vec<String>) -> Vec<RepositorySummary> {
    tauri::async_runtime::spawn_blocking(move || repository_summaries_blocking(paths))
        .await
        .unwrap_or_default()
}
/// Bulk colors for one loaded tree level. Two sources, merged:
/// 1. The repo *containing* the listed directory (any depth — the workspace
///    root itself, an ancestor, or none). Status paths are repo-relative, so
///    they are re-based onto the listed dir before matching; that way both a
///    root-level listing and a subdirectory listing inside one repo work.
/// 2. Each listed directory that is itself a nested repo root: its own
///    status decides its color, because the enclosing repo usually only sees
///    the whole subtree as one entry (or nothing at all when the workspace
///    root is not a repository).
pub fn file_tree_colors(
    path: &str,
    files: &[String],
) -> HashMap<String, &'static str> {
    let listed = Path::new(path);
    let mut out: HashMap<String, &'static str> = HashMap::new();
    // O(1) membership for the two hot loops below (status entries × files).
    let file_set: std::collections::HashSet<&str> =
        files.iter().map(String::as_str).collect();

    let mut prefix = String::new();
    if let Ok(repo) = Repository::discover(listed) {
        let walk_ok = (|| {
            let workdir = repo.workdir()?;
            let listed_c = std::fs::canonicalize(listed).ok()?;
            let root_c = std::fs::canonicalize(workdir).ok()?;
            let rel = listed_c.strip_prefix(&root_c).ok()?;
            prefix = rel.to_string_lossy().replace('\\', "/");
            let mut opts = StatusOptions::new();
            opts.include_untracked(true)
                // Untracked directories collapse to `dir/`; recursion would
                // expand them at real walk cost — strip the slash and let the
                // ancestor aggregation color the parents instead.
                .recurse_untracked_dirs(false);
            let statuses = repo.statuses(Some(&mut opts)).ok()?;
            let with_prefix = if prefix.is_empty() {
                None
            } else {
                Some(format!("{prefix}/"))
            };
            for entry in statuses.iter() {
                let Some(raw) = entry.path().filter(|file| !file.is_empty()) else {
                    continue;
                };
                // A trailing slash marks a collapsed untracked DIRECTORY —
                // strip it so the directory itself (and its ancestors) can
                // light up green.
                let file = raw.strip_suffix('/').unwrap_or(raw);
                // Re-base onto the listed directory: entries elsewhere in the
                // repo are irrelevant at this level.
                let rel_file = match &with_prefix {
                    Some(p) => match file.strip_prefix(p.as_str()) {
                        Some(r) => r,
                        None => continue,
                    },
                    None => file,
                };
                let status = entry.status();
                // INDEX_NEW is "added" (staged but never committed) — the
                // worktree side is a plain untracked file, so it paints as
                // untracked.
                let color = if status.intersects(git2::Status::INDEX_NEW | git2::Status::WT_NEW) {
                    "untracked"
                } else {
                    "modified"
                };
                // Direct hits at this level (files, or the collapsed
                // untracked dir itself)…
                if file_set.contains(rel_file) {
                    out.insert(rel_file.to_string(), color);
                }
                // …and parent propagation: a folder inherits the state of
                // anything under it, so parents light up without expanding.
                // Modified (uncommitted) wins over untracked when a folder
                // holds both kinds.
                let mut dir = Path::new(rel_file);
                while let Some(parent) = dir.parent() {
                    if parent.as_os_str().is_empty() {
                        break;
                    }
                    let key = parent.to_string_lossy().into_owned();
                    if file_set.contains(key.as_str()) {
                        let next = match out.get(&key).copied() {
                            Some("modified") => "modified",
                            _ => color,
                        };
                        out.insert(key, next);
                    }
                    dir = parent;
                }
            }
            Some(())
        })();
        let _ = walk_ok;
    }

    // Repo-root directories among the requested names paint blue — the tree
    // marks repository boundaries (nested repos like `CialloAssist` next to
    // plain folders like `ai-client-integration`), independent of their own
    // dirty state: the branch badge already carries that.
    for name in files {
        let dir = listed.join(name);
        if open_exact_repo(&dir).is_some() {
            out.insert(name.clone(), "repository");
        }
    }
    out
}

#[tauri::command]
pub fn git_file_colors(path: String, files: Vec<String>) -> HashMap<String, String> {
    file_tree_colors(&path, &files)
        .into_iter()
        .map(|(file, color)| (file, color.to_string()))
        .collect()
}

fn open_repo(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|_| "NOT_A_REPO".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceVcsMetadata {
    pub git_branch: Option<String>,
    pub git_head: Option<String>,
    pub dirty: bool,
}

/// Read-only repository facts for the workspace metadata plugin API. Plugins
/// receive these values but never gain access to Git operations themselves.
pub(crate) fn workspace_vcs_metadata(path: &str) -> Option<WorkspaceVcsMetadata> {
    let repo = Repository::discover(path).ok()?;
    let head = repo.head().ok();
    let git_branch = head
        .as_ref()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().map(str::to_string));
    let git_head = head.as_ref().and_then(|head| head.target()).map(|oid| oid.to_string());
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    let dirty = repo
        .statuses(Some(&mut options))
        .ok()
        .is_some_and(|statuses| !statuses.is_empty());
    Some(WorkspaceVcsMetadata {
        git_branch,
        git_head,
        dirty,
    })
}

fn status_label(status: git2::Status) -> &'static str {
    if status.contains(git2::Status::WT_DELETED) || status.contains(git2::Status::INDEX_DELETED) {
        "deleted"
    } else if status.contains(git2::Status::WT_RENAMED)
        || status.contains(git2::Status::INDEX_RENAMED)
    {
        "renamed"
    } else if status.contains(git2::Status::WT_NEW) || status.contains(git2::Status::INDEX_NEW) {
        "added"
    } else if status.contains(git2::Status::WT_TYPECHANGE)
        || status.contains(git2::Status::INDEX_TYPECHANGE)
    {
        "typechange"
    } else {
        "modified"
    }
}

/// Aggregate per-file (+additions, -deletions) from one diff. Binary deltas
/// emit no line callbacks, so they stay at the (0, 0) seeded by the delta cb.
fn diff_line_counts(diff: &mut git2::Diff) -> HashMap<String, (usize, usize)> {
    use std::cell::RefCell;
    let counts = RefCell::new(HashMap::<String, (usize, usize)>::new());
    let file = RefCell::new(String::new());
    if let Err(e) = diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            counts.borrow_mut().entry(path.clone()).or_insert((0, 0));
            *file.borrow_mut() = path;
            true
        },
        None,
        None,
        Some(&mut |_, _, line| {
            let mut counts = counts.borrow_mut();
            let Some(entry) = counts.get_mut(file.borrow().as_str()) else {
                return true;
            };
            match line.origin() {
                '+' => entry.0 += 1,
                '-' => entry.1 += 1,
                _ => {}
            }
            true
        }),
    ) {
        eprintln!("[git] diff line-count walk failed: {e}");
    }
    counts.into_inner()
}

/// (+lines, 0) for an untracked file. Chunked reads, capped at 100k lines:
/// the count only feeds a stats badge, so a huge file must not be slurped.
fn count_untracked_lines(repo: &Repository, file: &str) -> Option<(usize, usize)> {
    use std::io::Read;
    const MAX_COUNTED: usize = 100_000;
    let full = repo.workdir()?.join(file);
    let mut reader = std::io::BufReader::new(std::fs::File::open(full).ok()?);
    let mut lines = 0usize;
    let mut last_byte: Option<u8> = None;
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                lines += chunk[..n].iter().filter(|b| **b == b'\n').count();
                last_byte = chunk.get(n.wrapping_sub(1)).copied();
                if lines >= MAX_COUNTED {
                    lines = MAX_COUNTED;
                    break;
                }
            }
            Err(_) => return None,
        }
    }
    // BufRead::lines also yields a final line without a trailing newline.
    if lines < MAX_COUNTED && last_byte.is_some_and(|b| b != b'\n') {
        lines += 1;
    }
    Some((lines, 0))
}

/// Bucket status entries into staged/unstaged/untracked file lists.
fn collect_status_entries(
    statuses: &git2::Statuses,
) -> (Vec<GitFileEntry>, Vec<GitFileEntry>, Vec<GitFileEntry>) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        if path.is_empty() {
            continue;
        }
        let status = entry.status();
        if status.contains(git2::Status::WT_NEW) && !status.intersects(git2::Status::INDEX_NEW) {
            untracked.push(GitFileEntry {
                path,
                status: "added".to_string(),
                additions: None,
                deletions: None,
            });
            continue;
        }
        if status.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        ) {
            staged.push(GitFileEntry {
                path: path.clone(),
                status: status_label(status).to_string(),
                additions: None,
                deletions: None,
            });
        }
        if status.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_TYPECHANGE
                | git2::Status::WT_RENAMED,
        ) {
            unstaged.push(GitFileEntry {
                path,
                status: status_label(status).to_string(),
                additions: None,
                deletions: None,
            });
        }
    }
    (staged, unstaged, untracked)
}

/// Fill per-file (+/-) stats from one staged + one unstaged diff, and line
/// counts for untracked files straight off disk.
fn fill_line_stats(
    repo: &Repository,
    staged: &mut [GitFileEntry],
    unstaged: &mut [GitFileEntry],
    untracked: &mut [GitFileEntry],
) {
    let head_tree = repo.head().and_then(|h| h.peel_to_tree()).ok();
    let staged_counts = repo
        .diff_tree_to_index(head_tree.as_ref(), None, None)
        .map(|mut d| diff_line_counts(&mut d))
        .unwrap_or_default();
    let unstaged_counts = repo
        .diff_index_to_workdir(None, None)
        .map(|mut d| diff_line_counts(&mut d))
        .unwrap_or_default();
    for entry in staged.iter_mut() {
        if let Some(&(a, d)) = staged_counts.get(&entry.path) {
            entry.additions = Some(a);
            entry.deletions = Some(d);
        }
    }
    for entry in unstaged.iter_mut() {
        if let Some(&(a, d)) = unstaged_counts.get(&entry.path) {
            entry.additions = Some(a);
            entry.deletions = Some(d);
        }
    }
    for entry in untracked.iter_mut() {
        if let Some((a, d)) = count_untracked_lines(repo, &entry.path) {
            entry.additions = Some(a);
            entry.deletions = Some(d);
        }
    }
}

/// Ahead/behind counts vs the branch's upstream. Cheap: two ref lookups plus
/// one commit-graph walk. Returns `None` when there is no upstream to compare
/// against — the UI hides the indicator rather than showing a misleading 0/0.
fn ahead_behind(repo: &Repository) -> Option<(usize, usize)> {
    let head = repo.head().ok()?;
    let local_oid = head.target()?;
    let upstream_name = repo.branch_upstream_name(head.name()?).ok()?;
    let upstream_ref = repo.find_reference(upstream_name.as_str()?).ok()?;
    let upstream_oid = upstream_ref.target()?;
    repo.graph_ahead_behind(local_oid, upstream_oid).ok()
}

/// Sync body of `git_status` — libgit2 walks can touch thousands of files,
/// far too heavy for the IPC main thread.
fn git_status_blocking(path: &str) -> Result<GitStatus, String> {

    let repo = open_repo(path)?;
    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_string))
        .unwrap_or_else(|| "HEAD".to_string());
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let (mut staged, mut unstaged, mut untracked) = collect_status_entries(&statuses);
    fill_line_stats(&repo, &mut staged, &mut unstaged, &mut untracked);
    let (ahead, behind) = ahead_behind(&repo).unzip();
    Ok(GitStatus {
        branch,
        staged,
        unstaged,
        untracked,
        ahead,
        behind,
    })
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Hard cap on the patch text handed to the frontend — with untracked content
/// included, an arbitrarily large new file (build artifact, log) would
/// otherwise be expanded into a full-content patch crossing IPC, while the
/// frontend only ever renders the first DIFF_TRUNCATE_LINES lines.
const MAX_DIFF_PATCH_BYTES: usize = 2 * 1024 * 1024;
/// Appended when MAX_DIFF_PATCH_BYTES cuts the patch short, so the preview
/// shows an explicit boundary instead of silently ending mid-file.
const DIFF_TRUNCATED_MARKER: &str = "[... diff truncated: file too large to preview ...]\n";

/// Sync body of `git_diff` — with untracked content included, a large new
/// file turns into a full-content patch; far too heavy for the IPC main
/// thread, same rationale as `git_status_blocking`.
fn git_diff_blocking(path: &str, file: &str, staged: bool) -> Result<String, String> {
    let repo = open_repo(path)?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file);
    if !staged {
        // Worktree diffs exclude untracked files by default. Include their
        // content so a newly created file produces a real patch for preview.
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
    }
    let diff = if staged {
        let head_tree = repo.head().and_then(|h| h.peel_to_tree()).ok();
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
    }
    .map_err(|e| e.to_string())?;
    let mut text = String::new();
    let mut truncated = false;
    let print_result = diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let content = line.content();
        if text.len() + content.len() + 1 > MAX_DIFF_PATCH_BYTES {
            truncated = true;
            return false;
        }
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            text.push(origin);
        }
        text.push_str(std::str::from_utf8(content).unwrap_or(""));
        true
    });
    match print_result {
        Ok(()) => {}
        // Our own truncation stop: git2 maps a `false` callback to GIT_EUSER.
        Err(e) if truncated && e.code() == git2::ErrorCode::User => {}
        Err(e) => return Err(e.to_string()),
    }
    if truncated {
        if !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(DIFF_TRUNCATED_MARKER);
    }
    Ok(text)
}

#[tauri::command]
pub async fn git_diff(path: String, file: String, staged: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_blocking(&path, &file, staged))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    for file in &files {
        let file_path = std::path::Path::new(file);
        if repo
            .workdir()
            .map(|w| w.join(file_path))
            .map(|p| p.exists())
            .unwrap_or(false)
        {
            index.add_path(file_path).map_err(|e| e.to_string())?;
        } else {
            index.remove_path(file_path).map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let head = repo.head().and_then(|h| h.peel_to_commit());
    let mut index = repo.index().map_err(|e| e.to_string())?;
    match head {
        Ok(commit) => {
            let tree = commit.tree().map_err(|e| e.to_string())?;
            for file in &files {
                let file_path = std::path::Path::new(file);
                match tree.get_path(file_path) {
                    Ok(entry) => {
                        index
                            .add(&git2::IndexEntry {
                                ctime: git2::IndexTime::new(0, 0),
                                mtime: git2::IndexTime::new(0, 0),
                                dev: 0,
                                ino: 0,
                                mode: entry.filemode() as u32,
                                uid: 0,
                                gid: 0,
                                file_size: 0,
                                id: entry.id(),
                                flags: 0,
                                flags_extended: 0,
                                path: file.as_bytes().to_vec(),
                            })
                            .map_err(|e| e.to_string())?;
                    }
                    Err(_) => {
                        // Not in HEAD: staged-new file -> remove from index.
                        let _ = index.remove_path(file_path);
                    }
                }
            }
        }
        Err(_) => {
            // No HEAD yet: clearing the index for these files un-stages them.
            for file in &files {
                let _ = index.remove_path(std::path::Path::new(file));
            }
        }
    }
    index.write().map_err(|e| e.to_string())
}

/// Discard worktree changes (the panel's 撤销更改), matching
/// `git restore --worktree` + `git clean -f`: a path present in the index
/// restores from the index — so hunks already staged survive — while an
/// untracked path is deleted from disk. Staged deletions (in HEAD, removed
/// from the index) are not offered discard in the UI; here they are a no-op.
#[tauri::command]
pub fn git_discard(path: String, files: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let workdir = repo.workdir().ok_or_else(|| "bare repository".to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    for file in &files {
        let file_path = Path::new(file);
        if index.get_path(file_path, 0).is_some() {
            let mut checkout = git2::build::CheckoutBuilder::new();
            checkout.path(file).force();
            repo.checkout_index(Some(&mut index), Some(&mut checkout))
                .map_err(|e| e.to_string())?;
        } else {
            let abs = workdir.join(file_path);
            if abs.is_dir() {
                std::fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
            } else if abs.exists() {
                std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn git_commit(path: String, message: String) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("empty commit message".to_string());
    }
    let repo = open_repo(&path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let sig = repo
        .signature()
        .map_err(|e| format!("git identity not configured (user.name/user.email): {e}"))?;
    let parent = repo.head().and_then(|h| h.peel_to_commit()).ok();
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, trimmed, &tree, &parents)
        .map_err(|e| e.to_string())?;
    Ok(oid.to_string())
}

/// Push/pull run over the network; credential failures should read as
/// actionable guidance, not a libgit2 error dump.
fn map_remote_error(e: git2::Error) -> String {
    let message = e.message().to_string();
    let lower = message.to_lowercase();
    if e.code() == git2::ErrorCode::Auth
        || lower.contains("auth")
        || lower.contains("permission denied")
        || lower.contains("publickey")
        || lower.contains("credentials")
    {
        return format!(
            "git authentication failed: check your credentials / SSH key configuration ({message})"
        );
    }
    message
}
/// Credentials for network remotes, resolved the way the git CLI resolves
/// them: gitconfig credential helpers first (HTTPS: osxkeychain / manager /
/// store…), then ssh-agent. Without this callback libgit2 fails every
/// auth-required remote with "remote authentication required but no callback
/// set".
fn remote_callbacks(config: git2::Config) -> git2::RemoteCallbacks<'static> {
    let mut callbacks = git2::RemoteCallbacks::new();
    callbacks.credentials(move |url, username_from_url, allowed| {
        if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
            if let Ok(cred) = git2::Cred::credential_helper(&config, url, username_from_url) {
                return Ok(cred);
            }
        }
        if allowed.contains(git2::CredentialType::SSH_KEY) {
            let username = username_from_url.unwrap_or("git");
            if let Ok(cred) = git2::Cred::ssh_key_from_agent(username) {
                return Ok(cred);
            }
        }
        // Do not fall back to Cred::default(): its DEFAULT credtype never
        // intersects the allowed set, git2-rs maps that to GIT_PASSTHROUGH,
        // and libgit2 then reports the misleading "authentication required
        // but no callback set". Fail with an actionable message instead.
        Err(git2::Error::from_str(&format!(
            "no usable credentials for {url}: configure a git credential helper (HTTPS) or add your key to ssh-agent (SSH)"
        )))
    });
    callbacks
}

/// Config used to resolve remote credentials. libgit2 only reads
/// `/etc/gitconfig` as the system config, but Apple git (Command Line Tools)
/// keeps its system config — including `credential.helper osxkeychain` —
/// under the CLT directory. Append it at system level so credential helper
/// discovery matches the git CLI; without it HTTPS push/pull on a stock
/// macOS machine finds no helper and fails authentication.
fn remote_config(repo: &Repository) -> Result<git2::Config, String> {
    let mut config = repo.config().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        const APPLE_SYSTEM_CONFIG: &str =
            "/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig";
        let path = Path::new(APPLE_SYSTEM_CONFIG);
        // The System level slot is taken once /etc/gitconfig exists; only
        // fill it from Apple's file when libgit2 found no system config.
        if path.exists() && !Path::new("/etc/gitconfig").exists() {
            config
                .add_file(path, git2::ConfigLevel::System, false)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(config)
}

fn push_options(config: git2::Config) -> git2::PushOptions<'static> {
    let mut opts = git2::PushOptions::new();
    opts.remote_callbacks(remote_callbacks(config));
    opts
}

fn fetch_options(config: git2::Config) -> git2::FetchOptions<'static> {
    let mut opts = git2::FetchOptions::new();
    opts.remote_callbacks(remote_callbacks(config));
    opts
}

#[tauri::command]
pub async fn git_push(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open_repo(&path)?;
        let branch = current_branch_name(&repo)?;
        let mut remote = repo
            .find_remote("origin")
            .map_err(|e| format!("no origin remote: {e}"))?;
        let config = remote_config(&repo)?;
        let mut opts = push_options(config);
        remote
            .push(
                &[format!("refs/heads/{branch}:refs/heads/{branch}")],
                Some(&mut opts),
            )
            .map_err(map_remote_error)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Files the fast-forward would touch that also carry local modifications —
/// the conflict list for a safe (non-force) checkout failure.
fn ff_conflicting_files(repo: &Repository, target: git2::Oid) -> Vec<String> {
    let Ok(head_tree) = repo.head().and_then(|h| h.peel_to_tree()) else {
        return Vec::new();
    };
    let Ok(target_commit) = repo.find_commit(target) else {
        return Vec::new();
    };
    let Ok(target_tree) = target_commit.tree() else {
        return Vec::new();
    };
    let Ok(touched) = repo.diff_tree_to_tree(Some(&head_tree), Some(&target_tree), None) else {
        return Vec::new();
    };
    let mut touched_paths = std::collections::HashSet::new();
    let _ = touched.foreach(
        &mut |delta, _| {
            for p in [delta.old_file().path(), delta.new_file().path()].into_iter().flatten() {
                touched_paths.insert(p.to_string_lossy().into_owned());
            }
            true
        },
        None,
        None,
        None,
    );
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let Ok(statuses) = repo.statuses(Some(&mut opts)) else {
        return Vec::new();
    };
    statuses
        .iter()
        .filter_map(|s| s.path().map(str::to_string))
        .filter(|p| touched_paths.contains(p))
        .collect()
}

/// Sync body of `git_pull` (network fetch + merge analysis).
fn git_pull_blocking(path: &str) -> Result<(), String> {
    let repo = open_repo(path)?;
    let branch = current_branch_name(&repo)?;
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| format!("no origin remote: {e}"))?;
    let config = remote_config(&repo)?;
    let mut opts = fetch_options(config);
    remote
        .fetch(std::slice::from_ref(&branch), Some(&mut opts), None)
        .map_err(map_remote_error)?;
    let fetch_head = repo
        .find_reference("FETCH_HEAD")
        .map_err(|e| e.to_string())?;
    let fetch_commit = repo
        .reference_to_annotated_commit(&fetch_head)
        .map_err(|e| e.to_string())?;
    let (analysis, _) = repo
        .merge_analysis(&[&fetch_commit])
        .map_err(|e| e.to_string())?;
    if analysis.is_up_to_date() {
        return Ok(());
    }
    if analysis.is_fast_forward() {
        let refname = format!("refs/heads/{branch}");
        let mut reference = repo.find_reference(&refname).map_err(|e| e.to_string())?;
        // Safe checkout (no force): a fast-forward must never clobber
        // uncommitted local edits — report the conflicting files instead.
        // Keep HEAD at the old tree until checkout succeeds, otherwise local
        // edits are compared against the new commit and the index is stranded.
        let target = repo.find_commit(fetch_commit.id()).map_err(|e| e.to_string())?;
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.safe();
        if let Err(e) = repo.checkout_tree(target.as_object(), Some(&mut checkout)) {
            let conflicts = ff_conflicting_files(&repo, fetch_commit.id());
            return Err(if conflicts.is_empty() {
                format!("fast-forward checkout failed: {e}")
            } else {
                format!(
                    "pull would overwrite uncommitted changes in: {}",
                    conflicts.join(", ")
                )
            });
        }
        reference
            .set_target(fetch_commit.id(), "fast-forward")
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("pull requires a merge; not supported in v1".to_string())
}

#[tauri::command]
pub async fn git_pull(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git_pull_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn current_branch_name(repo: &Repository) -> Result<String, String> {
    repo.head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(str::to_string))
        .ok_or_else(|| "detached HEAD".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
}

#[tauri::command]
pub fn git_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    let repo = open_repo(&path)?;
    // No is_current flag: consumers compare against the live status branch —
    // a cached flag here goes stale on external (CLI) checkouts.
    let mut out = Vec::new();
    let branches = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| e.to_string())?;
    for branch in branches.flatten() {
        let (b, _) = branch;
        if let Ok(Some(name)) = b.name() {
            out.push(BranchInfo {
                name: name.to_string(),
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn git_checkout(path: String, branch: String) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let (object, reference) = repo
        .revparse_ext(&branch)
        .map_err(|e| format!("unknown branch {branch}: {e}"))?;
    repo.checkout_tree(&object, None)
        .map_err(|e| e.to_string())?;
    match reference {
        Some(r) => repo
            .set_head(r.name().ok_or("invalid ref name")?)
            .map_err(|e| e.to_string()),
        None => repo
            .set_head_detached(object.id())
            .map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub fn git_create_branch(path: String, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("empty branch name".to_string());
    }
    let repo = open_repo(&path)?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.to_string())?;
    let branch = repo
        .branch(trimmed, &head, false)
        .map_err(|e| e.to_string())?;
    let refname = format!(
        "refs/heads/{}",
        branch.name().map_err(|e| e.to_string())?.unwrap_or(trimmed)
    );
    let object = head.as_object().clone();
    repo.checkout_tree(&object, None)
        .map_err(|e| e.to_string())?;
    repo.set_head(&refname).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "ccgui-next-git-summary-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn diff_includes_untracked_file_content() {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        std::fs::write(scratch.0.join("new.txt"), "hello\n").unwrap();
        // Regression: worktree diffs used to return empty for untracked files.
        let unstaged = git_diff_blocking(scratch.0.to_str().unwrap(), "new.txt", false).unwrap();
        assert!(unstaged.contains("+hello"), "unstaged patch: {unstaged}");
        let staged = git_diff_blocking(scratch.0.to_str().unwrap(), "new.txt", true).unwrap();
        assert!(!staged.contains("+hello"), "staged must not leak untracked: {staged}");
    }

    #[test]
    fn binary_untracked_file_shows_marker_not_content() {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        let mut data = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe];
        data.extend(std::iter::repeat(0u8).take(64));
        std::fs::write(scratch.0.join("bin.dat"), &data).unwrap();
        let text = git_diff_blocking(scratch.0.to_str().unwrap(), "bin.dat", false).unwrap();
        assert!(
            text.contains("Binary files /dev/null and b/bin.dat differ"),
            "binary patch shows libgit2 marker: {text}"
        );
    }

    #[test]
    fn diff_is_capped_with_explicit_truncation_marker() {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        let line = "x".repeat(1024);
        let mut content = String::new();
        while content.len() <= MAX_DIFF_PATCH_BYTES {
            content.push_str(&line);
            content.push('\n');
        }
        std::fs::write(scratch.0.join("big.log"), &content).unwrap();
        let text = git_diff_blocking(scratch.0.to_str().unwrap(), "big.log", false).unwrap();
        assert!(text.contains(DIFF_TRUNCATED_MARKER), "marker in: {} bytes", text.len());
        assert!(
            text.len() <= MAX_DIFF_PATCH_BYTES + DIFF_TRUNCATED_MARKER.len() + 1,
            "output bounded: {} bytes",
            text.len()
        );
    }

    fn commit_file(repo: &Repository, relative: &str, content: &str) {
        let workdir = repo.workdir().unwrap();
        std::fs::write(workdir.join(relative), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(relative)).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &signature, &signature, "init", &tree, &parents)
            .unwrap();
    }

    /// Clone with the initial checkout skipped, pin `core.autocrlf=false`, then
    /// check out. The CI Windows runner's global `core.autocrlf=true` otherwise
    /// rewrites the LF blobs to CRLF during clone, so a never-touched file reads
    /// dirty against its LF blob — which blocks the fast-forward that must
    /// preserve unrelated local edits.
    fn clone_lf(origin_url: &str, into: &Path) -> Repository {
        let mut builder = git2::build::RepoBuilder::new();
        // Empty CheckoutBuilder = GIT_CHECKOUT_NONE: no worktree bytes are
        // written until autocrlf is pinned off just below.
        builder.with_checkout(git2::build::CheckoutBuilder::new());
        let repo = builder.clone(origin_url, into).unwrap();
        repo.config().unwrap().set_bool("core.autocrlf", false).unwrap();
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.force();
        repo.checkout_head(Some(&mut checkout)).unwrap();
        repo
    }

    #[test]
    fn pull_conflict_preserves_head_index_and_worktree() {
        for staged in [false, true] {
            let scratch = Scratch::new();
            let origin_path = scratch.0.join("origin");
            let origin = Repository::init(&origin_path).unwrap();
            origin.config().unwrap().set_bool("core.autocrlf", false).unwrap();
            commit_file(&origin, "shared.txt", "base\n");
            let local_path = scratch.0.join("local");
            let local = clone_lf(origin_path.to_str().unwrap(), &local_path);
            let old_head = local.head().unwrap().target().unwrap();
            std::fs::write(local_path.join("shared.txt"), "local\n").unwrap();
            if staged {
                let mut index = local.index().unwrap();
                index.add_path(Path::new("shared.txt")).unwrap();
                index.write().unwrap();
            }
            let old_index = local.index().unwrap().write_tree().unwrap();
            commit_file(&origin, "shared.txt", "remote\n");
            let error = git_pull_blocking(local_path.to_str().unwrap()).unwrap_err();
            assert_eq!(local.head().unwrap().target(), Some(old_head), "{error}");
            assert_eq!(local.index().unwrap().write_tree().unwrap(), old_index);
            assert_eq!(std::fs::read_to_string(local_path.join("shared.txt")).unwrap(), "local\n");
            assert!(error.contains("shared.txt"), "{error}");
        }
    }

    /// HTTPS push/pull on stock macOS relies on `credential.helper
    /// osxkeychain`, which lives in Apple's CLT system gitconfig — a path
    /// libgit2 does not read on its own. `remote_config` must surface it.
    #[cfg(target_os = "macos")]
    #[test]
    fn remote_config_resolves_apple_system_credential_helper() {
        let apple = Path::new("/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig");
        if !apple.exists() || Path::new("/etc/gitconfig").exists() {
            // No Apple system config on this machine; nothing to resolve.
            return;
        }
        let scratch = Scratch::new();
        let repo = Repository::init(&scratch.0).unwrap();
        let config = remote_config(&repo).unwrap();
        let helper = config
            .get_string("credential.helper")
            .expect("credential.helper from Apple's system gitconfig must be visible");
        assert!(!helper.trim().is_empty());
    }

    #[test]
    fn pull_fast_forward_preserves_unrelated_local_changes() {
        let scratch = Scratch::new();
        let origin_path = scratch.0.join("origin");
        let origin = Repository::init(&origin_path).unwrap();
        origin.config().unwrap().set_bool("core.autocrlf", false).unwrap();
        commit_file(&origin, "shared.txt", "base\n");
        commit_file(&origin, "local.txt", "base\n");
        let local_path = scratch.0.join("local");
        let local = clone_lf(origin_path.to_str().unwrap(), &local_path);
        std::fs::write(local_path.join("local.txt"), "staged\n").unwrap();
        let mut index = local.index().unwrap();
        index.add_path(Path::new("local.txt")).unwrap();
        index.write().unwrap();
        let staged_blob = index.get_path(Path::new("local.txt"), 0).unwrap().id;
        std::fs::write(local_path.join("local.txt"), "unstaged\n").unwrap();
        std::fs::write(local_path.join("new.txt"), "untracked\n").unwrap();
        commit_file(&origin, "shared.txt", "remote\n");
        git_pull_blocking(local_path.to_str().unwrap()).unwrap();
        assert_eq!(local.head().unwrap().target(), origin.head().unwrap().target());
        assert_eq!(std::fs::read_to_string(local_path.join("shared.txt")).unwrap(), "remote\n");
        assert_eq!(std::fs::read_to_string(local_path.join("local.txt")).unwrap(), "unstaged\n");
        assert_eq!(std::fs::read_to_string(local_path.join("new.txt")).unwrap(), "untracked\n");
        assert_eq!(local.index().unwrap().get_path(Path::new("local.txt"), 0).unwrap().id, staged_blob);
        git_pull_blocking(local_path.to_str().unwrap()).unwrap();
    }

    #[test]
    fn ordinary_subdirectory_of_a_repo_is_not_a_repository() {
        let scratch = Scratch::new();
        let repo = Repository::init(&scratch.0).unwrap();
        commit_file(&repo, "tracked.txt", "clean\n");
        let plain = scratch.0.join("plain");
        std::fs::create_dir(&plain).unwrap();

        assert!(exact_repository_summary(&plain).is_none());
        assert!(exact_repository_summary(&scratch.0).is_some());
    }

    #[test]
    fn summary_counts_changes_and_untracked_once() {
        let scratch = Scratch::new();
        let nested = scratch.0.join("nested");
        let repo = Repository::init(&nested).unwrap();
        commit_file(&repo, "tracked.txt", "clean\n");
        // Same file modified in the index and the worktree counts once.
        std::fs::write(nested.join("tracked.txt"), "staged\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        std::fs::write(nested.join("tracked.txt"), "changed again\n").unwrap();
        std::fs::write(nested.join("untracked.txt"), "new\n").unwrap();

        let summary = exact_repository_summary(&nested).unwrap();
        assert_eq!(summary.branch, repo.head().unwrap().shorthand().unwrap());
        assert_eq!(summary.changed, 1);
        assert_eq!(summary.untracked, 1);
    }

    #[test]
    fn batch_keeps_only_exact_roots_and_clean_status() {
        let scratch = Scratch::new();
        let repo_root = scratch.0.join("repo");
        let repo = Repository::init(&repo_root).unwrap();
        commit_file(&repo, "tracked.txt", "clean\n");
        let plain = scratch.0.join("plain");
        std::fs::create_dir(&plain).unwrap();

        let summaries = repository_summaries_blocking(vec![
            plain.to_string_lossy().into_owned(),
            repo_root.to_string_lossy().into_owned(),
        ]);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].path, repo_root.to_string_lossy().into_owned());
        assert_eq!(summaries[0].changed, 0);
        assert_eq!(summaries[0].untracked, 0);
    }

    #[test]
    fn file_colors_distinguish_untracked_from_modified() {
        let scratch = Scratch::new();
        let repo_root = scratch.0.join("repo");
        let repo = Repository::init(&repo_root).unwrap();
        commit_file(&repo, "clean.txt", "clean\n");
        commit_file(&repo, "modified.txt", "clean\n");
        std::fs::write(repo_root.join("modified.txt"), "dirty\n").unwrap();
        std::fs::write(repo_root.join("untracked.txt"), "new\n").unwrap();

        let colors = file_tree_colors(
            &repo_root.to_string_lossy(),
            &[
                "clean.txt".to_string(),
                "modified.txt".to_string(),
                "untracked.txt".to_string(),
            ],
        );

        assert_eq!(colors.get("clean.txt"), None, "colors={colors:?}");
        assert_eq!(
            colors.get("modified.txt"),
            Some(&"modified"),
            "colors={colors:?}"
        );
        assert_eq!(
            colors.get("untracked.txt"),
            Some(&"untracked"),
            "colors={colors:?}"
        );
    }

    #[test]
    fn file_colors_are_empty_outside_an_exact_repo() {
        let scratch = Scratch::new();
        let child = scratch.0.join("plain");
        std::fs::create_dir(&child).unwrap();

        let colors = file_tree_colors(
            &child.to_string_lossy(),
            &["whatever.txt".to_string()],
        );

        assert!(colors.is_empty());
    }

    #[test]
    fn folders_inherit_the_dirty_state_of_their_children() {
        let scratch = Scratch::new();
        let repo_root = scratch.0.join("repo");
        let repo = Repository::init(&repo_root).unwrap();
        commit_file(&repo, "clean.txt", "clean\n");
        std::fs::create_dir_all(repo_root.join("sub/deep")).unwrap();
        std::fs::write(repo_root.join("sub/deep/new.txt"), "x\n").unwrap();
        std::fs::create_dir_all(repo_root.join("mixed")).unwrap();
        commit_file(&repo, "mixed/tracked.txt", "clean\n");
        std::fs::write(repo_root.join("mixed/tracked.txt"), "dirty\n").unwrap();
        std::fs::write(repo_root.join("mixed/extra.txt"), "new\n").unwrap();
        std::fs::create_dir(repo_root.join("edited")).unwrap();
        commit_file(&repo, "edited/file.txt", "clean\n");
        std::fs::write(repo_root.join("edited/file.txt"), "dirty\n").unwrap();

        let colors = file_tree_colors(
            &repo_root.to_string_lossy(),
            &[
                "clean.txt".to_string(),
                "sub".to_string(),
                "mixed".to_string(),
                "edited".to_string(),
            ],
        );

        // Spec: folders propagate their children's state — untracked-only
        // → untracked (green), any modified → modified (orange).
        assert_eq!(colors.get("clean.txt"), None, "colors={colors:?}");
        assert_eq!(colors.get("sub"), Some(&"untracked"), "colors={colors:?}");
        assert_eq!(colors.get("mixed"), Some(&"modified"), "colors={colors:?}");
        assert_eq!(colors.get("edited"), Some(&"modified"), "colors={colors:?}");
    }

    #[test]
    fn colors_work_for_a_subdirectory_listing_inside_a_repo() {
        let scratch = Scratch::new();
        let repo_root = scratch.0.join("repo");
        let repo = Repository::init(&repo_root).unwrap();
        std::fs::create_dir_all(repo_root.join("pkg")).unwrap();
        commit_file(&repo, "top.txt", "clean\n");
        commit_file(&repo, "pkg/kept.txt", "clean\n");
        commit_file(&repo, "pkg/inner.txt", "clean\n");
        std::fs::write(repo_root.join("pkg/inner.txt"), "dirty\n").unwrap();
        std::fs::create_dir_all(repo_root.join("pkg/newdir")).unwrap();
        std::fs::write(repo_root.join("pkg/newdir/f.txt"), "x\n").unwrap();

        // Listing `pkg` (a plain subdir): paths are relative to `pkg`.
        let colors = file_tree_colors(
            &repo_root.join("pkg").to_string_lossy(),
            &[
                "kept.txt".to_string(),
                "inner.txt".to_string(),
                "newdir".to_string(),
            ],
        );

        assert_eq!(colors.get("kept.txt"), None, "colors={colors:?}");
        assert_eq!(colors.get("inner.txt"), Some(&"modified"), "colors={colors:?}");
        // An untracked directory lights up green (collapsed `newdir/` entry).
        assert_eq!(colors.get("newdir"), Some(&"untracked"), "colors={colors:?}");
    }

    #[test]
    fn nested_repo_folder_colors_from_its_own_status() {
        // The user's layout: a NON-repo workspace root whose subfolder is a
        // nested repo with changes — the folder name must still light up.
        let scratch = Scratch::new();
        let workspace = scratch.0.join("ws");
        let nested = workspace.join("Project").join("inner-repo");
        std::fs::create_dir_all(&nested).unwrap();
        let repo = Repository::init(&nested).unwrap();
        commit_file(&repo, "tracked.txt", "clean\n");
        std::fs::write(nested.join("tracked.txt"), "dirty\n").unwrap();
        std::fs::write(nested.join("fresh.txt"), "new\n").unwrap();

        let colors = file_tree_colors(
            &workspace.join("Project").to_string_lossy(),
            &["inner-repo".to_string()],
        );

        // Repo roots are blue regardless of their internal state.
        assert_eq!(
            colors.get("inner-repo"),
            Some(&"repository"),
            "colors={colors:?}"
        );
    }

    #[test]
    fn status_reports_ahead_behind_vs_upstream() {
        let scratch = Scratch::new();
        let origin_path = scratch.0.join("origin");
        let origin = Repository::init(&origin_path).unwrap();
        commit_file(&origin, "a.txt", "a\n");

        let local_path = scratch.0.join("local");
        let local =
            Repository::clone(origin_path.to_str().unwrap(), &local_path).unwrap();

        // One local-only commit → ahead 1; one origin-only commit → behind 1
        // once the local repo has fetched it.
        commit_file(&local, "b.txt", "b\n");
        commit_file(&origin, "c.txt", "c\n");
        local
            .find_remote("origin")
            .unwrap()
            .fetch(&["refs/heads/*:refs/remotes/origin/*"], None, None)
            .unwrap();

        let status = git_status_blocking(local_path.to_str().unwrap()).unwrap();
        assert_eq!(status.ahead, Some(1), "status={status:?}");
        assert_eq!(status.behind, Some(1), "status={status:?}");
    }

    #[test]
    fn status_omits_ahead_behind_without_upstream() {
        let scratch = Scratch::new();
        let repo_path = scratch.0.join("plain");
        let repo = Repository::init(&repo_path).unwrap();
        commit_file(&repo, "a.txt", "a\n");

        let status = git_status_blocking(repo_path.to_str().unwrap()).unwrap();
        assert_eq!(status.ahead, None, "status={status:?}");
        assert_eq!(status.behind, None, "status={status:?}");
    }

    #[test]
    fn discard_restores_worktree_from_index_preserving_staged_hunks() {
        for (autocrlf, expected) in [(false, "staged\n"), (true, "staged\r\n")] {
            let scratch = Scratch::new();
            let repo = Repository::init(&scratch.0).unwrap();
            repo.config().unwrap().set_bool("core.autocrlf", autocrlf).unwrap();
            repo.config().unwrap().set_str("core.eol", "lf").unwrap();
            commit_file(&repo, "a.txt", "base\n");
            std::fs::write(scratch.0.join("a.txt"), "staged\n").unwrap();
            {
                let mut index = repo.index().unwrap();
                index.add_path(Path::new("a.txt")).unwrap();
                index.write().unwrap();
            }
            let staged_blob = repo.index().unwrap().get_path(Path::new("a.txt"), 0).unwrap().id;
            std::fs::write(scratch.0.join("a.txt"), "unstaged\n").unwrap();

            git_discard(scratch.0.to_string_lossy().into_owned(), vec!["a.txt".to_string()]).unwrap();

            assert_eq!(std::fs::read_to_string(scratch.0.join("a.txt")).unwrap(), expected);
            assert_eq!(repo.index().unwrap().get_path(Path::new("a.txt"), 0).unwrap().id, staged_blob);
            assert_eq!(repo.find_blob(staged_blob).unwrap().content(), b"staged\n");
        }
    }

    #[test]
    fn discard_restores_unstaged_deletion() {
        for (autocrlf, expected) in [(false, "keep\n"), (true, "keep\r\n")] {
            let scratch = Scratch::new();
            let repo = Repository::init(&scratch.0).unwrap();
            repo.config().unwrap().set_bool("core.autocrlf", autocrlf).unwrap();
            repo.config().unwrap().set_str("core.eol", "lf").unwrap();
            commit_file(&repo, "a.txt", "keep\n");
            let staged_tree = repo.index().unwrap().write_tree().unwrap();
            std::fs::remove_file(scratch.0.join("a.txt")).unwrap();

            git_discard(scratch.0.to_string_lossy().into_owned(), vec!["a.txt".to_string()]).unwrap();

            assert_eq!(std::fs::read_to_string(scratch.0.join("a.txt")).unwrap(), expected);
            assert_eq!(repo.index().unwrap().write_tree().unwrap(), staged_tree);
        }
    }

    #[test]
    fn discard_keeps_staged_new_file_content() {
        for (autocrlf, expected) in [(false, "fresh\n"), (true, "fresh\r\n")] {
            let scratch = Scratch::new();
            let repo = Repository::init(&scratch.0).unwrap();
            repo.config().unwrap().set_bool("core.autocrlf", autocrlf).unwrap();
            repo.config().unwrap().set_str("core.eol", "lf").unwrap();
            commit_file(&repo, "base.txt", "base\n");
            std::fs::write(scratch.0.join("new.txt"), "fresh\n").unwrap();
            {
                let mut index = repo.index().unwrap();
                index.add_path(Path::new("new.txt")).unwrap();
                index.write().unwrap();
            }
            let staged_tree = repo.index().unwrap().write_tree().unwrap();

            git_discard(scratch.0.to_string_lossy().into_owned(), vec!["new.txt".to_string()]).unwrap();

            assert_eq!(std::fs::read_to_string(scratch.0.join("new.txt")).unwrap(), expected);
            assert_eq!(repo.index().unwrap().write_tree().unwrap(), staged_tree);
        }
    }

    #[test]
    fn discard_removes_untracked_file() {
        let scratch = Scratch::new();
        let repo = Repository::init(&scratch.0).unwrap();
        commit_file(&repo, "a.txt", "a\n");
        std::fs::create_dir_all(scratch.0.join("sub")).unwrap();
        std::fs::write(scratch.0.join("sub/new.txt"), "x\n").unwrap();

        git_discard(
            scratch.0.to_string_lossy().into_owned(),
            vec!["sub/new.txt".to_string()],
        )
        .unwrap();

        assert!(!scratch.0.join("sub/new.txt").exists());
        assert_eq!(std::fs::read_to_string(scratch.0.join("a.txt")).unwrap(), "a\n");
    }
}
