//! Product documentation embedded with the binary, independent of project memory.

use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
pub(crate) struct Document {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub source: &'static str,
    #[serde(skip)]
    pub body: &'static str,
}

macro_rules! document {
    ($id:literal, $title:literal, $description:literal, $category:literal, $source:literal) => {
        Document {
            id: $id,
            title: $title,
            description: $description,
            category: $category,
            source: $source,
            body: include_str!(concat!("../../../", $source)),
        }
    };
}

pub(crate) const DOCUMENTS: &[Document] = &[
    document!(
        "features",
        "Features & activation",
        "What each feature does, prerequisites, how to enable it, and how to verify capture and access.",
        "Start here",
        "docs/features.md"
    ),
    document!(
        "install",
        "Installation & agent setup",
        "Native and Docker setup, client hooks, MCP, supported harnesses, and upgrades.",
        "Start here",
        "docs/install.md"
    ),
    document!(
        "usage",
        "Usage & dashboard",
        "Recall, handoffs, recovery, live token accounting, agent sessions, and the web inbox.",
        "Start here",
        "docs/usage.md"
    ),
    document!(
        "cookbook",
        "Task cookbook",
        "Practical recipes for capturing, recalling, importing, and coordinating work.",
        "Start here",
        "docs/cookbook.md"
    ),
    document!(
        "agent-messaging",
        "Agent inbox & messaging",
        "Shared and directed messages, browser sending, recipient identity, and claim-once delivery.",
        "Agent workflows",
        "docs/agent-messaging.md"
    ),
    document!(
        "managed-workstreams",
        "Managed sessions & workstreams",
        "Launch and resume agents with ai-memory run, profiles, auto-wiring, and cross-harness continuity.",
        "Agent workflows",
        "docs/managed-workstreams.md"
    ),
    document!(
        "marker-file",
        "Project routing & capture privacy",
        "Configure workspace/project identity and capture exclusions in .ai-memory.toml.",
        "Agent workflows",
        "docs/marker-file.md"
    ),
    document!(
        "programmatic-memory",
        "Programmatic memory",
        "Use the public MCP protocol from applications and orchestrators.",
        "Agent workflows",
        "docs/programmatic-memory.md"
    ),
    document!(
        "external-lifecycle",
        "External lifecycle capture",
        "Connect orchestrators and the relay through the bounded lifecycle ingestion API.",
        "Agent workflows",
        "docs/external-lifecycle.md"
    ),
    document!(
        "llm-providers",
        "LLM & embedding providers",
        "Enable optional provider-backed consolidation, embeddings, authentication, and fallback chains.",
        "Learning & retrieval",
        "docs/llm-providers.md"
    ),
    document!(
        "llm-provider-fallback",
        "Provider fallback",
        "Configure an ordered provider chain and understand which failures may trigger fallback.",
        "Learning & retrieval",
        "docs/llm-provider-fallback.md"
    ),
    document!(
        "okf",
        "Portable wiki format",
        "Understand Markdown frontmatter, portable wiki layout, import, and format compatibility.",
        "Agent workflows",
        "docs/okf.md"
    ),
    document!(
        "session-management",
        "Session management API",
        "Build and enable owned-session inspection and purge routes with human authentication.",
        "Access & integration",
        "docs/session-management.md"
    ),
    document!(
        "self-service-keys",
        "Self-service API keys",
        "Build and enable the optional API for users to manage their own native credentials.",
        "Access & integration",
        "docs/self-service-keys.md"
    ),
    document!(
        "auto-improvement-loop",
        "Learning & proposal review",
        "Current learning behavior, approval settings, scheduler prerequisites, and detailed design history.",
        "Learning & retrieval",
        "docs/auto-improvement-loop.md"
    ),
    document!(
        "architecture",
        "Configuration & architecture",
        "The complete configuration reference, storage, retrieval signals, APIs, and operating boundaries.",
        "Operations",
        "docs/ARCHITECTURE.md"
    ),
    document!(
        "diagnostics",
        "Diagnostics & health",
        "Inspect capture, providers, logging, and server health when a feature is not reporting data.",
        "Operations",
        "docs/diagnostics.md"
    ),
    document!(
        "lifecycle-ops",
        "Backup, recovery & lifecycle",
        "Online backups, restore requirements, retention, moves, and scoped lifecycle operations.",
        "Operations",
        "docs/lifecycle-ops.md"
    ),
    document!(
        "deploy",
        "Deployment",
        "Native and container deployment, environment settings, and persistent storage.",
        "Operations",
        "docs/deploy.md"
    ),
    document!(
        "https-via-proxy",
        "HTTPS & reverse proxy",
        "Configure TLS and proxy deployment while retaining authentication and host checks.",
        "Operations",
        "docs/https-via-proxy.md"
    ),
    document!(
        "management-ui",
        "Management console",
        "Build and enable the optional console, human login, session management, and API keys.",
        "Access & integration",
        "docs/management-ui.md"
    ),
    document!(
        "security",
        "Security & authentication",
        "Authentication, authorization, sanitization, and deployment security guidance.",
        "Access & integration",
        "docs/security.md"
    ),
    document!(
        "sso",
        "SSO & enterprise identity",
        "OIDC device login, identity-provider configuration, and supported enterprise workflows.",
        "Access & integration",
        "docs/sso.md"
    ),
    document!(
        "frontend-api",
        "HTTP API & agent-readable docs",
        "Read-only JSON endpoints, documentation access, custom frontends, and URL prefixes.",
        "Access & integration",
        "docs/frontend-api.md"
    ),
    document!(
        "changelog",
        "Changelog",
        "Unreleased changes and the current major release history, bundled with this build.",
        "Release history",
        "CHANGELOG.md"
    ),
    document!(
        "changelog-2x",
        "Changelog · 2.x",
        "Archived releases from the 2.x series.",
        "Release history",
        "docs/changelog/2.x.md"
    ),
    document!(
        "changelog-1x",
        "Changelog · 1.x",
        "Archived releases from the 1.x series.",
        "Release history",
        "docs/changelog/1.x.md"
    ),
    document!(
        "changelog-0x",
        "Changelog · 0.x",
        "Archived releases from the 0.x series.",
        "Release history",
        "docs/changelog/0.x.md"
    ),
];

pub(crate) fn find(id: &str) -> Option<&'static Document> {
    DOCUMENTS.iter().find(|doc| doc.id == id)
}

pub(crate) fn search(query: &str) -> Vec<&'static Document> {
    let terms: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
    if terms.is_empty() {
        return DOCUMENTS.iter().collect();
    }
    DOCUMENTS
        .iter()
        .filter(|doc| {
            let text = format!(
                "{} {} {} {}",
                doc.title, doc.description, doc.category, doc.body
            )
            .to_lowercase();
            terms.iter().all(|term| text.contains(term))
        })
        .collect()
}

pub(crate) struct Release<'a> {
    pub id: &'a str,
    pub heading: &'a str,
    pub body: &'a str,
}

pub(crate) fn releases(body: &str) -> Vec<Release<'_>> {
    let mut starts = Vec::new();
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        if let Some(rest) = line.strip_prefix("## [")
            && let Some((id, _)) = rest.split_once(']')
        {
            starts.push((offset, id, line.trim()));
        }
        offset += line.len();
    }
    starts
        .iter()
        .enumerate()
        .map(|(i, &(start, id, heading))| Release {
            id,
            heading,
            body: &body[start..starts.get(i + 1).map_or(body.len(), |s| s.0)],
        })
        .collect()
}

/// Resolve repository links without interpreting them as project wiki paths.
pub(crate) fn link(doc: &Document, current_href: &str, target: &str) -> String {
    if target.starts_with('#') {
        return format!("{current_href}{target}");
    }
    if target.starts_with('/') || target.contains(':') || target.starts_with('\\') {
        return target.into();
    }
    let split = target.find(['#', '?']).unwrap_or(target.len());
    let (path, suffix) = target.split_at(split);
    let mut parts: Vec<_> = doc.source.split('/').collect();
    parts.pop();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return "#".into();
                }
            }
            part => parts.push(part),
        }
    }
    let normalized = parts.join("/");
    if let Some(known) = DOCUMENTS
        .iter()
        .find(|d| d.source == normalized || d.source == path.trim_start_matches("./"))
    {
        return format!("docs/{}{suffix}", known.id);
    }
    if normalized == "docs/changelog" {
        return format!("docs/changelog{suffix}");
    }
    let encoded = parts
        .iter()
        .map(|p| crate::templates::encode_segment(p))
        .collect::<Vec<_>>()
        .join("/");
    format!(
        "https://github.com/akitaonrails/ai-memory/{}/main/{encoded}{suffix}",
        if path.ends_with('/') { "tree" } else { "blob" }
    )
}
