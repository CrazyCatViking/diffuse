use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::Path;

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use sha2::{Digest, Sha256};

use crate::database::{LegacyImportRecord, LegacyReviewImportReport, WorkbenchDatabase};
use crate::{CoreResult, WorkspaceId};

const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES: u64 = 1024 * 1024;

struct ArtifactDirectory {
    kind: &'static str,
    components: &'static [&'static str],
    extension: &'static str,
    max_bytes: u64,
    json: bool,
}

const ARTIFACT_DIRECTORIES: [ArtifactDirectory; 4] = [
    ArtifactDirectory {
        kind: "run",
        components: &["runs"],
        extension: "json",
        max_bytes: MAX_JSON_BYTES,
        json: true,
    },
    ArtifactDirectory {
        kind: "agent",
        components: &["agents"],
        extension: "json",
        max_bytes: MAX_JSON_BYTES,
        json: true,
    },
    ArtifactDirectory {
        kind: "chat",
        components: &["chat", "messages"],
        extension: "json",
        max_bytes: MAX_JSON_BYTES,
        json: true,
    },
    ArtifactDirectory {
        kind: "prompt",
        components: &["prompts"],
        extension: "md",
        max_bytes: MAX_PROMPT_BYTES,
        json: false,
    },
];

pub(crate) fn import_legacy_reviews(
    database: &WorkbenchDatabase,
    workspace_id: WorkspaceId,
    root: &Path,
) -> CoreResult<LegacyReviewImportReport> {
    let root = Dir::open_ambient_dir(root, ambient_authority())?;
    let mut report = LegacyReviewImportReport {
        workspace_id,
        ..LegacyReviewImportReport::default()
    };
    let sessions = match open_directory_chain(&root, &[".diffuse", "reviews", "sessions"]) {
        Ok(Some(directory)) => directory,
        Ok(None) => return Ok(report),
        Err(error) => {
            record_diagnostic(
                database,
                workspace_id,
                "_root",
                "run",
                "sessions",
                &format!("unable to open capability-confined sessions directory: {error}"),
                &mut report,
            )?;
            return Ok(report);
        }
    };
    database.clear_legacy_import_diagnostic(workspace_id, "_root", "run", "sessions")?;

    let entries = match sessions.entries() {
        Ok(entries) => entries,
        Err(error) => {
            record_diagnostic(
                database,
                workspace_id,
                "_root",
                "run",
                "sessions",
                &format!("unable to scan sessions: {error}"),
                &mut report,
            )?;
            return Ok(report);
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                record_diagnostic(
                    database,
                    workspace_id,
                    "_root",
                    "run",
                    "sessions",
                    &format!("unable to read a sessions directory entry: {error}"),
                    &mut report,
                )?;
                continue;
            }
        };
        let Some(session_id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if session_id.is_empty() || session_id.len() > 512 {
            continue;
        }
        let session = match sessions.open_dir_nofollow(entry.file_name()) {
            Ok(directory) => directory,
            Err(error) => {
                record_diagnostic(
                    database,
                    workspace_id,
                    &session_id,
                    "run",
                    &session_id,
                    &format!("session is not a regular no-follow directory: {error}"),
                    &mut report,
                )?;
                continue;
            }
        };
        database.clear_legacy_import_diagnostic(workspace_id, &session_id, "run", &session_id)?;

        for directory in &ARTIFACT_DIRECTORIES {
            import_directory(
                database,
                workspace_id,
                &session_id,
                &session,
                directory,
                &mut report,
            )?;
        }
    }
    Ok(report)
}

fn import_directory(
    database: &WorkbenchDatabase,
    workspace_id: WorkspaceId,
    session_id: &str,
    session: &Dir,
    artifact: &ArtifactDirectory,
    report: &mut LegacyReviewImportReport,
) -> CoreResult<()> {
    let relative_directory = artifact.components.join("/");
    let directory = match open_directory_chain(session, artifact.components) {
        Ok(Some(directory)) => directory,
        Ok(None) => return Ok(()),
        Err(error) => {
            record_diagnostic(
                database,
                workspace_id,
                session_id,
                artifact.kind,
                &relative_directory,
                &format!("artifact path is not a regular no-follow directory: {error}"),
                report,
            )?;
            return Ok(());
        }
    };
    database.clear_legacy_import_diagnostic(
        workspace_id,
        session_id,
        artifact.kind,
        &relative_directory,
    )?;
    let entries = match directory.entries() {
        Ok(entries) => entries,
        Err(error) => {
            record_diagnostic(
                database,
                workspace_id,
                session_id,
                artifact.kind,
                &relative_directory,
                &format!("unable to scan artifact directory: {error}"),
                report,
            )?;
            return Ok(());
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                record_diagnostic(
                    database,
                    workspace_id,
                    session_id,
                    artifact.kind,
                    &relative_directory,
                    &format!("unable to read an artifact directory entry: {error}"),
                    report,
                )?;
                continue;
            }
        };
        let file_name = entry.file_name();
        let path = Path::new(&file_name);
        if path.extension().and_then(OsStr::to_str) != Some(artifact.extension) {
            continue;
        }
        let Some(file_name_text) = file_name.to_str() else {
            continue;
        };
        let relative_path = format!("{relative_directory}/{file_name_text}");
        import_file(
            database,
            workspace_id,
            session_id,
            &directory,
            artifact.kind,
            &file_name,
            &relative_path,
            artifact.max_bytes,
            artifact.json,
            report,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn import_file(
    database: &WorkbenchDatabase,
    workspace_id: WorkspaceId,
    session_id: &str,
    directory: &Dir,
    artifact_kind: &str,
    file_name: &OsStr,
    relative_path: &str,
    max_bytes: u64,
    json: bool,
    report: &mut LegacyReviewImportReport,
) -> CoreResult<()> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = match directory.open_with(file_name, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            record_diagnostic(
                database,
                workspace_id,
                session_id,
                artifact_kind,
                relative_path,
                &format!("artifact is not a regular no-follow file: {error}"),
                report,
            )?;
            return Ok(());
        }
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        record_diagnostic(
            database,
            workspace_id,
            session_id,
            artifact_kind,
            relative_path,
            "artifact is not a regular file",
            report,
        )?;
        return Ok(());
    }
    if metadata.len() > max_bytes {
        record_diagnostic(
            database,
            workspace_id,
            session_id,
            artifact_kind,
            relative_path,
            "artifact exceeds import size limit",
            report,
        )?;
        return Ok(());
    }
    let mut payload = Vec::new();
    file.by_ref()
        .take(max_bytes + 1)
        .read_to_end(&mut payload)?;
    if payload.len() as u64 > max_bytes {
        record_diagnostic(
            database,
            workspace_id,
            session_id,
            artifact_kind,
            relative_path,
            "artifact changed while reading or exceeds import size limit",
            report,
        )?;
        return Ok(());
    }
    let hash = format!("{:x}", Sha256::digest(&payload));
    let text = match String::from_utf8(payload) {
        Ok(text) => text,
        Err(error) => {
            record_diagnostic(
                database,
                workspace_id,
                session_id,
                artifact_kind,
                relative_path,
                &format!("artifact is not UTF-8: {error}"),
                report,
            )?;
            return Ok(());
        }
    };
    let entity_id = if json {
        let document = match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(serde_json::Value::Object(document)) => document,
            Ok(_) => {
                return record_diagnostic(
                    database,
                    workspace_id,
                    session_id,
                    artifact_kind,
                    relative_path,
                    "JSON artifact must be an object",
                    report,
                );
            }
            Err(error) => {
                return record_diagnostic(
                    database,
                    workspace_id,
                    session_id,
                    artifact_kind,
                    relative_path,
                    &format!("malformed JSON: {error}"),
                    report,
                );
            }
        };
        match document.get("id").and_then(serde_json::Value::as_str) {
            Some(id) if !id.is_empty() && id.len() <= 512 => id.to_owned(),
            _ => {
                return record_diagnostic(
                    database,
                    workspace_id,
                    session_id,
                    artifact_kind,
                    relative_path,
                    "JSON artifact requires a non-empty string id",
                    report,
                );
            }
        }
    } else {
        match Path::new(file_name).file_stem().and_then(OsStr::to_str) {
            Some(id) if !id.is_empty() && id.len() <= 512 => id.to_owned(),
            _ => {
                return record_diagnostic(
                    database,
                    workspace_id,
                    session_id,
                    artifact_kind,
                    relative_path,
                    "prompt filename requires a valid identity",
                    report,
                );
            }
        }
    };
    let changed = database.record_legacy_import(
        workspace_id,
        LegacyImportRecord {
            session_id,
            artifact_kind,
            relative_path,
            entity_id: Some(&entity_id),
            content_hash: Some(&hash),
            payload: Some(&text),
            diagnostic: None,
        },
    )?;
    update_report(report, changed, false);
    Ok(())
}

fn open_directory_chain(base: &Dir, components: &[&str]) -> io::Result<Option<Dir>> {
    let mut current = base.try_clone()?;
    for component in components {
        match current.open_dir_nofollow(component) {
            Ok(next) => current = next,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
    }
    Ok(Some(current))
}

fn record_diagnostic(
    database: &WorkbenchDatabase,
    workspace_id: WorkspaceId,
    session_id: &str,
    artifact_kind: &str,
    relative_path: &str,
    diagnostic: &str,
    report: &mut LegacyReviewImportReport,
) -> CoreResult<()> {
    let changed = database.record_legacy_import(
        workspace_id,
        LegacyImportRecord {
            session_id,
            artifact_kind,
            relative_path,
            entity_id: None,
            content_hash: None,
            payload: None,
            diagnostic: Some(diagnostic),
        },
    )?;
    update_report(report, changed, true);
    Ok(())
}

fn update_report(report: &mut LegacyReviewImportReport, changed: bool, diagnostic: bool) {
    if changed {
        if diagnostic {
            report.diagnostics += 1;
        } else {
            report.imported += 1;
        }
    } else {
        report.already_imported += 1;
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::WorkspaceGeneration;

    fn add_workspace(database: &WorkbenchDatabase, root: &Path) -> WorkspaceId {
        database
            .open_workspace(
                &root.to_string_lossy(),
                &root.to_string_lossy(),
                "repository",
                WorkspaceGeneration::new(),
            )
            .unwrap()
            .id
    }

    #[test]
    fn imports_semantic_artifacts_idempotently_without_modifying_sources() {
        let root = tempfile::tempdir().unwrap();
        let session = root.path().join(".diffuse/reviews/sessions/session-one");
        for directory in ["runs", "agents", "chat/messages", "prompts", "threads"] {
            fs::create_dir_all(session.join(directory)).unwrap();
        }
        let fixtures = [
            (
                "runs/run.json",
                br#"{"id":"run","status":"running"}"#.as_slice(),
            ),
            (
                "agents/agent.json",
                br#"{"id":"agent","currentPhase":"reviewing"}"#.as_slice(),
            ),
            (
                "chat/messages/message.json",
                br#"{"id":"message"}"#.as_slice(),
            ),
            ("prompts/prompt.md", b"Review this change".as_slice()),
        ];
        for (path, bytes) in fixtures {
            fs::write(session.join(path), bytes).unwrap();
        }
        let portable = [
            ("review.json", br#"{"id":"portable-review"}"#.as_slice()),
            (
                "threads/thread.json",
                br#"{"id":"portable-thread"}"#.as_slice(),
            ),
        ];
        for (path, bytes) in portable {
            fs::write(session.join(path), bytes).unwrap();
        }
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let workspace_id = add_workspace(&database, root.path());

        let first = import_legacy_reviews(&database, workspace_id, root.path()).unwrap();
        let second = import_legacy_reviews(&database, workspace_id, root.path()).unwrap();

        assert_eq!((first.imported, first.diagnostics), (4, 0));
        assert_eq!(second.already_imported, 4);
        let imported = database.legacy_imported_artifacts(workspace_id).unwrap();
        assert_eq!(imported.len(), 4);
        assert!(imported.iter().any(|artifact| matches!(
            artifact,
            crate::LegacyImportedArtifact::Run { entity_id, document, .. }
                if entity_id == "run" && document["status"] == "running"
        )));
        assert!(imported.iter().any(|artifact| matches!(
            artifact,
            crate::LegacyImportedArtifact::Agent { entity_id, .. } if entity_id == "agent"
        )));
        assert!(imported.iter().any(|artifact| matches!(
            artifact,
            crate::LegacyImportedArtifact::Chat { entity_id, .. } if entity_id == "message"
        )));
        assert!(imported.iter().any(|artifact| matches!(
            artifact,
            crate::LegacyImportedArtifact::Prompt { entity_id, text, .. }
                if entity_id == "prompt" && text == "Review this change"
        )));
        assert!(!imported.iter().any(|artifact| match artifact {
            crate::LegacyImportedArtifact::Run { entity_id, .. }
            | crate::LegacyImportedArtifact::Agent { entity_id, .. }
            | crate::LegacyImportedArtifact::Chat { entity_id, .. }
            | crate::LegacyImportedArtifact::Prompt { entity_id, .. } => {
                matches!(entity_id.as_str(), "portable-review" | "portable-thread")
            }
        }));
        for (path, bytes) in fixtures {
            assert_eq!(fs::read(session.join(path)).unwrap(), bytes);
        }
        for (path, bytes) in portable {
            assert_eq!(fs::read(session.join(path)).unwrap(), bytes);
        }
        assert!(database.attention_items().unwrap().is_empty());
    }

    #[test]
    fn changed_content_updates_the_same_stable_path_and_repairs_diagnostics() {
        let root = tempfile::tempdir().unwrap();
        let runs = root.path().join(".diffuse/reviews/sessions/session/runs");
        fs::create_dir_all(&runs).unwrap();
        let artifact = runs.join("run.json");
        fs::write(&artifact, "not json").unwrap();
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let workspace_id = add_workspace(&database, root.path());
        let malformed = import_legacy_reviews(&database, workspace_id, root.path()).unwrap();
        fs::write(&artifact, r#"{"id":"run-one","status":"running"}"#).unwrap();
        let repaired = import_legacy_reviews(&database, workspace_id, root.path()).unwrap();
        fs::write(&artifact, r#"{"id":"run-one","status":"completed"}"#).unwrap();
        let changed = import_legacy_reviews(&database, workspace_id, root.path()).unwrap();

        assert_eq!(malformed.diagnostics, 1);
        assert_eq!(repaired.imported, 1);
        assert_eq!(changed.imported, 1);
        let report = database.legacy_review_import_report(workspace_id).unwrap();
        assert_eq!((report.imported, report.diagnostics), (1, 0));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_descendants() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let session = root.path().join(".diffuse/reviews/sessions/session");
        fs::create_dir_all(&session).unwrap();
        fs::write(outside.path().join("run.json"), r#"{"id":"outside"}"#).unwrap();
        symlink(outside.path(), session.join("runs")).unwrap();
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let workspace_id = add_workspace(&database, root.path());

        let report = import_legacy_reviews(&database, workspace_id, root.path()).unwrap();

        assert_eq!(report.diagnostics, 1);
        assert_eq!(
            database
                .legacy_review_import_report(workspace_id)
                .unwrap()
                .imported,
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_legacy_root_ancestor() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(outside.path().join("reviews/sessions/session")).unwrap();
        symlink(outside.path(), root.path().join(".diffuse")).unwrap();
        let database = WorkbenchDatabase::open_in_memory().unwrap();
        let workspace_id = add_workspace(&database, root.path());

        let report = import_legacy_reviews(&database, workspace_id, root.path()).unwrap();

        assert_eq!(report.diagnostics, 1);
        assert_eq!(
            database
                .legacy_review_import_report(workspace_id)
                .unwrap()
                .imported,
            0
        );
    }
}
