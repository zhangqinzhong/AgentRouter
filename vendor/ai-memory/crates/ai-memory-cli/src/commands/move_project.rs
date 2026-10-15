//! `ai-memory move-project` — thin HTTP client for cross-workspace project move.

use anyhow::{Result, bail};
use serde::Serialize;

use crate::cli::MoveProjectArgs;
use crate::config::Config;
use crate::http_client::{ServerEndpoint, post_json};

/// Request sent to `POST /admin/move-project`.
#[derive(Serialize)]
struct MoveProjectRequest {
    from_workspace: String,
    /// Exactly one of `project` / `project_id` is `Some`. `--project-id`
    /// bypasses the server's name/legacy/canonical lookup, which is the point:
    /// a legacy row whose name collides with another project's `legacy_name`
    /// is otherwise unreachable by name. (#1208)
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    to_workspace: String,
    confirm: bool,
    force: bool,
    on_conflict: String,
}

/// Run the `move-project` subcommand.
///
/// Resolves the source project name (auto-derived from the git repo root
/// when `--project` is omitted) -- or, when `--project-id` is given, skips
/// name resolution and moves that id directly, the only way to reach a legacy
/// row whose name is shadowed by another project's `legacy_name` -- requires
/// `--confirm` before sending the request (a true-move re-stamp or a
/// copy+purge merge, both irreversible), then prints the report.
///
/// # Errors
/// Returns an error when `--confirm` is absent, the server is unreachable,
/// or the server returns a non-2xx response.
pub async fn run(config: &Config, args: MoveProjectArgs) -> Result<()> {
    let (from_workspace, project, project_id) = match args.project_id {
        Some(id) => (
            super::resolve_workspace(config, args.from_workspace.as_deref())?,
            None,
            Some(id),
        ),
        None => {
            let (ws, project) = super::resolve_scope(
                config,
                args.from_workspace.as_deref(),
                args.project.as_deref(),
            )?;
            (ws, Some(project), None)
        }
    };
    let (target_flag, requested) = match (&project, &project_id) {
        (Some(project), _) => (format!("--project {project}"), project.clone()),
        (None, Some(id)) => (format!("--project-id {id}"), id.clone()),
        (None, None) => bail!("one of --project or --project-id is required"),
    };

    if !args.confirm {
        bail!(
            "move-project moves {}/{} to workspace {}. If the destination has \
             no same-named project it is a lossless true-move (re-stamp in \
             place — sessions, observations and history preserved). If it \
             already has one, the pages are copied in and merged, then the \
             source is PURGED. Both are irreversible.\n\
             Re-run with --confirm to proceed:\n\n  \
             ai-memory move-project --from-workspace {} {} \
             --to-workspace {} --confirm",
            from_workspace,
            target_flag,
            args.to_workspace,
            from_workspace,
            target_flag,
            args.to_workspace,
        );
    }

    let endpoint = ServerEndpoint::from_config_resolving_auth(config).await;
    let report: serde_json::Value = post_json(
        &endpoint,
        "/admin/move-project",
        &MoveProjectRequest {
            from_workspace: from_workspace.clone(),
            project: project.clone(),
            project_id: project_id.clone(),
            to_workspace: args.to_workspace.clone(),
            confirm: true,
            force: args.force,
            on_conflict: args.on_conflict.clone(),
        },
    )
    .await?;

    let pages = report["pages_copied"].as_u64().unwrap_or(0);
    let target_label = moved_project_name(&report, requested);
    let purged = report["source_purged"].as_bool().unwrap_or(false);
    let moved_via = report["moved_via"].as_str().unwrap_or("");
    let skipped_count = report["pages_skipped"].as_array().map_or(0, |s| s.len());
    if let Some(warning) = report["manifest_warning"].as_str() {
        eprintln!("ai-memory: warning: {warning}");
    }

    if (moved_via == "true-move" || purged)
        && let Err(error) = super::project_registry::rekey_scope(
            config,
            &endpoint,
            &from_workspace,
            &target_label,
            &args.to_workspace,
            &target_label,
        )
    {
        eprintln!(
            "ai-memory: project moved, but the client-local checkout link could not be updated ({error:#})"
        );
    }

    if moved_via == "true-move" {
        // Lossless: re-stamped in place, nothing copied or purged.
        println!(
            "Moved {}/{} → {}/{}: {pages} pages re-stamped (true move — \
             sessions, observations and history preserved).",
            from_workspace, target_label, args.to_workspace, target_label,
        );
    } else {
        // copy-purge (merge into an existing same-named project).
        let tail = if skipped_count > 0 {
            ", SOURCE LEFT INTACT (some pages unreadable — fix and re-run)"
        } else if purged {
            ", source purged"
        } else {
            ", SOURCE LEFT INTACT (partial copy)"
        };
        println!(
            "Moved {}/{} → {}/{}: {pages} pages copied (merged into existing \
             project){tail}.",
            from_workspace, target_label, args.to_workspace, target_label,
        );
        if skipped_count > 0 {
            println!(
                "Warning: {skipped_count} page(s) could not be read from the \
                 source and were skipped; the source was NOT purged. Fix and re-run.",
            );
        }
        if let Some(conflicts) = report["conflicts"].as_array().filter(|c| !c.is_empty()) {
            println!(
                "{} path conflict(s) — source page kept under a de-duplicated path \
                 (both versions preserved):",
                conflicts.len()
            );
            for c in conflicts {
                println!(
                    "  {} → {}",
                    c["path"].as_str().unwrap_or("?"),
                    c["moved_to"].as_str().unwrap_or("?"),
                );
            }
        }
    }
    Ok(())
}

/// The moved project's name as the server resolved it. The report's `from` is
/// `<workspace>/<project>`, and it is the only way to learn the name behind
/// `--project-id`; the client-local checkout link is keyed by that name.
fn moved_project_name(report: &serde_json::Value, requested: String) -> String {
    report["from"]
        .as_str()
        .and_then(|label| label.rsplit_once('/'))
        .map_or(requested, |(_, name)| name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::moved_project_name;

    #[test]
    fn a_move_by_id_rekeys_the_link_under_the_resolved_name() {
        let report = serde_json::json!({ "from": "default/api", "to": "team/api" });
        let id = "0193e7a1-0000-7000-8000-000000000001".to_owned();
        assert_eq!(moved_project_name(&report, id.clone()), "api");
        // A report without the label keeps what the operator asked for.
        assert_eq!(moved_project_name(&serde_json::json!({}), id.clone()), id);
    }
}
