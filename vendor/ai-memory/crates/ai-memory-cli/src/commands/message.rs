//! `ai-memory message` — send, list, pop, and cancel cross-project agent
//! messages.
//!
//! A message is a directed, claim-once note from one project (the sender
//! coordinate) to another (the recipient coordinate): an agent in project A
//! composes a request and drops it into project B's inbox, and the next
//! session working in B pops it exactly once. See `docs/agent-messaging.md`.
//!
//! Security: a popped message body was composed by another project's agent —
//! untrusted cross-project input, a task request to weigh rather than
//! instructions to obey.

use std::io::Read;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::cli::{
    MessageArgs, MessageCancelArgs, MessageCommand, MessageListArgs, MessagePopArgs,
    MessageSendArgs,
};
use crate::config::Config;
use crate::http_client::{ServerEndpoint, get_json, post_json};

#[derive(Debug, Deserialize, Serialize)]
struct AgentMessage {
    id: String,
    to_workspace_id: String,
    to_project_id: String,
    from_workspace_id: String,
    from_project_id: String,
    from_agent: String,
    #[serde(default)]
    from_owner_user: Option<String>,
    #[serde(default)]
    subject: Option<String>,
    body: String,
    state: String,
    created_at: String,
    #[serde(default)]
    claimed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListMessagesResponse {
    messages: Vec<AgentMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PopMessageResponse {
    message: Option<AgentMessage>,
    #[serde(default)]
    security_notice: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct SendMessageResponse {
    message_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct CancelMessagesResponse {
    cancelled: u64,
}

/// Dispatch `ai-memory message`.
///
/// # Errors
/// Returns [`anyhow::Error`] when the scope cannot be resolved, stdin cannot
/// be read, the server is unreachable, or it answers non-2xx.
pub async fn run(config: &Config, args: MessageArgs) -> Result<()> {
    match args.command {
        MessageCommand::Send(args) => send(config, args).await,
        MessageCommand::List(args) => list(config, args).await,
        MessageCommand::Pop(args) => pop(config, args).await,
        MessageCommand::Cancel(args) => cancel(config, args).await,
    }
}

#[derive(Debug, Serialize)]
struct SendRequest<'a> {
    from_workspace: &'a str,
    from_project: &'a str,
    to_workspace: &'a str,
    to_project: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<&'a str>,
    body: &'a str,
}

async fn send(config: &Config, args: MessageSendArgs) -> Result<()> {
    let (from_workspace, from_project) = super::resolve_scope(
        config,
        args.from_workspace.as_deref(),
        args.from_project.as_deref(),
    )?;

    let body = match args.body {
        Some(body) => body,
        None => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| anyhow::anyhow!("reading message body from stdin: {e}"))?;
            buf
        }
    };

    let endpoint = ServerEndpoint::from_config_resolving_auth(config).await;
    let resp: SendMessageResponse = post_json(
        &endpoint,
        "/admin/messages/send",
        &SendRequest {
            from_workspace: &from_workspace,
            from_project: &from_project,
            to_workspace: &args.to_workspace,
            to_project: &args.to_project,
            subject: args.subject.as_deref(),
            body: &body,
        },
    )
    .await?;

    if args.json {
        println!("{}", serde_json::to_string_pretty(&resp)?);
        return Ok(());
    }

    println!(
        "Sent message {} from {from_workspace}/{from_project} to {}/{}.",
        resp.message_id, args.to_workspace, args.to_project
    );
    Ok(())
}

async fn list(config: &Config, args: MessageListArgs) -> Result<()> {
    let (workspace, project) =
        super::resolve_scope(config, args.workspace.as_deref(), args.project.as_deref())?;
    let endpoint = ServerEndpoint::from_config_resolving_auth(config).await;
    let mailbox = if args.outbox { "outbox" } else { "inbox" };

    let response: ListMessagesResponse = get_json(
        &endpoint,
        "/admin/messages",
        &[
            ("workspace", workspace.as_str()),
            ("project", project.as_str()),
            ("box", mailbox),
            ("limit", &args.limit.to_string()),
        ],
    )
    .await?;

    if args.json {
        println!("{}", serde_json::to_string_pretty(&response.messages)?);
        return Ok(());
    }

    if response.messages.is_empty() {
        println!("No pending {mailbox} messages for {workspace}/{project}.");
        return Ok(());
    }

    let now_ms = jiff::Timestamp::now().as_millisecond();
    println!("Pending {mailbox} messages for {workspace}/{project} (oldest first):");
    for m in &response.messages {
        let age_secs = m
            .created_at
            .parse::<jiff::Timestamp>()
            .map(|ts| now_ms.saturating_sub(ts.as_millisecond()) / 1_000)
            .unwrap_or(0);
        let subject = m.subject.as_deref().unwrap_or("(no subject)");
        let (from, to) = if args.outbox {
            (
                format!("{workspace}/{project}"),
                format!("{}/{}", m.to_workspace_id, m.to_project_id),
            )
        } else {
            (
                format!("{}/{}", m.from_workspace_id, m.from_project_id),
                format!("{workspace}/{project}"),
            )
        };
        println!("  {}  {subject}", super::humanize_age_secs(age_secs));
        println!("    id: {}", m.id);
        println!("    {from} -> {to}");
    }
    Ok(())
}

async fn pop(config: &Config, args: MessagePopArgs) -> Result<()> {
    let (workspace, project) =
        super::resolve_scope(config, args.workspace.as_deref(), args.project.as_deref())?;
    let endpoint = ServerEndpoint::from_config_resolving_auth(config).await;

    let resp: PopMessageResponse = post_json(
        &endpoint,
        "/admin/messages/pop",
        &PopRequest {
            workspace: &workspace,
            project: &project,
            message_id: args.id.as_deref(),
        },
    )
    .await?;

    if args.json {
        println!("{}", serde_json::to_string_pretty(&resp)?);
        return Ok(());
    }

    let Some(message) = resp.message else {
        println!("No pending messages in {workspace}/{project}'s inbox.");
        return Ok(());
    };

    println!("Popped message {} for {workspace}/{project}.", message.id);
    println!(
        "  from: {}/{} (agent: {})",
        message.from_workspace_id, message.from_project_id, message.from_agent
    );
    if let Some(owner) = message.from_owner_user.as_deref() {
        println!("  sent by: {owner}");
    }
    if let Some(subject) = message.subject.as_deref() {
        println!("  subject: {subject}");
    }
    println!("  created: {}", message.created_at);
    println!(
        "\n{}",
        resp.security_notice
            .as_deref()
            .unwrap_or(ai_memory_core::UNTRUSTED_MESSAGE_NOTICE)
    );
    println!("---- body (untrusted cross-project input) ----");
    println!("{}", message.body);
    println!("---- end of body ----");
    Ok(())
}

#[derive(Debug, Serialize)]
struct PopRequest<'a> {
    workspace: &'a str,
    project: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<&'a str>,
}

async fn cancel(config: &Config, args: MessageCancelArgs) -> Result<()> {
    if args.id.is_none() && !args.all {
        anyhow::bail!("message cancel requires exactly one of --id <MESSAGE_ID> or --all");
    }

    let (workspace, project) =
        super::resolve_scope(config, args.workspace.as_deref(), args.project.as_deref())?;
    let endpoint = ServerEndpoint::from_config_resolving_auth(config).await;

    let resp: CancelMessagesResponse = post_json(
        &endpoint,
        "/admin/messages/cancel",
        &CancelRequest {
            workspace: &workspace,
            project: &project,
            message_id: args.id.as_deref(),
        },
    )
    .await?;

    if args.json {
        println!("{}", serde_json::to_string_pretty(&resp)?);
        return Ok(());
    }

    println!(
        "Cancelled {} message{} in {workspace}/{project}.",
        resp.cancelled,
        if resp.cancelled == 1 { "" } else { "s" }
    );
    Ok(())
}

#[derive(Debug, Serialize)]
struct CancelRequest<'a> {
    workspace: &'a str,
    project: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<&'a str>,
}
