use std::collections::HashSet;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffTarget {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_empty",
        skip_serializing_if = "Option::is_none"
    )]
    pub base: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_empty",
        skip_serializing_if = "Option::is_none"
    )]
    pub compare: Option<String>,
    #[serde(
        default = "default_true",
        deserialize_with = "deserialize_default_true"
    )]
    pub include_staged: bool,
    #[serde(
        default = "default_true",
        deserialize_with = "deserialize_default_true"
    )]
    pub include_unstaged: bool,
}

impl Default for DiffTarget {
    fn default() -> Self {
        Self {
            base: None,
            compare: None,
            include_staged: true,
            include_unstaged: true,
        }
    }
}

const fn default_true() -> bool {
    true
}

fn deserialize_optional_non_empty<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?.filter(|value| !value.is_empty()))
}

fn deserialize_default_true<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<bool>::deserialize(deserializer)?.unwrap_or(true))
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

    pub(crate) fn list_changed_files(&self, target: &DiffTarget) -> CoreResult<Vec<ChangedFile>> {
        let name_status = self.git_diff(target, &["--name-status", "-M"], None)?;
        let numstat = self.git_diff(target, &["--numstat"], None)?;
        let mut files = Vec::new();

        for line in name_status.lines() {
            if line.is_empty() {
                continue;
            }
            let mut fields = line.split('\t');
            let Some(status_text) = fields.next() else {
                continue;
            };
            let status = file_status_from_name_status(status_text);
            let Some(first_path) = fields.next() else {
                continue;
            };
            let (old_path, new_path) = if status == FileStatus::Renamed {
                (
                    Some(first_path.to_owned()),
                    fields.next().unwrap_or(first_path),
                )
            } else {
                (None, first_path)
            };
            if new_path.is_empty() {
                continue;
            }
            let (additions, deletions) = parse_numstat(&numstat, new_path);

            files.push(ChangedFile {
                id: new_path.to_owned(),
                old_path,
                new_path: Some(new_path.to_owned()),
                status,
                additions,
                deletions,
                signature: self.diff_signature(target, new_path)?,
            });
        }

        Ok(files)
    }

    pub(crate) fn git_diff(
        &self,
        target: &DiffTarget,
        flags: &[&str],
        path: Option<&str>,
    ) -> CoreResult<String> {
        let output = self.git_diff_bytes(target, flags, path)?;
        String::from_utf8(output).map_err(|_| CoreError::GitCommandFailed)
    }

    fn git_diff_bytes(
        &self,
        target: &DiffTarget,
        flags: &[&str],
        path: Option<&str>,
    ) -> CoreResult<Vec<u8>> {
        if target.compare.is_none() && !target.include_staged && !target.include_unstaged {
            return Ok(Vec::new());
        }

        let mut args = Vec::with_capacity(flags.len() + 5);
        args.push("diff");
        args.extend_from_slice(flags);

        if let Some(compare) = target.compare.as_deref() {
            args.push(target.base.as_deref().unwrap_or("HEAD"));
            args.push(compare);
        } else if target.include_staged && target.include_unstaged {
            args.push(target.base.as_deref().unwrap_or("HEAD"));
        } else if target.include_staged {
            args.push("--cached");
            args.push(target.base.as_deref().unwrap_or("HEAD"));
        }

        if let Some(path) = path {
            args.push("--");
            args.push(path);
        }

        git_bytes(&self.root, &args)
    }

    fn diff_signature(&self, target: &DiffTarget, path: &str) -> CoreResult<String> {
        let diff = self.git_diff_bytes(target, &["--binary"], Some(path))?;
        Ok(hex_sha256(&diff))
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

pub(crate) fn git(repo_path: &Path, args: &[&str]) -> CoreResult<String> {
    let stdout = git_bytes(repo_path, args)?;
    String::from_utf8(stdout).map_err(|_| CoreError::GitCommandFailed)
}

fn git_bytes(repo_path: &Path, args: &[&str]) -> CoreResult<Vec<u8>> {
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

    Ok(stdout)
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

fn file_status_from_name_status(status: &str) -> FileStatus {
    match status.as_bytes().first() {
        Some(b'R') => FileStatus::Renamed,
        Some(b'A') => FileStatus::Added,
        Some(b'D') => FileStatus::Deleted,
        _ => FileStatus::Modified,
    }
}

fn parse_numstat(output: &str, path: &str) -> (u32, u32) {
    for line in output.lines() {
        let mut fields = line.split('\t');
        let Some(additions) = fields.next() else {
            continue;
        };
        let Some(deletions) = fields.next() else {
            continue;
        };
        if fields.next() != Some(path) {
            continue;
        }
        return (
            additions.parse().unwrap_or(0),
            deletions.parse().unwrap_or(0),
        );
    }
    (0, 0)
}

fn hex_sha256(input: &[u8]) -> String {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut padded = input.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    let mut hash = INITIAL;
    for chunk in padded.chunks_exact(64) {
        let mut words = [0_u32; 64];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes(chunk[offset..offset + 4].try_into().unwrap());
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = hash;
        for index in 0..64 {
            let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(sum1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = sum0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (value, update) in hash.iter_mut().zip([a, b, c, d, e, f, g, h].into_iter()) {
            *value = value.wrapping_add(update);
        }
    }

    use std::fmt::Write as _;
    let mut output = String::with_capacity(64);
    for value in hash {
        write!(output, "{value:08x}").unwrap();
    }
    output
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

    #[test]
    fn diff_target_and_changed_file_json_match_the_protocol() {
        let target: DiffTarget = serde_json::from_str(
            r#"{"base":"","compare":null,"includeStaged":null,"includeUnstaged":null}"#,
        )
        .unwrap();
        assert_eq!(target, DiffTarget::default());
        assert_eq!(
            serde_json::to_value(&target).unwrap(),
            serde_json::json!({ "includeStaged": true, "includeUnstaged": true })
        );

        let file = ChangedFile {
            id: "new.rs".to_owned(),
            old_path: None,
            new_path: Some("new.rs".to_owned()),
            status: FileStatus::Added,
            additions: 2,
            deletions: 0,
            signature: "abc".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(file).unwrap(),
            serde_json::json!({
                "id": "new.rs",
                "newPath": "new.rs",
                "status": "added",
                "additions": 2,
                "deletions": 0,
                "signature": "abc"
            })
        );
    }

    #[test]
    fn lists_changed_files_with_zig_rename_count_and_signature_semantics() {
        let (temp, repository) = repository();
        fs::create_dir(temp.path().join("src")).unwrap();
        fs::create_dir(temp.path().join("docs")).unwrap();
        fs::write(temp.path().join("src/main.rs"), "old\n").unwrap();
        fs::write(temp.path().join("src/legacy.rs"), "legacy\n").unwrap();
        fs::write(temp.path().join("docs/removed.md"), "removed\n").unwrap();
        git_ok(temp.path(), &["add", "."]);
        git_ok(temp.path(), &["commit", "-m", "fixture"]);

        fs::write(temp.path().join("src/main.rs"), "new\n").unwrap();
        fs::write(temp.path().join("src/added.rs"), "one\ntwo\n").unwrap();
        git_ok(temp.path(), &["add", "src/added.rs"]);
        git_ok(temp.path(), &["mv", "src/legacy.rs", "src/renamed.rs"]);
        fs::remove_file(temp.path().join("docs/removed.md")).unwrap();

        let mut files = repository
            .list_changed_files(&DiffTarget::default())
            .unwrap();
        files.sort_by(|left, right| left.id.cmp(&right.id));
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].id, "docs/removed.md");
        assert_eq!(files[0].status, FileStatus::Deleted);
        assert_eq!((files[0].additions, files[0].deletions), (0, 1));
        assert_eq!(files[0].new_path.as_deref(), Some("docs/removed.md"));
        assert_eq!(files[1].id, "src/added.rs");
        assert_eq!(files[1].status, FileStatus::Added);
        assert_eq!((files[1].additions, files[1].deletions), (2, 0));
        assert_eq!(files[2].id, "src/main.rs");
        assert_eq!(files[2].status, FileStatus::Modified);
        assert_eq!((files[2].additions, files[2].deletions), (1, 1));
        assert_eq!(files[3].id, "src/renamed.rs");
        assert_eq!(files[3].old_path.as_deref(), Some("src/legacy.rs"));
        assert_eq!(files[3].new_path.as_deref(), Some("src/renamed.rs"));
        assert_eq!(files[3].status, FileStatus::Renamed);
        assert_eq!((files[3].additions, files[3].deletions), (0, 0));
        assert!(files.iter().all(|file| {
            file.signature.len() == 64
                && file.signature.bytes().all(|byte| byte.is_ascii_hexdigit())
        }));
    }

    #[test]
    fn git_diff_preserves_all_target_modes_and_errors() {
        let (temp, repository) = repository();
        fs::write(temp.path().join("README.md"), "staged\n").unwrap();
        git_ok(temp.path(), &["add", "README.md"]);
        fs::write(temp.path().join("README.md"), "working\n").unwrap();

        let both = repository
            .git_diff(&DiffTarget::default(), &[], Some("README.md"))
            .unwrap();
        assert!(both.contains("-fixture") && both.contains("+working"));

        let staged = repository
            .git_diff(
                &DiffTarget {
                    include_unstaged: false,
                    ..DiffTarget::default()
                },
                &[],
                Some("README.md"),
            )
            .unwrap();
        assert!(staged.contains("-fixture") && staged.contains("+staged"));
        assert!(!staged.contains("working"));

        let unstaged = repository
            .git_diff(
                &DiffTarget {
                    include_staged: false,
                    ..DiffTarget::default()
                },
                &[],
                Some("README.md"),
            )
            .unwrap();
        assert!(unstaged.contains("-staged") && unstaged.contains("+working"));

        let neither = repository
            .git_diff(
                &DiffTarget {
                    include_staged: false,
                    include_unstaged: false,
                    ..DiffTarget::default()
                },
                &[],
                Some("README.md"),
            )
            .unwrap();
        assert!(neither.is_empty());

        let invalid = repository.git_diff(
            &DiffTarget {
                base: Some("missing-ref".to_owned()),
                compare: Some("HEAD".to_owned()),
                include_staged: false,
                include_unstaged: false,
            },
            &[],
            None,
        );
        assert!(matches!(invalid, Err(CoreError::GitCommandFailed)));
    }

    #[test]
    fn compare_target_ignores_worktree_flags() {
        let (temp, repository) = repository();
        fs::write(temp.path().join("README.md"), "committed\n").unwrap();
        git_ok(temp.path(), &["add", "README.md"]);
        git_ok(temp.path(), &["commit", "-m", "second"]);
        fs::write(temp.path().join("README.md"), "uncommitted\n").unwrap();

        let output = repository
            .git_diff(
                &DiffTarget {
                    base: Some("HEAD~1".to_owned()),
                    compare: Some("HEAD".to_owned()),
                    include_staged: true,
                    include_unstaged: true,
                },
                &[],
                Some("README.md"),
            )
            .unwrap();
        assert!(output.contains("-fixture") && output.contains("+committed"));
        assert!(!output.contains("uncommitted"));
    }

    #[test]
    fn sha256_matches_standard_vectors() {
        assert_eq!(
            hex_sha256(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
