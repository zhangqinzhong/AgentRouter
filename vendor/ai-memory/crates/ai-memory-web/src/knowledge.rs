//! Evidence beside the consulted page. Recall is recomputed only on request.
use crate::{
    state::WebState,
    templates::{HitTrace, encode_segment, page_href, session_href},
};
use ai_memory_core::{OwnerFilter, Tier, UserId};
use ai_memory_store::{PageFilter, PageMeta, PageProvenance};
use axum::http::StatusCode;
use std::sync::Arc;

#[derive(Default, serde::Deserialize)]
pub(crate) struct KnowledgeQuery {
    pub evidence_offset: Option<String>,
    pub recall_q: Option<String>,
    pub recall_kind: Option<String>,
    pub recall_tier: Option<String>,
    pub recall_limit: Option<String>,
    pub recall_global: Option<String>,
    pub recall_explain: Option<String>,
}
pub(crate) struct SourceView {
    pub kind: String,
    pub at: String,
    pub href: String,
    pub label: String,
}
pub(crate) struct DisagreementView {
    pub href: String,
    pub title: String,
    pub direction: &'static str,
}
pub(crate) struct KnowledgeView {
    pub version: String,
    pub expiry: String,
    pub sources: Vec<SourceView>,
    pub source_count: usize,
    pub older: String,
    pub newer: String,
    pub disagreements: Vec<DisagreementView>,
    pub disagreement_count: usize,
    pub query: String,
    pub explain_href: String,
    pub search_href: String,
    pub recall_note: String,
    pub trace: Option<HitTrace>,
}
impl KnowledgeQuery {
    pub fn href(&self, base: &str, offset: usize, explain: bool) -> String {
        let mut result = format!("{base}?evidence_offset={offset}");
        for (key, value) in [
            ("recall_q", &self.recall_q),
            ("recall_kind", &self.recall_kind),
            ("recall_tier", &self.recall_tier),
            ("recall_limit", &self.recall_limit),
            ("recall_global", &self.recall_global),
        ] {
            if let Some(value) = value {
                result.push_str(&format!("&{key}={}", encode_segment(value)));
            }
        }
        if explain {
            result.push_str("&recall_explain=1");
        }
        result
    }
}
/// The route has already resolved and authorized the page coordinate.
pub(crate) async fn view(
    state: &Arc<WebState>,
    meta: &PageMeta,
    workspace: &str,
    project: &str,
    viewer: Option<UserId>,
    owner: OwnerFilter,
    q: &KnowledgeQuery,
) -> Result<KnowledgeView, StatusCode> {
    let bad = StatusCode::BAD_REQUEST;
    if [
        &q.recall_q,
        &q.recall_kind,
        &q.recall_tier,
        &q.recall_limit,
        &q.recall_global,
    ]
    .iter()
    .any(|v| v.as_ref().is_some_and(|s| s.len() > 2000))
    {
        return Err(bad);
    }
    let offset = q
        .evidence_offset
        .as_deref()
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|_| bad)?;
    if offset > i64::MAX as usize {
        return Err(bad);
    }
    let limit = q
        .recall_limit
        .as_deref()
        .unwrap_or("20")
        .parse::<usize>()
        .map_err(|_| bad)?
        .clamp(1, 100);
    let tier = match q.recall_tier.as_deref().filter(|s| !s.is_empty()) {
        Some(v) => Some(
            Tier::ALL
                .iter()
                .find(|t| t.as_str().eq_ignore_ascii_case(v))
                .ok_or(bad)?
                .as_str(),
        ),
        None => None,
    };
    let filter = PageFilter {
        kind: q.recall_kind.as_deref().filter(|s| !s.is_empty()),
        tier,
        ..PageFilter::default()
    };
    let PageProvenance {
        page_id,
        sources,
        source_count,
        disagreements,
        disagreement_count,
    } = state
        .reader
        .page_provenance(
            meta.workspace_id,
            meta.project_id,
            meta.path.clone(),
            viewer,
            owner.clone(),
            offset,
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let base = page_href(workspace, project, &meta.path);
    let query = q.recall_q.as_deref().unwrap_or("").trim().to_string();
    let global = q.recall_global.as_deref() == Some("1");
    let mut search_href = format!(
        "search?q={}&explain=1&limit={limit}",
        encode_segment(&query)
    );
    if !global {
        search_href.push_str(&format!(
            "&workspace={}&project={}",
            encode_segment(workspace),
            encode_segment(project)
        ));
    }
    for (key, value) in [("kind", filter.kind), ("tier", filter.tier)] {
        if let Some(v) = value {
            search_href.push_str(&format!("&{key}={}", encode_segment(v)));
        }
    }
    let mut recall_note=if query.is_empty(){"Opened directly: no retrieval query was supplied. A direct URL does not establish a retrieval reason."}else{"Search context is carried in the URL. Recompute explicitly to inspect the current ranker; configured embedding/reranking providers may be contacted."}.to_string();
    let mut trace = None;
    if !query.is_empty() && q.recall_explain.as_deref() == Some("1") {
        if global {
            let hits = state
                .reader
                .search_pages_with_meta(query.clone(), limit + 1, None, viewer, filter)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            recall_note=match hits.iter().take(limit).position(|h|h.id==page_id){Some(i)=>format!("Recomputed now: cross-project FTS-only retrieval, position {}. This stream has no hybrid RRF explanation.",i+1),None=>"Recomputed now: this page is outside the current result window. It may have changed or expired.".into()};
        } else {
            let result = crate::recall::search_scopes(
                state,
                &[(meta.workspace_id, meta.project_id)],
                &query,
                limit + 1,
                true,
                &owner,
                filter,
            )
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            for (position, (hit, details)) in result.hits.into_iter().take(limit).enumerate() {
                if hit.id == page_id {
                    trace = details
                        .map(|d| crate::routes::search::hit_trace(position + 1, hit.rank, &d));
                    break;
                }
            }
            recall_note=if trace.is_some(){"Recomputed now with the current index, permissions and configured providers. This is not a historical snapshot of the original search."}else{"Recomputed now: this page is outside the current result window. It may have changed or expired."}.into();
        }
    }
    Ok(KnowledgeView {
        version: page_id.to_string(),
        expiry: meta.expires_at.clone().unwrap_or_else(|| {
            "No recorded expiration; validity is not independently verified.".into()
        }),
        sources: sources
            .into_iter()
            .map(|s| SourceView {
                kind: s.kind,
                at: jiff::Timestamp::from_microsecond(s.created_at)
                    .map(|t| t.to_string())
                    .unwrap_or_default(),
                href: s
                    .session_id
                    .map(|id| session_href(workspace, project, &id.to_string()))
                    .unwrap_or_default(),
                label: s
                    .observation_id
                    .map(|id| format!("Observation {id}"))
                    .unwrap_or_else(|| {
                        s.session_id
                            .map(|id| format!("Session {id}"))
                            .unwrap_or_else(|| {
                                "Recorded citation; no verifiable source link".into()
                            })
                    }),
            })
            .collect(),
        source_count,
        older: if offset.saturating_add(20) < source_count {
            q.href(&base, offset + 20, false)
        } else {
            String::new()
        },
        newer: if offset > 0 {
            q.href(&base, offset.saturating_sub(20), false)
        } else {
            String::new()
        },
        disagreements: disagreements
            .into_iter()
            .map(|d| DisagreementView {
                href: page_href(&d.page.workspace, &d.page.project, &d.page.path),
                title: format!("{}/{} · {}", d.page.workspace, d.page.project, d.page.title),
                direction: if d.outgoing {
                    "This page contradicts"
                } else {
                    "Contradicted by"
                },
            })
            .collect(),
        disagreement_count,
        explain_href: q.href(&base, offset, true),
        search_href,
        query,
        recall_note,
        trace,
    })
}
