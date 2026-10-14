use agentrouter_session_core::{
    adapters::{self, AgentAdapter},
    db::{self, Store},
    models::*,
    remote, scanner,
    services::exporter,
};
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::sync::Arc;
fn str_arg<'a>(q: &'a Value, key: &str) -> Result<&'a str> {
    q[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 8192)
        .context("Missing or invalid argument")
}
fn number(q: &Value, key: &str, default: i64, max: i64) -> Result<i64> {
    let v = match q.get(key) {
        None => default,
        Some(v) => v.as_i64().context("Expected integer")?,
    };
    anyhow::ensure!((0..=max).contains(&v), "Argument out of range");
    Ok(v)
}
fn agent(q: &Value) -> Result<Vec<AgentId>> {
    match q["agent"].as_str().filter(|s| *s != "all") {
        Some(s) => Ok(vec![AgentId::from_str(s).context("Unknown client")?]),
        None => Ok(vec![]),
    }
}
fn projects(q: &Value) -> Vec<String> {
    q["project"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != "all")
        .map(|s| vec![s.into()])
        .unwrap_or_default()
}
fn session(store: &Store, q: &Value) -> Result<SessionMeta> {
    store
        .get_session(str_arg(q, "key")?)?
        .context("Session not found")
}
fn reader<'a>(
    adapters: &'a [Box<dyn AgentAdapter>],
    meta: &SessionMeta,
) -> Result<&'a dyn AgentAdapter> {
    adapters::adapter_for(adapters, meta.agent, &meta.file_path)
        .context("Client location unavailable")
}
const TRANSCRIPT_PAGE: usize = 60;

fn rows(messages: Vec<TranscriptMessage>, offset: usize) -> Value {
    let total = messages.len();
    let mut image_budget = 4 * 1024 * 1024usize;
    let rows:Vec<Value>=messages.into_iter().skip(offset).take(TRANSCRIPT_PAGE).map(|m|{
  let images:Vec<Value>=m.images.iter().filter_map(|im|{
   if !matches!(im.media_type.as_str(),"image/png"|"image/jpeg"|"image/gif"|"image/webp")||im.bytes.len()>image_budget{return None}
   image_budget-=im.bytes.len();Some(json!({"url":format!("data:{};base64,{}",im.media_type,base64::engine::general_purpose::STANDARD.encode(&im.bytes)),"offset":im.text_offset}))
  }).collect();
  json!({"id":m.seq,"seq":m.seq,"role":m.role,"kind":m.kind,"text":m.text,"thinking":m.thinking,"tools":m.tool_calls,"images":images,"timestamp":m.timestamp,"truncated":m.truncated})
 }).collect();
    json!({"messages":rows,"total":total,"nextOffset":if offset+TRANSCRIPT_PAGE<total{Some(offset+TRANSCRIPT_PAGE)}else{None}})
}
pub fn run(q: Value) -> Result<Value> {
    let op = str_arg(&q, "op")?;
    let path = db::default_db_path();
    std::fs::create_dir_all(path.parent().context("Missing index directory")?)?;
    let store = Arc::new(Store::open(&path)?);
    if op == "refresh" {
        let _lock = match db::IndexLock::try_acquire(&path, "AgentRouter sessions")? {
            db::Ownership::Ours(v) => v,
            db::Ownership::Held(_) => return Ok(json!({"busy":true})),
        };
        let adapters = adapters::create_adapters_for(&store);
        scanner::run_scan(&adapters, &store, &scanner::NullEvents, false)?;
        return Ok(json!({"ok":true}));
    }
    let filter = SessionFilter {
        agents: agent(&q)?,
        project_paths: projects(&q),
        favorite_only: q["starred"].as_bool().unwrap_or(false),
        include_archived: q["archived"].as_bool().unwrap_or(false),
        roots_only: true,
        updated_since: q["since"].as_i64(),
        limit: number(&q, "limit", 100, 500)?,
        offset: number(&q, "offset", 0, 1000000)?,
        sort: match q["sort"].as_str() {
            Some("created") => SortKey::Created,
            Some("messages") => SortKey::Messages,
            _ => SortKey::Updated,
        },
        ..Default::default()
    };
    match op {
        "request-refresh" => {
            store.pref_set(
                "ar.refresh-requested",
                &std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos()
                    .to_string(),
            )?;
            Ok(json!({"ok":true}))
        }
        "list" => {
            let (sessions, total) = store.list_sessions(&filter)?;
            Ok(json!({"sessions":sessions,"total":total}))
        }
        "search" => {
            let query = str_arg(&q, "query")?;
            anyhow::ensure!(query.chars().count() <= 512, "Search query too long");
            let (hits, degraded) = store.search_with(
                query,
                &SearchFilter {
                    favorite_only: filter.favorite_only,
                    agents: filter.agents,
                    project_paths: filter.project_paths,
                    updated_since: filter.updated_since,
                    limit: filter.limit,
                },
            )?;
            Ok(
                json!({"hits":hits.into_iter().filter(|h|!filter.favorite_only||h.session.favorite).map(|h|json!({"session":h.session,"seq":h.seq,"sidechain":h.sidechain_id,"snippet":h.snippet})).collect::<Vec<_>>(),"degraded":degraded}),
            )
        }
        "insights" => {
            let today = str_arg(&q, "today")?.parse().context("Invalid date")?;
            let v = store.insights(today)?;
            let rank = |rows: Vec<UsageTally>| {
                rows.into_iter().map(|r|json!({"name":r.name,"sessions":r.sessions,"prompts":r.prompts,"tokens":r.tokens})).collect::<Vec<_>>()
            };
            let (current, previous) = v.last_week_pair();
            Ok(
                json!({"asOf":v.as_of,"sessions":v.sessions,"prompts":v.prompts,"projectsCount":v.project_count,"currentStreak":v.current_streak,"longestStreak":v.longest_streak,"daily":v.daily,"agents":rank(v.agents),"projects":rank(v.projects),"models":rank(v.models),"thisWeek":{"sessions":current.sessions,"prompts":current.prompts},"lastWeek":{"sessions":previous.sessions,"prompts":previous.prompts},"weekly":v.trend_agents.into_iter().map(|r|json!({"name":r.name,"weekly":r.weekly})).collect::<Vec<_>>()}),
            )
        }
        "projects" => {
            // 侧栏数字和会话列表共用 since：不传是全部，传了就按同一棵树的活动时间收窄。
            let since = q["since"].as_i64().filter(|t| *t > 0);
            let counts = store.agent_counts_since(since)?;
            let agents = AgentId::ALL
                .iter()
                .filter_map(|agent| {
                    let count = *counts.get(agent.as_str())?;
                    (count > 0).then(|| {
                        json!({"id": agent.as_str(), "name": agent.display_name(), "count": count})
                    })
                })
                .collect::<Vec<_>>();
            let projects = store
                .list_projects_since(false, since)?
                .into_iter()
                .map(|p| json!({"path": p.path, "name": p.name, "count": p.session_count}))
                .collect::<Vec<_>>();
            Ok(json!({"projects": projects, "agents": agents}))
        }
        "children" => Ok(
            json!({"sessions":store.list_children(&session(&store,&q)?.key,&SessionFilter{roots_only:false,..filter})?}),
        ),
        "state" => {
            let meta = session(&store, &q)?;
            store.set_user_data(&meta.key, q["favorite"].as_bool(), q["pinned"].as_bool())?;
            Ok(json!({"ok":true}))
        }
        "transcript" | "export" | "handoff" => {
            let meta = session(&store, &q)?;
            if op == "handoff" {
                let binary = std::env::current_exe()?.with_file_name(if cfg!(windows) {
                    "agentrouter-session-cli.exe"
                } else {
                    "agentrouter-session-cli"
                });
                return Ok(
                    json!({"markdown":agentrouter_session_core::cli::handoff_text(&meta.key,&meta.title,Some(&binary))}),
                );
            }
            let adapters = adapters::create_adapters_for(&store);
            let adapter = reader(&adapters, &meta)?;
            let parsed = adapter.parse_transcript(&SessionFileRef::from_meta(&meta))?;
            if op == "export" {
                return Ok(
                    json!({"markdown":exporter::render_markdown(adapter,&meta)?,"filename":exporter::default_file_name(&meta,"md")}),
                );
            }
            let messages = if let Some(side) = q["sidechain"].as_str() {
                anyhow::ensure!(
                    parsed.sidechains.iter().any(|s| s.id == side),
                    "Unknown branch"
                );
                adapter.load_sidechain(&SessionFileRef::from_meta(&meta), side)?
            } else {
                parsed.mainline
            };
            // Match Wake's reader policy before paginating. Keep original seq values
            // so full-text hits and branch anchors still refer to the source record.
            let messages: Vec<_> = messages
                .into_iter()
                .filter(|message| {
                    message.kind != MessageKind::Meta
                        && (!message.text.trim().is_empty()
                            || !message.tool_calls.is_empty()
                            || message.thinking.is_some()
                            || !message.images.is_empty()
                            || message.kind == MessageKind::CompactSummary)
                })
                .collect();
            // A search seq starts the window at that message. Otherwise `tail`
            // opens on the latest page; the first page is the oldest messages.
            let offset = if let Some(seq) = q["seq"].as_i64() {
                messages.iter().position(|m| m.seq >= seq).unwrap_or(0)
            } else if q["tail"].as_bool().unwrap_or(false) {
                messages.len().saturating_sub(TRANSCRIPT_PAGE)
            } else {
                number(&q, "offset", 0, 1000000)? as usize
            };
            let mut out = rows(messages, offset);
            out["sidechains"] = json!(parsed.sidechains);
            out["offset"] = json!(offset);
            // Some clients (notably Grok Bot) use real cache paths but permit
            // index-only hiding. Let the adapter decide; do not guess from '#'.
            let paths = adapter.session_paths(&meta);
            out["deletion"] = json!(if paths.iter().all(|p| !std::path::Path::new(p).exists()) {
                "hide"
            } else {
                "trash"
            });
            out["meta"] = json!(meta);
            Ok(out)
        }
        "memory" => {
            let doc = store
                .get_memory(str_arg(&q, "key")?)?
                .context("Memory not found")?;
            Ok(
                json!({"key":doc.key,"title":doc.title,"path":doc.path,"body":adapters::memory_body(&doc)}),
            )
        }
        "memories" => {
            let f = MemoryFilter {
                agents: filter.agents,
                project_paths: filter.project_paths,
                limit: number(&q, "limit", 300, 10000)?,
                ..Default::default()
            };
            let docs = if let Some(query) = q["query"].as_str().filter(|s| !s.is_empty()) {
                store
                    .search_memories(query, &f)?
                    .into_iter()
                    .map(|h| h.doc)
                    .collect()
            } else {
                store.list_memories(&f)?
            };
            Ok(
                json!({"memories":docs.into_iter().map(|d|json!({"key":d.key,"agent":d.agent,"title":d.title,"path":d.path,"project":d.project_name,"body":d.body,"updated":d.updated_at})).collect::<Vec<_>>()}),
            )
        }
        "settings" => {
            let roster = adapters::create_adapter_roster_for(&store);
            Ok(
                json!({"locations":store.list_custom_roots()?,"remotes":store.list_remote_hosts()?.into_iter().map(|h|json!({"name":h.name,"enabled":h.enabled,"lastSync":h.last_sync_at,"error":h.last_sync_error})).collect::<Vec<_>>(),"sources":roster.locations.iter().map(|a|json!({"agent":a.agent.as_str(),"name":a.agent.display_name(),"paths":[a.path],"enabled":a.enabled,"available":a.path.exists()})).collect::<Vec<_>>()}),
            )
        }
        "memory-sources" => {
            let adapters = adapters::create_adapters_for(&store);
            let (customs, disabled) = store.memory_source_overrides()?;
            let plan = adapters::memory_source_plan(&adapters, &customs, &disabled);
            Ok(
                json!({"sources":plan.into_iter().filter(|p|p.host.is_empty()).flat_map(|p|p.sources.into_iter().map(move |s|json!({"agent":p.agent.as_str(),"name":p.agent.display_name(),"id":s.source.id(),"path":s.source.path,"enabled":s.enabled,"custom":s.custom}))).collect::<Vec<_>>()}),
            )
        }
        "memory-source-add" | "memory-source-remove" => {
            let a = AgentId::from_str(str_arg(&q, "agent")?).context("Unknown client")?;
            let path = str_arg(&q, "path")?;
            let p = std::path::Path::new(path);
            anyhow::ensure!(p.is_absolute(), "Absolute path required");
            if op == "memory-source-add" {
                anyhow::ensure!(p.exists(), "Path not found");
                store.add_memory_source(a.as_str(), path)?;
            } else {
                store.remove_memory_source(a.as_str(), path)?;
            }
            Ok(json!({"ok":true}))
        }
        "memory-source-state" => {
            let a = AgentId::from_str(str_arg(&q, "agent")?).context("Unknown client")?;
            let id = str_arg(&q, "id")?;
            let enabled = q["enabled"].as_bool().context("Expected enabled flag")?;
            let adapters = adapters::create_adapters_for(&store);
            let (customs, disabled) = store.memory_source_overrides()?;
            let plan = adapters::memory_source_plan(&adapters, &customs, &disabled);
            anyhow::ensure!(
                plan.iter().any(|p| p.agent == a
                    && p.host.is_empty()
                    && p.sources.iter().any(|s| s.source.id() == id)),
                "Unknown memory source"
            );
            store.set_memory_source_enabled(a.as_str(), id, enabled)?;
            Ok(json!({"ok":true}))
        }
        "location-state" => {
            let a = AgentId::from_str(str_arg(&q, "agent")?).context("Unknown client")?;
            let path = str_arg(&q, "path")?;
            let enabled = q["enabled"].as_bool().context("Expected enabled flag")?;
            let roster = adapters::create_adapter_roster_for(&store);
            anyhow::ensure!(
                roster
                    .locations
                    .iter()
                    .any(|l| l.agent == a && l.path == std::path::Path::new(path)),
                "Unknown location"
            );
            store.set_location_enabled(a.as_str(), path, enabled)?;
            Ok(json!({"ok":true}))
        }
        "location-add" | "location-remove" => {
            let a = AgentId::from_str(str_arg(&q, "agent")?).context("Unknown client")?;
            let dir = std::path::Path::new(str_arg(&q, "path")?);
            anyhow::ensure!(dir.is_absolute(), "Absolute directory required");
            if op == "location-add" {
                anyhow::ensure!(dir.is_dir(), "Directory not found");
                store.add_custom_root(a.as_str(), &dir.to_string_lossy())?
            } else {
                store.remove_custom_root(a.as_str(), &dir.to_string_lossy())?
            }
            Ok(json!({"ok":true}))
        }
        "remote-sync-enabled" => {
            remote::sync_hosts(&store, &store.enabled_remote_host_names());
            Ok(json!({"ok":true}))
        }
        "remote-add" | "remote-remove" | "remote-sync" | "remote-state" => {
            let name = str_arg(&q, "name")?;
            anyhow::ensure!(remote::valid_host_name(name), "Invalid SSH host");
            match op {
                "remote-add" => store.add_remote_host(name)?,
                "remote-remove" => store.remove_remote_host(name)?,
                "remote-state" => store.set_remote_host_enabled(
                    name,
                    q["enabled"].as_bool().context("Expected enabled flag")?,
                )?,
                _ => {
                    anyhow::ensure!(
                        store.list_remote_hosts()?.iter().any(|h| h.name == name),
                        "Host not configured"
                    );
                    remote::sync_hosts(&store, &[name.into()]);
                }
            }
            Ok(json!({"ok":true}))
        }
        "resume-targets" => {
            let meta = session(&store, &q)?;
            Ok(
                json!({"targets":agentrouter_session_core::services::terminal::resume_targets(&meta).iter().map(|t|match t {agentrouter_session_core::services::terminal::ResumeTarget::App(app)=>json!({"id":app.id(),"name":app.display_name()}),_=>json!({"id":"ssh","name":"SSH"})}).collect::<Vec<_>>()}),
            )
        }
        "resume" => {
            use agentrouter_session_core::services::terminal::{self, ResumeTarget};
            let meta = session(&store, &q)?;
            let id = str_arg(&q, "target")?;
            let target = terminal::resume_targets(&meta)
                .into_iter()
                .find(|t| match t {
                    ResumeTarget::App(a) => a.id() == id,
                    _ => id == "ssh",
                })
                .context("Resume target unavailable")?;
            if id == "ssh" {
                let command =
                    terminal::ssh_resume_command(&meta).context("Remote resume unavailable")?;
                return Ok(json!({"ok":true,"command":command,"mode":"copy"}));
            }
            let r = terminal::resume_target(&meta, target);
            Ok(json!({"ok":r.ok,"command":r.command,"error":r.error,"mode":"opened"}))
        }
        "cleanup" => {
            let adapters = adapters::create_adapters_for(&store);
            let inv = agentrouter_session_core::cleanup::inventory(&store, &adapters)?;
            Ok(
                json!({"candidates":inv.candidates.into_iter().filter(|c|!c.has_starred()&&!c.has_pinned()).collect::<Vec<_>>(),"unavailable":inv.unavailable.into_iter().map(|u|json!({"session":u.session,"reason":u.reason})).collect::<Vec<_>>()}),
            )
        }
        "cleanup-review" => {
            use agentrouter_session_core::cleanup;
            let keys = q["keys"].as_array().context("Select sessions")?;
            anyhow::ensure!(
                !keys.is_empty() && keys.len() <= 100,
                "Select 1 to 100 sessions"
            );
            let adapters = adapters::create_adapters_for(&store);
            let inv = cleanup::inventory(&store, &adapters)?;
            let chosen: Vec<_> = inv
                .candidates
                .into_iter()
                .filter(|c| !c.has_starred() && !c.has_pinned())
                .filter(|c| keys.iter().any(|k| k.as_str() == Some(&c.root.key)))
                .collect();
            anyhow::ensure!(
                chosen.len() == keys.len(),
                "Some sessions are no longer eligible"
            );
            let review = cleanup::review(
                &store,
                &adapters,
                chosen,
                &std::sync::atomic::AtomicBool::new(false),
                |_| {},
            )
            .context("Review cancelled")?;
            anyhow::ensure!(
                review.skipped.is_empty(),
                "Sessions changed during review; refresh and review again"
            );
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as i64;
            let batch = cleanup::CleanupBatch::new(review.ready, stamp);
            batch.save(&store)?;
            Ok(json!({"batch":batch}))
        }
        "cleanup-execute" => {
            use agentrouter_session_core::cleanup;
            let id = str_arg(&q, "id")?;
            let raw = store
                .pref_get(&format!("cleanup.batch.{}", id))
                .context("Review expired")?;
            let mut batch: cleanup::CleanupBatch = serde_json::from_str(&raw)?;
            anyhow::ensure!(!batch.finished, "Cleanup already completed");
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as i64;
            anyhow::ensure!(now - batch.stamp < 300000, "Review expired; review again");
            let adapters = adapters::create_adapters_for(&store);
            cleanup::execute(
                &store,
                &adapters,
                &mut batch,
                &std::sync::atomic::AtomicBool::new(false),
                |_| {},
            )?;
            Ok(json!({"batch":batch}))
        }
        "cleanup-restore" => {
            use agentrouter_session_core::cleanup;
            let id = str_arg(&q, "id")?;
            let raw = store
                .pref_get(&format!("cleanup.batch.{}", id))
                .context("Cleanup record not found")?;
            let mut batch: cleanup::CleanupBatch = serde_json::from_str(&raw)?;
            let adapters = adapters::create_adapters_for(&store);
            let count = cleanup::restore(&store, &adapters, &mut batch)?;
            Ok(json!({"restored":count}))
        }
        "hide" => {
            let meta = session(&store, &q)?;
            let adapters = adapters::create_adapters_for(&store);
            let plan = agentrouter_session_core::cleanup::delete_plan(&store, &adapters, &meta)?;
            anyhow::ensure!(
                plan.targets
                    .iter()
                    .all(|p| !std::path::Path::new(p).exists()),
                "File-backed sessions require a Trash review"
            );
            anyhow::ensure!(
                !plan.sessions.iter().any(|s| s.favorite || s.pinned),
                "Unstar and unpin sessions before hiding"
            );
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as i64;
            let mut history: Vec<Value> =
                serde_json::from_str(&store.pref_get("ar.hidden-sessions").unwrap_or("[]".into()))?;
            history.push(json!({"stamp":stamp,"sessions":plan.sessions}));
            store.pref_set("ar.hidden-sessions", &serde_json::to_string(&history)?)?;
            store.complete_cleanup(&plan.sessions, stamp)?;
            Ok(json!({"ok":true}))
        }
        "hidden" => Ok(
            json!({"records":serde_json::from_str::<Value>(&store.pref_get("ar.hidden-sessions").unwrap_or("[]".into()))?}),
        ),
        "unhide" => {
            let stamp = q["stamp"].as_i64().context("Missing record")?;
            let mut history: Vec<Value> =
                serde_json::from_str(&store.pref_get("ar.hidden-sessions").unwrap_or("[]".into()))?;
            let ix = history
                .iter()
                .position(|h| h["stamp"].as_i64() == Some(stamp))
                .context("Hidden record not found")?;
            let sessions: Vec<SessionMeta> =
                serde_json::from_value(history[ix]["sessions"].clone())?;
            store.restore_cleanup(&sessions, stamp)?;
            history.remove(ix);
            store.pref_set("ar.hidden-sessions", &serde_json::to_string(&history)?)?;
            Ok(json!({"ok":true}))
        }
        "cleanup-history" => {
            Ok(json!({"batches":agentrouter_session_core::cleanup::history(&store)?}))
        }
        _ => bail!("Unknown workspace operation"),
    }
}

// One process owns filesystem events and index writes; EOF from the parent closes it.
pub fn watch() -> Result<()> {
    use std::io::{BufRead, Write};
    enum Command {
        Refresh,
        Stop,
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(4);
    struct Events(std::sync::mpsc::SyncSender<Command>);
    impl scanner::ScanEvents for Events {
        fn on_rescan_needed(&self) {
            let _ = self.0.try_send(Command::Refresh);
        }
        fn on_progress(&self, p: &scanner::ScanProgress) {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(
                out,
                "{}",
                json!({"scanning":p.scanning,"done":p.done,"total":p.total,"error":p.error})
            );
            let _ = out.flush();
        }
        fn on_sessions_changed(&self) {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{}", json!({"changed":true}));
            let _ = out.flush();
        }
    }
    let path = db::default_db_path();
    std::fs::create_dir_all(path.parent().context("No index directory")?)?;
    let _lock = match db::IndexLock::try_acquire(&path, "AgentRouter session watcher")? {
        db::Ownership::Ours(v) => v,
        db::Ownership::Held(_) => {
            println!("{}", json!({"shared":true,"scanning":false}));
            return Ok(());
        }
    };
    let store = Arc::new(Store::open(&path)?);
    let events: Arc<dyn scanner::ScanEvents> = Arc::new(Events(tx.clone()));
    let restart = || -> Result<_> {
        let adapters = Arc::new(adapters::create_adapters_for(&store));
        let watcher = agentrouter_session_core::watcher::start_watcher(
            adapters.clone(),
            store.clone(),
            events.clone(),
        );
        scanner::run_scan(&adapters, &store, events.as_ref(), false)?;
        Ok(watcher)
    };
    let mut watcher = restart()?;
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(line) if line == "refresh" => {
                    let _ = tx.try_send(Command::Refresh);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = tx.send(Command::Stop);
    });
    // Reconcile periodically as a fallback for filesystems without reliable events.
    let mut last_scan = std::time::Instant::now();
    let mut request = store.pref_get("ar.refresh-requested");
    loop {
        match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Command::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            event => {
                let next = store.pref_get("ar.refresh-requested");
                if event.is_ok() || next != request || last_scan.elapsed().as_secs() >= 300 {
                    request = next;
                    drop(watcher.take());
                    watcher = restart()?;
                    last_scan = std::time::Instant::now();
                }
            }
        }
    }
    drop(watcher);
    Ok(())
}
