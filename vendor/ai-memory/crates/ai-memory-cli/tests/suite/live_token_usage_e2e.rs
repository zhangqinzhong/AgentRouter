//! End to end: token usage is recorded at EVERY step of a conversation, not only when the session ends.
//!
//! Nothing here is faked. The shipped `ai-memory hook` binary reads a Claude Code transcript that grows between steps
//! (the same JSONL shape the harness writes), delivers to a real `ai-memory serve`, and the test reads the store back
//! after each step. The unit and router suites check the pieces (extraction, merge, aggregation); this one proves the
//! pieces are wired together, which is where "usage stays empty until the session ends" would hide.
//!
//! Steps, each asserted on the server's own database:
//!   1. first assistant response + `post-tool-use`  -> usage already present, session still open
//!   2. second response + `stop`                   -> totals grow by exactly that response
//!   3. the same `stop` delivered again            -> nothing changes (a replay is not a new response)
//!   4. a streamed response (partial, then final)  -> counted once, at its final size
//!   5. `session-end` (legacy cumulative path)     -> never double counts what live capture already recorded

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::e2e_support::{hermetic, start_serve};

const BIN: &str = env!("CARGO_BIN_EXE_ai-memory");
const WORKSPACE: &str = "usage-ws";
const PROJECT: &str = "usage-app";
const SESSION: &str = "live-usage-e2e-session";

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct Totals {
    input: i64,
    output: i64,
    cache_write: i64,
    cache_read: i64,
}

/// One assistant line as Claude Code writes it. A response that streams appears more than once with the SAME
/// `message.id` and a growing `output_tokens`.
fn assistant(id: &str, input: u64, output: u64, cache_read: u64, cache_write: u64) -> Value {
    json!({
        "type": "assistant",
        "message": {
            "id": id,
            "model": "claude-fixture-model",
            "usage": {
                "input_tokens": input,
                "output_tokens": output,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_write,
            }
        }
    })
}

fn write_transcript(path: &Path, rows: &[Value]) {
    let mut body = String::new();
    for row in rows {
        body.push_str(&row.to_string());
        body.push('\n');
    }
    std::fs::write(path, body).expect("write transcript");
}

/// Run the real native hook for one lifecycle event of the session, then drain the spool to the server.
fn emit(hook_dir: &Path, server: &str, cwd: &Path, transcript: &Path, event: &str) {
    let payload = json!({
        "session_id": SESSION,
        "cwd": cwd,
        "transcript_path": transcript,
        "tool_name": "Bash",
        "tool_input": { "command": "echo step" },
        "tool_response": { "stdout": "step" },
    });
    let mut child = hermetic(BIN)
        .env("AI_MEMORY_HOME", hook_dir)
        .args(["--data-dir"])
        .arg(hook_dir)
        .args([
            "hook",
            "--event",
            event,
            "--agent",
            "claude-code",
            "--server-url",
            server,
        ])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn native hook");
    {
        use std::io::Write as _;
        child
            .stdin
            .take()
            .expect("hook stdin")
            .write_all(payload.to_string().as_bytes())
            .expect("write payload");
    }
    let out = child.wait_with_output().expect("wait for hook");
    assert!(
        out.status.success(),
        "hook {event} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    drain(hook_dir, server);
}

/// Deliver whatever the hook spooled. The hook also starts a detached drainer on boundary events, so wait until the
/// spool really is empty instead of trusting either process alone.
fn drain(hook_dir: &Path, server: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let _ = hermetic(BIN)
            .env("AI_MEMORY_HOME", hook_dir)
            .env("AI_MEMORY_SERVER_URL", server)
            .args(["--data-dir"])
            .arg(hook_dir)
            .arg("hook-drain")
            .stdin(Stdio::null())
            .output();
        if spooled_events(hook_dir) == 0 {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the spool never emptied: {} event(s) undelivered",
            spooled_events(hook_dir)
        );
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn spooled_events(hook_dir: &Path) -> usize {
    std::fs::read_dir(hook_dir.join("hook-spool"))
        .map(|dir| {
            dir.filter_map(Result::ok)
                .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
                .count()
        })
        .unwrap_or(0)
}

fn open_db(server_dir: &Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_with_flags(
        server_dir.join("db").join("memory.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("open server db read-only");
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    conn
}

/// The session's recorded usage, the number of distinct responses behind it, and whether it has ended.
fn read_usage(server_dir: &Path) -> Option<(Totals, i64, bool)> {
    let conn = open_db(server_dir);
    let totals = conn
        .query_row(
            "SELECT u.input_tokens, u.output_tokens, u.cache_write_tokens, u.cache_read_tokens \
             FROM session_usage u JOIN sessions s ON s.id = u.session_id",
            [],
            |r| {
                Ok(Totals {
                    input: r.get(0)?,
                    output: r.get(1)?,
                    cache_write: r.get(2)?,
                    cache_read: r.get(3)?,
                })
            },
        )
        .ok()?;
    let calls: i64 = conn
        .query_row("SELECT COUNT(*) FROM token_calls", [], |r| r.get(0))
        .unwrap();
    let ended: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE ended_at IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
        > 0;
    Some((totals, calls, ended))
}

/// The server applies a delivered event asynchronously; wait for the expected state rather than a fixed sleep, and on
/// timeout report what was actually stored (a bare timeout hides whether usage was missing or merely wrong).
fn expect_usage(server_dir: &Path, step: &str, want: Totals, calls: i64, ended: bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let seen = read_usage(server_dir);
        if seen == Some((want, calls, ended)) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{step}: wanted {want:?}, {calls} response(s), ended={ended}; the store has {seen:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Assert the state STAYS as expected after the pipeline has gone quiet (used for replays, where "eventually equal"
/// would also pass for a value that briefly doubled).
fn expect_stable(server_dir: &Path, step: &str, want: Totals, calls: i64, ended: bool) {
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(
        read_usage(server_dir),
        Some((want, calls, ended)),
        "{step}: the totals moved when nothing new happened"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_is_recorded_at_every_step_not_only_at_session_end() {
    let root = tempfile::tempdir().unwrap();
    let server_dir = root.path().join("server");
    let hook_dir = root.path().join("hook");
    let project_dir = root.path().join("project");
    for dir in [&server_dir, &hook_dir, &project_dir] {
        std::fs::create_dir_all(dir).unwrap();
    }
    // The marker pins the scope the hook writes to, so the test never depends on directory names.
    std::fs::write(
        project_dir.join(".ai-memory.toml"),
        format!("workspace = \"{WORKSPACE}\"\nproject = \"{PROJECT}\"\n"),
    )
    .unwrap();
    let transcript = root.path().join("transcript.jsonl");

    let client = reqwest::Client::new();
    let (_server, base) = start_serve(&client, &server_dir.join("serve.log"), |port| {
        let mut cmd = hermetic(BIN);
        cmd.args([
            "serve",
            "--transport",
            "http",
            "--bind",
            &format!("127.0.0.1:{port}"),
            "--workspace",
            WORKSPACE,
            "--project",
            PROJECT,
            "--no-watcher",
        ])
        .env("AI_MEMORY_DATA_DIR", &server_dir)
        .env("AI_MEMORY_HOME", root.path())
        .env("AI_MEMORY_EMBEDDING_PROVIDER", "none");
        cmd.current_dir(&project_dir);
        cmd
    })
    .await;

    // The session exists and is open; nothing has been reported yet.
    emit(&hook_dir, &base, &project_dir, &transcript, "session-start");
    assert!(
        read_usage(&server_dir).is_none(),
        "no usage before any response"
    );

    // Step 1: first response, mid-session (`post-tool-use`). Usage must already be there and the session still open.
    let a = assistant("msg_A", 100, 20, 80, 10);
    write_transcript(&transcript, std::slice::from_ref(&a));
    emit(&hook_dir, &base, &project_dir, &transcript, "post-tool-use");
    expect_usage(
        &server_dir,
        "step 1 (first response, session open)",
        Totals {
            input: 100,
            output: 20,
            cache_write: 10,
            cache_read: 80,
        },
        1,
        false,
    );

    // Step 2: a second response arrives; `stop` adds exactly that response.
    let b = assistant("msg_B", 40, 10, 30, 0);
    write_transcript(&transcript, &[a.clone(), b.clone()]);
    emit(&hook_dir, &base, &project_dir, &transcript, "stop");
    expect_usage(
        &server_dir,
        "step 2 (second response)",
        Totals {
            input: 140,
            output: 30,
            cache_write: 10,
            cache_read: 110,
        },
        2,
        false,
    );

    // Step 3: the same event delivered again (a retry, or a boundary that re-reads the same tail) changes nothing.
    emit(&hook_dir, &base, &project_dir, &transcript, "stop");
    expect_stable(
        &server_dir,
        "step 3 (replay)",
        Totals {
            input: 140,
            output: 30,
            cache_write: 10,
            cache_read: 110,
        },
        2,
        false,
    );

    // Step 4: a response that streams. First it is partial, then final under the SAME id: it counts once, at its
    // final size, never partial + final.
    let c_partial = assistant("msg_C", 30, 5, 0, 0);
    write_transcript(&transcript, &[a.clone(), b.clone(), c_partial]);
    emit(&hook_dir, &base, &project_dir, &transcript, "post-tool-use");
    expect_usage(
        &server_dir,
        "step 4a (streamed response, partial)",
        Totals {
            input: 170,
            output: 35,
            cache_write: 10,
            cache_read: 110,
        },
        3,
        false,
    );
    let c_final = assistant("msg_C", 30, 60, 0, 0);
    write_transcript(&transcript, &[a.clone(), b.clone(), c_final]);
    emit(&hook_dir, &base, &project_dir, &transcript, "stop");
    expect_usage(
        &server_dir,
        "step 4b (streamed response, final)",
        Totals {
            input: 170,
            output: 90,
            cache_write: 10,
            cache_read: 110,
        },
        3,
        false,
    );

    // Step 5: the session ends. The legacy cumulative report must agree with what live capture already recorded; if
    // the two paths were added together the totals would double here.
    emit(&hook_dir, &base, &project_dir, &transcript, "session-end");
    expect_usage(
        &server_dir,
        "step 5 (session end)",
        Totals {
            input: 170,
            output: 90,
            cache_write: 10,
            cache_read: 110,
        },
        3,
        true,
    );
}

/// Same wiring, but the hook is asked about a transcript it cannot use. A hook must never fail a harness turn, and an
/// unreadable transcript must leave usage absent rather than zero or wrong.
#[tokio::test(flavor = "multi_thread")]
async fn a_missing_transcript_never_fails_the_hook_or_invents_usage() {
    let root = tempfile::tempdir().unwrap();
    let server_dir = root.path().join("server");
    let hook_dir = root.path().join("hook");
    let project_dir = root.path().join("project");
    for dir in [&server_dir, &hook_dir, &project_dir] {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(
        project_dir.join(".ai-memory.toml"),
        format!("workspace = \"{WORKSPACE}\"\nproject = \"{PROJECT}\"\n"),
    )
    .unwrap();
    let client = reqwest::Client::new();
    let (_server, base) = start_serve(&client, &server_dir.join("serve.log"), |port| {
        let mut cmd = hermetic(BIN);
        cmd.args([
            "serve",
            "--transport",
            "http",
            "--bind",
            &format!("127.0.0.1:{port}"),
            "--workspace",
            WORKSPACE,
            "--project",
            PROJECT,
            "--no-watcher",
        ])
        .env("AI_MEMORY_DATA_DIR", &server_dir)
        .env("AI_MEMORY_HOME", root.path())
        .env("AI_MEMORY_EMBEDDING_PROVIDER", "none");
        cmd.current_dir(&project_dir);
        cmd
    })
    .await;
    let missing = root.path().join("does-not-exist.jsonl");
    emit(&hook_dir, &base, &project_dir, &missing, "session-start");
    emit(&hook_dir, &base, &project_dir, &missing, "post-tool-use");
    emit(&hook_dir, &base, &project_dir, &missing, "stop");
    std::thread::sleep(Duration::from_millis(600));
    assert!(
        read_usage(&server_dir).is_none(),
        "an unreadable transcript must not create a usage row"
    );
}
