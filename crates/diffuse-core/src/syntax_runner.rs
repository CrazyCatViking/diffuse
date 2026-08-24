//! Isolated native Tree-sitter parser entry point.
//!
//! This module requires `tree-sitter = { version = "=0.26.13",
//! default-features = false, features = ["std"] }` and
//! `libloading = "=0.8.9"`. The containing executable must dispatch its
//! `syntax-runner` subcommand to [`run_syntax_runner`].

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use libloading::{Library, Symbol};
use serde::Deserialize;
use tree_sitter::{Language, Parser, Point, Query, QueryCursor, StreamingIterator};

use super::{
    MAX_QUERY_SIZE, MAX_SOURCE_SIZE, SyntaxError, SyntaxLineSpans, SyntaxResult, SyntaxSpan,
    validate_language_id,
};

const MAX_GRAMMAR_SIZE: u64 = 100 * 1024 * 1024;
const MAX_PATH_SIZE: usize = 32 * 1024;
const MAX_REQUEST_SIZE: usize = MAX_SOURCE_SIZE * 6 + MAX_PATH_SIZE * 2 + 4096;
const MAX_SOURCE_LINES: usize = 1_000_000;
const MAX_SPANS: usize = 1_000_000;
const MAX_SCOPE_SIZE: usize = 512;
const MAX_RESPONSE_SIZE: usize = 20 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunnerRequest {
    language: String,
    grammar_path: String,
    highlights_query_path: String,
    source: String,
    start_line: u32,
    end_line: u32,
}

/// Reads one JSON parser request, loads and runs its native grammar in this
/// process, and writes a JSON array of [`SyntaxLineSpans`]. Call this only from
/// the dedicated `syntax-runner` child process, never from the RPC/AppCore path.
pub fn run_syntax_runner(mut stdin: impl Read, mut stdout: impl Write) -> SyntaxResult<()> {
    let mut input = Vec::new();
    stdin
        .by_ref()
        .take((MAX_REQUEST_SIZE + 1) as u64)
        .read_to_end(&mut input)?;
    if input.len() > MAX_REQUEST_SIZE {
        return Err(runner_error("request exceeds the size limit"));
    }

    let request: RunnerRequest = serde_json::from_slice(&input)?;
    let spans = execute(request)?;
    let output = serde_json::to_vec(&spans)?;
    if output.len() > MAX_RESPONSE_SIZE {
        return Err(runner_error(
            "syntax runner response exceeds the size limit",
        ));
    }
    stdout.write_all(&output)?;
    stdout.flush()?;
    Ok(())
}

fn execute(request: RunnerRequest) -> SyntaxResult<Vec<SyntaxLineSpans>> {
    validate_request(&request)?;
    if request.end_line < request.start_line || request.source.is_empty() {
        return Ok(Vec::new());
    }

    let grammar_path = validated_file(&request.grammar_path, MAX_GRAMMAR_SIZE, "grammar library")?;
    let query_path = validated_file(
        &request.highlights_query_path,
        MAX_QUERY_SIZE,
        "highlights query",
    )?;
    let query_source = read_utf8_file_limited(&query_path, MAX_QUERY_SIZE, "highlights query")?;
    let line_lengths = line_lengths(&request.source)?;

    // Keep the library alive until every Tree-sitter value backed by its
    // language has been dropped.
    let library = unsafe { Library::new(&grammar_path) }
        .map_err(|error| runner_error(format!("cannot load grammar library: {error}")))?;
    let language = load_language(&library, &request.language)?;
    let query = Query::new(&language, &query_source)
        .map_err(|error| runner_error(format!("cannot compile highlights query: {error}")))?;
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|error| runner_error(format!("incompatible grammar language: {error}")))?;
    let tree = parser
        .parse(request.source.as_bytes(), None)
        .ok_or_else(|| runner_error("Tree-sitter parse failed"))?;

    let mut cursor = QueryCursor::new();
    cursor.set_point_range(
        Point {
            row: request.start_line.saturating_sub(1) as usize,
            column: 0,
        }..Point {
            row: request.end_line as usize,
            column: 0,
        },
    );
    let mut captures = cursor.captures(&query, tree.root_node(), request.source.as_bytes());
    let capture_names = query.capture_names();
    let mut lines = BTreeMap::<u32, Vec<SyntaxSpan>>::new();
    let mut span_count = 0usize;
    let mut estimated_output_size = 0usize;

    while let Some((query_match, capture_index)) = captures.next() {
        let capture = query_match.captures[*capture_index];
        let Some(scope) = capture_names.get(capture.index as usize).copied() else {
            return Err(runner_error("query returned an unknown capture"));
        };
        if !visible_capture(scope) {
            continue;
        }
        if scope.len() > MAX_SCOPE_SIZE {
            return Err(runner_error("query capture name exceeds the size limit"));
        }

        append_capture(
            &mut lines,
            &mut span_count,
            &mut estimated_output_size,
            capture.node.start_position(),
            capture.node.end_position(),
            scope,
            &line_lengths,
            request.start_line,
            request.end_line,
        )?;
    }

    let mut result = Vec::with_capacity(lines.len());
    for (line, mut spans) in lines {
        spans.sort_by(|left, right| {
            (left.start_column, left.end_column, left.scope.as_str()).cmp(&(
                right.start_column,
                right.end_column,
                right.scope.as_str(),
            ))
        });
        spans.dedup();
        result.push(SyntaxLineSpans { line, spans });
    }
    Ok(result)
}

fn validate_request(request: &RunnerRequest) -> SyntaxResult<()> {
    validate_language_id(&request.language)?;
    if request.grammar_path.is_empty()
        || request.grammar_path.len() > MAX_PATH_SIZE
        || request.highlights_query_path.is_empty()
        || request.highlights_query_path.len() > MAX_PATH_SIZE
    {
        return Err(runner_error("parser path is empty or too long"));
    }
    if request.source.len() > MAX_SOURCE_SIZE {
        return Err(runner_error("source exceeds 20 MiB"));
    }
    if request.start_line == 0 {
        return Err(runner_error("syntax line ranges are 1-based"));
    }
    Ok(())
}

fn validated_file(raw_path: &str, max_size: u64, label: &str) -> SyntaxResult<PathBuf> {
    let path = Path::new(raw_path);
    if path.as_os_str().is_empty() || path.file_name().is_none() {
        return Err(runner_error(format!("invalid {label} path")));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| runner_error(format!("cannot resolve {label} path: {error}")))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| runner_error(format!("cannot inspect {label}: {error}")))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_size {
        return Err(runner_error(format!("invalid {label} size or file type")));
    }
    Ok(canonical)
}

fn read_utf8_file_limited(path: &Path, limit: u64, label: &str) -> SyntaxResult<String> {
    let file = std::fs::File::open(path)
        .map_err(|error| runner_error(format!("cannot open {label}: {error}")))?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err(runner_error(format!("invalid {label} size")));
    }
    String::from_utf8(bytes).map_err(|_| runner_error(format!("{label} is not UTF-8")))
}

fn load_language(library: &Library, language: &str) -> SyntaxResult<Language> {
    type LanguageFn = unsafe extern "C" fn() -> *const tree_sitter::ffi::TSLanguage;

    let mut symbol_name = format!("tree_sitter_{}", language.replace('-', "_")).into_bytes();
    symbol_name.push(0);
    let function: Symbol<'_, LanguageFn> = unsafe { library.get(&symbol_name) }
        .map_err(|error| runner_error(format!("grammar language symbol not found: {error}")))?;
    let raw_language = unsafe { function() };
    if raw_language.is_null() {
        return Err(runner_error("grammar language symbol returned null"));
    }
    Ok(unsafe { Language::from_raw(raw_language) })
}

#[allow(clippy::too_many_arguments)]
fn append_capture(
    lines: &mut BTreeMap<u32, Vec<SyntaxSpan>>,
    span_count: &mut usize,
    estimated_output_size: &mut usize,
    start: Point,
    end: Point,
    scope: &str,
    line_lengths: &[u32],
    requested_start: u32,
    requested_end: u32,
) -> SyntaxResult<()> {
    if end < start || start.row >= line_lengths.len() {
        return Ok(());
    }
    let last_row = end.row.min(line_lengths.len().saturating_sub(1));
    for (row, &line_length) in line_lengths
        .iter()
        .enumerate()
        .take(last_row + 1)
        .skip(start.row)
    {
        let line = u32::try_from(row)
            .ok()
            .and_then(|row| row.checked_add(1))
            .ok_or_else(|| runner_error("capture line exceeds the supported range"))?;
        if line < requested_start || line > requested_end {
            continue;
        }

        let start_column = if row == start.row {
            u32::try_from(start.column)
                .unwrap_or(u32::MAX)
                .min(line_length)
        } else {
            0
        };
        let end_column = if row == end.row {
            u32::try_from(end.column)
                .unwrap_or(u32::MAX)
                .min(line_length)
        } else {
            line_length
        };
        if end_column <= start_column {
            continue;
        }

        *span_count += 1;
        if *span_count > MAX_SPANS {
            return Err(runner_error("syntax span count exceeds the limit"));
        }
        *estimated_output_size = estimated_output_size
            .saturating_add(160)
            .saturating_add(scope.len().saturating_mul(6));
        if *estimated_output_size > MAX_RESPONSE_SIZE {
            return Err(runner_error(
                "syntax runner response exceeds the size limit",
            ));
        }
        lines.entry(line).or_default().push(SyntaxSpan {
            start_column,
            end_column,
            scope: scope.to_owned(),
        });
    }
    Ok(())
}

fn line_lengths(source: &str) -> SyntaxResult<Vec<u32>> {
    let mut lengths = Vec::new();
    let mut start = 0usize;
    for (index, byte) in source.bytes().enumerate() {
        if byte == b'\n' {
            lengths.push((index - start) as u32);
            start = index + 1;
            if lengths.len() > MAX_SOURCE_LINES {
                return Err(runner_error("source has too many lines"));
            }
        }
    }
    lengths.push((source.len() - start) as u32);
    if lengths.len() > MAX_SOURCE_LINES {
        return Err(runner_error("source has too many lines"));
    }
    Ok(lengths)
}

fn visible_capture(scope: &str) -> bool {
    !scope.is_empty() && scope != "none" && scope != "nospell" && !scope.starts_with('_')
}

fn runner_error(message: impl Into<String>) -> SyntaxError {
    SyntaxError::ParserFailed(message.into())
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn capture_spans_are_clipped_split_sorted_and_deduplicated() {
        let mut lines = BTreeMap::new();
        let mut count = 0;
        let mut output_size = 0;
        for _ in 0..2 {
            append_capture(
                &mut lines,
                &mut count,
                &mut output_size,
                Point { row: 0, column: 2 },
                Point { row: 2, column: 3 },
                "comment",
                &[5, 4, 6],
                2,
                3,
            )
            .unwrap();
        }
        for spans in lines.values_mut() {
            spans.sort_by_key(|span| (span.start_column, span.end_column));
            spans.dedup();
        }
        assert_eq!(
            lines,
            BTreeMap::from([
                (
                    2,
                    vec![SyntaxSpan {
                        start_column: 0,
                        end_column: 4,
                        scope: "comment".into(),
                    }]
                ),
                (
                    3,
                    vec![SyntaxSpan {
                        start_column: 0,
                        end_column: 3,
                        scope: "comment".into(),
                    }]
                ),
            ])
        );
    }

    #[test]
    fn runner_file_validation_rejects_empty_and_oversized_files() {
        let temp = TempDir::new().unwrap();
        let empty = temp.path().join("empty.scm");
        let oversized = temp.path().join("oversized.scm");
        std::fs::write(&empty, []).unwrap();
        std::fs::write(&oversized, [0; 8]).unwrap();
        assert!(validated_file(empty.to_str().unwrap(), 8, "test").is_err());
        assert!(validated_file(oversized.to_str().unwrap(), 7, "test").is_err());
        assert!(validated_file(oversized.to_str().unwrap(), 8, "test").is_ok());
    }
}
