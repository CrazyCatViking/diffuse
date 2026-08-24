use std::fs::File;
use std::io::Read;

use serde::{Deserialize, Deserializer, Serialize};

use crate::repository::{DiffTarget, Repository, git};
use crate::{CoreError, CoreResult};

const MAX_SOURCE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffViewMode {
    #[default]
    Split,
    Inline,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffContextMode {
    #[default]
    Diff,
    Full,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffIntelligence {
    Basic,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DiffRenderOptions {
    pub mode: DiffViewMode,
    pub context: DiffContextMode,
    #[serde(
        default,
        deserialize_with = "deserialize_intelligence",
        skip_serializing_if = "Option::is_none"
    )]
    pub intelligence: Option<DiffIntelligence>,
}

fn deserialize_intelligence<'de, D>(deserializer: D) -> Result<Option<DiffIntelligence>, D::Error>
where
    D: Deserializer<'de>,
{
    DiffIntelligence::deserialize(deserializer).map(Some)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffRowKind {
    Context,
    Added,
    Deleted,
    Modified,
    Hunk,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSpan {
    pub start_column: u32,
    pub end_column: u32,
    pub scope: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub grammar_installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grammar_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlights_query_path: Option<String>,
    pub highlights_installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_reason: Option<String>,
}

impl SyntaxStatus {
    fn unavailable() -> Self {
        Self {
            language: None,
            grammar_installed: false,
            grammar_path: None,
            highlights_query_path: None,
            highlights_installed: false,
            missing_reason: Some("syntax-unavailable".to_owned()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub kind: DiffRowKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunk_header: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_syntax_spans: Option<Vec<SyntaxSpan>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_syntax_spans: Option<Vec<SyntaxSpan>>,
}

impl DiffRow {
    fn new(kind: DiffRowKind) -> Self {
        Self {
            kind,
            old_line: None,
            new_line: None,
            old_text: None,
            new_text: None,
            text: None,
            hunk_header: None,
            old_syntax_spans: None,
            new_syntax_spans: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRenderModel {
    pub file_id: String,
    pub mode: DiffViewMode,
    pub context: DiffContextMode,
    pub syntax: SyntaxStatus,
    pub rows: Vec<DiffRow>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyntaxSide {
    Old,
    New,
}

pub(crate) fn get_diff_render_model(
    repository: &Repository,
    file_id: &str,
    path: &str,
    options: DiffRenderOptions,
    target: &DiffTarget,
) -> CoreResult<DiffRenderModel> {
    let flags: &[&str] = match options.context {
        DiffContextMode::Diff => &[],
        DiffContextMode::Full => &["-U999999"],
    };
    let output = repository.git_diff(target, flags, Some(path))?;

    Ok(DiffRenderModel {
        file_id: file_id.to_owned(),
        mode: options.mode,
        context: options.context,
        syntax: SyntaxStatus::unavailable(),
        rows: parse_unified_diff(&output),
    })
}

pub(crate) fn source_for_side(
    repository: &Repository,
    path: &str,
    side: SyntaxSide,
    target: &DiffTarget,
) -> CoreResult<String> {
    let result = if let Some(compare) = target.compare.as_deref() {
        match side {
            SyntaxSide::Old => {
                source_from_ref(repository, target.base.as_deref().unwrap_or("HEAD"), path)
            }
            SyntaxSide::New => source_from_ref(repository, compare, path),
        }
    } else if target.include_staged && !target.include_unstaged {
        match side {
            SyntaxSide::Old => {
                source_from_ref(repository, target.base.as_deref().unwrap_or("HEAD"), path)
            }
            SyntaxSide::New => source_from_index(repository, path),
        }
    } else if !target.include_staged && target.include_unstaged {
        match side {
            SyntaxSide::Old => source_from_index(repository, path),
            SyntaxSide::New => source_from_working_tree(repository, path),
        }
    } else {
        match side {
            SyntaxSide::Old => {
                source_from_ref(repository, target.base.as_deref().unwrap_or("HEAD"), path)
            }
            SyntaxSide::New => source_from_working_tree(repository, path),
        }
    };

    match result {
        Ok(source) => Ok(source),
        Err(_) => Ok(String::new()),
    }
}

fn source_from_index(repository: &Repository, path: &str) -> CoreResult<String> {
    git(repository.root(), &["show", &format!(":{path}")])
}

fn source_from_ref(repository: &Repository, reference: &str, path: &str) -> CoreResult<String> {
    git(repository.root(), &["show", &format!("{reference}:{path}")])
}

fn source_from_working_tree(repository: &Repository, path: &str) -> CoreResult<String> {
    let mut file = File::open(repository.root().join(path))?;
    let mut source = Vec::with_capacity(64 * 1024);
    file.by_ref()
        .take((MAX_SOURCE_BYTES + 1) as u64)
        .read_to_end(&mut source)?;
    if source.len() > MAX_SOURCE_BYTES {
        return Err(CoreError::Io(std::io::Error::other(
            "source file too large",
        )));
    }
    String::from_utf8(source)
        .map_err(|error| CoreError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, error)))
}

fn parse_unified_diff(input: &str) -> Vec<DiffRow> {
    let mut rows = Vec::new();
    let mut old_line = 0;
    let mut new_line = 0;

    for raw_line in input.split('\n') {
        let line = raw_line.trim_end_matches('\r');
        if line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
        {
            continue;
        }

        if line.starts_with("@@") {
            (old_line, new_line) = parse_hunk_header(line);
            let mut row = DiffRow::new(DiffRowKind::Hunk);
            row.text = Some(line.to_owned());
            row.hunk_header = Some(line.to_owned());
            rows.push(row);
            continue;
        }

        let Some((prefix, text)) = line.as_bytes().split_first() else {
            continue;
        };
        let text = String::from_utf8_lossy(text).into_owned();
        match prefix {
            b' ' => {
                let mut row = DiffRow::new(DiffRowKind::Context);
                row.old_line = Some(old_line);
                row.new_line = Some(new_line);
                row.old_text = Some(text.clone());
                row.new_text = Some(text);
                rows.push(row);
                old_line += 1;
                new_line += 1;
            }
            b'-' => {
                let mut row = DiffRow::new(DiffRowKind::Deleted);
                row.old_line = Some(old_line);
                row.old_text = Some(text);
                rows.push(row);
                old_line += 1;
            }
            b'+' => {
                let mut row = DiffRow::new(DiffRowKind::Added);
                row.new_line = Some(new_line);
                row.new_text = Some(text);
                rows.push(row);
                new_line += 1;
            }
            _ => {}
        }
    }

    rows
}

fn parse_hunk_header(line: &str) -> (u32, u32) {
    let mut parts = line.split(' ');
    let _ = parts.next();
    let old_start = parts
        .next()
        .and_then(|part| part.strip_prefix('-'))
        .map(parse_start)
        .unwrap_or(0);
    let new_start = parts
        .next()
        .and_then(|part| part.strip_prefix('+'))
        .map(parse_start)
        .unwrap_or(0);
    (old_start, new_start)
}

fn parse_start(value: &str) -> u32 {
    value
        .split_once(',')
        .map_or(value, |(start, _)| start)
        .parse()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
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

    fn repository(contents: &str) -> (TempDir, Repository) {
        let temp = TempDir::new().expect("temporary repository");
        git_ok(temp.path(), &["init", "--initial-branch=main"]);
        fs::write(temp.path().join("fixture.txt"), contents).expect("write fixture");
        git_ok(temp.path(), &["add", "."]);
        git_ok(temp.path(), &["commit", "-m", "initial"]);
        let repository = Repository::open(temp.path()).expect("open repository");
        (temp, repository)
    }

    #[test]
    fn parses_unified_rows_and_omits_absent_json_fields() {
        let rows = parse_unified_diff(
            "diff --git a/a b/a\r\nindex 1..2 100644\r\n--- a/a\r\n+++ b/a\r\n@@ -2,3 +4,3 @@ label\r\n same\r\n-old\r\n+new\r\n+\r\n\\ No newline at end of file\r\n",
        );
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0].kind, DiffRowKind::Hunk);
        assert_eq!(
            rows[0].hunk_header.as_deref(),
            Some("@@ -2,3 +4,3 @@ label")
        );
        assert_eq!(rows[1].old_line, Some(2));
        assert_eq!(rows[1].new_line, Some(4));
        assert_eq!(rows[1].old_text.as_deref(), Some("same"));
        assert_eq!(rows[2].kind, DiffRowKind::Deleted);
        assert_eq!(rows[2].old_line, Some(3));
        assert_eq!(rows[3].kind, DiffRowKind::Added);
        assert_eq!(rows[3].new_line, Some(5));
        assert_eq!(rows[4].new_text.as_deref(), Some(""));
        assert_eq!(
            serde_json::to_value(&rows[2]).unwrap(),
            serde_json::json!({ "kind": "deleted", "oldLine": 3, "oldText": "old" })
        );
    }

    #[test]
    fn render_options_and_syntax_status_match_the_json_contract() {
        let options: DiffRenderOptions = serde_json::from_str(r#"{"mode":"inline"}"#).unwrap();
        assert_eq!(options.mode, DiffViewMode::Inline);
        assert_eq!(options.context, DiffContextMode::Diff);
        assert!(serde_json::from_str::<DiffRenderOptions>(r#"{"intelligence":"full"}"#).is_err());
        assert!(serde_json::from_str::<DiffRenderOptions>(r#"{"intelligence":null}"#).is_err());

        let model = DiffRenderModel {
            file_id: "a.rs".to_owned(),
            mode: DiffViewMode::Split,
            context: DiffContextMode::Diff,
            syntax: SyntaxStatus::unavailable(),
            rows: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(model).unwrap(),
            serde_json::json!({
                "fileId": "a.rs",
                "mode": "split",
                "context": "diff",
                "syntax": {
                    "grammarInstalled": false,
                    "highlightsInstalled": false,
                    "missingReason": "syntax-unavailable"
                },
                "rows": []
            })
        );
    }

    #[test]
    fn resolves_sources_for_combined_staged_and_unstaged_targets() {
        let (temp, repository) = repository("base\n");
        fs::write(temp.path().join("fixture.txt"), "staged\n").unwrap();
        git_ok(temp.path(), &["add", "fixture.txt"]);
        fs::write(temp.path().join("fixture.txt"), "working\n").unwrap();

        assert_eq!(
            source_for_side(
                &repository,
                "fixture.txt",
                SyntaxSide::Old,
                &DiffTarget::default()
            )
            .unwrap(),
            "base\n"
        );
        assert_eq!(
            source_for_side(
                &repository,
                "fixture.txt",
                SyntaxSide::New,
                &DiffTarget::default()
            )
            .unwrap(),
            "working\n"
        );

        let staged = DiffTarget {
            include_unstaged: false,
            ..DiffTarget::default()
        };
        assert_eq!(
            source_for_side(&repository, "fixture.txt", SyntaxSide::Old, &staged).unwrap(),
            "base\n"
        );
        assert_eq!(
            source_for_side(&repository, "fixture.txt", SyntaxSide::New, &staged).unwrap(),
            "staged\n"
        );

        let unstaged = DiffTarget {
            include_staged: false,
            ..DiffTarget::default()
        };
        assert_eq!(
            source_for_side(&repository, "fixture.txt", SyntaxSide::Old, &unstaged).unwrap(),
            "staged\n"
        );
        assert_eq!(
            source_for_side(&repository, "fixture.txt", SyntaxSide::New, &unstaged).unwrap(),
            "working\n"
        );
    }

    #[test]
    fn resolves_compare_sources_and_returns_empty_for_missing_sides() {
        let (temp, repository) = repository("base\n");
        fs::write(temp.path().join("fixture.txt"), "compare\n").unwrap();
        git_ok(temp.path(), &["add", "fixture.txt"]);
        git_ok(temp.path(), &["commit", "-m", "compare"]);
        let target = DiffTarget {
            base: Some("HEAD~1".to_owned()),
            compare: Some("HEAD".to_owned()),
            include_staged: false,
            include_unstaged: false,
        };

        assert_eq!(
            source_for_side(&repository, "fixture.txt", SyntaxSide::Old, &target).unwrap(),
            "base\n"
        );
        assert_eq!(
            source_for_side(&repository, "fixture.txt", SyntaxSide::New, &target).unwrap(),
            "compare\n"
        );
        assert_eq!(
            source_for_side(&repository, "missing.txt", SyntaxSide::Old, &target).unwrap(),
            ""
        );
        assert_eq!(
            source_for_side(
                &repository,
                "missing.txt",
                SyntaxSide::New,
                &DiffTarget::default()
            )
            .unwrap(),
            ""
        );
    }

    #[test]
    fn renders_default_and_full_context_models() {
        let contents = (1..=20)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        let (temp, repository) = repository(&contents);
        let changed = contents.replace("line 10\n", "changed 10\n");
        fs::write(temp.path().join("fixture.txt"), changed).unwrap();

        let compact = get_diff_render_model(
            &repository,
            "fixture.txt",
            "fixture.txt",
            DiffRenderOptions::default(),
            &DiffTarget::default(),
        )
        .unwrap();
        let full = get_diff_render_model(
            &repository,
            "fixture.txt",
            "fixture.txt",
            DiffRenderOptions {
                context: DiffContextMode::Full,
                ..DiffRenderOptions::default()
            },
            &DiffTarget::default(),
        )
        .unwrap();

        assert_eq!(compact.file_id, "fixture.txt");
        assert!(compact.rows.len() < full.rows.len());
        assert_eq!(
            full.rows
                .iter()
                .filter(|row| row.kind == DiffRowKind::Context)
                .count(),
            19
        );
        assert!(full.rows.iter().any(|row| {
            row.kind == DiffRowKind::Deleted && row.old_text.as_deref() == Some("line 10")
        }));
        assert!(full.rows.iter().any(|row| {
            row.kind == DiffRowKind::Added && row.new_text.as_deref() == Some("changed 10")
        }));
    }

    #[test]
    fn render_model_propagates_git_errors() {
        let (_temp, repository) = repository("base\n");
        let result = get_diff_render_model(
            &repository,
            "fixture.txt",
            "fixture.txt",
            DiffRenderOptions::default(),
            &DiffTarget {
                base: Some("missing-ref".to_owned()),
                compare: Some("HEAD".to_owned()),
                include_staged: false,
                include_unstaged: false,
            },
        );
        assert!(matches!(result, Err(CoreError::GitCommandFailed)));
    }
}
