//! Issue #1433: unicode61 treats an unspaced CJK run as one token. The
//! auxiliary index must recover substring queries without changing Latin-only
//! retrieval, scope filters, supersession, or upgraded-store behavior.

use ai_memory_core::{NewPage, PagePath, Tier};
use ai_memory_store::Store;

use super::retrieval_observation_stream::{observe, scope, search, session, session_page};

fn page(
    ws: ai_memory_core::WorkspaceId,
    project: ai_memory_core::ProjectId,
    path: &str,
    title: &str,
    body: &str,
) -> NewPage {
    NewPage {
        workspace_id: ws,
        project_id: project,
        path: PagePath::new(path).unwrap(),
        title: title.into(),
        body: body.into(),
        tier: Tier::Semantic,
        frontmatter_json: serde_json::json!({}),
        pinned: false,
        links: Vec::new(),
        author_id: None,
        expires_at: None,
        entities: Vec::new(),
        evidence: Vec::new(),
    }
}

#[tokio::test]
async fn page_search_finds_unspaced_cjk_substrings_and_keeps_latin_hits() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (ws, project) = scope(&store, "default", "app").await;

    store
        .writer
        .upsert_page(page(
            ws,
            project,
            "payments.md",
            "支付说明",
            "启用微信支付服务后检查回调。",
        ))
        .await
        .unwrap();
    store
        .writer
        .upsert_page(page(
            ws,
            project,
            "japanese.md",
            "運用手順",
            "本番環境で自動更新機能を確認する。",
        ))
        .await
        .unwrap();
    store
        .writer
        .upsert_page(page(
            ws,
            project,
            "deploy.md",
            "Deploy guide",
            "deploy the service after tests pass",
        ))
        .await
        .unwrap();

    let chinese = store
        .reader
        .search_pages_for_project(ws, project, "微信支付".into(), 10, None)
        .await
        .unwrap();
    assert_eq!(chinese.len(), 1);
    assert_eq!(chinese[0].path.as_str(), "payments.md");

    let japanese = store
        .reader
        .search_pages_for_project(ws, project, "自動更新".into(), 10, None)
        .await
        .unwrap();
    assert_eq!(japanese.len(), 1);
    assert_eq!(japanese[0].path.as_str(), "japanese.md");

    let global = store
        .reader
        .search_pages_with_meta(
            "微信支付".into(),
            10,
            None,
            None,
            ai_memory_store::PageFilter::default(),
        )
        .await
        .unwrap();
    assert_eq!(global.len(), 1);
    assert_eq!(global[0].path.as_str(), "payments.md");

    let mixed = store
        .reader
        .search_pages_for_project(ws, project, "deploy 支付".into(), 10, None)
        .await
        .unwrap();
    let paths: Vec<_> = mixed.iter().map(|hit| hit.path.as_str()).collect();
    assert!(
        paths.contains(&"deploy.md"),
        "Latin stream disappeared: {paths:?}"
    );
    assert!(
        paths.contains(&"payments.md"),
        "CJK stream disappeared: {paths:?}"
    );

    let latin = store
        .reader
        .search_pages_for_project(ws, project, "deploy service".into(), 10, None)
        .await
        .unwrap();
    assert_eq!(latin[0].path.as_str(), "deploy.md");
}

#[tokio::test]
async fn observation_search_and_session_votes_find_cjk_substrings() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (ws, project) = scope(&store, "default", "app").await;
    let session_id = session(&store, ws, project).await;
    observe(
        &store,
        ws,
        project,
        session_id,
        "启用微信支付服务后检查回调",
    )
    .await;
    session_page(
        &store,
        ws,
        project,
        session_id,
        "English-only session summary",
    )
    .await;

    let observations = store
        .reader
        .search_observations_for_project(ws, project, "微信支付".into(), 10)
        .await
        .unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].session_id, session_id);

    let timeline = store
        .reader
        .session_observations_scoped(
            ws,
            project,
            session_id,
            ai_memory_store::ObservationPage {
                limit: 10,
                offset: 0,
                order: ai_memory_store::ObservationOrder::Asc,
                kinds: None,
                query: Some("微信支付".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(timeline.total, 1);

    let pages = search(&store, ws, project, "微信支付").await;
    assert!(
        pages
            .iter()
            .any(|(hit, _)| hit.path.as_str() == format!("sessions/{session_id}.md")),
        "the CJK observation stream did not vote for its session page: {pages:?}"
    );
}

#[tokio::test]
async fn superseded_cjk_text_is_hidden_and_startup_repairs_missing_index_rows() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = Store::open(tmp.path()).unwrap();
    let (ws, project) = scope(&store, "default", "app").await;
    store
        .writer
        .upsert_page(page(ws, project, "state.md", "状态", "旧版支付服务"))
        .await
        .unwrap();
    store
        .writer
        .upsert_page(page(ws, project, "state.md", "State", "new English state"))
        .await
        .unwrap();
    assert!(
        store
            .reader
            .search_pages_for_project(ws, project, "旧版支付".into(), 10, None)
            .await
            .unwrap()
            .is_empty()
    );

    store
        .writer
        .upsert_page(page(ws, project, "repair.md", "恢复", "需要恢复索引"))
        .await
        .unwrap();
    store.close().await;
    drop(store);

    let db = rusqlite::Connection::open(tmp.path().join("db/memory.sqlite")).unwrap();
    db.execute("DELETE FROM pages_cjk_fts", []).unwrap();
    drop(db);

    store = Store::open(tmp.path()).unwrap();
    let repaired = store
        .reader
        .search_pages_for_project(ws, project, "恢复索引".into(), 10, None)
        .await
        .unwrap();
    assert_eq!(repaired.len(), 1);
    assert_eq!(repaired[0].path.as_str(), "repair.md");

    store.writer.compact().await.unwrap();
    let after_rebuild = store
        .reader
        .search_pages_for_project(ws, project, "恢复索引".into(), 10, None)
        .await
        .unwrap();
    assert_eq!(after_rebuild.len(), 1);
    assert_eq!(after_rebuild[0].path.as_str(), "repair.md");
}

#[tokio::test]
async fn cjk_stream_does_not_fuse_back_a_not_excluded_term() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (ws, project) = scope(&store, "default", "app").await;

    store
        .writer
        .upsert_page(page(ws, project, "tokyo.md", "東京", "office notes"))
        .await
        .unwrap();
    // 大阪 only ever appears inside an unspaced run, so unicode61 gives the
    // primary stream no token to match: this page is reachable through the
    // auxiliary CJK stream alone.
    store
        .writer
        .upsert_page(page(
            ws,
            project,
            "osaka.md",
            "Kansai",
            "関西の大阪支社について",
        ))
        .await
        .unwrap();

    // Control: the excluded page IS indexed and IS findable on its own, so an
    // absence below means the operator was honoured, not that nothing matched.
    let osaka = store
        .reader
        .search_pages_for_project(ws, project, "大阪".into(), 10, None)
        .await
        .unwrap();
    let paths: Vec<_> = osaka.iter().map(|hit| hit.path.as_str()).collect();
    assert!(
        paths.contains(&"osaka.md"),
        "control search failed: {paths:?}"
    );

    let excluded = store
        .reader
        .search_pages_for_project(ws, project, "東京 NOT 大阪".into(), 10, None)
        .await
        .unwrap();
    let paths: Vec<_> = excluded.iter().map(|hit| hit.path.as_str()).collect();
    assert!(
        paths.contains(&"tokyo.md"),
        "the requested term lost its page: {paths:?}"
    );
    assert!(
        !paths.contains(&"osaka.md"),
        "the CJK stream fused back the NOT-excluded term: {paths:?}"
    );
}

#[tokio::test]
async fn cjk_stream_honours_column_filters() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (ws, project) = scope(&store, "default", "app").await;

    store
        .writer
        .upsert_page(page(
            ws,
            project,
            "titled.md",
            "支付服务概要",
            "English body",
        ))
        .await
        .unwrap();
    store
        .writer
        .upsert_page(page(
            ws,
            project,
            "bodied.md",
            "Callback notes",
            "启用微信支付服务后检查回调。",
        ))
        .await
        .unwrap();

    store
        .writer
        .upsert_page(page(
            ws,
            project,
            "支付服务.md",
            "Path notes",
            "English body",
        ))
        .await
        .unwrap();

    // Control: every column carries 支付服务 and all three pages are
    // reachable through the CJK stream. Excluding a body/path-only match
    // below therefore proves the column filter held.
    let unqualified = store
        .reader
        .search_pages_for_project(ws, project, "支付服务".into(), 10, None)
        .await
        .unwrap();
    let paths: Vec<_> = unqualified.iter().map(|hit| hit.path.as_str()).collect();
    assert!(
        paths.contains(&"titled.md"),
        "control search failed: {paths:?}"
    );
    assert!(
        paths.contains(&"bodied.md"),
        "control search failed: {paths:?}"
    );

    assert!(
        paths.contains(&"支付服务.md"),
        "path control failed: {paths:?}"
    );

    for (query, expected) in [
        ("title:支付服务", vec!["titled.md"]),
        ("(title:支付服务)", vec!["titled.md"]),
        ("((title:支付服务))", vec!["titled.md"]),
        ("body:支付服务", vec!["bodied.md"]),
        ("(body:支付服务)", vec!["bodied.md"]),
        ("((body:支付服务))", vec!["bodied.md"]),
        (
            "(title:支付服务 OR body:支付服务)",
            vec!["bodied.md", "titled.md"],
        ),
        (
            "((title:支付服务) OR (body:支付服务))",
            vec!["bodied.md", "titled.md"],
        ),
    ] {
        let hits = store
            .reader
            .search_pages_for_project(ws, project, query.into(), 10, None)
            .await
            .unwrap();
        let mut paths: Vec<_> = hits.iter().map(|hit| hit.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, expected, "project query={query}");

        let hits = store
            .reader
            .search_pages_with_meta(query.into(), 10, None, None, Default::default())
            .await
            .unwrap();
        let mut paths: Vec<_> = hits.iter().map(|hit| hit.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, expected, "global query={query}");
    }
}

#[tokio::test]
async fn cjk_search_finds_a_word_written_with_the_iteration_mark() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (ws, project) = scope(&store, "default", "app").await;

    store
        .writer
        .upsert_page(page(
            ws,
            project,
            "daily.md",
            "運用",
            "日々の作業ログを残す。",
        ))
        .await
        .unwrap();
    store
        .writer
        .upsert_page(page(
            ws,
            project,
            "country.md",
            "概要",
            "日本の明日の予定。",
        ))
        .await
        .unwrap();

    // Control: the decoy IS indexed and IS findable on its own terms, so its
    // absence below means 日々 matched as a unit rather than nothing matching.
    let decoy = store
        .reader
        .search_pages_for_project(ws, project, "日本".into(), 10, None)
        .await
        .unwrap();
    let paths: Vec<_> = decoy.iter().map(|hit| hit.path.as_str()).collect();
    assert!(
        paths.contains(&"country.md"),
        "control search failed: {paths:?}"
    );

    let iterated = store
        .reader
        .search_pages_for_project(ws, project, "日々".into(), 10, None)
        .await
        .unwrap();
    let paths: Vec<_> = iterated.iter().map(|hit| hit.path.as_str()).collect();
    assert!(
        paths.contains(&"daily.md"),
        "日々 was not findable as a unit: {paths:?}"
    );
    assert!(
        !paths.contains(&"country.md"),
        "日々 degraded to a bare 日 character match: {paths:?}"
    );
}
