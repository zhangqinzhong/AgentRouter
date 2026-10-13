mod workspace;
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{self, Read},
    path::Path,
};
use agentrouter_session_core::adapters::{
    claude::ClaudeAdapter, codex::CodexAdapter, grok::GrokAdapter, AgentAdapter,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    source: String,
    files: Vec<String>,
    offset: usize,
}
fn limited(s: &str) -> String {
    s.chars().take(24000).collect()
}
fn run() -> Result<Value> {
    let mut raw = String::new();
    io::stdin().take(1024 * 1024 + 1).read_to_string(&mut raw)?;
    if raw.len() > 1024 * 1024 {
        bail!("Request too large")
    }
    let value: Value = serde_json::from_str(&raw)?;
    if value.get("op").is_some() { return workspace::run(value); }
    let q: Request = serde_json::from_value(value)?;
    if q.offset > 100000 || q.files.is_empty() || q.files.len() > 32 {
        bail!("Invalid request")
    }
    let base: Box<dyn AgentAdapter> = match q.source.as_str() {
        "claude" => Box::new(ClaudeAdapter::new()),
        "codex" => Box::new(CodexAdapter::new()),
        "grok" => Box::new(GrokAdapter::new()),
        _ => bail!("Unsupported source"),
    };
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    let mut size = 0u64;
    let mut unknown = 0;
    for file in &q.files {
        let p = Path::new(file);
        let metadata = std::fs::metadata(p)?;
        size += metadata.len();
        if !metadata.is_file() || size > 128 * 1024 * 1024 {
            bail!("Session exceeds the 128 MiB read limit")
        }
        let boundary = if q.source == "claude" {
            "projects"
        } else {
            "sessions"
        };
        let root = p
            .ancestors()
            .find(|p| {
                p.file_name()
                    .is_some_and(|v| v == boundary || v == "archived_sessions")
            })
            .context("Unrecognized session layout")?;
        let adapter = base.with_custom_root(if q.source == "claude" {
            root.to_path_buf()
        } else {
            root.parent().context("Missing session home")?.to_path_buf()
        });
        let reference = adapter
            .file_ref(p)
            .context("Not a supported session file")?;
        let parsed = adapter.parse_transcript(&reference)?;
        unknown += parsed.unknown_line_count;
        for m in parsed.mainline {
            let identity = format!("{}:{:?}:{}:{}", m.seq, m.timestamp, m.role.as_str(), m.text);
            if !seen.insert(identity) {
                continue;
            }
            if let Some(thinking) = m.thinking.filter(|s| !s.is_empty()) {
                output.push(json!({"role":"thinking","text":limited(&thinking),"truncated":thinking.chars().count()>24000}));
            }
            if !m.text.is_empty() {
                output.push(json!({"role":m.role.as_str(),"text":limited(&m.text),"truncated":m.truncated||m.text.chars().count()>24000}));
            }
            for tool in m.tool_calls {
                let input = tool.input.unwrap_or(tool.input_preview);
                let content = match tool.output {
                    Some(v) => format!("{}\n\n{}", limited(&input), limited(&v)),
                    None => limited(&input),
                };
                output.push(
                    json!({"role":"tool","name":tool.name,"text":content,"isError":tool.is_error}),
                );
            }
        }
    }
    let more = output.len() > q.offset + 100;
    let messages: Vec<Value> = output
        .into_iter()
        .enumerate()
        .skip(q.offset)
        .take(100)
        .map(|(i, mut v)| {
            v["id"] = json!(i);
            v
        })
        .collect();
    Ok(
        json!({"available":true,"messages":messages,"nextOffset":if more{Some(q.offset+100)}else{None},"unknownLineCount":unknown,"engine":"agentrouter-session-core/0.1.0"}),
    )
}
fn main() {
    if std::env::args().nth(1).as_deref()==Some("--watch") { if let Err(e)=workspace::watch(){eprintln!("{e:#}");std::process::exit(1)} return; }
    match run() {
        Ok(v) => println!("{v}"),
        Err(e) => {
            eprintln!("{e:#}");
            std::process::exit(1)
        }
    }
}
