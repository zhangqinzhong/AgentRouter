//! Bundled product references are stable, readable without project scope, and safe.

use ai_memory_store::Store;
use ai_memory_web::{api_router, router};
use ai_memory_wiki::Wiki;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use tower::ServiceExt;

fn setup() -> (tempfile::TempDir, Router, Router) {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let wiki = Wiki::new(tmp.path(), store.writer.clone()).unwrap();
    let web = router(store.reader.clone(), wiki.clone());
    let api = api_router(store.reader, wiki);
    (tmp, web, api)
}

async fn get(app: &Router, path: &str) -> (StatusCode, String, String) {
    let response = app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let text = String::from_utf8(
        to_bytes(response.into_body(), 4_000_000)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    (status, kind, text)
}

#[tokio::test]
async fn documentation_catalog_and_search_work_without_registered_projects() {
    let (_tmp, web, api) = setup();
    let (status, _, html) = get(&web, "/docs").await;
    assert_eq!(status, StatusCode::OK);
    for text in [
        "Documentation",
        "Features &amp; activation",
        "docs/changelog",
        "Markdown for agents",
    ] {
        assert!(html.contains(text), "{text}");
    }
    let (_, _, body) = get(&api, "/docs?q=Token%20accounting").await;
    let result: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(result["version"], env!("CARGO_PKG_VERSION"));
    assert!(
        result["documents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["id"] == "features")
    );
    assert!(
        !body.contains("\"body\""),
        "catalog must not return every full guide"
    );
    let (_, _, html) = get(&web, "/docs?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E").await;
    assert!(!html.contains("<script>alert(1)</script>"));
    assert!(html.contains("No matching guides"));
    assert_eq!(
        get(&api, &format!("/docs?q={}", "x".repeat(201))).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn documentation_every_registered_guide_has_matching_html_markdown_and_json() {
    let (_tmp, web, api) = setup();
    let (_, _, body) = get(&api, "/docs").await;
    let catalog: Value = serde_json::from_str(&body).unwrap();
    for doc in catalog["documents"].as_array().unwrap() {
        let id = doc["id"].as_str().unwrap();
        let (status, _, html) = get(&web, &format!("/docs/{id}")).await;
        assert_eq!(status, StatusCode::OK, "{id}");
        assert!(html.contains("Source:"));
        let (status, kind, raw) = get(&web, &format!("/docs/{id}.md")).await;
        assert_eq!(status, StatusCode::OK, "{id}");
        assert!(kind.starts_with("text/markdown"));
        let (status, _, body) = get(&api, &format!("/docs/{id}")).await;
        assert_eq!(status, StatusCode::OK);
        let json: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["markdown"], raw, "{id}");
        assert!(!raw.is_empty());
    }
}

#[tokio::test]
async fn documentation_changelog_separates_unreleased_tagged_and_archived_entries() {
    let (_tmp, web, api) = setup();
    let (_, _, raw) = get(&web, "/docs/changelog.md").await;
    assert!(raw.starts_with("## [Unreleased]"));
    assert!(!raw.contains("## [3.2.2]"));
    let (_, _, body) = get(&api, "/docs/changelog?release=3.2.2").await;
    let value: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(value["release"], "3.2.2");
    assert!(
        value["markdown"]
            .as_str()
            .unwrap()
            .starts_with("## [3.2.2]")
    );
    assert!(!value["markdown"].as_str().unwrap().contains("## [3.2.1]"));
    let (_, _, html) = get(&web, "/docs/changelog?release=3.2.2").await;
    assert!(html.contains("docs/changelog.md?release=3.2.2"));
    assert!(
        html.contains("docs/changelog?release=3.2.2#"),
        "TOC must preserve release and web mount"
    );
    let (_, _, all) = get(&web, "/docs/changelog.md?release=all").await;
    assert_eq!(all, include_str!("../../../../CHANGELOG.md"));
    let (_, _, old) = get(&web, "/docs/changelog-2x.md").await;
    assert!(!old.contains("## [Unreleased]"));
    assert_eq!(
        get(&web, "/docs/changelog?release=does-not-exist").await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn documentation_links_are_repository_aware_and_never_project_wiki_routes() {
    let (_tmp, web, _) = setup();
    let (_, _, html) = get(&web, "/docs/features").await;
    assert!(html.contains("href=\"docs/install\""));
    assert!(html.contains("href=\"docs/usage#investigate-token-usage-in-the-dashboard\""));
    assert!(html.contains("href=\"docs/changelog\""));
    assert!(!html.contains("/p/install.md"));
    for path in [
        "/docs/unknown",
        "/docs/config.toml",
        "/docs/%2e%2e%2fconfig.toml",
        "/docs/.env.md",
    ] {
        assert_eq!(get(&web, path).await.0, StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(
        get(&web, "/docs/features?release=Unreleased").await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn documentation_respects_the_existing_prefixed_mount() {
    let (_tmp, web, _) = setup();
    let app = Router::new().nest("/memory/portal", web);
    // Route and article links stay relative to the host-injected web base.
    let (status, _, html) = get(&app, "/memory/portal/docs/features").await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("href=\"docs/install\""));
}
