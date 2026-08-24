use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};
use tempfile::TempDir;

#[test]
fn isolated_runner_loads_a_real_native_grammar_and_returns_spans() {
    let grammar = syntax_fixture_library();
    let temp = TempDir::new().expect("temporary syntax fixture");
    let query = temp.path().join("highlights.scm");
    fs::write(&query, "(string) @string\n(number) @number\n").expect("write highlights query");
    let request = json!({
        "language": "diffuse-test-json",
        "grammarPath": grammar,
        "highlightsQueryPath": query,
        "source": "{\"answer\": 42}\n",
        "startLine": 1,
        "endLine": 1,
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_diffuse"))
        .arg("syntax-runner")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start isolated syntax runner");
    child
        .stdin
        .take()
        .expect("syntax runner stdin")
        .write_all(serde_json::to_string(&request).unwrap().as_bytes())
        .expect("write syntax request");
    let output = child.wait_with_output().expect("wait for syntax runner");

    assert!(
        output.status.success(),
        "syntax runner failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines: Value = serde_json::from_slice(&output.stdout).expect("syntax runner JSON");
    let spans = lines
        .as_array()
        .and_then(|lines| lines.first())
        .and_then(|line| line.get("spans"))
        .and_then(Value::as_array)
        .expect("line spans");
    assert!(
        spans
            .iter()
            .any(|span| span.get("scope") == Some(&json!("string")))
    );
    assert!(
        spans
            .iter()
            .any(|span| span.get("scope") == Some(&json!("number")))
    );
}

fn syntax_fixture_library() -> PathBuf {
    let executable = Path::new(env!("CARGO_BIN_EXE_diffuse"));
    let target = executable.parent().expect("target directory");
    let extension = std::env::consts::DLL_EXTENSION;
    let prefix = format!("{}diffuse_syntax_fixture", std::env::consts::DLL_PREFIX);
    let direct = target.join(format!("{prefix}.{extension}"));
    if !direct.is_file() {
        let workspace = target
            .parent()
            .and_then(Path::parent)
            .expect("workspace root");
        let status = Command::new(env!("CARGO"))
            .args(["build", "-p", "diffuse-syntax-fixture", "--locked"])
            .current_dir(workspace)
            .status()
            .expect("build syntax fixture library");
        assert!(status.success(), "syntax fixture library build failed");
    }
    if direct.is_file() {
        return direct;
    }

    let deps = target.join("deps");
    fs::read_dir(&deps)
        .expect("read target deps")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(extension))
        })
        .unwrap_or_else(|| panic!("syntax fixture library was not built in {}", deps.display()))
}
