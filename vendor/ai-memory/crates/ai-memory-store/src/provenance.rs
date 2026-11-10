//! Version-specific, access-filtered knowledge evidence.
use crate::{ReaderPool, RelatedPage, StoreResult};
use ai_memory_core::{OwnerFilter, PageId, ProjectId, SessionId, UserId, WorkspaceId};
use rusqlite::{OptionalExtension, params};

/// A recorded source; opaque identifiers are never presented as verified links.
#[derive(Debug)]
pub struct PageSource {
    /// Recorded evidence category.
    pub kind: String,
    /// Citation time, in UTC microseconds.
    pub created_at: i64,
    /// Existing source session in the same scope, if readable.
    pub session_id: Option<SessionId>,
    /// Existing observation identifier, when this cites an observation.
    pub observation_id: Option<String>,
}
/// A live, readable declared disagreement. It does not establish which page is correct.
#[derive(Debug)]
pub struct PageDisagreement {
    /// The visible far end.
    pub page: RelatedPage,
    /// Whether the consulted page declared the edge.
    pub outgoing: bool,
}
/// Evidence for exactly the current version, with visible totals and bounded pages.
#[derive(Debug)]
pub struct PageProvenance {
    /// Indexed version, not a guessed page path identity.
    pub page_id: PageId,
    /// Visible evidence at the requested offset.
    pub sources: Vec<PageSource>,
    /// Count after source scope and ownership checks.
    pub source_count: usize,
    /// Live readable disagreements; capped at twenty.
    pub disagreements: Vec<PageDisagreement>,
    /// Count after far-end authorization and expiry filtering.
    pub disagreement_count: usize,
}
impl ReaderPool {
    /// Read evidence for an authorized page coordinate. Source ownership does
    /// not filter the shared page itself. Missing/foreign source IDs are omitted.
    ///
    /// # Errors
    /// Returns pool, SQL and malformed stored-ID errors.
    pub async fn page_provenance(
        &self,
        ws: WorkspaceId,
        project: ProjectId,
        path: String,
        viewer: Option<UserId>,
        owner: OwnerFilter,
        offset: usize,
    ) -> StoreResult<Option<PageProvenance>> {
        self.with_conn(move |conn| {
            let id: Option<Vec<u8>> = conn
                .query_row(
                    "SELECT id FROM pages WHERE workspace_id=?1 AND project_id=?2 \
                 AND path=?3 AND is_latest=1",
                    params![ws.as_bytes(), project.as_bytes(), path],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(id) = id else {
                return Ok(None);
            };
            let (mode, actor) = match owner {
                OwnerFilter::Any => (0, String::new()),
                OwnerFilter::User(a) => (1, a),
                OwnerFilter::Unattributed => (2, String::new()),
            };
            // Decode source IDs, keeping indexed BLOB columns bare for point lookups.
            // Both the session and observation must match the page coordinate.
            // Feedback and rewrite ids are opaque, so only category/time is exposed.
            let base = "FROM page_evidence e LEFT JOIN observations o \
                ON e.source_kind='observation' \
                AND o.id=unhex(replace(e.source_id,'-','')) \
                AND o.workspace_id=?2 AND o.project_id=?3 \
                LEFT JOIN sessions s ON s.id=CASE \
                WHEN e.source_kind='session' THEN unhex(replace(e.source_id,'-','')) \
                WHEN e.source_kind='observation' THEN o.session_id END \
                AND s.workspace_id=?2 AND s.project_id=?3 \
                WHERE e.page_id=?1 AND (e.source_kind IN ('feedback','reconsolidation') \
                OR (s.id IS NOT NULL AND (?4=0 OR s.actor_user IS NULL \
                OR (?4=1 AND s.actor_user=?5))))";
            let source_count = conn.query_row(
                &format!("SELECT COUNT(*) {base}"),
                params![id, ws.as_bytes(), project.as_bytes(), mode, actor],
                |r| r.get::<_, usize>(0),
            )?;
            let mut stmt = conn.prepare(&format!(
                "SELECT e.source_kind,e.created_at,s.id,lower(hex(o.id)) {base} \
                 ORDER BY e.created_at DESC,e.source_kind,e.source_id LIMIT 20 OFFSET ?6"
            ))?;
            let rows = stmt.query_map(
                params![
                    id,
                    ws.as_bytes(),
                    project.as_bytes(),
                    mode,
                    actor,
                    i64::try_from(offset).unwrap_or(i64::MAX)
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, Option<Vec<u8>>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )?;
            let mut sources = Vec::new();
            for row in rows {
                let (kind, created_at, sid, observation_id) = row?;
                sources.push(PageSource {
                    kind,
                    created_at,
                    session_id: sid.map(|b| SessionId::from_slice(&b)).transpose()?,
                    observation_id: observation_id.filter(|s| !s.is_empty()),
                });
            }
            let visible = crate::reader::readable_repository_predicate("pg.project_id", viewer);
            let ttl = crate::reader::not_expired("pg", "?2");
            let edges = format!(
                "FROM links l JOIN pages pg ON pg.id=CASE WHEN l.from_page_id=?1 \
                 THEN l.to_page_id ELSE l.from_page_id END \
                 JOIN projects pr ON pr.id=pg.project_id \
                 JOIN workspaces w ON w.id=pg.workspace_id \
                 WHERE l.link_type='contradicts' \
                 AND (l.from_page_id=?1 OR l.to_page_id=?1) \
                 AND pg.is_latest=1{visible}{ttl}"
            );
            let now = jiff::Timestamp::now().as_microsecond();
            let disagreement_count =
                conn.query_row(&format!("SELECT COUNT(*) {edges}"), params![id, now], |r| {
                    r.get(0)
                })?;
            let kind = crate::reader::page_kind_expr("pg.path", "pg.frontmatter_json");
            let mut stmt = conn.prepare(&format!(
                "SELECT pg.path,pg.title,w.name,pr.name,l.from_page_id=?1,{kind} {edges} \
                 ORDER BY w.name,pr.name,pg.path LIMIT 20"
            ))?;
            let disagreements = stmt
                .query_map(params![id, now], |r| {
                    Ok(PageDisagreement {
                        page: RelatedPage {
                            path: r.get(0)?,
                            title: r.get(1)?,
                            workspace: r.get(2)?,
                            project: r.get(3)?,
                            kind: r.get(5)?,
                        },
                        outgoing: r.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Some(PageProvenance {
                page_id: PageId::from_slice(&id)?,
                sources,
                source_count,
                disagreements,
                disagreement_count,
            }))
        })
        .await
    }
}
