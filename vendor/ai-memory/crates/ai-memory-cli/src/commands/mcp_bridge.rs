//! Stdio MCP bridge to an ai-memory HTTP MCP server.
//!
//! Two modes, chosen by the entry that launches it, never by the environment:
//!
//! - **Session-aware** (the default, `install-mcp --client claude-code` and
//!   `--client muse`): forwards the launching harness's session id as
//!   `X-Memory-Actor-Session-Id` on every upstream request, and refuses to
//!   start without it. `--agent` names that harness and so the one variable
//!   read: `claude-code` (the default) reads `CLAUDE_CODE_SESSION_ID`,
//!   `muse` reads `MUSE_SESSION_ID`. No variable wins over another: the
//!   other one is never consulted, so a Claude Code started from a Muse shell
//!   (or the reverse) cannot forward the outer harness's id. The refusal is
//!   deliberate (`docs/auto-scope.md`): a registration installed to give a
//!   client per-session routing must not silently degrade to the shared
//!   single slot when the id is missing.
//! - **Session-less** (`--no-session-id`, every other client): a plain
//!   stdio-to-HTTP relay that forwards no session identity, so the client
//!   is a static MCP client and passes `workspace` + `project` explicitly,
//!   exactly as with a direct HTTP entry. It ignores `CLAUDE_CODE_SESSION_ID`
//!   even when present: a client started from a Claude Code terminal inherits
//!   that session's id, and forwarding it would steer this client's unscoped
//!   calls through another session's active-project pointer.
//!
//! Either way the bridge authenticates with the bearer `Config::load`
//! resolved (`AI_MEMORY_AUTH_TOKEN`, `[auth].bearer_token`, or the file
//! `[auth].bearer_token_file` names), so a harness config that launches it
//! carries no token and no token reaches its command line.

use std::collections::HashMap;

use anyhow::{Context, Result};
use reqwest::header::{HeaderName, HeaderValue};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ListToolsResult, PaginatedRequestParams, ServerInfo,
};
use rmcp::service::{RequestContext, RoleClient, RoleServer, ServiceError};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, stdio};
use rmcp::{ErrorData as McpError, Peer, ServerHandler, ServiceExt};

use crate::cli::{BridgeAgent, McpBridgeArgs};
use crate::commands::install_mcp::mcp_server_url_from_base;
use crate::config::Config;

const ACTOR_SESSION_HEADER: HeaderName = HeaderName::from_static("x-memory-actor-session-id");

#[derive(Clone)]
struct SessionAwareBridge {
    upstream: Peer<RoleClient>,
    server_info: ServerInfo,
}

impl ServerHandler for SessionAwareBridge {
    fn get_info(&self) -> ServerInfo {
        self.server_info.clone()
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        self.upstream
            .list_tools(request)
            .await
            .map_err(upstream_error)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        self.upstream
            .call_tool(request)
            .await
            .map_err(upstream_error)
    }
}

fn upstream_error(error: ServiceError) -> McpError {
    match error {
        ServiceError::McpError(error) => error,
        other => McpError::internal_error(format!("upstream MCP request failed: {other}"), None),
    }
}

pub(crate) fn upstream_config(
    server_url: &str,
    session_id: Option<&str>,
    auth_token: Option<&str>,
) -> Result<StreamableHttpClientTransportConfig> {
    // Every transport in this module is built from a config this function
    // produced, so installing here covers each of them. Doing it only in
    // `run` left `StreamableHttpClientTransport::from_config` reachable
    // without a provider, and reqwest 0.13 under `rustls-no-provider`
    // *panics* rather than erroring when one is missing.
    install_crypto_provider()?;

    let mut headers = HashMap::new();
    if let Some(session_id) = session_id {
        headers.insert(
            ACTOR_SESSION_HEADER,
            HeaderValue::from_str(session_id)
                .context("the session id contains characters that are invalid in an HTTP header")?,
        );
    }

    let mut config =
        StreamableHttpClientTransportConfig::with_uri(server_url).custom_headers(headers);
    if let Some(token) = auth_token {
        config = config.auth_header(token);
    }
    Ok(config)
}

/// The session id to forward: in the session-aware mode, the one `agent`
/// sets (`CLAUDE_CODE_SESSION_ID` or `MUSE_SESSION_ID`), refusing to run
/// without it; in the session-less mode nothing at all, whatever the
/// environment holds (see the module docs for why an inherited id must not be
/// forwarded there).
fn bridge_session_id(
    env: &crate::config::RuntimeEnv,
    agent: BridgeAgent,
    no_session_id: bool,
) -> Result<Option<&str>> {
    if no_session_id {
        return Ok(None);
    }
    let inherited = match agent {
        BridgeAgent::ClaudeCode => env.claude_code_session_id(),
        BridgeAgent::Muse => env.muse_session_id(),
    };
    let (variable, harness) = match agent {
        BridgeAgent::ClaudeCode => (agent.session_env(), "Claude Code"),
        BridgeAgent::Muse => (agent.session_env(), "Muse Code"),
    };
    inherited.map(Some).with_context(|| {
        format!(
            "{variable} is missing; this session-aware bridge must be launched by {harness} \
             as an stdio MCP server (other clients register it with `--no-session-id`)"
        )
    })
}

/// Install a process-wide rustls crypto provider before the bridge opens an HTTPS
/// transport.
///
/// The bridge uses rmcp's `reqwest-tls-no-provider`, which supplies the platform
/// certificate verifier without pinning a crypto provider — that is what keeps
/// aws-lc-rs, and the C toolchain and Android JNI stack it needs, out of every build
/// of this workspace. The trade is that rustls then has no default provider of its
/// own, and without one the first `https://` request fails inside the handshake with
/// an error that does not name the cause. `ring` is already compiled for this binary
/// via the reqwest 0.12 the rest of the workspace uses, so install that.
fn install_crypto_provider() -> Result<()> {
    // `Err` means another component installed a provider first, which is fine — the
    // postcondition we need is only that *some* provider is present.
    let _ = rustls::crypto::ring::default_provider().install_default();
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        anyhow::bail!(
            "failed to install a rustls crypto provider; the MCP bridge cannot open an \
             https:// connection without one"
        );
    }
    Ok(())
}

/// The base URL the bridge connects to. An empty `--server-url` counts as
/// not given: the Claude Code plugin passes its unset `server_url` option
/// through as "", and the install's configured server then applies.
fn bridge_base_url<'a>(flag: Option<&'a str>, configured: &'a str) -> &'a str {
    flag.filter(|url| !url.trim().is_empty())
        .unwrap_or(configured)
}

/// Run the stdio bridge, session-aware or session-less (see the module docs).
///
/// # Errors
/// Returns an error when the session-aware mode has no Claude session id, the
/// upstream HTTP MCP server refuses or cannot initialize (an unauthenticated
/// connection to a server that requires a token included), or either
/// transport fails.
pub async fn run(config: &Config, args: McpBridgeArgs) -> Result<()> {
    let session_id = bridge_session_id(&config.runtime_env, args.agent, args.no_session_id)?;
    let server_url = mcp_server_url_from_base(bridge_base_url(
        args.server_url.as_deref(),
        &config.server_url,
    ));
    let transport = StreamableHttpClientTransport::from_config(upstream_config(
        &server_url,
        session_id,
        config.auth.bearer_token.as_deref(),
    )?);

    // Connecting before serving stdio means a refused credential (401) or an
    // unreachable server ends the process with this error at once; the client
    // sees the MCP server exit instead of a session that never answers.
    let mut upstream = match ().serve(transport).await {
        Ok(upstream) => upstream,
        Err(error) => {
            let error = anyhow::Error::new(error);
            // rmcp reports the server's 401 only as "Auth required"; name it.
            let refused = format!("{error:#}").contains("Auth required");
            return Err(error).with_context(|| {
                format!(
                    "connecting the MCP bridge to {server_url}{}{}",
                    if refused {
                        ": the server answered 401 Unauthorized"
                    } else {
                        ""
                    },
                    if config.auth.bearer_token.is_some() {
                        ""
                    } else {
                        " (sent without a bearer token; the bridge reads it from \
                         AI_MEMORY_AUTH_TOKEN, [auth].bearer_token or [auth].bearer_token_file)"
                    }
                )
            });
        }
    };
    let server_info = upstream
        .peer_info()
        .map(|info| (*info).clone())
        .context("upstream MCP server completed initialization without server info")?;
    let bridge = SessionAwareBridge {
        upstream: upstream.peer().clone(),
        server_info,
    };
    let downstream = bridge
        .serve(stdio())
        .await
        .context("starting session-aware stdio MCP bridge")?;

    downstream
        .waiting()
        .await
        .context("waiting for the stdio MCP client transport")?;
    upstream
        .close()
        .await
        .context("closing upstream HTTP MCP transport")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The plugin's `.mcp.json` passes an unset option as "": that must reach
    /// the configured server, while a real flag value still wins.
    #[test]
    fn empty_server_url_flag_falls_back_to_the_configured_server() {
        let configured = "https://memory.example";
        assert_eq!(super::bridge_base_url(None, configured), configured);
        assert_eq!(super::bridge_base_url(Some(""), configured), configured);
        assert_eq!(super::bridge_base_url(Some("  "), configured), configured);
        assert_eq!(
            super::bridge_base_url(Some("http://127.0.0.1:5"), configured),
            "http://127.0.0.1:5"
        );
    }

    /// Building the transport must never depend on a caller having installed
    /// a provider first. reqwest 0.13 under `rustls-no-provider` **panics**
    /// inside `ClientBuilder` when none is present, so a missing install is a
    /// crash rather than an error a caller could handle.
    ///
    /// The install lives in `upstream_config` for that reason: every transport
    /// in this module is built from a config it produced.
    ///
    /// Note what this test cannot do. The provider is process-global, so once
    /// any test installs one this assertion would hold even with the install
    /// removed. The structural guarantee — install in the constructor path,
    /// not at one call site — is what actually prevents the panic; this pins
    /// the contract so the call is not quietly deleted.
    #[test]
    fn upstream_config_leaves_a_crypto_provider_installed() {
        let config = upstream_config("http://127.0.0.1:1/mcp", Some("session-for-provider"), None);
        assert!(config.is_ok(), "config build must succeed");
        assert!(
            rustls::crypto::CryptoProvider::get_default().is_some(),
            "upstream_config must guarantee a provider before any client is built"
        );
    }

    #[test]
    fn install_crypto_provider_is_idempotent_and_leaves_a_default() {
        // The bridge builds its transport with `reqwest-tls-no-provider`, so rustls has
        // no provider of its own. Both calls must succeed and a default must be present
        // afterwards — the second models another component having installed one first.
        super::install_crypto_provider().expect("first install");
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
        super::install_crypto_provider().expect("second install must not fail");
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
    use super::*;
    use crate::config::RuntimeEnv;
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use rmcp::model::{ContentBlock as Content, ServerCapabilities, Tool};
    use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
    use rmcp::transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService,
    };

    #[derive(Clone)]
    struct EchoServer {
        seen_session: Arc<Mutex<Option<String>>>,
    }

    impl ServerHandler for EchoServer {
        fn get_info(&self) -> ServerInfo {
            ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
        }

        async fn list_tools(
            &self,
            _request: Option<PaginatedRequestParams>,
            _context: RequestContext<RoleServer>,
        ) -> Result<ListToolsResult, McpError> {
            Ok(ListToolsResult {
                tools: vec![Tool::new(
                    "echo",
                    "Echo through the bridge",
                    Arc::new(Default::default()),
                )],
                ..Default::default()
            })
        }

        async fn call_tool(
            &self,
            request: CallToolRequestParams,
            context: RequestContext<RoleServer>,
        ) -> Result<CallToolResult, McpError> {
            let session = context
                .extensions
                .get::<axum::http::request::Parts>()
                .and_then(|parts| parts.headers.get(&ACTOR_SESSION_HEADER))
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            *self.seen_session.lock().unwrap() = session;
            Ok(CallToolResult::success(vec![Content::text(format!(
                "echo:{}",
                request.name
            ))]))
        }
    }

    #[test]
    fn upstream_config_injects_session_id_and_raw_bearer_token() {
        let config = upstream_config(
            "https://memory.example/mcp",
            Some("550e8400-e29b-41d4-a716-446655440000"),
            Some("secret-token"),
        )
        .unwrap();

        assert_eq!(config.auth_header.as_deref(), Some("secret-token"));
        assert_eq!(
            config
                .custom_headers
                .get(&ACTOR_SESSION_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("550e8400-e29b-41d4-a716-446655440000")
        );
        assert!(config.allow_stateless);
        assert!(config.reinit_on_expired_session);
    }

    #[test]
    fn upstream_config_rejects_an_invalid_header_value() {
        let error = upstream_config(
            "https://memory.example/mcp",
            Some("session\ninjected"),
            None,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("invalid in an HTTP header"),
            "{error:#}"
        );
    }

    #[tokio::test]
    async fn bridge_fails_closed_without_a_claude_session_id() {
        let error = run(
            &Config::default(),
            McpBridgeArgs {
                server_url: Some("https://memory.example/mcp".into()),
                no_session_id: false,
                agent: BridgeAgent::ClaudeCode,
            },
        )
        .await
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("CLAUDE_CODE_SESSION_ID is missing"),
            "{error:#}"
        );
    }

    /// The session-aware mode still fails closed without an id; the
    /// session-less mode never forwards one, not even an inherited id.
    #[test]
    fn only_the_session_aware_mode_forwards_and_requires_a_session_id() {
        let claude = RuntimeEnv::with_session_ids_for_tests(Some("s"), None);
        let none = RuntimeEnv::default();
        let agent = BridgeAgent::ClaudeCode;
        assert_eq!(bridge_session_id(&claude, agent, false).unwrap(), Some("s"));
        assert!(bridge_session_id(&none, agent, false).is_err());
        assert_eq!(bridge_session_id(&claude, agent, true).unwrap(), None);
        assert_eq!(bridge_session_id(&none, agent, true).unwrap(), None);
    }

    /// Adversarial: `--agent` names the one variable read, so no harness's id
    /// stands in for another's. A Muse bridge forwards `MUSE_SESSION_ID` and
    /// never an inherited `CLAUDE_CODE_SESSION_ID`, and fails closed without
    /// its own id even when Claude's is set; a Claude bridge never forwards a
    /// `MUSE_SESSION_ID` it inherited from a Muse shell. Control: each
    /// forwards its own id when both are present, and the session-less mode
    /// forwards neither.
    #[test]
    fn each_harness_forwards_only_its_own_session_id() {
        let muse_id = "01a13669-dc61-7a72-b5ec-ad2f300ffd26";
        let both = RuntimeEnv::with_session_ids_for_tests(Some("claude-id"), Some(muse_id));
        assert_eq!(
            bridge_session_id(&both, BridgeAgent::Muse, false).unwrap(),
            Some(muse_id)
        );
        assert_eq!(
            bridge_session_id(&both, BridgeAgent::ClaudeCode, false).unwrap(),
            Some("claude-id")
        );

        let claude_only = RuntimeEnv::with_session_ids_for_tests(Some("claude-id"), None);
        let error = bridge_session_id(&claude_only, BridgeAgent::Muse, false).unwrap_err();
        assert!(
            error.to_string().contains("MUSE_SESSION_ID is missing"),
            "{error:#}"
        );
        let muse_only = RuntimeEnv::with_session_ids_for_tests(None, Some(muse_id));
        let error = bridge_session_id(&muse_only, BridgeAgent::ClaudeCode, false).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("CLAUDE_CODE_SESSION_ID is missing"),
            "{error:#}"
        );
        assert_eq!(
            bridge_session_id(&both, BridgeAgent::Muse, true).unwrap(),
            None
        );
    }

    /// Session-less mode sends no session header at all, even when a
    /// `CLAUDE_CODE_SESSION_ID` is inherited (it is not even consulted).
    #[test]
    fn a_session_less_upstream_config_carries_no_session_header() {
        let config = upstream_config("https://memory.example/mcp", None, Some("t")).unwrap();
        assert!(!config.custom_headers.contains_key(&ACTOR_SESSION_HEADER));
        assert_eq!(config.auth_header.as_deref(), Some("t"));
    }

    async fn assert_bridge_round_trip(stateful: bool) {
        let seen_session = Arc::new(Mutex::new(None));
        let echo = EchoServer {
            seen_session: seen_session.clone(),
        };
        let service: StreamableHttpService<EchoServer, LocalSessionManager> =
            StreamableHttpService::new(
                move || Ok(echo.clone()),
                LocalSessionManager::default().into(),
                StreamableHttpServerConfig::default()
                    .with_stateful_mode(stateful)
                    .with_json_response(!stateful),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let http_server = tokio::spawn(async move {
            axum::serve(listener, Router::new().nest_service("/mcp", service))
                .await
                .unwrap();
        });

        let upstream_transport = StreamableHttpClientTransport::from_config(
            upstream_config(
                &format!("http://{address}/mcp"),
                Some("claude-session-244"),
                None,
            )
            .unwrap(),
        );
        let upstream = ().serve(upstream_transport).await.unwrap();
        let bridge = SessionAwareBridge {
            upstream: upstream.peer().clone(),
            server_info: upstream.peer_info().map(|info| (*info).clone()).unwrap(),
        };
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let downstream_server = tokio::spawn(async move { bridge.serve(server_io).await.unwrap() });
        let downstream_client = ().serve(client_io).await.unwrap();
        let downstream_server = downstream_server.await.unwrap();

        let tools = downstream_client.list_all_tools().await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        let result = downstream_client
            .call_tool(CallToolRequestParams::new("echo"))
            .await
            .unwrap();
        assert_eq!(
            result
                .content
                .first()
                .and_then(|content| content.as_text())
                .map(|text| text.text.as_str()),
            Some("echo:echo")
        );
        assert_eq!(
            seen_session.lock().unwrap().as_deref(),
            Some("claude-session-244")
        );

        downstream_client.cancel().await.unwrap();
        downstream_server.cancel().await.unwrap();
        upstream.cancel().await.unwrap();
        http_server.abort();
    }

    #[tokio::test]
    async fn stdio_bridge_forwards_tools_and_session_header_in_both_http_modes() {
        assert_bridge_round_trip(false).await;
        assert_bridge_round_trip(true).await;
    }
}
