use std::collections::HashSet;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{CoreError, CoreResult};

const MAX_STDOUT_BYTES: usize = 20 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRepositoryResult {
    pub root: String,
    pub head: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffTargetDefaults {
    pub base: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compare: Option<String>,
    pub include_staged: bool,
    pub include_unstaged: bool,
    pub dirty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct Repository {
    root: PathBuf,
    canonical_root: PathBuf,
    head: String,
}

impl Repository {
    pub(crate) fn open(path: &Path) -> CoreResult<Self> {
        let root_output = git(path, &["rev-parse", "--show-toplevel"])?;
        let root = PathBuf::from(trim_newlines(&root_output));
        let canonical_root = dunce::canonicalize(&root).map_err(|_| CoreError::GitCommandFailed)?;
        let head = git(&root, &["rev-parse", "--short", "HEAD"])
            .map(|output| trim_newlines(&output).to_owned())
            .unwrap_or_default();

        Ok(Self {
            root,
            canonical_root,
            head,
        })
    }

    pub(crate) fn result(&self) -> OpenRepositoryResult {
        OpenRepositoryResult {
            root: self.root.to_string_lossy().into_owned(),
            head: self.head.clone(),
        }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn canonical_key(&self) -> String {
        canonical_key(&self.canonical_root)
    }

    pub(crate) fn diff_target_defaults(&self) -> CoreResult<DiffTargetDefaults> {
        let status = git(&self.root, &["status", "--porcelain=v1", "-uall"])?;
        let dirty = !trim_newlines(&status).is_empty();
        let upstream = self.default_upstream();

        if dirty {
            return Ok(DiffTargetDefaults {
                base: "HEAD".to_owned(),
                compare: None,
                include_staged: true,
                include_unstaged: true,
                dirty: true,
                upstream,
            });
        }

        Ok(DiffTargetDefaults {
            base: upstream.clone().unwrap_or_else(|| "HEAD".to_owned()),
            compare: Some("HEAD".to_owned()),
            include_staged: false,
            include_unstaged: false,
            dirty: false,
            upstream,
        })
    }

    pub(crate) fn list_branches(&self) -> CoreResult<Vec<BranchInfo>> {
        let output = git(
            &self.root,
            &[
                "for-each-ref",
                "--format=%(refname:short)%09%(HEAD)",
                "refs/heads",
                "refs/remotes",
            ],
        )?;
        let mut seen = HashSet::new();
        let mut branches = Vec::new();

        for line in output.lines() {
            let mut fields = line.split('\t');
            let Some(name) = fields.next() else {
                continue;
            };
            if name.is_empty() || name.ends_with("/HEAD") || !seen.insert(name.to_owned()) {
                continue;
            }
            branches.push(BranchInfo {
                name: name.to_owned(),
                current: fields.next() == Some("*"),
            });
        }

        branches.sort_by(|left, right| {
            right.current.cmp(&left.current).then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
        });
        Ok(branches)
    }

    fn default_upstream(&self) -> Option<String> {
        if let Ok(output) = git(
            &self.root,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        ) {
            let value = trim_newlines(&output);
            if !value.is_empty() {
                return Some(value.to_owned());
            }
        }

        ["origin/main", "origin/master"]
            .into_iter()
            .find(|reference| git(&self.root, &["rev-parse", "--verify", reference]).is_ok())
            .map(str::to_owned)
    }
}

fn git(repo_path: &Path, args: &[&str]) -> CoreResult<String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| CoreError::GitCommandFailed)?;
    let stdout = child.stdout.take().ok_or(CoreError::GitCommandFailed)?;
    let stderr = child.stderr.take().ok_or(CoreError::GitCommandFailed)?;
    let (limit_sender, limit_receiver) = mpsc::channel();
    let stdout_reader = read_bounded(stdout, MAX_STDOUT_BYTES, limit_sender.clone());
    let stderr_reader = read_bounded(stderr, MAX_STDERR_BYTES, limit_sender);
    let mut exceeded_limit = false;

    let status = loop {
        if limit_receiver.try_recv().is_ok() {
            exceeded_limit = true;
            let _ = child.kill();
            break child.wait().map_err(|_| CoreError::GitCommandFailed)?;
        }
        if let Some(status) = child.try_wait().map_err(|_| CoreError::GitCommandFailed)? {
            break status;
        }
        thread::sleep(Duration::from_millis(1));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| CoreError::GitCommandFailed)?
        .map_err(|_| CoreError::GitCommandFailed)?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| CoreError::GitCommandFailed)?
        .map_err(|_| CoreError::GitCommandFailed)?;

    if !status.success()
        || exceeded_limit
        || stdout.len() > MAX_STDOUT_BYTES
        || stderr.len() > MAX_STDERR_BYTES
    {
        return Err(CoreError::GitCommandFailed);
    }

    String::from_utf8(stdout).map_err(|_| CoreError::GitCommandFailed)
}

fn read_bounded(
    reader: impl Read + Send + 'static,
    limit: usize,
    limit_sender: mpsc::Sender<()>,
) -> thread::JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut output = Vec::with_capacity(limit.min(64 * 1024));
        reader.take((limit + 1) as u64).read_to_end(&mut output)?;
        if output.len() > limit {
            let _ = limit_sender.send(());
        }
        Ok(output)
    })
}

fn trim_newlines(value: &str) -> &str {
    value.trim_end_matches(['\r', '\n'])
}

pub(crate) fn canonical_key(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::Command;

    use tempfile::TempDir;

    use super::*;

    fn git_ok(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Diffuse Test")
            .env("GIT_AUTHOR_EMAIL", "diffuse@example.test")
            .env("GIT_COMMITTER_NAME", "Diffuse Test")
            .env("GIT_COMMITTER_EMAIL", "diffuse@example.test")
            .status()
            .expect("run git");
        assert!(status.success(), "git command failed: {args:?}");
    }

    fn repository() -> (TempDir, Repository) {
        let temp = TempDir::new().expect("temporary repository");
        git_ok(temp.path(), &["init", "--initial-branch=main"]);
        fs::write(temp.path().join("README.md"), "fixture\n").expect("write fixture");
        git_ok(temp.path(), &["add", "."]);
        git_ok(temp.path(), &["commit", "-m", "initial"]);
        let repository = Repository::open(temp.path()).expect("open repository");
        (temp, repository)
    }

    #[test]
    fn opens_nested_repository_paths() {
        let (temp, _) = repository();
        fs::create_dir(temp.path().join("nested")).expect("create nested directory");
        let opened = Repository::open(&temp.path().join("nested")).expect("open nested path");
        assert_eq!(opened.root(), temp.path());
        assert!(!opened.head.is_empty());
    }

    #[test]
    fn chooses_dirty_and_clean_defaults() {
        let (temp, repository) = repository();
        let clean = repository.diff_target_defaults().expect("clean defaults");
        assert_eq!(clean.base, "HEAD");
        assert_eq!(clean.compare.as_deref(), Some("HEAD"));
        assert!(!clean.dirty);

        fs::write(temp.path().join("README.md"), "changed\n").expect("change fixture");
        let dirty = repository.diff_target_defaults().expect("dirty defaults");
        assert_eq!(dirty.base, "HEAD");
        assert_eq!(dirty.compare, None);
        assert!(dirty.include_staged && dirty.include_unstaged && dirty.dirty);
    }

    #[test]
    fn lists_current_branch_first_and_filters_remote_head() {
        let (temp, repository) = repository();
        git_ok(temp.path(), &["branch", "zebra"]);
        git_ok(temp.path(), &["branch", "alpha"]);
        let branches = repository.list_branches().expect("list branches");
        assert_eq!(
            branches[0],
            BranchInfo {
                name: "main".to_owned(),
                current: true
            }
        );
        assert_eq!(branches[1].name, "alpha");
        assert_eq!(branches[2].name, "zebra");
    }
}
