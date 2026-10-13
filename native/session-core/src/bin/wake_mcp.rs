//! agentrouter-session-mcp:AgentRouter 索引的只读 MCP server(stdio)。
//!
//!   agentrouter-session-mcp [--db PATH] [--on-request]
//!                                 以 MCP server 身份服务 stdin/stdout(客户端这样起它)
//!   agentrouter-session-mcp setup [--db PATH]    打印接入 Claude Code / Codex / Cursor 的配置片段
//!   agentrouter-session-mcp call TOOL [JSON]     跑一次工具调用、打印文本(调试用)
//!   agentrouter-session-mcp --version | --help
//!
//! 索引库默认取 GUI 同一份(`db::default_db_path`),只读打开;库不存在或太老
//! 直接以清晰的 stderr 错误退出(非零),让客户端的日志说明白"先启动一次 AgentRouter"。
use std::io::{self, Write as _};
use std::path::PathBuf;
use std::process::ExitCode;

use agentrouter_session_core::db::Store;
use agentrouter_session_core::mcp::{self, McpServer, Usage};

const USAGE: &str = "agentrouter-session-mcp — read-only MCP server for your AgentRouter session index

USAGE:
  agentrouter-session-mcp [--db PATH] [--on-request]
                                  serve MCP over stdio (what MCP clients run)
  agentrouter-session-mcp setup [--db PATH]      print config snippets for Claude Code / Codex / Cursor
  agentrouter-session-mcp call TOOL [JSON]       run one tool call and print its text (debugging)
  agentrouter-session-mcp --version | --help

OPTIONS:
  --db PATH      index database (default: AgentRouter: ~/.agentrouter/sessions/index.sqlite)
  --on-request   tell agents to use these tools only when you ask (same as AR_SESSION_ON_REQUEST=1)";

struct Args {
    db: Option<PathBuf>,
    usage: Usage,
    command: Vec<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut db = None;
    // 参数压过环境变量
    let mut usage = Usage::from_env();
    let mut command = Vec::new();
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--db" => {
                db = Some(PathBuf::from(
                    it.next().ok_or("--db needs a path".to_string())?,
                ))
            }
            "--on-request" => usage = Usage::OnRequest,
            "--help" | "-h" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            "--version" | "-V" => {
                println!("agentrouter-session-mcp {}", mcp::SERVER_VERSION);
                std::process::exit(0);
            }
            s if s.starts_with("--db=") => db = Some(PathBuf::from(&s[5..])),
            s if s.starts_with('-') => return Err(format!("unknown option {s}\n\n{USAGE}")),
            _ => command.push(a),
        }
    }
    Ok(Args { db, usage, command })
}

fn db_path(db: &Option<PathBuf>) -> PathBuf {
    agentrouter_session_core::db::path_or_default(db.as_deref())
}

fn open(db: &Option<PathBuf>, usage: Usage) -> Result<McpServer, String> {
    let (store, adapters) = mcp::open_index(&db_path(db))?;
    Ok(McpServer::new(store, adapters, usage))
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("agentrouter-session-mcp: {e}");
            return ExitCode::from(2);
        }
    };
    match args.command.first().map(String::as_str) {
        None => {
            let server = match open(&args.db, args.usage) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("agentrouter-session-mcp: {e}");
                    return ExitCode::from(2);
                }
            };
            let stdin = io::stdin();
            let stdout = io::stdout();
            match server.serve(stdin.lock(), stdout.lock()) {
                Ok(()) => ExitCode::SUCCESS,
                // 客户端先走一步、管道断开是正常收场
                Err(e) if e.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("agentrouter-session-mcp: {e}");
                    ExitCode::from(1)
                }
            }
        }
        Some("setup") => {
            let bin = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agentrouter-session-mcp"));
            let mut out = io::stdout().lock();
            let _ = writeln!(out, "agentrouter-session-mcp binary: {}\n", bin.display());
            for s in mcp::setup_snippets(&bin) {
                let _ = writeln!(out, "## {} — {}\n\n{}\n", s.client, s.hint, s.text);
            }
            // 只探库,不必为一行提示把整份 roster 建起来
            if let Err(e) = Store::open_read_only(&db_path(&args.db)) {
                let _ = writeln!(out, "Note: {e:#}");
            }
            ExitCode::SUCCESS
        }
        Some("call") => {
            let Some(tool) = args.command.get(1) else {
                eprintln!("agentrouter-session-mcp: call needs a tool name\n\n{USAGE}");
                return ExitCode::from(2);
            };
            let json_args = args.command.get(2).map(String::as_str).unwrap_or("{}");
            let params: serde_json::Value = match serde_json::from_str(json_args) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("agentrouter-session-mcp: arguments are not valid JSON: {e}");
                    return ExitCode::from(2);
                }
            };
            let server = match open(&args.db, args.usage) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("agentrouter-session-mcp: {e}");
                    return ExitCode::from(2);
                }
            };
            let request = serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": tool, "arguments": params },
            });
            let reply = server.handle_line(&request.to_string()).unwrap_or_default();
            let reply: serde_json::Value = serde_json::from_str(&reply).unwrap_or_default();
            if let Some(err) = reply.get("error") {
                eprintln!("agentrouter-session-mcp: {}", err["message"].as_str().unwrap_or("error"));
                return ExitCode::from(1);
            }
            let text = reply["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default();
            println!("{text}");
            if reply["result"]["isError"].as_bool().unwrap_or(false) {
                return ExitCode::from(1);
            }
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("agentrouter-session-mcp: unknown command {other}\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}
