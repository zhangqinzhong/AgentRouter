//! Content-free, access-filtered inbox notifications for the shared navigation.

use std::sync::Arc;

use ai_memory_core::AuthorizedViewer;
use axum::{
    Extension, Json,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;

use crate::state::WebState;

#[derive(Serialize)]
struct ProjectNotification {
    workspace: String,
    project: String,
    pending: u64,
}

#[derive(Serialize)]
struct Notifications {
    pending: u64,
    project_count: usize,
    projects: Vec<ProjectNotification>,
}

pub(crate) async fn handler(
    State(state): State<Arc<WebState>>,
    viewer: Option<Extension<AuthorizedViewer>>,
) -> Response {
    let mut counts = match state
        .reader
        .pending_inbox_counts(viewer.map(|v| v.0.user()))
        .await
    {
        Ok(counts) => counts,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    counts.sort_by(|a, b| {
        b.pending
            .cmp(&a.pending)
            .then_with(|| a.workspace_name.cmp(&b.workspace_name))
            .then_with(|| a.project_name.cmp(&b.project_name))
    });
    let notifications = Notifications {
        pending: counts
            .iter()
            .fold(0_u64, |n, c| n.saturating_add(c.pending)),
        project_count: counts.len(),
        projects: counts
            .into_iter()
            .take(5)
            .map(|c| ProjectNotification {
                workspace: c.workspace_name,
                project: c.project_name,
                pending: c.pending,
            })
            .collect(),
    };
    ([(header::CACHE_CONTROL, "no-store")], Json(notifications)).into_response()
}
