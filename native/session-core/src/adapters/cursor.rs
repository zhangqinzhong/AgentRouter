use super::parse_utils::*;
use super::{cursor_ide, AgentAdapter};
use crate::models::*;
use anyhow::Result;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

/// Cursor CLI:`~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl` 明文。
/// 行结构 {role, message:{content:[{type:text|tool_use}]}} + {type:"turn_ended"}。
/// user 正文包在 <timestamp>/<user_query> 壳里;transcript 不含 cwd,也不记模型——
/// 两样都优先从同一会话的 IDE 元数据借(`cursor_ide::composer_facts`),路径缺失时从
/// slug 目录名还原。纯 CLI 会话在 IDE 库里没有记录,模型就空着;token 转录这一路不给。
///
/// **同一家的另一个源**:IDE 面板(Chat/Composer)的会话正文在
/// `globalStorage/state.vscdb`,由 cursor_ide.rs 读。某些 Cursor 版本的 IDE
/// 会话在本源只留 `{"type":"turn_ended"}` 空壳,枚举时按 `is_turn_marker_only`
/// 跳过;转录带正文时两源各有一份,scanner 的副本裁决按 `dedup_rank` 固定让
/// 本源胜出,正文仍从转录读取。
pub struct CursorAdapter {
    root: PathBuf,
    metadata_db: Option<PathBuf>,
    /// 指令文件(项目根下的 .cursor/rules、.cursorrules)与自定义来源按指纹缓存,每轮扫描只 stat
    memories: super::MemoryCache,
}

impl CursorAdapter {
    pub fn new() -> Self {
        Self {
            root: super::home_dir()
                .unwrap_or_default()
                .join(".cursor")
                .join("projects"),
            metadata_db: Some(cursor_ide::default_db_path()),
            memories: super::MemoryCache::new(),
        }
    }

    /// 同一个会话在 IDE 库里的 composer(只有默认实例有 IDE 库;自定义根也用于远程缓存,
    /// 不能混用本机的)。新版 Cursor 给 IDE 会话也写转录、转录胜出,项目与模型得从这份借
    fn composer_facts(&self, r: &SessionFileRef) -> cursor_ide::ComposerFacts {
        self.metadata_db
            .as_deref()
            .and_then(|db| cursor_ide::composer_facts(db, std::iter::once(r.native_id.as_str())))
            .and_then(|mut facts| facts.remove(&r.native_id))
            .unwrap_or_default()
    }

    fn build_meta(&self, r: &SessionFileRef, p: &CursorParse) -> SessionMeta {
        let facts = self.composer_facts(r);
        let cwd = resolve_project_path(r, facts.project.as_ref());
        let spawned = subagent_parent_dir(Path::new(&r.file_path)).is_some();
        // 子代理的 composer 名字是派它时写的任务说明(IDE 里跑的才有),比它收到的整段提示好认
        let title = facts
            .name
            .filter(|_| spawned)
            .or_else(|| title_from_messages(&p.messages))
            .unwrap_or_else(|| UNTITLED.to_string());
        SessionMeta {
            key: format!("cursor:{}", r.native_id),
            host: String::new(),
            id: r.native_id.clone(),
            agent: AgentId::Cursor,
            title,
            project_path: cwd.clone(),
            project_name: project_name_of(&cwd),
            file_path: r.file_path.clone(),
            created_at: if p.created_at > 0 {
                p.created_at
            } else {
                r.mtime_ms
            },
            updated_at: if p.updated_at > 0 {
                p.updated_at
            } else {
                r.mtime_ms
            },
            message_count: p
                .messages
                .iter()
                .filter(|m| m.kind == MessageKind::Text)
                .count() as i64,
            size_bytes: r.size,
            git_branch: None,
            model: facts.model,
            tokens_used: None,
            archived: false,
            source: None,
            spawned,
            favorite: false,
            pinned: false,
        }
    }
}

/// Cursor 用 `-` 表示分隔符、连字符和空格；优先保留原有路径匹配。
fn decode_existing_slug(base: PathBuf, slug: &str) -> Option<PathBuf> {
    fn dfs(base: PathBuf, parts: &[&str]) -> Option<PathBuf> {
        if parts.is_empty() {
            return Some(base);
        }
        let mut seg = String::new();
        for i in 0..parts.len() {
            if i > 0 {
                seg.push('-');
            }
            seg.push_str(parts[i]);
            let path = base.join(&seg);
            if path.is_dir() {
                if let Some(hit) = dfs(path, &parts[i + 1..]) {
                    return Some(hit);
                }
            }
        }
        None
    }

    if slug.is_empty() {
        return Some(base);
    }
    let parts: Vec<&str> = slug.split('-').collect();
    if let Some(path) = dfs(base.clone(), &parts) {
        return Some(path);
    }

    let entries = fs::read_dir(&base).ok()?;
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let raw = entry.file_name().to_string_lossy().to_string();
        let encoded = raw.replace(' ', "-");
        let rest = if slug == encoded {
            Some("")
        } else {
            slug.strip_prefix(&encoded)
                .and_then(|s| s.strip_prefix('-'))
        };
        if let Some(rest) = rest {
            let path = entry.path();
            if path.is_dir() {
                candidates.push((encoded.len(), raw.contains(' '), raw, path, rest));
            }
        }
    }
    candidates.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    for (_, _, _, path, rest) in candidates {
        if let Some(hit) = decode_existing_slug(path, rest) {
            return Some(hit);
        }
    }
    None
}

fn decode_slug(slug: &str) -> String {
    decode_existing_slug(PathBuf::from("/"), slug)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("/{}", slug.replace('-', "/")))
}

/// "Thursday, Jul 23, 2026, 4:00 PM (UTC+8)" → epoch ms,解析失败 = 0
fn cursor_ts_ms(s: &str) -> i64 {
    (|| -> Option<i64> {
        let (dt_part, tz_part) = s.rsplit_once(" (")?;
        let naive =
            chrono::NaiveDateTime::parse_from_str(dt_part.trim(), "%A, %b %d, %Y, %I:%M %p")
                .ok()?;
        let off = tz_part.trim_end_matches(')').strip_prefix("UTC")?;
        let (sign, rest) = match off.as_bytes().first()? {
            b'+' => (1i32, &off[1..]),
            b'-' => (-1i32, &off[1..]),
            _ => (1i32, off),
        };
        let secs = match rest.split_once(':') {
            Some((h, m)) => h.parse::<i32>().ok()? * 3600 + m.parse::<i32>().ok()? * 60,
            None => rest.parse::<i32>().ok()? * 3600,
        };
        let offset = chrono::FixedOffset::east_opt(sign * secs)?;
        use chrono::TimeZone;
        Some(
            offset
                .from_local_datetime(&naive)
                .single()?
                .timestamp_millis(),
        )
    })()
    .unwrap_or(0)
}

struct CursorParse {
    messages: Vec<TranscriptMessage>,
    created_at: i64,
    updated_at: i64,
    unknown_lines: u32,
    dispatches: Vec<Dispatch>,
}

/// 主线里派子代理的调用(Task)。转录里的工具调用没有 id,详情页的跳转靠这两样对上
/// subagents/ 里的转录:头一回派的 `prompt` 就是子代理收到的第一句,接着派的 `resume` 直接
/// 点名子代理
struct Dispatch {
    /// 调用所在的消息,与它在那条消息里的位置
    message: usize,
    call: usize,
    prompt: Option<String>,
    resume: Option<String>,
    description: Option<String>,
    agent_type: Option<String>,
}

#[derive(Default)]
struct PendingAssistant {
    content: ParsedContent,
    tool_calls: Vec<ToolCallView>,
    timestamp: Option<i64>,
}

fn flush_assistant(pending: &mut Option<PendingAssistant>, messages: &mut Vec<TranscriptMessage>) {
    let Some(p) = pending.take() else { return };
    let ParsedContent { text, images } = p.content;
    if text.is_empty() && p.tool_calls.is_empty() && images.is_empty() {
        return;
    }
    let (clipped, truncated) = clip(&text, MAX_MSG_TEXT);
    messages.push(TranscriptMessage {
        seq: 0,
        role: Role::Assistant,
        kind: MessageKind::Text,
        text: clipped,
        truncated,
        tool_calls: p.tool_calls,
        thinking: None,
        timestamp: p.timestamp,
        model: None,
        images,
    });
}

fn parse_cursor_jsonl(path: &Path, decode_images: bool) -> Result<CursorParse> {
    let _image_budget = transcript_image_decode_budget(decode_images);
    let file = fs::File::open(path)?;
    let reader = BufReader::with_capacity(1 << 20, file);

    let mut messages: Vec<TranscriptMessage> = Vec::new();
    let mut pending: Option<PendingAssistant> = None;
    let mut created_at = 0i64;
    let mut updated_at = 0i64;
    let mut unknown_lines = 0u32;
    // 读不出/不是 JSON 的行(截断、损坏),与"认得出 JSON 但类型未知"分开计
    let mut malformed_lines = 0u32;
    let mut dispatches = Vec::new();

    for row in jsonl_values(reader) {
        let Some(row) = row? else {
            unknown_lines += 1;
            malformed_lines += 1;
            continue;
        };
        let Some(role) = row.get("role").and_then(|v| v.as_str()) else {
            match row.get("type").and_then(|v| v.as_str()) {
                Some("turn_ended") => flush_assistant(&mut pending, &mut messages),
                _ => unknown_lines += 1,
            }
            continue;
        };
        let blocks = row
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        match role {
            "user" => {
                flush_assistant(&mut pending, &mut messages);
                let mut parsed_message = ParsedContent::default();
                let mut ts = 0i64;
                for b in &blocks {
                    match b.get("type").and_then(|v| v.as_str()) {
                        Some("text") => {
                            let Some(raw) = b.get("text").and_then(|v| v.as_str()) else {
                                continue;
                            };
                            if let Some(t) = extract_tag(raw, "timestamp") {
                                let parsed = cursor_ts_ms(&t);
                                if parsed > 0 {
                                    ts = parsed;
                                }
                            }
                            parsed_message.push_text(&user_query(raw));
                        }
                        _ if is_image_part(b) => {
                            let parsed = content_parts(b, decode_images);
                            parsed_message.append(parsed);
                        }
                        _ => {}
                    }
                }
                let ParsedContent { text, images } = parsed_message;
                if text.trim().is_empty() && images.is_empty() {
                    continue;
                }
                if ts > 0 {
                    if created_at == 0 {
                        created_at = ts;
                    }
                    updated_at = updated_at.max(ts);
                }
                let mut message = text_msg(Role::User, &text, ts);
                message.images = images;
                messages.push(message);
            }
            "assistant" => {
                // Cursor 逐块落行且无消息 id,连续 assistant 行并成一条,turn_ended/user 处 flush
                let p = pending.get_or_insert_with(PendingAssistant::default);
                for b in &blocks {
                    match b.get("type").and_then(|v| v.as_str()) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                                if !t.trim().is_empty() {
                                    p.content.push_text(t);
                                }
                            }
                        }
                        Some("tool_use") => {
                            let input = b.get("input").cloned().unwrap_or(Value::Null);
                            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                            let text = |key: &str| optional_string(input.get(key));
                            let (prompt, resume) = (text("prompt"), text("resume"));
                            if prompt.is_some() || resume.is_some() {
                                // 这条助手消息还没落进 messages:flush 时它就排在这个位置
                                dispatches.push(Dispatch {
                                    message: messages.len(),
                                    call: p.tool_calls.len(),
                                    prompt,
                                    resume,
                                    description: text("description"),
                                    agent_type: text("subagent_type"),
                                });
                            }
                            // transcript 不落盘工具结果,output 恒 None
                            p.tool_calls.push(tool_call_view(
                                String::new(),
                                name,
                                &input,
                                None,
                                false,
                            ));
                        }
                        _ if is_image_part(b) => {
                            let parsed = content_parts(b, decode_images);
                            p.content.append(parsed);
                        }
                        _ => {}
                    }
                }
            }
            _ => unknown_lines += 1,
        }
    }
    flush_assistant(&mut pending, &mut messages);
    assign_seq(&mut messages);
    // 一条消息都没解出来、却有坏行:这是截断/损坏的转录(如只剩 `{"role":`,
    // 它过得了 is_turn_marker_only 的空壳判定),不是空会话。按失败报出去,
    // scanner 才会按裁决顺位回退到 IDE 库那份副本;返回 Ok 零消息会让
    // dedup_rank 靠前的坏转录压过完整副本(2026-09-15 Codex review)
    if messages.is_empty() && malformed_lines > 0 {
        anyhow::bail!("no messages parsed, {malformed_lines} unreadable line(s)");
    }
    Ok(CursorParse {
        messages,
        created_at,
        updated_at,
        unknown_lines,
        dispatches,
    })
}

/// 用户文字块里人打的那句:`<user_query>` 壳里的话,没有壳的原样(解析与 `first_query` 共用,
/// 对派活调用要逐字相同)
fn user_query(raw: &str) -> String {
    extract_tag(raw, "user_query").unwrap_or_else(|| raw.to_string())
}

/// 子代理收到的第一句:第一条用户行里人打的话,与解析出来的那条用户消息同一个取法
fn first_query(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for row in jsonl_values(BufReader::new(file)) {
        let Ok(Some(row)) = row else { continue };
        if row.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let mut query = ParsedContent::default();
        for b in row.pointer("/message/content")?.as_array()? {
            if b.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(raw) = b.get("text").and_then(Value::as_str) {
                    query.push_text(&user_query(raw));
                }
            }
        }
        return Some(query.text).filter(|q| !q.is_empty());
    }
    None
}

/// Task 派出去的子代理转录 `agent-transcripts/<父会话>/subagents/<id>.jsonl`(没有 Claude 那样的
/// meta 边车),返回父会话的目录
fn subagent_parent_dir(path: &Path) -> Option<&Path> {
    let dir = path.parent()?;
    if dir.file_name()? != "subagents" {
        return None;
    }
    let session = dir.parent()?;
    (session.parent()?.file_name()? == "agent-transcripts").then_some(session)
}

/// 子代理所在会话的原生 id:会话目录的名字(`AgentAdapter::parent_in_path`)
fn subagent_parent(path: &Path) -> Option<String> {
    Some(
        subagent_parent_dir(path)?
            .file_name()?
            .to_string_lossy()
            .into_owned(),
    )
}

/// 父会话的子代理(subagents/ 里的转录,各自也作为子会话入库)。派它的调用对上了(见
/// `Dispatch`)就挂上跳转,任务说明与类型也从那次调用取;子代理自己下面没有 subagents/,给空
fn link_dispatches(
    r: &SessionFileRef,
    mainline: &mut [TranscriptMessage],
    dispatches: &[Dispatch],
) -> Vec<SidechainInfo> {
    let Ok(entries) = fs::read_dir(subagents_dir(r)) else {
        return Vec::new();
    };
    let by_prompt = dispatches
        .iter()
        .any(|d| d.resume.is_none() && d.prompt.is_some());
    let mut sidechains = Vec::new();
    let mut firsts = Vec::new();
    for path in entries.flatten().map(|entry| entry.path()) {
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        if let Some(info) = sidechain_info(&path) {
            firsts.push(by_prompt.then(|| first_query(&path)).flatten());
            sidechains.push(info);
        }
    }
    // 头一回派的按第一句对,只认一对一:同一句话派了两次、或两个子代理收到的第一句相同,分不清
    // 谁是谁,不挂跳转——挂了就是几个按钮都指向枚举到的最后一个(Codex review 2026-10-12)
    let mut fresh: HashMap<&str, usize> = HashMap::new();
    for prompt in dispatches
        .iter()
        .filter(|d| d.resume.is_none())
        .filter_map(|d| d.prompt.as_deref())
    {
        *fresh.entry(prompt).or_default() += 1;
    }
    let mut received: HashMap<&str, Option<usize>> = HashMap::new();
    for (ix, first) in firsts.iter().enumerate() {
        if let Some(first) = first.as_deref() {
            received
                .entry(first)
                .and_modify(|only| *only = None)
                .or_insert(Some(ix));
        }
    }
    for d in dispatches {
        // 接着派的按 resume 点名,只认它:它的 prompt 是接着说的话,恰好与另一个子代理的第一句
        // 相同时会对上两个
        let sent = match (&d.resume, d.prompt.as_deref()) {
            (Some(resume), _) => sidechains.iter().position(|info| info.id == *resume),
            (None, Some(prompt)) if fresh.get(prompt) == Some(&1) => {
                received.get(prompt).copied().flatten()
            }
            _ => None,
        };
        let Some(info) = sent.map(|ix| &mut sidechains[ix]) else {
            continue;
        };
        if let Some(call) = mainline
            .get_mut(d.message)
            .and_then(|m| m.tool_calls.get_mut(d.call))
        {
            call.child_id = info.session_id.clone();
        }
        info.description = info.description.take().or_else(|| d.description.clone());
        info.agent_type = info.agent_type.take().or_else(|| d.agent_type.clone());
    }
    sidechains
}

fn subagents_dir(r: &SessionFileRef) -> PathBuf {
    Path::new(&r.file_path)
        .parent()
        .unwrap_or(Path::new("."))
        .join("subagents")
}

fn resolve_project_path(
    r: &SessionFileRef,
    metadata: Option<&cursor_ide::ProjectMetadata>,
) -> String {
    if let Some(workspace) = metadata.and_then(|m| m.workspace.as_ref()) {
        return workspace.clone();
    }
    // …/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl → slug(子代理的转录再深一层)
    let Some(slug) = Path::new(&r.file_path)
        .ancestors()
        .find(|d| {
            d.file_name()
                .is_some_and(|name| name == "agent-transcripts")
        })
        .and_then(|d| d.parent()?.file_name())
    else {
        return String::new();
    };
    let slug = slug.to_string_lossy();
    // A Git root is not necessarily the workspace. Only let it disambiguate
    // spaces/hyphens when the entire path encodes to this transcript's slug.
    if let Some(repo) = metadata.and_then(|m| {
        m.repositories.iter().find(|path| {
            path.trim_start_matches(['/', '\\'])
                .replace(['/', '\\', ' '], "-")
                == slug
        })
    }) {
        return repo.clone();
    }
    decode_slug(&slug)
}

/// 这个 transcript 只有回合标记、没有任何对话行吗?
///
/// IDE 面板里跑的会话在这里只留 `{"type":"turn_ended"}`,正文全在
/// `state.vscdb`(cursor_ide.rs 读)。两源同 native_id,而 Cursor 是**回合结束
/// 之后**才写 turn_ended——空壳的 mtime 必然晚于库里的 lastUpdatedAt,scanner
/// 的 mtime 裁决会让空壳稳赢,于是 IDE 会话在列表里显示成 0 条消息。空壳压根
/// 不是一个会话,枚举阶段就不该让它参与竞争。
///
/// 判据是"有没有 `"role"` 字段":CLI 会话每一行都是 `{"role":…}`,IDE 空壳
/// 只有 turn_ended。
///
/// **不设文件大小上限**:空壳按每回合一行(约 40 字节)增长,长会话的空壳
/// 可以很大——"大文件必有正文"是经验观测、不是结构保证,拿它当早退条件会让
/// 恰好最长最活跃的那些 IDE 会话重新落回 0 消息(2026-09-14 review)。改为
/// 流式扫描、命中即停:带正文的文件首行就命中(代价与读定长前缀相同),
/// 只有纯空壳才会读到尾,而它每行都是同一个短标记、总量本就小。
fn is_turn_marker_only(path: &Path) -> bool {
    /// 一次读一块,跨块边界靠保留尾巴(见下)
    const CHUNK: usize = 16 * 1024;
    /// 跨块保留的字节数:必须 ≥ needle 长度 - 1,否则骑在块边界上的
    /// `"role"` 会被劈成两半、两块都不命中
    const NEEDLE: &[u8] = b"\"role\"";

    let Ok(file) = fs::File::open(path) else {
        // 读不到就别替它下结论,交给解析阶段
        return false;
    };
    let mut reader = std::io::BufReader::with_capacity(CHUNK, file);
    let mut window: Vec<u8> = Vec::with_capacity(CHUNK + NEEDLE.len());
    loop {
        let start = window.len();
        window.resize(start + CHUNK, 0);
        let read = match std::io::Read::read(&mut reader, &mut window[start..]) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return false,
        };
        window.truncate(start + read);
        if window.windows(NEEDLE.len()).any(|w| w == NEEDLE) {
            return false;
        }
        // 只留够拼出跨界 needle 的尾巴,其余丢弃——整文件不进内存
        let keep = window.len().saturating_sub(NEEDLE.len() - 1);
        window.drain(..keep);
    }
    true
}

impl AgentAdapter for CursorAdapter {
    fn agent(&self) -> AgentId {
        AgentId::Cursor
    }

    fn list_session_files(&self) -> Result<Vec<SessionFileRef>> {
        let mut refs = Vec::new();
        let Ok(projects) = fs::read_dir(&self.root) else {
            return Ok(refs);
        };
        for project in projects.flatten() {
            let transcripts = project.path().join("agent-transcripts");
            let Ok(sessions) = fs::read_dir(&transcripts) else {
                continue;
            };
            for session in sessions.flatten() {
                // 会话自己的转录,与它派出去的子代理(子会话);判据与监听同一个 file_ref
                let dir = session.path();
                let files = |dir: &Path| -> Vec<PathBuf> {
                    fs::read_dir(dir)
                        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
                        .unwrap_or_default()
                };
                refs.extend(
                    files(&dir)
                        .iter()
                        .chain(&files(&dir.join("subagents")))
                        .filter_map(|path| self.file_ref(path)),
                );
            }
        }
        Ok(refs)
    }

    fn file_ref(&self, path: &Path) -> Option<SessionFileRef> {
        // 会话转录 `agent-transcripts/<会话>/<会话>.jsonl` 与子代理转录 `…/<会话>/subagents/<id>.jsonl`。
        // 按路径分段判:Windows 的反斜杠路径一样认
        if path.parent()?.parent()?.file_name()? != "agent-transcripts"
            && subagent_parent_dir(path).is_none()
        {
            return None;
        }
        let r = default_file_ref(self.agent(), path)?;
        // 与枚举同一判据:IDE 会话每个回合都会 append 一行 turn_ended,
        // 这里不挡的话 watcher 会把空壳一次次写回,压掉 cursor_ide 的正文
        if is_turn_marker_only(path) {
            return None;
        }
        Some(r)
    }

    fn session_paths(&self, meta: &SessionMeta) -> Vec<String> {
        // 子代理只有它自己那份转录
        if subagent_parent_dir(Path::new(&meta.file_path)).is_some() {
            return vec![meta.file_path.clone()];
        }
        // 会话是 <uuid>/ 整个目录(含 subagents/),删除时整目录进废纸篓
        Path::new(&meta.file_path)
            .parent()
            .map(|d| vec![d.to_string_lossy().to_string()])
            .unwrap_or_else(|| vec![meta.file_path.clone()])
    }

    fn parse_session(&self, r: &SessionFileRef) -> Result<ParsedSession> {
        let parsed = parse_cursor_jsonl(Path::new(&r.file_path), false)?;
        let meta = self.build_meta(r, &parsed);
        Ok(ParsedSession::derive(
            meta,
            &parsed.messages,
            parsed.unknown_lines,
        ))
    }

    fn parse_transcript(&self, r: &SessionFileRef) -> Result<ParsedTranscript> {
        let mut parsed = parse_cursor_jsonl(Path::new(&r.file_path), true)?;
        let meta = self.build_meta(r, &parsed);
        let mut mainline = std::mem::take(&mut parsed.messages);
        let sidechains = link_dispatches(r, &mut mainline, &parsed.dispatches);
        Ok(ParsedTranscript {
            meta,
            mainline,
            sidechains,
            unknown_line_count: parsed.unknown_lines,
        })
    }

    fn load_sidechain(
        &self,
        r: &SessionFileRef,
        sidechain_id: &str,
    ) -> Result<Vec<TranscriptMessage>> {
        let file = subagents_dir(r).join(format!("{sidechain_id}.jsonl"));
        if !file.is_file() {
            return Ok(Vec::new());
        }
        Ok(parse_cursor_jsonl(&file, true)?.messages)
    }

    fn cleanup_paths(&self, meta: &SessionMeta) -> Option<Vec<String>> {
        Some(self.session_paths(meta))
    }

    /// 子代理挂到派它的会话下面:转录在派它的会话目录里,目录名就是那个会话的 id。IDE 库那一路
    /// 另报 composer 记的关系
    fn parent_in_path(&self) -> Option<super::ParentInPath> {
        Some(subagent_parent)
    }

    fn list_memories(
        &self,
        sources: &[MemorySource],
        projects: &[PathBuf],
    ) -> Result<Vec<MemoryDoc>> {
        // 只有项目指令文件与用户加的自定义来源;trait 默认实现没处放缓存、每轮都重读
        super::generic_memory_docs(&self.memories, AgentId::Cursor, sources, projects)
    }

    fn with_custom_root(&self, dir: PathBuf) -> Box<dyn AgentAdapter> {
        // 选中 `~/.cursor` 形态(含 projects/)或直接选中 projects 目录都认
        let root = if dir.join("projects").is_dir() {
            dir.join("projects")
        } else {
            dir
        };
        Box::new(Self {
            root,
            // 自定义目录也用于远程缓存,不能混用本机 IDE 元数据。
            metadata_db: None,
            memories: super::MemoryCache::new(),
        })
    }

    fn data_roots(&self) -> Vec<PathBuf> {
        // 空根 = 本条 location 已被用户移除(见 excluding_data_roots)
        if self.root.as_os_str().is_empty() {
            Vec::new()
        } else {
            vec![self.root.clone()]
        }
    }

    /// IDE 库里的 composer 可能比转录的最后一次写入还晚落盘:项目与模型每轮扫描都按它
    /// 刷一遍,转录没变也跟上(与解析时借的是同一份,不会来回翻)
    fn sidecar_updates(
        &self,
        refs: &[SessionFileRef],
    ) -> std::collections::HashMap<String, SidecarMeta> {
        if refs.is_empty() {
            return Default::default();
        }
        let facts = self.metadata_db.as_deref().and_then(|db| {
            cursor_ide::composer_facts(db, refs.iter().map(|r| r.native_id.as_str()))
        });
        let Some(facts) = facts else {
            return Default::default();
        };
        refs.iter()
            .filter_map(|r| {
                let f = facts.get(&r.native_id)?;
                let update = SidecarMeta {
                    project: f.project.as_ref().map(|p| resolve_project_path(r, Some(p))),
                    model: f.model.clone(),
                };
                Some((r.file_path.clone(), update))
            })
            .collect()
    }

    /// Cursor 一家两源(本实例的 agent-transcripts 与 cursor_ide 的 state.vscdb),
    /// 彼此独立:移除其一不该连带关掉另一个。与 cursor_ide 成对,两边必须同时
    /// 开启——只开一边的话,面板对另一边的 Remove 仍会按 agent 整家压制
    fn supports_individual_root_removal(&self) -> bool {
        true
    }

    /// 单根实例:被排除的是自己的根就交出空根实例(roster 丢弃它);
    /// 排除列表里是另一个源的根时返回 None(与我无关,原样保留)
    fn excluding_data_roots(&self, roots: &[PathBuf]) -> Option<Box<dyn AgentAdapter>> {
        if roots.contains(&self.root) {
            Some(Box::new(Self {
                root: PathBuf::new(),
                metadata_db: None,
                memories: super::MemoryCache::new(),
            }))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        let mut f = fs::File::create(&p).expect("write fixture");
        f.write_all(body.as_bytes()).expect("write body");
        p
    }

    fn metadata_fixture(data: &str) -> (tempfile::TempDir, CursorAdapter, SessionFileRef) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        let session_dir = root.join("wakefx-My-Project/agent-transcripts/session");
        fs::create_dir_all(&session_dir).unwrap();
        let file = write(
            &session_dir,
            "session.jsonl",
            r#"{"role":"user","message":{"content":[{"type":"text","text":"Transcript body"}]}}"#,
        );
        let db = dir.path().join("state.vscdb");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)")
            .unwrap();
        conn.execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:session', ?1)",
            [data],
        )
        .unwrap();
        let adapter = CursorAdapter {
            root,
            metadata_db: Some(db),
            memories: crate::adapters::MemoryCache::new(),
        };
        let r = adapter.file_ref(&file).unwrap();
        (dir, adapter, r)
    }

    #[test]
    fn transcript_prefers_matching_metadata_and_keeps_its_body() {
        for data in [
            r#"{"workspaceIdentifier":{"uri":{"fsPath":"/wakefx/My Project"}},"trackedGitRepos":[{"repoPath":"/wrong/repo"}]}"#,
            r#"{"workspaceIdentifier":{"uri":{"fsPath":""}},"trackedGitRepos":[{"repoPath":"/wakefx/My Project"}]}"#,
            r#"{"trackedGitRepos":[{"repoPath":"/wakefx/My Project"}]}"#,
            r#"{"trackedGitRepos":[{"repoPath":"/other/repo"},{"repoPath":"/wakefx/My Project"}]}"#,
        ] {
            let (_dir, adapter, r) = metadata_fixture(data);
            let session = adapter.parse_session(&r).unwrap();
            let transcript = adapter.parse_transcript(&r).unwrap();
            for meta in [&session.meta, &transcript.meta] {
                assert_eq!(meta.project_path, "/wakefx/My Project");
                assert_eq!(meta.project_name, "My Project");
                assert_eq!(meta.file_path, r.file_path);
                assert_eq!(meta.title, "Transcript body");
            }
            assert_eq!(session.units.len(), 1);
            assert_eq!(transcript.mainline.len(), 1);
            assert_eq!(transcript.mainline[0].text, "Transcript body");
        }
    }

    #[test]
    fn transcript_falls_back_when_metadata_is_unavailable() {
        for data in [
            "{}",
            r#"{"workspaceIdentifier":{"uri":{"fsPath":""}}}"#,
            r#"{"trackedGitRepos":[{"repoPath":"/wakefx"}]}"#,
            "{broken",
        ] {
            let (_dir, adapter, r) = metadata_fixture(data);
            assert_eq!(
                adapter.parse_session(&r).unwrap().meta.project_path,
                "/wakefx/My/Project"
            );
        }

        let (dir, mut adapter, mut r) =
            metadata_fixture(r#"{"workspaceIdentifier":{"uri":{"fsPath":"/wrong/session"}}}"#);
        r.native_id = "unmapped".into();
        assert_eq!(
            adapter.parse_session(&r).unwrap().meta.project_path,
            "/wakefx/My/Project"
        );
        r.native_id = "session".into();
        adapter.metadata_db = Some(dir.path().join("missing.vscdb"));
        assert_eq!(
            adapter.parse_transcript(&r).unwrap().meta.project_path,
            "/wakefx/My/Project"
        );
    }

    #[cfg(unix)]
    #[test]
    fn repository_root_does_not_replace_existing_subdirectory_workspace() {
        let (dir, adapter, mut r) = metadata_fixture("{}");
        let repo = dir.path().join("repo");
        let project = repo.join("apps/client");
        fs::create_dir_all(&project).unwrap();
        let slug = project
            .to_str()
            .unwrap()
            .trim_start_matches('/')
            .replace('/', "-");
        let session_dir = adapter.root.join(slug).join("agent-transcripts/session");
        fs::create_dir_all(&session_dir).unwrap();
        let file = session_dir.join("session.jsonl");
        fs::rename(&r.file_path, &file).unwrap();
        r = adapter.file_ref(&file).unwrap();
        let conn = rusqlite::Connection::open(adapter.metadata_db.as_ref().unwrap()).unwrap();
        conn.execute(
            "UPDATE cursorDiskKV SET value = ?1 WHERE key = 'composerData:session'",
            [serde_json::json!({"trackedGitRepos": [{"repoPath": repo}]}).to_string()],
        )
        .unwrap();

        assert_eq!(
            adapter.parse_session(&r).unwrap().meta.project_path,
            project.to_str().unwrap()
        );
        assert_eq!(
            adapter.parse_transcript(&r).unwrap().meta.project_path,
            project.to_str().unwrap()
        );
    }

    #[test]
    fn metadata_updates_refresh_index_without_reparsing_transcript() {
        use crate::db::Store;
        use crate::mcp::tools::{self, TranscriptCache};
        use crate::scanner::{run_scan, NullEvents, ScanEvents, ScanProgress};
        use std::sync::{Arc, Mutex};

        #[derive(Default)]
        struct Events(Mutex<usize>, Mutex<usize>);
        impl ScanEvents for Events {
            fn on_progress(&self, progress: &ScanProgress) {
                *self.0.lock().unwrap() = progress.total;
            }
            fn on_sessions_changed(&self) {
                *self.1.lock().unwrap() += 1;
            }
        }

        let (dir, adapter, r) = metadata_fixture("{}");
        let metadata_db = adapter.metadata_db.clone().unwrap();
        let root = adapter.root.clone();
        let index = dir.path().join("wake.db");
        let adapters: Vec<Box<dyn AgentAdapter>> = vec![Box::new(adapter)];
        let store = Arc::new(Store::open(&index).unwrap());
        run_scan(&adapters, &store, &NullEvents, false).unwrap();
        let before = store.get_session("cursor:session").unwrap().unwrap();
        assert_eq!(before.project_path, "/wakefx/My/Project");
        let known = store.known_files().unwrap();
        let cache = TranscriptCache::default();
        let args = serde_json::json!({"key": "cursor:session"});
        assert!(
            tools::invoke(&store, &adapters, &cache, tools::GET_SESSION, &args)
                .unwrap()
                .contains("/wakefx/My/Project")
        );

        // Keep the writer open: the new metadata exists only in WAL, while the
        // transcript and the main database's modification time stay unchanged.
        let writer = rusqlite::Connection::open(&metadata_db).unwrap();
        writer.pragma_update(None, "journal_mode", "WAL").unwrap();
        let db_mtime = fs::metadata(&metadata_db).unwrap().modified().unwrap();
        writer
            .execute(
                "UPDATE cursorDiskKV SET value = ?1 WHERE key = 'composerData:session'",
                [r#"{"workspaceIdentifier":{"uri":{"fsPath":"/wakefx/My Project"}}}"#],
            )
            .unwrap();
        assert_eq!(
            fs::metadata(&metadata_db).unwrap().modified().unwrap(),
            db_mtime
        );
        assert_eq!(
            adapters[0]
                .file_ref(Path::new(&r.file_path))
                .unwrap()
                .mtime_ms,
            r.mtime_ms
        );
        let events = Events::default();
        run_scan(&adapters, &store, &events, false).unwrap();
        let after = store.get_session("cursor:session").unwrap().unwrap();
        assert_eq!(after.project_path, "/wakefx/My Project");
        assert_eq!(after.project_name, "My Project");
        assert_eq!(after.title, before.title);
        assert_eq!(after.message_count, before.message_count);
        assert_eq!(after.file_path, before.file_path);
        assert_eq!(store.known_files().unwrap(), known);
        let shown = tools::invoke(&store, &adapters, &cache, tools::GET_SESSION, &args).unwrap();
        assert!(
            shown.contains("/wakefx/My Project"),
            "cached query still has old project: {shown}"
        );
        assert!(!shown.contains("/wakefx/My/Project"));
        assert_eq!(*events.0.lock().unwrap(), 0, "no transcript reparsing");
        assert_eq!(
            *events.1.lock().unwrap(),
            1,
            "notify the UI of the new project"
        );
        let conn = rusqlite::Connection::open(&index).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT text FROM messages_fts WHERE messages_fts MATCH 'Transcript'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "Transcript body"
        );

        let unchanged = Events::default();
        run_scan(&adapters, &store, &unchanged, false).unwrap();
        assert_eq!(
            *unchanged.1.lock().unwrap(),
            0,
            "unchanged metadata is a no-op"
        );
        drop(store);

        // A new process/adapter must also notice later metadata changes.
        writer
            .execute(
                "UPDATE cursorDiskKV SET value = ?1 WHERE key = 'composerData:session'",
                [r#"{"workspaceIdentifier":{"uri":{"fsPath":"/wakefx/Relocated Project"}}}"#],
            )
            .unwrap();
        let store = Arc::new(Store::open(&index).unwrap());
        let adapters: Vec<Box<dyn AgentAdapter>> = vec![Box::new(CursorAdapter {
            root,
            metadata_db: Some(metadata_db),
            memories: crate::adapters::MemoryCache::new(),
        })];
        let events = Events::default();
        run_scan(&adapters, &store, &events, false).unwrap();
        assert_eq!(
            store
                .get_session("cursor:session")
                .unwrap()
                .unwrap()
                .project_path,
            "/wakefx/Relocated Project"
        );
        assert_eq!(*events.0.lock().unwrap(), 0);
        // A temporary read/JSON failure must not erase a known project path.
        writer
            .execute("UPDATE cursorDiskKV SET value = '{broken'", [])
            .unwrap();
        run_scan(&adapters, &store, &NullEvents, false).unwrap();
        assert_eq!(
            store
                .get_session("cursor:session")
                .unwrap()
                .unwrap()
                .project_path,
            "/wakefx/Relocated Project"
        );
    }

    #[test]
    fn upgrade_refreshes_existing_cursor_project_without_source_changes() {
        use crate::db::Store;
        use crate::scanner::{run_scan, NullEvents};
        use std::sync::Arc;

        let (dir, adapter, r) =
            metadata_fixture(r#"{"workspaceIdentifier":{"uri":{"fsPath":"/wakefx/My Project"}}}"#);
        let index = dir.path().join("upgrade.db");
        let mut old = adapter.parse_session(&r).unwrap();
        old.meta.project_path = "/wakefx/My/Project".into();
        old.meta.project_name = "Project".into();
        {
            let store = Store::open(&index).unwrap();
            store
                .write_session(&old.meta, r.mtime_ms, &old.units)
                .unwrap();
        }
        rusqlite::Connection::open(&index)
            .unwrap()
            .execute(
                "UPDATE schema_meta SET value = '3' WHERE key = 'fts_format'",
                [],
            )
            .unwrap();
        let store = Arc::new(Store::open(&index).unwrap());
        assert!(store.needs_fts_reindex());
        run_scan(&[Box::new(adapter)], &store, &NullEvents, false).unwrap();
        assert_eq!(
            store
                .get_session("cursor:session")
                .unwrap()
                .unwrap()
                .project_path,
            "/wakefx/My Project"
        );
        assert!(!store.needs_fts_reindex());
    }

    #[test]
    fn project_refresh_only_updates_the_unchanged_winning_copy() {
        use crate::db::Store;

        let (dir, adapter, r) =
            metadata_fixture(r#"{"workspaceIdentifier":{"uri":{"fsPath":"/wakefx/My Project"}}}"#);
        let parsed = adapter.parse_session(&r).unwrap();
        let updates = adapter.sidecar_updates(std::slice::from_ref(&r));
        for case in ["unchanged", "newer", "resized", "other-copy", "child"] {
            let index = dir.path().join(format!("{case}.db"));
            let store = Store::open(&index).unwrap();
            let mut saved = parsed.meta.clone();
            saved.project_path = "/saved/project".into();
            saved.project_name = "project".into();
            let mtime = if case == "newer" {
                r.mtime_ms + 1
            } else {
                r.mtime_ms
            };
            if case == "resized" {
                saved.size_bytes += 1;
            }
            if case == "other-copy" {
                saved.file_path.push_str(".copy");
            }
            store.write_session(&saved, mtime, &parsed.units).unwrap();
            if case == "child" {
                rusqlite::Connection::open(&index)
                    .unwrap()
                    .execute("UPDATE sessions SET parent_key = 'cursor:parent'", [])
                    .unwrap();
            }
            let changed = store
                .update_sidecar_meta(std::slice::from_ref(&r), &updates)
                .unwrap();
            assert_eq!(changed, case == "unchanged", "{case}");
            let after = store.get_session(&saved.key).unwrap().unwrap();
            assert_eq!(
                after.project_path,
                if changed {
                    "/wakefx/My Project"
                } else {
                    "/saved/project"
                },
                "{case}"
            );
            assert_eq!(after.file_path, saved.file_path);
        }
    }

    #[test]
    fn sidecar_refresh_fills_the_model_without_clearing_it() {
        use crate::db::Store;

        // composer 比转录的最后一次写入还晚落盘:解析那一刻借不到模型,之后每轮扫描的
        // 侧档刷新补上;侧档不知道模型时(Auto 档、读不出来)不清掉库里已有的
        let (dir, adapter, r) =
            metadata_fixture(r#"{"modelConfig":{"modelName":"claude-4.5-sonnet"}}"#);
        let parsed = adapter.parse_session(&r).unwrap();
        assert_eq!(parsed.meta.model.as_deref(), Some("claude-4.5-sonnet"));
        let store = Store::open(&dir.path().join("index.db")).unwrap();
        let mut saved = parsed.meta.clone();
        saved.model = None;
        store
            .write_session(&saved, r.mtime_ms, &parsed.units)
            .unwrap();
        let model = || store.get_session(&saved.key).unwrap().unwrap().model;

        let updates = adapter.sidecar_updates(std::slice::from_ref(&r));
        assert!(store
            .update_sidecar_meta(std::slice::from_ref(&r), &updates)
            .unwrap());
        assert_eq!(model().as_deref(), Some("claude-4.5-sonnet"));

        let unknown =
            std::collections::HashMap::from([(r.file_path.clone(), SidecarMeta::default())]);
        assert!(!store
            .update_sidecar_meta(std::slice::from_ref(&r), &unknown)
            .unwrap());
        assert_eq!(model().as_deref(), Some("claude-4.5-sonnet"));
    }

    #[test]
    fn custom_root_does_not_use_default_project_metadata() {
        let (_dir, adapter, r) =
            metadata_fixture(r#"{"workspaceIdentifier":{"uri":{"fsPath":"/local/My Project"}}}"#);
        let custom = adapter.with_custom_root(adapter.root.clone());
        assert_eq!(
            custom.parse_session(&r).unwrap().meta.project_path,
            "/wakefx/My/Project"
        );
        assert_eq!(
            custom.parse_transcript(&r).unwrap().meta.project_path,
            "/wakefx/My/Project"
        );
        assert!(custom.sidecar_updates(std::slice::from_ref(&r)).is_empty());
    }

    #[test]
    fn slug_decoder_recovers_existing_directory_with_spaces() {
        let dir = tempfile::tempdir().expect("tempdir");
        for (name, slug) in [
            ("My Project", "My-Project"),
            ("My Project/source-code", "My-Project-source-code"),
        ] {
            let project = dir.path().join(name);
            fs::create_dir_all(&project).unwrap();
            assert_eq!(
                decode_existing_slug(dir.path().to_path_buf(), slug),
                Some(project)
            );
        }
    }

    #[test]
    fn slug_decoder_prefers_literal_hyphen_when_ambiguous() {
        for (slug, alternative) in [
            ("image-translate", "image translate"),
            ("image-translate-src", "image translate/src"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let literal = dir.path().join(slug);
            fs::create_dir(&literal).unwrap();
            fs::create_dir_all(dir.path().join(alternative)).unwrap();
            assert_eq!(
                decode_existing_slug(dir.path().to_path_buf(), slug),
                Some(literal)
            );
        }
    }

    #[test]
    fn slug_decoder_respects_filesystem_case_matching() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Mixed-Case")).unwrap();
        let path = dir.path().join("mixed-case");
        assert_eq!(
            decode_existing_slug(dir.path().to_path_buf(), "mixed-case"),
            path.is_dir().then_some(path)
        );
    }

    #[cfg(unix)]
    #[test]
    fn slug_decoder_does_not_require_parent_read_permission() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("my-project");
        fs::create_dir(&project).unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o111)).unwrap();
        let decoded = decode_existing_slug(dir.path().to_path_buf(), "my-project");
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(decoded, Some(project));
    }

    /// 判据必须与文件大小无关。曾经的实现对 >64KB 的文件直接判"有正文"
    /// 早退——空壳按每回合一行增长,约 1600 轮后就会越过这条线,于是
    /// **恰好最长最活跃**的那些 IDE 会话重新落回 0 消息(2026-09-14 review)
    #[test]
    fn oversized_stub_is_still_a_stub() {
        let dir = tempfile::tempdir().expect("tempdir");
        let line = "{\"type\":\"turn_ended\",\"status\":\"success\"}\n";
        let huge: String = line.repeat(3000); // ~120KB,远超任何定长探测窗口
        assert!(huge.len() > 100 * 1024, "这个用例要的就是超大空壳");
        let p = write(dir.path(), "huge-stub.jsonl", &huge);
        assert!(
            is_turn_marker_only(&p),
            "空壳不因体积变大就变成会话——这正是回归点"
        );
    }

    /// 正文判定要命中就停:首行即 role 的常规会话、以及正文远在文件深处
    /// (前面堆了大量回合标记)的会话,都必须被认成真会话
    #[test]
    fn any_role_line_means_real_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        let role = "{\"role\":\"user\",\"message\":{\"content\":[]}}\n";
        let marker = "{\"type\":\"turn_ended\",\"status\":\"success\"}\n";

        let head = write(dir.path(), "head.jsonl", &format!("{role}{marker}"));
        assert!(!is_turn_marker_only(&head), "首行即 role");

        // role 藏在 100KB 标记之后:定长窗口的实现会漏判,流式扫描不会
        let deep = write(
            dir.path(),
            "deep.jsonl",
            &format!("{}{role}", marker.repeat(2600)),
        );
        assert!(!is_turn_marker_only(&deep), "正文在深处也算真会话");
    }

    /// `"role"` 骑在读块边界上时不能被劈成两半漏掉。构造:让 needle 的
    /// 起点正好落在 CHUNK 前一字节处
    #[test]
    fn needle_across_chunk_boundary_is_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chunk = 16 * 1024;
        for offset in [chunk - 3, chunk - 1, chunk, chunk + 1] {
            let mut body = "x".repeat(offset);
            body.push_str("{\"role\":\"user\"}");
            let p = write(dir.path(), &format!("edge-{offset}.jsonl"), &body);
            assert!(
                !is_turn_marker_only(&p),
                "needle 起点在 {offset} 字节处(跨块)也必须命中"
            );
        }
    }

    /// 截断成 `{"role":` 的转录过得了空壳判定,却一条消息都解不出:必须按解析
    /// 失败报出去,scanner 才会回退到 IDE 库副本,而不是让零消息的坏文件胜出
    #[test]
    fn truncated_transcript_is_a_parse_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let truncated = write(dir.path(), "truncated.jsonl", "{\"role\":\n");
        assert!(!is_turn_marker_only(&truncated), "含 role 字样,不是空壳");
        assert!(
            parse_cursor_jsonl(&truncated, false).is_err(),
            "零消息 + 坏行 = 解析失败"
        );
        // 有消息就照常成功——尾部一条坏行只计 unknown,不推翻整个会话
        let intact = write(
            dir.path(),
            "intact.jsonl",
            "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n{\"role\":\n",
        );
        let parsed = parse_cursor_jsonl(&intact, false).expect("有正文的转录照常解析");
        assert_eq!(parsed.messages.len(), 1);
        assert_eq!(parsed.unknown_lines, 1);
    }

    /// 读不到的文件不下结论:判为"非空壳"交给解析阶段,
    /// 绝不能因为打不开就把一个真会话从索引里抹掉
    #[test]
    fn unreadable_file_is_not_judged_a_stub() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(!is_turn_marker_only(
            &dir.path().join("does-not-exist.jsonl")
        ));
    }
}
