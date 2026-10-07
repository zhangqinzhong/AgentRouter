//! Antigravity CLI lifecycle hook output extraction and enrichment.
//!
//! Antigravity CLI's native `PostToolUse` event payload carries invocation
//! metadata (`toolCall`, `conversationId`, `stepIdx`, `artifactDirectoryPath`)
//! but omits command/tool stdout and stderr from the event JSON itself.
//! Instead, the CLI writes step execution logs to:
//! `<artifactDirectoryPath>/.system_generated/steps/<stepIdx>/output.txt`.
//!
//! This module resolves and reads that output file for output-eligible tools
//! (e.g. `run_command`, `view_file`, `list_dir`, etc.) while strictly
//! preserving the code extraction behavior for file-editing tools (`write_to_file`,
//! `replace_file_content`, etc.), which extract actual code changes from `args`.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::payload::HookEvent;

/// Maximum number of bytes read from Antigravity's `output.txt`.
/// Matches the standard tool excerpt upper bound (2 KB) so spooled events
/// remain compact and within bounded limits.
pub const MAX_ANTIGRAVITY_OUTPUT_BYTES: usize = 2048;

/// Check if a tool is eligible for output extraction from `output.txt`.
///
/// Whitelist rationale:
/// - Tools like `run_command`, `view_file`, and search tools produce valuable
///   execution logs or inspection output in `output.txt`.
/// - Mutation tools (`write_to_file`, `replace_file_content`) must NEVER be
///   enriched here because their `output.txt` only contains generic confirmation
///   strings ("Created file..."), whereas `ai-memory` extracts the real code
///   from `args.CodeContent` / `args.ReplacementContent`. Overwriting with
///   `tool_response` would destroy that code capture.
/// - Unproven generic tools (`read_url_content`, `read_resource`, `call_mcp_tool`)
///   fail closed to `ToolFamily::Unknown`.
#[must_use]
pub fn is_output_eligible(tool_name: &str) -> bool {
    matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "run_command"
            | "view_file"
            | "list_dir"
            | "find_by_name"
            | "grep_search"
            | "search_web"
            | "manage_task"
            | "manage_subagents"
    )
}

/// Resolves an artifact directory path, expanding leading `~` or `~/`
/// if `home_dir` is provided.
#[must_use]
pub fn resolve_artifact_dir(raw_path: &str, home_dir: Option<&Path>) -> Option<PathBuf> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(stripped) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        home_dir.map(|h| h.join(stripped))
    } else if trimmed == "~" {
        home_dir.map(Path::to_path_buf)
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Builds the absolute path to a step's `output.txt` file given the artifact directory
/// and the step index.
#[must_use]
pub fn step_output_file_path(artifact_dir: &Path, step_idx: u64) -> PathBuf {
    artifact_dir
        .join(".system_generated")
        .join("steps")
        .join(step_idx.to_string())
        .join("output.txt")
}

/// Reads up to `max_bytes` from `output_path`, ensuring it is a regular file
/// (preventing symlink traversal and blocking on FIFOs/special devices). Slices
/// cleanly on multi-byte UTF-8 code point boundaries and trims trailing whitespace.
/// Returns `None` if the file cannot be read, is not a regular file, or contains
/// only whitespace.
#[must_use]
pub fn read_step_output(output_path: &Path, max_bytes: usize) -> Option<String> {
    let metadata = std::fs::symlink_metadata(output_path).ok()?;
    if !metadata.is_file() {
        return None;
    }

    let file = File::open(output_path).ok()?;
    let mut reader = Read::take(file, max_bytes as u64);
    let mut buffer = Vec::new();
    reader.read_to_end(&mut buffer).ok()?;
    if buffer.is_empty() {
        return None;
    }

    let text = match std::str::from_utf8(&buffer) {
        Ok(valid) => valid,
        Err(err) => {
            let valid = &buffer[..err.valid_up_to()];
            std::str::from_utf8(valid).unwrap_or_default()
        }
    };
    let trimmed = text.trim_end();
    if trimmed.trim().is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn extract_step_idx(raw: &serde_json::Value) -> Option<u64> {
    if let Some(idx) = raw.get("stepIdx").and_then(serde_json::Value::as_u64) {
        return Some(idx);
    }
    raw.get("stepIdx")
        .and_then(serde_json::Value::as_str)
        .and_then(|s| s.parse::<u64>().ok())
}

fn extract_artifact_dir_str(raw: &serde_json::Value) -> Option<&str> {
    let path = raw
        .get("artifactDirectoryPath")
        .and_then(serde_json::Value::as_str)?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn artifact_dir_from_transcript(
    raw: &serde_json::Value,
    home_dir: Option<&Path>,
) -> Option<PathBuf> {
    let transcript = raw
        .get("transcriptPath")
        .and_then(serde_json::Value::as_str)?;
    let resolved = resolve_artifact_dir(transcript, home_dir)?;
    let logs_dir = resolved.parent()?;
    let sys_dir = logs_dir.parent()?;
    if sys_dir.file_name()? != ".system_generated" {
        return None;
    }
    sys_dir.parent().map(Path::to_path_buf)
}

fn extract_tool_name(raw: &serde_json::Value) -> Option<&str> {
    raw.get("toolCall")
        .and_then(|tc| tc.get("name"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| raw.get("tool").and_then(serde_json::Value::as_str))
}

/// Enriches an Antigravity hook payload by reading output from the step's `output.txt`
/// if eligible and unpopulated. Returns `true` if `tool_response` was populated.
pub fn enrich_antigravity_step_output(
    raw: &mut serde_json::Value,
    event: HookEvent,
    home_dir: Option<&Path>,
) -> bool {
    if event != HookEvent::PostToolUse {
        return false;
    }
    if raw
        .get("tool_response")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
    {
        return false;
    }
    let Some(tool_name) = extract_tool_name(raw) else {
        return false;
    };
    if !is_output_eligible(tool_name) {
        return false;
    }
    let Some(step_idx) = extract_step_idx(raw) else {
        return false;
    };
    let artifact_dir = extract_artifact_dir_str(raw)
        .and_then(|p| resolve_artifact_dir(p, home_dir))
        .or_else(|| artifact_dir_from_transcript(raw, home_dir));
    let Some(artifact_dir) = artifact_dir else {
        return false;
    };
    let output_file = step_output_file_path(&artifact_dir, step_idx);
    let Some(output) = read_step_output(&output_file, MAX_ANTIGRAVITY_OUTPUT_BYTES) else {
        return false;
    };
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("tool_response".into(), serde_json::Value::String(output));
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_is_output_eligible() {
        // Arrange & Assert: Eligible tools (case-insensitive)
        assert!(is_output_eligible("run_command"));
        assert!(is_output_eligible("RUN_COMMAND"));
        assert!(is_output_eligible("view_file"));
        assert!(is_output_eligible("View_File"));
        assert!(is_output_eligible("list_dir"));
        assert!(is_output_eligible("find_by_name"));
        assert!(is_output_eligible("grep_search"));
        assert!(is_output_eligible("search_web"));
        assert!(is_output_eligible("manage_task"));
        assert!(is_output_eligible("manage_subagents"));

        // Arrange & Assert: Ineligible tools (edit tools, UI, media, unproven)
        assert!(!is_output_eligible("write_to_file"));
        assert!(!is_output_eligible("replace_file_content"));
        assert!(!is_output_eligible("multi_replace_file_content"));
        assert!(!is_output_eligible("generate_image"));
        assert!(!is_output_eligible("ask_question"));
        assert!(!is_output_eligible("schedule"));
        assert!(!is_output_eligible("read_url_content"));
        assert!(!is_output_eligible("read_resource"));
        assert!(!is_output_eligible("call_mcp_tool"));
        assert!(!is_output_eligible("unknown_tool"));
    }

    #[test]
    fn test_resolve_artifact_dir() {
        let fake_home = Path::new("/custom/home");

        // Act & Assert
        assert_eq!(
            resolve_artifact_dir("/abs/path", Some(fake_home)),
            Some(PathBuf::from("/abs/path"))
        );
        assert_eq!(
            resolve_artifact_dir("~/workspace/dir", Some(fake_home)),
            Some(PathBuf::from("/custom/home/workspace/dir"))
        );
        assert_eq!(
            resolve_artifact_dir("~", Some(fake_home)),
            Some(PathBuf::from("/custom/home"))
        );
        assert_eq!(resolve_artifact_dir("~/workspace/dir", None), None);
        assert_eq!(resolve_artifact_dir("", Some(fake_home)), None);
        assert_eq!(resolve_artifact_dir("   ", Some(fake_home)), None);
    }

    #[test]
    fn test_read_step_output_bounds_and_trims() {
        // Arrange
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("output.txt");
        let content = "Hello from output.txt   \n\n";
        fs::write(&file_path, content).unwrap();

        // Act
        let read = read_step_output(&file_path, 1024);

        // Assert
        assert_eq!(read, Some("Hello from output.txt".to_string()));

        // Act: max_bytes truncate
        let truncated = read_step_output(&file_path, 5);
        assert_eq!(truncated, Some("Hello".to_string()));
    }

    #[test]
    #[cfg(unix)]
    fn test_read_step_output_rejects_symlink() {
        use std::os::unix::fs::symlink;
        let dir = tempdir().unwrap();
        let target = dir.path().join("real_output.txt");
        let link = dir.path().join("output.txt");
        fs::write(&target, "secret content").unwrap();
        symlink(&target, &link).unwrap();

        assert_eq!(read_step_output(&link, 1024), None);
    }

    #[test]
    fn test_read_step_output_handles_multibyte_utf8_truncation() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("output.txt");
        // "🦀" is 4 bytes. "abc🦀def" with limit 5 truncates inside the emoji.
        fs::write(&file_path, "abc🦀def").unwrap();

        let read = read_step_output(&file_path, 5);
        assert_eq!(read, Some("abc".to_string()));
    }

    #[test]
    fn test_read_step_output_missing_or_empty() {
        // Arrange
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("empty.txt");
        fs::write(&file_path, "   \n\t").unwrap();

        // Act & Assert
        assert_eq!(read_step_output(&file_path, 1024), None);
        assert_eq!(
            read_step_output(&dir.path().join("nonexistent.txt"), 1024),
            None
        );
    }

    #[test]
    fn test_enrich_antigravity_step_output_success() {
        // Arrange
        let dir = tempdir().unwrap();
        let step_dir = dir.path().join(".system_generated").join("steps").join("5");
        fs::create_dir_all(&step_dir).unwrap();
        fs::write(
            step_dir.join("output.txt"),
            "npm test passed: 42 tests OK\n",
        )
        .unwrap();

        let mut payload = serde_json::json!({
            "toolCall": {
                "name": "run_command",
                "args": {
                    "CommandLine": "npm test"
                }
            },
            "stepIdx": 5,
            "artifactDirectoryPath": dir.path().to_str().unwrap()
        });

        // Act
        let enriched = enrich_antigravity_step_output(&mut payload, HookEvent::PostToolUse, None);

        // Assert
        assert!(enriched);
        assert_eq!(
            payload
                .get("tool_response")
                .and_then(serde_json::Value::as_str),
            Some("npm test passed: 42 tests OK")
        );
    }

    #[test]
    fn test_enrich_antigravity_step_output_falls_back_to_transcript_path() {
        // Arrange
        let dir = tempdir().unwrap();
        let logs_dir = dir.path().join(".system_generated").join("logs");
        let step_dir = dir
            .path()
            .join(".system_generated")
            .join("steps")
            .join("12");
        fs::create_dir_all(&logs_dir).unwrap();
        fs::create_dir_all(&step_dir).unwrap();
        let transcript = logs_dir.join("transcript.jsonl");
        fs::write(&transcript, "").unwrap();
        fs::write(step_dir.join("output.txt"), "found file content").unwrap();

        let mut payload = serde_json::json!({
            "toolCall": {
                "name": "view_file",
                "args": {"AbsolutePath": "/workspace/src/lib.rs"}
            },
            "stepIdx": "12",
            "transcriptPath": transcript.to_str().unwrap()
        });

        // Act
        let enriched = enrich_antigravity_step_output(&mut payload, HookEvent::PostToolUse, None);

        // Assert
        assert!(enriched);
        assert_eq!(
            payload
                .get("tool_response")
                .and_then(serde_json::Value::as_str),
            Some("found file content")
        );
    }

    #[test]
    fn test_enrich_antigravity_step_output_bypasses_ineligible_tools() {
        // Arrange: write_to_file must NEVER be enriched with output.txt
        let dir = tempdir().unwrap();
        let step_dir = dir.path().join(".system_generated").join("steps").join("1");
        fs::create_dir_all(&step_dir).unwrap();
        fs::write(step_dir.join("output.txt"), "Created file test.rs").unwrap();

        let mut payload = serde_json::json!({
            "toolCall": {
                "name": "write_to_file",
                "args": {
                    "TargetFile": "/workspace/test.rs",
                    "CodeContent": "fn main() {}"
                }
            },
            "stepIdx": 1,
            "artifactDirectoryPath": dir.path().to_str().unwrap()
        });

        // Act
        let enriched = enrich_antigravity_step_output(&mut payload, HookEvent::PostToolUse, None);

        // Assert
        assert!(!enriched);
        assert!(payload.get("tool_response").is_none());
    }

    #[test]
    fn test_enrich_antigravity_step_output_ignores_non_post_tool_use() {
        // Arrange
        let dir = tempdir().unwrap();
        let step_dir = dir.path().join(".system_generated").join("steps").join("1");
        fs::create_dir_all(&step_dir).unwrap();
        fs::write(step_dir.join("output.txt"), "output").unwrap();

        let mut payload = serde_json::json!({
            "toolCall": {
                "name": "run_command",
                "args": {"CommandLine": "ls"}
            },
            "stepIdx": 1,
            "artifactDirectoryPath": dir.path().to_str().unwrap()
        });

        // Act: PreToolUse
        let enriched = enrich_antigravity_step_output(&mut payload, HookEvent::PreToolUse, None);

        // Assert
        assert!(!enriched);
        assert!(payload.get("tool_response").is_none());
    }

    #[test]
    fn test_enrich_antigravity_step_output_does_not_overwrite_existing_response() {
        // Arrange
        let dir = tempdir().unwrap();
        let step_dir = dir.path().join(".system_generated").join("steps").join("1");
        fs::create_dir_all(&step_dir).unwrap();
        fs::write(step_dir.join("output.txt"), "from disk").unwrap();

        let mut payload = serde_json::json!({
            "toolCall": {
                "name": "run_command",
                "args": {"CommandLine": "ls"}
            },
            "stepIdx": 1,
            "artifactDirectoryPath": dir.path().to_str().unwrap(),
            "tool_response": "already populated"
        });

        // Act
        let enriched = enrich_antigravity_step_output(&mut payload, HookEvent::PostToolUse, None);

        // Assert
        assert!(!enriched);
        assert_eq!(
            payload
                .get("tool_response")
                .and_then(serde_json::Value::as_str),
            Some("already populated")
        );
    }
}
