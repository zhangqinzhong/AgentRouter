//! Opt-in validation on a disposable copy of a real index, never the live DB.
use agentrouter_session_core::db::Store;
use std::time::Instant;

#[test]
#[ignore = "requires AR_UPSTREAM_AUDIT_DB pointing to a disposable snapshot"]
fn cjk_search_on_real_snapshot() {
    let path = std::env::var("AR_UPSTREAM_AUDIT_DB").expect("snapshot path");
    assert!(path.contains("upstream-audit"), "only use a disposable audit snapshot");
    let store = Store::open(std::path::Path::new(&path)).unwrap();
    let queries = ["部署", "配置", "部署 docker"];
    for q in queries {
        let start = Instant::now();
        let (hits, degraded) = store.search(q, &[], None, 100).unwrap();
        println!("before {q}: {} hits, degraded={degraded}, {}us", hits.len(), start.elapsed().as_micros());
    }
    store.backfill_cjk().unwrap();
    for q in queries {
        let start = Instant::now();
        let (hits, degraded) = store.search(q, &[], None, 100).unwrap();
        assert!(!degraded, "two-character and mixed queries must use indexes");
        println!("after {q}: {} hits, degraded={degraded}, {}us", hits.len(), start.elapsed().as_micros());
    }
}
