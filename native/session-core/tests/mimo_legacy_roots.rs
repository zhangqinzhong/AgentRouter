use agentrouter_session_core::{adapters::create_adapters, models::AgentId};
use std::path::PathBuf;

// One test per integration-test process: changing discovery environment cannot
// race the shared fixture HOME in adapter_contracts.rs.
#[test]
fn native_mimo_roster_retains_legacy_home_db_and_default_sources() {
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("AR_SESSION_HOME", home.path());
    for name in ["MIMO_HOME", "MIMOCODE_HOME", "MIMO_DB", "XDG_DATA_HOME"] {
        std::env::remove_var(name);
    }
    let roots = || -> Vec<PathBuf> {
        create_adapters().into_iter().filter(|a| a.agent() == AgentId::Mimo)
            .flat_map(|a| a.data_roots()).collect()
    };
    let legacy = home.path().join("legacy-data");
    std::env::set_var("MIMO_HOME", &legacy);
    // Keep a missing explicit directory in the roster for later discovery.
    assert_eq!(roots(), vec![legacy.join("mimocode.db")]);
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::write(legacy.join("mimocode.db"), []).unwrap();
    let official = home.path().join("official");
    std::fs::create_dir_all(official.join("data")).unwrap();
    std::fs::write(official.join("data/mimocode.db"), []).unwrap();
    std::env::set_var("MIMOCODE_HOME", &official);
    assert_eq!(roots(), vec![official.join("data/mimocode.db"), legacy.join("mimocode.db")]);

    std::env::remove_var("MIMO_HOME");
    std::env::remove_var("MIMOCODE_HOME");
    let default = home.path().join(".local/share/mimocode/mimocode.db");
    std::fs::create_dir_all(default.parent().unwrap()).unwrap();
    std::fs::write(&default, []).unwrap();
    let override_db = home.path().join("custom-mimo.db");
    std::fs::write(&override_db, []).unwrap();
    std::env::set_var("MIMO_DB", &override_db);
    assert_eq!(roots(), vec![default, override_db]);
}
