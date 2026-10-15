//! Cross-scope wikilink validation for LLM-produced page bodies (#1218).
//!
//! The consolidation prompts tell the model not to invent
//! `[[project:path]]` / `[[_global:path]]` links, but a prompt cannot
//! guarantee it (#1207 shipped the wording; this is the code backstop).
//! Whatever the lint pass would later flag as a dangling cross-project
//! dependency is instead caught here, before the write: every cross-scope
//! wikilink in a proposed body is resolved against the store with no-create
//! lookups, and an unresolved one is rewritten to its plain label text
//! (brackets dropped, label kept) so the prose still reads. Resolved links
//! survive byte-identical; same-project `[[target]]` links are by design
//! allowed to dangle (the target may be written later) and are never
//! touched.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

use ai_memory_core::{PagePath, WorkspaceId};
use ai_memory_store::{ReaderPool, ScopeResolutionError, lookup_existing_scope};
use tracing::warn;

/// A normalised link key as `ai_memory_wiki::extract_links` yields it:
/// `(workspace, project, path)`, with `workspace`/`project` `None` for a
/// same-project link. Only project-qualified keys ever enter the sets this
/// module handles.
pub(crate) type LinkKey = (Option<String>, Option<String>, String);

/// Collect the cross-scope link targets across `pages` — body wikilinks and
/// typed `relations:` frontmatter entries — that do NOT resolve to an
/// existing latest page in the store.
///
/// Lookups are no-create and batched: each named scope is resolved once via
/// [`lookup_existing_scope`], then every path under it is checked in a
/// single query. A missing workspace, a missing project, or an ambiguous
/// project name all count as unresolved — the link can never resolve
/// deterministically, so keeping it would only mint a lint finding. A
/// genuine store failure propagates rather than stripping links that may be
/// fine.
///
/// `source_workspace_id` supplies the workspace name for project-only
/// `[[project:path]]` links, exactly as the write-path link resolver treats
/// a missing workspace qualifier as "the source page's workspace".
pub(crate) async fn unresolved_cross_scope_links(
    reader: &ReaderPool,
    source_workspace_id: WorkspaceId,
    pages: &[(&PagePath, &str, &serde_json::Value)],
) -> Result<BTreeSet<LinkKey>, ScopeResolutionError> {
    let mut targets: BTreeSet<LinkKey> = BTreeSet::new();
    for (page_path, body, frontmatter) in pages {
        let links = ai_memory_wiki::extract_links(body, page_path)
            .into_iter()
            .chain(ai_memory_wiki::extract_relation_links(frontmatter));
        for link in links {
            if link.project.is_some() {
                targets.insert((link.workspace, link.project, link.path.as_str().to_string()));
            }
        }
    }
    if targets.is_empty() {
        return Ok(BTreeSet::new());
    }

    // The source workspace exists by construction — the session's
    // observations landed in it — so a miss here is a genuine store
    // inconsistency worth failing on rather than silently de-linking.
    let source_workspace = reader
        .workspace_name_by_id(source_workspace_id)
        .await?
        .ok_or_else(|| ScopeResolutionError::WorkspaceNotFound {
            workspace: source_workspace_id.to_string(),
        })?;

    let mut by_scope: BTreeMap<(String, String), Vec<LinkKey>> = BTreeMap::new();
    for key in targets {
        let workspace = key.0.clone().unwrap_or_else(|| source_workspace.clone());
        let project = key.1.clone().unwrap_or_default();
        by_scope.entry((workspace, project)).or_default().push(key);
    }

    let mut unresolved = BTreeSet::new();
    for ((workspace, project), keys) in by_scope {
        let scope = match lookup_existing_scope(reader, &workspace, &project).await {
            Ok(scope) => scope,
            Err(
                error @ (ScopeResolutionError::WorkspaceNotFound { .. }
                | ScopeResolutionError::ProjectNotFoundInWorkspace { .. }
                | ScopeResolutionError::ProjectNameAmbiguous { .. }),
            ) => {
                warn!(
                    target_scope = %format!("{workspace}/{project}"),
                    error = %error,
                    "de-linking cross-scope wikilinks: the named scope does not resolve",
                );
                unresolved.extend(keys);
                continue;
            }
            Err(error) => return Err(error),
        };
        let paths: Vec<String> = keys.iter().map(|key| key.2.clone()).collect();
        let existing: std::collections::HashSet<String> = reader
            .existing_latest_paths(scope.workspace_id, scope.project_id, paths)
            .await?
            .into_iter()
            .collect();
        for key in keys {
            if !existing.contains(&key.2) {
                warn!(
                    target = %format!("{}:{}", key.1.as_deref().unwrap_or_default(), key.2),
                    "de-linking cross-scope wikilink: no such page in the target project",
                );
                unresolved.insert(key);
            }
        }
    }
    Ok(unresolved)
}

/// Rewrite `body`, replacing every wikilink whose key is in `unresolved`
/// with its plain label text. A borrowed no-op when the set is empty.
pub(crate) fn delink_body<'a>(
    body: &'a str,
    page_path: &PagePath,
    unresolved: &BTreeSet<LinkKey>,
) -> Cow<'a, str> {
    if unresolved.is_empty() {
        return Cow::Borrowed(body);
    }
    Cow::Owned(ai_memory_wiki::delink_wikilinks(
        body, page_path, unresolved,
    ))
}

/// Drop every `relations:` entry whose target is in `unresolved`, then any
/// relation left empty, then an empty `relations` map. Entries are matched
/// through [`ai_memory_wiki::extract_relation_links`], so a target is keyed
/// exactly as the write boundary will parse it.
pub(crate) fn prune_relations(frontmatter: &mut serde_json::Value, unresolved: &BTreeSet<LinkKey>) {
    if unresolved.is_empty() {
        return;
    }
    let Some(relations) = frontmatter
        .get_mut("relations")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    for (relation, targets) in relations.iter_mut() {
        let Some(list) = targets.as_array_mut() else {
            continue;
        };
        list.retain(|entry| {
            let probe = serde_json::json!({ "relations": { relation.as_str(): [entry] } });
            ai_memory_wiki::extract_relation_links(&probe)
                .into_iter()
                .all(|link| {
                    !unresolved.contains(&(
                        link.workspace,
                        link.project,
                        link.path.as_str().to_string(),
                    ))
                })
        });
    }
    relations.retain(|_, targets| targets.as_array().is_none_or(|list| !list.is_empty()));
    if relations.is_empty()
        && let Some(map) = frontmatter.as_object_mut()
    {
        map.remove("relations");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(project: &str, path: &str) -> LinkKey {
        (None, Some(project.to_string()), path.to_string())
    }

    #[test]
    fn prune_relations_drops_only_unresolved_cross_scope_entries() {
        let mut fm = serde_json::json!({
            "title": "t",
            "relations": {
                "causes": ["ghost:notes/missing.md", "billing:notes/live.md", "local/page.md"],
                "fixes": ["ghost:other"],
            },
        });
        prune_relations(
            &mut fm,
            &BTreeSet::from([key("ghost", "notes/missing.md"), key("ghost", "other.md")]),
        );
        assert_eq!(
            fm["relations"]["causes"],
            serde_json::json!(["billing:notes/live.md", "local/page.md"])
        );
        assert!(
            fm["relations"].get("fixes").is_none(),
            "an emptied relation is removed"
        );
    }

    #[test]
    fn prune_relations_removes_an_emptied_map_and_ignores_an_empty_set() {
        let original = serde_json::json!({ "relations": { "causes": ["ghost:x.md"] } });
        let mut untouched = original.clone();
        prune_relations(&mut untouched, &BTreeSet::new());
        assert_eq!(untouched, original);

        let mut fm = original;
        prune_relations(&mut fm, &BTreeSet::from([key("ghost", "x.md")]));
        assert!(fm.get("relations").is_none());
    }
}
