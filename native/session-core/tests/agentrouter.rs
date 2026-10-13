use agentrouter_session_core::{adapters::{opencode::OpencodeAdapter,AgentAdapter},models::AgentId};
use rusqlite::Connection;
#[test]
fn mimo_reuses_opencode_parts_without_newer_session_columns_and_never_writes_source(){
 let root=tempfile::tempdir().unwrap();let path=root.path().join("mimocode.db");
 let db=Connection::open(&path).unwrap();
 db.execute_batch("CREATE TABLE session(id TEXT, directory TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER,version TEXT,parent_id TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT);INSERT INTO session VALUES('session-one','/tmp/project','MiMo fixture',1000,2000,NULL,'1',NULL);").unwrap();
 db.execute("INSERT INTO message VALUES('a','session-one',1000,?1)",[r#"{"role":"assistant","modelID":"mimo-test","time":{"created":1000},"tokens":{"input":10,"output":2,"reasoning":1}}"#]).unwrap();
 db.execute("INSERT INTO part VALUES('p','a','session-one',?1)",[r#"{"type":"text","text":"二维码 fixture"}"#]).unwrap();drop(db);
 let before=std::fs::read(&path).unwrap();let adapter=OpencodeAdapter::mimo().with_custom_root(root.path().to_path_buf());let refs=adapter.list_session_files().unwrap();assert_eq!(refs.len(),1);assert_eq!(refs[0].agent,AgentId::Mimo);
 let parsed=adapter.parse_transcript(&refs[0]).unwrap();assert_eq!(parsed.meta.model.as_deref(),Some("mimo-test"));assert_eq!(parsed.meta.tokens_used,Some(13));assert_eq!(parsed.mainline[0].text,"二维码 fixture");assert_eq!(std::fs::read(&path).unwrap(),before);
}
