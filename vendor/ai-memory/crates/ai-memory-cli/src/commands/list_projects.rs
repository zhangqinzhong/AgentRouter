//! `ai-memory list-projects` — plain read-only listing of every
//! workspace/project pair the server knows about.
//!
//! Before this command, the only way to see this from the client was to hit
//! `GET /api/v1/projects` directly with curl/Invoke-RestMethod. `show`'s own
//! use of that endpoint is folded into an interactive picker and silently
//! falls back to client-local scan results when the server call fails, so it
//! was never a plain, scriptable listing on its own.
//!
//! `/api/v1/projects` is mounted only by `serve --enable-web` or
//! `--enable-api`, so a 404 there falls back to the always-mounted
//! `GET /admin/projects`. `show` lists projects through the same fallback.

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::cli::ListProjectsArgs;
use crate::commands::show::ProjectRow;
use crate::config::Config;
use crate::http_client::{ServerEndpoint, ServerResponseError, get_json};

const WEB_PROJECTS_PATH: &str = "/api/v1/projects";
const ADMIN_PROJECTS_PATH: &str = "/admin/projects";

#[derive(Debug, Deserialize)]
struct AdminProjectList {
    projects: Vec<ProjectRow>,
}

pub async fn run(config: &Config, args: ListProjectsArgs) -> Result<()> {
    let endpoint = ServerEndpoint::from_config_resolving_auth(config).await;
    let rows = fetch_sorted(&endpoint, args.workspace.as_deref()).await?;

    if args.json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }

    print!("{}", render_human(&rows));
    Ok(())
}

async fn fetch_sorted(
    endpoint: &ServerEndpoint,
    workspace: Option<&str>,
) -> Result<Vec<ProjectRow>> {
    let mut rows = fetch_project_rows(endpoint, workspace).await?;
    sort_rows(&mut rows);
    Ok(rows)
}

/// The server's project listing, from `/api/v1/projects` or, when that route
/// is not mounted, from `/admin/projects` filtered to `workspace` here.
pub(crate) async fn fetch_project_rows(
    endpoint: &ServerEndpoint,
    workspace: Option<&str>,
) -> Result<Vec<ProjectRow>> {
    let workspace = workspace.map(str::trim).filter(|value| !value.is_empty());
    let query = workspace.map_or_else(Vec::new, |workspace| vec![("workspace", workspace)]);
    match get_json::<Vec<ProjectRow>>(endpoint, WEB_PROJECTS_PATH, &query).await {
        Ok(rows) => Ok(rows),
        Err(error) if is_not_found(&error) => fetch_from_admin(endpoint, workspace).await,
        Err(error) => Err(error),
    }
}

async fn fetch_from_admin(
    endpoint: &ServerEndpoint,
    workspace: Option<&str>,
) -> Result<Vec<ProjectRow>> {
    let listing: AdminProjectList = get_json(endpoint, ADMIN_PROJECTS_PATH, &[])
        .await
        .with_context(|| {
            format!(
                "{WEB_PROJECTS_PATH} returned 404 and the fallback {ADMIN_PROJECTS_PATH} also \
                 failed. The server may run without `--enable-api` (or `--enable-web`), the \
                 server URL or base path may be wrong, or, on a multi-user server, the admin \
                 route needs the root token"
            )
        })?;
    Ok(keep_workspace(listing.projects, workspace))
}

fn is_not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ServerResponseError>()
        .is_some_and(|response| response.status() == reqwest::StatusCode::NOT_FOUND)
}

fn keep_workspace(rows: Vec<ProjectRow>, workspace: Option<&str>) -> Vec<ProjectRow> {
    match workspace {
        Some(workspace) => rows
            .into_iter()
            .filter(|row| row.workspace_name == workspace)
            .collect(),
        None => rows,
    }
}

fn sort_rows(rows: &mut [ProjectRow]) {
    rows.sort_by(|a, b| {
        a.workspace_name
            .cmp(&b.workspace_name)
            .then_with(|| a.project_name.cmp(&b.project_name))
    });
}

fn render_human(rows: &[ProjectRow]) -> String {
    if rows.is_empty() {
        return "No projects found.\n".to_owned();
    }

    let workspace_width = rows
        .iter()
        .map(|row| row.workspace_name.len())
        .max()
        .unwrap_or(0)
        .max("WORKSPACE".len());
    let project_width = rows
        .iter()
        .map(|row| row.project_name.len())
        .max()
        .unwrap_or(0)
        .max("PROJECT".len());
    // The id column carries what `--project-id` takes. A row from an older
    // server has no id; render `-` rather than hiding the column, so the
    // header stays stable across server versions. (#1208)
    let id_width = rows
        .iter()
        .map(|row| row.project_id.as_deref().unwrap_or("-").len())
        .max()
        .unwrap_or(0)
        .max("PROJECT ID".len());

    let mut out = format!(
        "{:workspace_width$}  {:project_width$}  {:id_width$}  {:>6}  LAST UPDATED\n",
        "WORKSPACE", "PROJECT", "PROJECT ID", "PAGES"
    );
    for row in rows {
        out += &format!(
            "{:workspace_width$}  {:project_width$}  {:id_width$}  {:>6}  {}\n",
            row.workspace_name,
            row.project_name,
            row.project_id.as_deref().unwrap_or("-"),
            row.page_count,
            row.last_updated.as_deref().unwrap_or("-")
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(workspace: &str, project: &str, pages: u64, last_updated: Option<&str>) -> ProjectRow {
        ProjectRow {
            workspace_id: Some(format!("{workspace}-id")),
            workspace_name: workspace.to_owned(),
            project_id: Some(format!("{project}-id")),
            project_name: project.to_owned(),
            page_count: pages,
            last_updated: last_updated.map(str::to_owned),
        }
    }

    /// The id column is what makes `--project-id` usable: the operator reads
    /// the UUID here and passes it to the destructive admin commands. (#1208)
    #[test]
    fn render_human_includes_the_project_id_needed_by_project_id_flags() {
        let rows = vec![row("default", "acme-api", 12, None)];
        let out = render_human(&rows);
        assert!(out.contains("PROJECT ID"), "{out}");
        assert!(
            out.contains("acme-api-id"),
            "the id is what an operator passes to --project-id: {out}"
        );
    }

    /// A row from a server that predates the id fields still renders: the
    /// column shows `-` instead of collapsing or panicking.
    #[test]
    fn render_human_shows_a_dash_for_a_row_from_an_older_server() {
        let rows = vec![ProjectRow {
            workspace_id: None,
            workspace_name: "default".to_owned(),
            project_id: None,
            project_name: "legacy".to_owned(),
            page_count: 1,
            last_updated: None,
        }];
        let out = render_human(&rows);
        let data_line = out.lines().nth(1).expect("one data line");
        assert!(data_line.contains("legacy"), "{data_line}");
        assert!(
            data_line.matches(" - ").count() >= 1,
            "a missing id renders as a dash, not an empty column: {data_line}"
        );
    }

    #[test]
    fn render_human_reports_an_empty_server() {
        assert_eq!(render_human(&[]), "No projects found.\n");
    }

    #[test]
    fn render_human_prints_a_header_and_one_row_per_project() {
        let rows = vec![row("default", "acme-api", 12, Some("2026-09-30T00:00:00Z"))];
        let out = render_human(&rows);
        assert!(out.starts_with("WORKSPACE"), "{out}");
        assert!(out.contains("default"), "{out}");
        assert!(out.contains("acme-api"), "{out}");
        assert!(out.contains("12"), "{out}");
        assert!(out.contains("2026-09-30T00:00:00Z"), "{out}");
    }

    #[test]
    fn render_human_shows_a_dash_for_a_project_with_no_pages_yet() {
        let rows = vec![row("default", "empty-project", 0, None)];
        let out = render_human(&rows);
        let data_line = out.lines().nth(1).expect("one data line");
        assert!(data_line.contains("empty-project"), "{data_line}");
        assert!(data_line.trim_end().ends_with('-'), "{data_line}");
    }

    #[test]
    fn render_human_columns_widen_to_the_longest_name() {
        let rows = vec![
            row("default", "a", 1, None),
            row(
                "a-much-longer-workspace-name",
                "a-much-longer-project-name",
                2,
                None,
            ),
        ];
        let out = render_human(&rows);
        // Every data line must be at least as wide as the longest name in its
        // column, i.e. the short names are padded, not truncated.
        for line in out.lines().skip(1) {
            assert!(
                line.len() >= "a-much-longer-workspace-name".len(),
                "line not padded to the widest workspace name: {line:?}"
            );
        }
    }

    #[test]
    fn sort_orders_by_workspace_then_project() {
        let mut rows = [
            row("default", "zeta", 1, None),
            row("alpha", "zeta", 1, None),
            row("default", "alpha", 1, None),
        ];
        sort_rows(&mut rows);
        let ordered: Vec<(&str, &str)> = rows
            .iter()
            .map(|r| (r.workspace_name.as_str(), r.project_name.as_str()))
            .collect();
        assert_eq!(
            ordered,
            vec![("alpha", "zeta"), ("default", "alpha"), ("default", "zeta")]
        );
    }

    #[test]
    fn a_404_from_the_web_route_triggers_the_admin_fallback() {
        let error = crate::http_client::server_response_error_for_test(
            reqwest::Method::GET,
            WEB_PROJECTS_PATH,
            reqwest::StatusCode::NOT_FOUND,
            String::new(),
        );
        assert!(is_not_found(&error));
    }

    #[test]
    fn other_failures_do_not_trigger_the_admin_fallback() {
        let error = crate::http_client::server_response_error_for_test(
            reqwest::Method::GET,
            WEB_PROJECTS_PATH,
            reqwest::StatusCode::UNAUTHORIZED,
            String::new(),
        );
        assert!(!is_not_found(&error));
        assert!(!is_not_found(&anyhow::anyhow!("connection refused")));
    }

    #[test]
    fn admin_listing_parses_the_wrapped_project_rows() {
        let body = r#"{"projects":[{"workspace_name":"default","project_name":"acme-api","page_count":3,"last_updated":null}]}"#;
        let listing: AdminProjectList = serde_json::from_str(body).expect("admin listing");
        assert_eq!(listing.projects.len(), 1);
        assert_eq!(listing.projects[0].project_name, "acme-api");
    }

    #[test]
    fn keep_workspace_filters_only_when_a_workspace_is_given() {
        let rows = vec![row("default", "a", 1, None), row("team", "b", 1, None)];
        assert_eq!(keep_workspace(rows.clone(), None).len(), 2);
        let kept = keep_workspace(rows, Some("team"));
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].project_name, "b");
    }

    async fn serve(app: axum::Router) -> (ServerEndpoint, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (
            ServerEndpoint::from_pair(Some(format!("http://{address}")), None),
            server,
        )
    }

    #[tokio::test]
    async fn a_server_without_the_web_ui_is_listed_through_the_admin_route() {
        let app = axum::Router::new().route(
            ADMIN_PROJECTS_PATH,
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({ "projects": [
                    { "workspace_name": "team", "project_name": "zeta", "page_count": 1, "last_updated": null },
                    { "workspace_name": "default", "project_name": "web", "page_count": 2, "last_updated": null },
                    { "workspace_name": "team", "project_name": "alpha", "page_count": 3, "last_updated": null },
                ]}))
            }),
        );
        let (endpoint, server) = serve(app).await;

        let all = fetch_sorted(&endpoint, None).await.expect("admin fallback");
        let team = fetch_sorted(&endpoint, Some(" team "))
            .await
            .expect("filtered");
        server.abort();

        let names = |rows: &[ProjectRow]| {
            rows.iter()
                .map(|r| format!("{}/{}", r.workspace_name, r.project_name))
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&all), ["default/web", "team/alpha", "team/zeta"]);
        assert_eq!(names(&team), ["team/alpha", "team/zeta"]);
    }

    #[tokio::test]
    async fn a_failed_fallback_explains_how_to_fix_it() {
        let (endpoint, server) = serve(axum::Router::new()).await;
        let error = fetch_sorted(&endpoint, None)
            .await
            .expect_err("both routes 404");
        server.abort();

        let message = format!("{error:#}");
        assert!(message.contains("--enable-web"), "{message}");
        assert!(message.contains(ADMIN_PROJECTS_PATH), "{message}");
    }
}
