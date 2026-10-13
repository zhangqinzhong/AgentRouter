use super::parse_utils::*;
use super::AgentAdapter;
use crate::models::*;
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// DeepSeek Harness(dsh):`~/.dsh/sessions/--<cwd转义>--/<id转义>/<日志>`,一目录一会话。
/// 日志文件名带**格式代数**:v0 是 `session.jsonl[.zstd]`,之后每代 `session.vN.jsonl[.zstd]`
/// (issue #45:0.1.6 起写 v3,master 已在写 v4)。dsh 迁移只新增下一代文件、不删旧代,
/// 读的永远是编号最大的那一代——`session_log` 单点裁决。默认落盘是 zstd **多帧连接**
/// (首帧 header 行,之后每次 append 一帧),标准流式解码到 EOF 即可;`compression: none`
/// 配置则是纯文本 .jsonl,两种后缀都认。首行 {type:"session",version,id,createdAt,cwd,…}
/// 给权威 id/cwd/created,不反推目录名。origin=="subagent" 或 delegationDepth>0 是委派出去的
/// 子代理会话(issue #63):照常收录,经首行的 parentSession 挂到派它的会话下面。fork 出来的会话
/// (fork 后端派的子代理、用户自己 fork 的)开头原样复制了父会话到截点为止的事件,截点是最后一个
/// `session/end-seed {inherited: true}`,之前的折成一条、标题 / 模型 / 用量只算之后的。
/// 事件行 {type,seq,time,data}:assistant/message 是一次模型调用的合成体
/// (v0/v1 的 assistant/chunk 与其打包行 *-chunks 直接跳过,v2 起流嵌在消息里),tool/result
/// 按 toolCallId 回填(v0–v3 包在一个 tool-result 块里,v4 直接挂在 tool 角色消息上),
/// system/message(v3 起系统提示在对话里)与 developer/message(v4)归 Meta,session/title
/// 事件 last-wins 给标题,model 在 assistant 消息的 source 里。
pub struct DshAdapter {
    root: PathBuf,
    /// 会话目录 → 最近一次读出来的(日志引用, 父会话 id)。列表、file_ref 与每批监听都问的
    /// parent_links 都要首行里的 id 与 parentSession:首行写下就不变,同一份日志只解压一次,追加
    /// 之后只 stat 选代;换了一代、换了压缩格式才再读一次。目录一时列不出、新的那份一时打不开
    /// (权限、锁)交回上次读到的
    logs: Mutex<HashMap<PathBuf, (SessionFileRef, Option<String>)>>,
}

impl DshAdapter {
    pub fn new() -> Self {
        Self::at(
            super::home_dir()
                .unwrap_or_default()
                .join(".dsh")
                .join("sessions"),
        )
    }

    fn at(root: PathBuf) -> Self {
        Self {
            root,
            logs: Mutex::new(HashMap::new()),
        }
    }

    /// `<project-dir>/<session-dir>` 固定两层,不 walkdir 全递归(会话目录里还放别的 artifacts)。
    /// 根不在 = 确定没有;根或某个项目目录在却列不出 = 这一刻不知道(None)——列表据此冻结这一家
    /// 这一轮,parent_links 据此保留库里的关系(当成空的话,一个读不出的目录就让全量扫描把会话
    /// 整批删掉、子代理全打回顶层,2026-10-11 Codex review)
    fn session_dirs(&self) -> Option<Vec<PathBuf>> {
        let listed = |dir: &Path| match fs::read_dir(dir) {
            Ok(entries) => Some(entries.collect::<std::io::Result<Vec<_>>>().ok()?),
            Err(e) if e.kind() == ErrorKind::NotFound => Some(Vec::new()),
            Err(_) => None,
        };
        let is_dir = |entry: &fs::DirEntry| entry.file_type().is_ok_and(|t| t.is_dir());
        let mut dirs = Vec::new();
        for project in listed(&self.root)?.iter().filter(|e| is_dir(e)) {
            let sessions = listed(&project.path())?;
            dirs.extend(sessions.iter().filter(|e| is_dir(e)).map(|e| e.path()));
        }
        Some(dirs)
    }

    /// 会话目录 → (被读的那一代日志的引用, 父会话 id)。日志取 dsh 自己会读的那一份:编号最大的
    /// 一代(迁移只新增、不删旧代,旧代的 mtime 可能更新);同一代压缩与明文并存(换过
    /// compression 配置)时 mtime 新者胜、平局 .zstd 胜。list、watcher(经 file_ref)与
    /// parent_links 共用这一处裁决——只做在 list 会让 watcher 把旧代的事件当主文件解析。首行
    /// header 给权威 id(目录名是转义过的 id)。Ok(None) = 确定不是会话(没有日志、首行不是会话
    /// header);目录列不出、日志打不开(权限、锁)交回上次读到的(见 `logs`),没读到过才报错——
    /// parent_links 据此整份交 None。把读不出当成没有,parent_links 会交出缺一截的关系:A 派 B、
    /// B 派 C,B 一时读不出,C 就从 A 下面挪到 B 下面(2026-10-11 Codex review)
    fn session_log(&self, dir: &Path) -> std::io::Result<Option<(SessionFileRef, Option<String>)>> {
        let last = self.logs.lock().unwrap().get(dir).cloned();
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return last.map(Some).ok_or(e),
        };
        let Some(((_, mtime, _), path, size)) = entries
            .flatten()
            .filter_map(|entry| {
                let (generation, zstd) = log_generation(&entry.file_name().to_string_lossy())?;
                let path = entry.path();
                let (mtime, size) = stat_stamp(&path).filter(|(_, size)| *size > 0)?;
                Some(((generation, mtime, zstd), path, size))
            })
            .max_by_key(|(rank, ..)| *rank)
        else {
            return Ok(None);
        };
        let same_log = last
            .as_ref()
            .is_some_and(|(r, _)| Path::new(&r.file_path) == path);
        let (native_id, parent) = match last {
            Some((r, parent)) if same_log => (r.native_id, parent),
            // 新目录,或者换了一代、换了压缩格式(解压不持锁)。读到过的会话读不出新的那份(打不开、
            // 首帧坏)就交回上一份——旧代原样留着;换到解析不了的新路径的话,旧路径又不在枚举里,
            // 全量扫描会把会话连同搜索记录删掉(2026-10-11 Codex review)
            _ => match read_header(&path) {
                Ok(Some(header)) => (header.id, header.parent),
                Ok(None) => return Ok(last),
                Err(e) => return last.map(Some).ok_or(e),
            },
        };
        let r = SessionFileRef {
            agent: AgentId::Dsh,
            native_id,
            file_path: path.to_string_lossy().into_owned(),
            mtime_ms: mtime,
            size,
        };
        self.logs
            .lock()
            .unwrap()
            .insert(dir.to_path_buf(), (r.clone(), parent.clone()));
        Ok(Some((r, parent)))
    }
}

/// 打开会话日志为行读取器,按后缀透明解压(.zstd = 多帧连接,Decoder 默认解到
/// EOF)。cap 是缓冲尺寸:只读首行的 header 路径用小值,免得每次列举都预读兆级
fn open_log(path: &Path, cap: usize) -> std::io::Result<Box<dyn BufRead>> {
    let file = fs::File::open(path)?;
    if path.extension().is_some_and(|e| e == "zstd") {
        let dec = zstd::stream::read::Decoder::with_buffer(BufReader::with_capacity(cap, file))?;
        Ok(Box::new(BufReader::with_capacity(cap, dec)))
    } else {
        Ok(Box::new(BufReader::with_capacity(cap, file)))
    }
}

struct DshHeader {
    id: String,
    cwd: String,
    created_at: i64,
    /// 委派出去的子代理会话(origin subagent / delegationDepth > 0)
    subagent: bool,
    /// 派出这个子代理会话的会话 id(首行的 parentSession)。用户自己 fork 出来的会话也写
    /// parentSession,但那是一段独立的对话——dsh 自己也只把子代理当成父会话的孩子——不挂
    parent: Option<String>,
    /// v0 / v1 的 fork 截点:首行的 seedLength,seq 小于它的事件是从父会话复制来的(上游 v1→v2
    /// 迁移同一判法,且要带 parentSession);v2 起换成 `session/end-seed {inherited: true}` 标记
    seed_length: Option<i64>,
    /// 开头带着从父会话复制来的一段:v2 起首行的 isSeeded(上游保证这种会话一定有那个截点标记,
    /// 继承段是空的也补一个),v0 / v1 有 seedLength
    seeded: bool,
}

fn parse_header(v: &serde_json::Value) -> Option<DshHeader> {
    if v.get("type").and_then(|t| t.as_str()) != Some("session") {
        return None;
    }
    let id = v.get("id")?.as_str()?.to_string();
    let subagent = v.get("origin").and_then(|o| o.as_str()) == Some("subagent")
        || v.get("delegationDepth")
            .and_then(|d| d.as_i64())
            .unwrap_or(0)
            > 0;
    let forked_from = text_at(v, "parentSession").filter(|p| *p != id);
    let parent = forked_from.filter(|_| subagent).map(String::from);
    let seed_length = forked_from
        .and(v.get("seedLength"))
        .and_then(|n| n.as_i64())
        .filter(|n| *n > 0);
    Some(DshHeader {
        cwd: v
            .get("cwd")
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .to_string(),
        created_at: v.get("createdAt").and_then(|t| t.as_i64()).unwrap_or(0),
        seeded: true_at(v, "isSeeded") || seed_length.is_some(),
        id,
        subagent,
        parent,
        seed_length,
    })
}

/// 只读首行拿 header(zstd 惰性解码,不会解整个文件;非会话日志返回 None)
fn read_header(path: &Path) -> std::io::Result<Option<DshHeader>> {
    // 打不开(权限、锁)是这一刻读不出;打开了却读不出首行(坏帧)当不是会话——重试也好不了,
    // 报错会让 parent_links 一直交 None、关系永远冻住
    let mut reader = match open_log(path, 8 << 10) {
        Ok(reader) => reader,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return Ok(None);
    }
    let header = serde_json::from_str(line.trim_end()).ok();
    Ok(header.as_ref().and_then(parse_header))
}

/// dsh 的事件词汇,照抄上游 `KNOWN_SESSION_EVENT_TYPES`(dsh-session 包的 known-event-types.ts,
/// 生成文件;当前是 v4)。上面有 match 分支的内容事件也在里面——先到先得、这里不会命中;
/// 上游换代时整段替换即可,不用挑
const UPSTREAM_EVENT_TYPES: &[&str] = &[
    "agent-preset/selected",
    "agent/inbox/spliced",
    "approval/asked",
    "approval/decided",
    "approval/policy",
    "assistant/attempt",
    "assistant/message",
    "command/done",
    "command/run",
    "compaction/end",
    "compaction/prune",
    "compaction/start",
    "compaction/summary",
    "deliverables/presented",
    "developer/message",
    "feedback/message-delete",
    "feedback/message-put",
    "feedback/record",
    "goal/change",
    "hook/invoked",
    "hook/result",
    "image/offload",
    "llm/retry",
    "llm/retry-started",
    "model/selection",
    "permission/preset",
    "plan/mode",
    "request/context",
    "request/header",
    "sandbox/mode",
    "schedule/change",
    "session-log-deepseek/delivery-accepted",
    "session/end-seed",
    "session/title",
    "session/title-llm-request",
    "step/end",
    "step/start",
    "subagent/catalog",
    "subagent/descriptor",
    "subagent/model-selection-policy",
    "system/message",
    "team/member",
    "team/message/delivered",
    "team/message/queued",
    "team/task",
    "todo/write",
    "tool-workflow/agent-end",
    "tool-workflow/agent-start",
    "tool-workflow/run-end",
    "tool-workflow/run-start",
    "tool/call",
    "tool/ptc-dispatch",
    "tool/ptc-dispatch-start",
    "tool/result",
    "turn/end",
    "turn/start",
    "user/message",
    "web/deepseek-search-llm-request",
    "workspace/changes",
];

/// 上游清单已经删掉、只在老格式里出现的名字:v0/v1 的 assistant/chunk 与三种 chunk 打包
/// 存储行,v3 前的 tool/code-dispatch*。没被 dsh 重新打开过的老会话不会迁移,照样得认——
/// 只增不减
const LEGACY_EVENT_TYPES: &[&str] = &[
    "assistant/chunk",
    "text-chunks",
    "reasoning-chunks",
    "tool-call-chunks",
    "tool/code-dispatch",
    "tool/code-dispatch-start",
];

/// 已知最新的格式代数。更新的一代照样选中、按形状读,但 header 那一行记一笔 unknown:
/// 字段在已知事件里挪了位置时(v4 的 tool/result 就是),一个事件名都不会漏,只有这一笔
/// 能让 Clean up 知道这个会话读不全
const NEWEST_FORMAT: u64 = 4;

/// 会话日志文件名 → (格式代数, 是否 zstd)。v0 是 `session.jsonl[.zstd]`,之后每代
/// `session.vN.jsonl[.zstd]`(N 从 1 起、不带前导零——`session.v0` / `session.v03` 不是 dsh
/// 会写的名字,认了就会两个名字指同一代);别的文件(session.lock 等)给 None
fn log_generation(name: &str) -> Option<(u32, bool)> {
    let (stem, zstd) = match name.strip_suffix(".zstd") {
        Some(stem) => (stem, true),
        None => (name, false),
    };
    let version = stem.strip_suffix(".jsonl")?.strip_prefix("session")?;
    if version.is_empty() {
        return Some((0, zstd));
    }
    let digits = version.strip_prefix(".v")?;
    if digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((digits.parse().ok()?, zstd))
}

struct DshParse {
    header: Option<DshHeader>,
    title: Option<String>,
    /// 子代理的任务名:`subagent/descriptor` 的 label(派活时那句简短说明),截点之后的第一个
    label: Option<String>,
    last_ts: i64,
    messages: Vec<TranscriptMessage>,
    model: Option<String>,
    tokens_used: Option<i64>,
    unknown_lines: u32,
    /// fork 的截点落在第几条消息上:之前的消息是从父会话原样复制来的
    inherited: Option<usize>,
}

impl DshParse {
    /// 到了 fork 的截点:之前的消息是从父会话复制来的(收尾时折成一条);标题、任务名、模型、
    /// 用量都是父会话的,清零,只算会话自己的
    fn cut(&mut self) {
        self.inherited = Some(self.messages.len());
        self.title = None;
        self.label = None;
        self.model = None;
        self.tokens_used = None;
    }

    /// 还在从父会话复制来的那段里(收尾要折掉):里面的图片不必解码,也别占掉会话自己的解码额度
    fn in_seed(&self) -> bool {
        self.inherited.is_none() && self.header.as_ref().is_some_and(|h| h.seeded)
    }
}

fn parse_dsh_log(path: &Path, decode_images: bool) -> Result<DshParse> {
    let _image_budget = transcript_image_decode_budget(decode_images);
    let reader = open_log(path, 1 << 20)?;

    let mut p = DshParse {
        header: None,
        title: None,
        label: None,
        last_ts: 0,
        messages: Vec::new(),
        model: None,
        tokens_used: None,
        unknown_lines: 0,
        inherited: None,
    };
    // toolCallId → (消息下标, tool_calls 下标),tool/result 事件回填用
    let mut tool_index: HashMap<String, (usize, usize)> = HashMap::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            // 末帧可能是半写的(写端每次 append 一帧,扫描与 dsh 天然并发):
            // zstd decoder 对断尾**反复**返回 UnexpectedEof 而非 EOF,`continue`
            // 就是死循环——扫描线程打满 CPU、ScanFinale 永不 Drop、刷新弹窗按
            // 不变量 6 永久锁死。截断到此为止,已解析的部分照常呈现
            Err(_) => {
                p.unknown_lines += 1;
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<serde_json::Value>(&line) else {
            p.unknown_lines += 1;
            continue;
        };
        let ty = row.get("type").and_then(|v| v.as_str()).unwrap_or_default();
        // 信封顶层的 surfaceOp 是联合类型(dsh-session types.d.ts:
        // `'append' | {op:'replace',start,end}`)——**replace 是对象不是字符串**,
        // 按字符串比永远不命中。compaction 与工具结果裁剪都用它把 start..end 的
        // surface 节点换成缩短版,那是喂模型的上下文;Wake 要还原用户当时看到的
        // 原文,所以整条跳过(留下被它遮蔽的原始节点)。缺失或 append 一律照旧
        if row.pointer("/surfaceOp/op").and_then(|v| v.as_str()) == Some("replace") {
            continue;
        }
        let ts = row.get("time").and_then(|v| v.as_i64()).unwrap_or(0);
        p.last_ts = p.last_ts.max(ts);
        let data = row.get("data").unwrap_or(&serde_json::Value::Null);
        // v0 / v1 没有截点标记:第一个 seq 不小于首行 seedLength 的事件起是会话自己的
        let seed_length = p.header.as_ref().and_then(|h| h.seed_length);
        let seq = row.get("seq").and_then(|v| v.as_i64());
        if p.inherited.is_none() && seed_length.is_some_and(|n| seq.is_some_and(|seq| seq >= n)) {
            p.cut();
        }
        let decode = decode_images && !p.in_seed();
        match ty {
            "session" => {
                if row
                    .get("version")
                    .and_then(|v| v.as_u64())
                    .is_some_and(|v| v > NEWEST_FORMAT)
                {
                    p.unknown_lines += 1;
                }
                if let Some(h) = parse_header(&row) {
                    p.header = Some(h);
                }
            }
            // v3 起系统提示是对话里的一条 system/message;v4 的 developer/message 记会话中途
            // 的变更(工具增删是 tool-addition / tool-removal 块,没有文字)。都是给模型的
            // 上下文、不是对话,归 Meta。图片不解码、只留占位文字:解码了转录那边就只剩图片
            // 没有文字,这条被跳过,之后每条消息的 seq 都和索引错开一位
            "system/message" | "developer/message" => {
                let parsed = content_parts(
                    data.pointer("/message/content")
                        .unwrap_or(&serde_json::Value::Null),
                    false,
                );
                if !parsed.text.is_empty() {
                    p.messages.push(meta_msg(&parsed.text, ts));
                }
            }
            "user/message" => {
                let parsed = content_parts(
                    data.get("content").unwrap_or(&serde_json::Value::Null),
                    decode,
                );
                if parsed.text.is_empty() && parsed.images.is_empty() {
                    continue;
                }
                let kind = data.pointer("/source/kind").and_then(|k| k.as_str());
                let mut m = text_msg(Role::User, &parsed.text, ts);
                m.images = parsed.images;
                // dsh 的 source.kind 权威区分真人输入与注入上下文(实测一族:
                // "agent-instructions"/"plugin"/"skill-catalog",后续还会长)。
                // 白名单 "user":非真人一律归 Meta,缺失时当真人(宁可多显示)
                if kind.is_some_and(|k| k != "user") {
                    m.kind = MessageKind::Meta;
                }
                p.messages.push(m);
            }
            "assistant/message" => {
                let msg = data.get("message").unwrap_or(&serde_json::Value::Null);
                let content = msg.get("content").unwrap_or(&serde_json::Value::Null);
                // 单遍分桶:text 进正文、reasoning 进 thinking、tool-call 进工具
                // (blocks_text 类型盲,会把 reasoning 的 text 混进正文,不适用)
                let mut parsed_message = ParsedContent::default();
                let mut thinking_parts: Vec<&str> = Vec::new();
                let mut tools: Vec<ToolCallView> = Vec::new();
                for b in content.as_array().into_iter().flatten() {
                    let block_text = || {
                        b.get("text")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|t| !t.is_empty())
                    };
                    match b.get("type").and_then(|v| v.as_str()) {
                        Some("text") => {
                            if let Some(text) = block_text() {
                                parsed_message.push_text(text);
                            }
                        }
                        Some("reasoning") => thinking_parts.extend(block_text()),
                        Some("tool-call") => {
                            let id = b.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                            // arguments 是模型原样输出的 JSON 字符串,解析失败保留原文
                            let input = decoded_arguments(
                                b.get("arguments").unwrap_or(&serde_json::Value::Null),
                            );
                            tools.push(tool_call_view(id.to_string(), name, &input, None, false));
                        }
                        _ if is_image_part(b) => {
                            let parsed = content_parts(b, decode);
                            parsed_message.append(parsed);
                        }
                        _ => {}
                    }
                }
                // 元数据先收再判空:content 为空的 assistant/message 是 dsh 专门
                // 用来挂 usage 的载体(dsh-session surface.d.ts:"exists only to
                // host usage",如撞上 max-tokens 的调用),提前 continue 会把这次
                // 调用的 model 与 token 一起丢掉——它落在会话末尾时最明显
                let model = msg
                    .pointer("/source/model")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                if model.is_some() {
                    p.model = model.clone();
                }
                if let Some(u) = data.get("usage") {
                    // TokenUsage 是"one model call"的账、三项 input 互斥(billed =
                    // 三项之和),所以**按调用累加**,不能 last-wins:一个 turn 多个
                    // step,last-wins 只会剩最后一次调用的量
                    let sum = [
                        "inputTokens",
                        "outputTokens",
                        "cacheReadTokens",
                        "cacheWriteTokens",
                    ]
                    .iter()
                    .filter_map(|k| u.get(*k).and_then(|v| v.as_i64()))
                    .sum::<i64>();
                    if sum > 0 {
                        p.tokens_used = Some(p.tokens_used.unwrap_or(0) + sum);
                    }
                }
                if parsed_message.text.is_empty()
                    && tools.is_empty()
                    && thinking_parts.is_empty()
                    && parsed_message.images.is_empty()
                {
                    continue;
                }
                // 截点后的第一段回复另起一条:并进复制来的最后一条回复,收尾折叠时会一起折掉
                if p.inherited == Some(p.messages.len()) {
                    p.messages.push(text_msg(Role::Assistant, "", ts));
                }
                // 一个 turn 多个 step,每 step 一条 assistant/message;连续 assistant
                // 行(中间只隔 tool/result)合并成一条,详情页每回合一条助手消息
                let base = merge_into_last_assistant(
                    &mut p.messages,
                    ts,
                    parsed_message,
                    &thinking_parts.join("\n\n"),
                );
                let last = &mut p.messages[base];
                if model.is_some() {
                    last.model = model;
                }
                for tc in tools {
                    tool_index.insert(tc.id.clone(), (base, last.tool_calls.len()));
                    last.tool_calls.push(tc);
                }
            }
            "tool/result" => {
                // v4:tool 角色消息自己带 toolCallId / content / isError;v0–v3:
                // data.message.content = [tool-result 块],三样包在块里
                let msg = data.get("message").unwrap_or(&serde_json::Value::Null);
                let block = if msg.get("toolCallId").is_some() {
                    msg
                } else {
                    msg.pointer("/content/0")
                        .unwrap_or(&serde_json::Value::Null)
                };
                let Some(call_id) = block.get("toolCallId").and_then(|v| v.as_str()) else {
                    continue;
                };
                if let Some(&(mi, ti)) = tool_index.get(call_id) {
                    let parsed = content_parts(
                        block.get("content").unwrap_or(&serde_json::Value::Null),
                        decode,
                    );
                    let message = &mut p.messages[mi];
                    let tc = &mut message.tool_calls[ti];
                    if !parsed.text.is_empty() {
                        tc.output = Some(clip(&parsed.text, MAX_TOOL_IO).0);
                    }
                    if block.get("isError").and_then(|v| v.as_bool()) == Some(true)
                        || data.get("error").is_some_and(|e| !e.is_null())
                    {
                        tc.is_error = true;
                    }
                    append_images_to_message_end(message, parsed.images);
                }
            }
            // v2 起的 fork 截点(dsh-session fork.ts 的 buildForkSeed;最后一个带 inherited 的
            // 才是本会话的——嵌套 fork 里祖先的标记也在复制来的那段里)
            "session/end-seed" => {
                if true_at(data, "inherited") {
                    p.cut();
                }
            }
            // 子代理在第一个回合里记下的身份;上游按截点之后的第一个算
            "subagent/descriptor" => {
                if p.label.is_none() {
                    p.label = text_at(data, "label").map(clean_title_candidate);
                }
            }
            "session/title" => {
                if let Some(t) = text_at(data, "title") {
                    p.title = Some(clean_title_candidate(t));
                }
            }
            "request/context" => {
                // 路由元数据(仅变更时记录);assistant/message 的 source.model 会覆盖
                if p.model.is_none() {
                    if let Some(m) = data.get("model").and_then(|v| v.as_str()) {
                        p.model = Some(m.to_string());
                    }
                }
            }
            // 信封自带 ignorable 标记 = 写端声明的纯信息性记录,读者可安全跳过
            _ if row.get("ignorable").and_then(|v| v.as_bool()) == Some(true) => {}
            // 其余已知词汇(上游清单 + 老格式名字)跳过,两张表外才计 unknown——保住 schema
            // 漂移金丝雀
            t if UPSTREAM_EVENT_TYPES.contains(&t) || LEGACY_EVENT_TYPES.contains(&t) => {}
            _ => {
                p.unknown_lines += 1;
            }
        }
    }
    if let Some(cut) = p.inherited {
        collapse_inherited(&mut p.messages, cut, "session");
    }
    assign_seq(&mut p.messages);
    Ok(p)
}

fn build_meta(r: &SessionFileRef, p: &DshParse) -> SessionMeta {
    let (native, cwd, created) = match &p.header {
        Some(h) => (h.id.clone(), h.cwd.clone(), h.created_at),
        None => (r.native_id.clone(), String::new(), 0),
    };
    // 改过名的(session/title)> 子代理的任务名 > 第一句话
    let title = p
        .title
        .clone()
        .filter(|t| !t.is_empty())
        .or_else(|| p.label.clone())
        .or_else(|| title_from_messages(&p.messages))
        .unwrap_or_else(|| UNTITLED.to_string());
    SessionMeta {
        key: format!("dsh:{native}"),
        host: String::new(),
        id: native,
        agent: AgentId::Dsh,
        title,
        project_path: cwd.clone(),
        project_name: project_name_of(&cwd),
        file_path: r.file_path.clone(),
        created_at: if created > 0 { created } else { r.mtime_ms },
        updated_at: if p.last_ts > 0 { p.last_ts } else { r.mtime_ms },
        message_count: p
            .messages
            .iter()
            .filter(|m| m.kind == MessageKind::Text)
            .count() as i64,
        size_bytes: r.size,
        git_branch: None,
        model: p.model.clone(),
        tokens_used: p.tokens_used,
        archived: false,
        source: None,
        spawned: p.header.as_ref().is_some_and(|h| h.subagent),
        favorite: false,
        pinned: false,
    }
}

impl AgentAdapter for DshAdapter {
    fn agent(&self) -> AgentId {
        AgentId::Dsh
    }

    fn list_session_files(&self) -> Result<Vec<SessionFileRef>> {
        let dirs = self
            .session_dirs()
            .ok_or_else(|| anyhow!("cannot list {}", self.root.display()))?;
        let refs: Vec<SessionFileRef> = dirs
            .iter()
            .filter_map(|dir| Some(self.session_log(dir).ok()??.0))
            .collect();
        // 删掉的会话目录不留在缓存里
        let alive: std::collections::HashSet<&PathBuf> = dirs.iter().collect();
        self.logs
            .lock()
            .unwrap()
            .retain(|dir, _| alive.contains(dir));
        Ok(refs)
    }

    /// 同一会话的几份日志,新一代恒胜(位次小者胜:v0 = 255、v4 = 251),与
    /// `session_log` 的选代同一把尺子。list 只交出新一代还不够:库里已经记着旧代时
    /// (0.8.2 及以前的 Wake 只认 v0 的名字,或者同步、拷贝来的新代 mtime 反而更旧),
    /// 写库的副本裁决先比位次、再比 mtime,不给位次新代就会被挡回去
    fn dedup_rank(&self, path: &str) -> u8 {
        let generation = Path::new(path)
            .file_name()
            .and_then(|name| log_generation(&name.to_string_lossy()))
            .map_or(0, |(generation, _)| generation);
        u8::MAX - generation.min(u32::from(u8::MAX)) as u8
    }

    fn file_ref(&self, path: &Path) -> Option<SessionFileRef> {
        // 名字先粗筛(session.lock、迁移临时文件等不碰磁盘就不要),再看它是不是这个目录里
        // 被读的那一代
        log_generation(&path.file_name()?.to_string_lossy())?;
        let (r, _) = self.session_log(path.parent()?).ok()??;
        (Path::new(&r.file_path) == path).then_some(r)
    }

    fn manages_parent_links(&self) -> bool {
        true
    }

    /// 子代理会话首行里的 parentSession。每批监听事件都会问:只列目录,读到过的会话直接用缓存
    /// (首行不变),新目录才进去读;没入库的会话 scanner 自己会丢掉。目录列不出、某个会话读不出
    /// 又没读到过,都给 None,库里的关系原样保留
    fn parent_links(&self) -> Option<Vec<(String, String)>> {
        let key = |id: &str| session_key(AgentId::Dsh, "", id);
        let mut links = Vec::new();
        for dir in self.session_dirs()? {
            let known = self.logs.lock().unwrap().get(&dir).cloned();
            let entry = match known {
                Some(known) => Some(known),
                None => self.session_log(&dir).ok()?,
            };
            let Some((r, parent)) = entry else {
                continue;
            };
            if let Some(parent) = parent {
                links.push((key(&r.native_id), key(&parent)));
            }
        }
        Some(links)
    }

    /// 关系写在子会话自己的首行里:多 location 下按子会话的胜出文件认边
    fn parent_links_in_child(&self) -> bool {
        true
    }

    fn parse_session(&self, r: &SessionFileRef) -> Result<ParsedSession> {
        let parsed = parse_dsh_log(Path::new(&r.file_path), false)?;
        let meta = build_meta(r, &parsed);
        Ok(ParsedSession::derive(
            meta,
            &parsed.messages,
            parsed.unknown_lines,
        ))
    }

    fn parse_transcript(&self, r: &SessionFileRef) -> Result<ParsedTranscript> {
        let mut parsed = parse_dsh_log(Path::new(&r.file_path), true)?;
        let meta = build_meta(r, &parsed);
        let mut mainline = std::mem::take(&mut parsed.messages);
        // 后台续跑的子代理:派它的调用只回一句 `started subagent <子会话 id>`(dsh-tool-subagent
        // 的约定;本地跑的子代理 id 就是它的会话 id)。前台跑的结果只有最终文字,不带 id,挂不上
        for call in mainline.iter_mut().flat_map(|m| m.tool_calls.iter_mut()) {
            let child = call
                .output
                .as_deref()
                .and_then(|out| out.trim().strip_prefix("started subagent "))
                .filter(|id| !id.is_empty() && !id.contains(char::is_whitespace));
            if let Some(id) = child {
                call.child_id = Some(id.to_string());
            }
        }
        Ok(ParsedTranscript {
            meta,
            mainline,
            sidechains: Vec::new(),
            unknown_line_count: parsed.unknown_lines,
        })
    }

    fn session_paths(&self, meta: &SessionMeta) -> Vec<String> {
        // 一目录一会话:trash 整个会话目录(各代日志、session.lock 与 artifacts 一起)
        match Path::new(&meta.file_path).parent() {
            Some(dir) => vec![dir.to_string_lossy().to_string()],
            None => vec![meta.file_path.clone()],
        }
    }

    fn cleanup_paths(&self, meta: &SessionMeta) -> Option<Vec<String>> {
        Some(self.session_paths(meta))
    }

    fn with_custom_root(&self, dir: PathBuf) -> Box<dyn AgentAdapter> {
        let root = if dir.join("sessions").is_dir() {
            dir.join("sessions")
        } else {
            dir
        };
        Box::new(Self::at(root))
    }

    fn data_roots(&self) -> Vec<PathBuf> {
        vec![self.root.clone()]
    }
}

#[cfg(test)]
mod tests {
    use super::{log_generation, parse_dsh_log, parse_header, DshAdapter, DshHeader, DshParse};
    use crate::adapters::AgentAdapter;
    use crate::models::{MessageKind, Role, TranscriptMessage};

    /// 首行再加几个字段(`extra` 是接在 createdAt 后面的 JSON 片段)
    fn header(extra: &str) -> DshHeader {
        let line = format!(r#"{{"type":"session","version":4,"id":"c1","createdAt":1{extra}}}"#);
        parse_header(&serde_json::from_str(&line).unwrap()).unwrap()
    }

    /// 几行日志写进临时文件再解析
    fn parsed(lines: &[&str], decode_images: bool) -> DshParse {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.v4.jsonl");
        std::fs::write(&path, lines.join("\n")).unwrap();
        parse_dsh_log(&path, decode_images).unwrap()
    }

    fn texts(messages: &[TranscriptMessage]) -> Vec<(Role, MessageKind, &str)> {
        messages
            .iter()
            .map(|m| (m.role, m.kind, m.text.as_str()))
            .collect()
    }

    /// 只有子代理挂到父会话下;用户自己 fork 出来的会话也写 parentSession,是独立的对话
    #[test]
    fn only_subagents_hang_under_their_parent() {
        let parent = |extra: &str| header(extra).parent;
        assert_eq!(
            parent(r#","origin":"subagent","delegationDepth":1,"parentSession":"p1""#),
            Some("p1".to_string())
        );
        assert_eq!(
            parent(r#","delegationDepth":2,"parentSession":"p1""#),
            Some("p1".to_string())
        );
        assert_eq!(
            parent(r#","isSeeded":true,"delegationDepth":0,"parentSession":"p1""#),
            None
        );
        assert_eq!(parent(r#","origin":"subagent""#), None);

        // Insights 不算子会话的提问:子代理是 agent 派出去的,用户 fork 的仍是用户自己的对话
        let spawned = |extra: &str| header(extra).subagent;
        assert!(spawned(r#","origin":"subagent""#));
        assert!(spawned(r#","delegationDepth":2,"parentSession":"p1""#));
        assert!(!spawned(
            r#","isSeeded":true,"delegationDepth":0,"parentSession":"p1""#
        ));
    }

    /// v0 / v1 没有截点标记(那时的 session/end-seed 不带 inherited):截点在首行的 seedLength,
    /// seq 小于它的事件是复制来的;只认带 parentSession 的
    #[test]
    fn a_v0_fork_cuts_at_its_seed_length() {
        let parsed = parsed(
            &[
                r#"{"type":"session","version":0,"id":"sub0","createdAt":1,"cwd":"/w","origin":"subagent","delegationDepth":1,"parentSession":"p1","seedLength":3}"#,
                r#"{"type":"user/message","seq":0,"time":10,"data":{"content":[{"type":"text","text":"parent question"}],"source":{"kind":"user"}}}"#,
                r#"{"type":"assistant/message","seq":1,"time":20,"data":{"message":{"content":[{"type":"text","text":"parent answer"}],"source":{"model":"parent-model"}},"usage":{"inputTokens":900,"outputTokens":100}}}"#,
                r#"{"type":"session/title","seq":2,"time":21,"data":{"title":"Parent title"}}"#,
                r#"{"type":"session/end-seed","seq":3,"time":22,"data":{}}"#,
                r#"{"type":"user/message","seq":4,"time":30,"data":{"content":[{"type":"text","text":"child task"}],"source":{"kind":"user"}}}"#,
                r#"{"type":"assistant/message","seq":5,"time":40,"data":{"message":{"content":[{"type":"text","text":"child answer"}],"source":{"model":"child-model"}},"usage":{"inputTokens":40,"outputTokens":2}}}"#,
            ],
            false,
        );
        assert_eq!(
            texts(&parsed.messages),
            vec![
                (
                    Role::System,
                    MessageKind::Meta,
                    "── 2 messages inherited from the parent session ──"
                ),
                (Role::User, MessageKind::Text, "child task"),
                (Role::Assistant, MessageKind::Text, "child answer"),
            ]
        );
        assert_eq!(parsed.title, None, "父会话的标题不算");
        assert_eq!(parsed.model.as_deref(), Some("child-model"));
        assert_eq!(parsed.tokens_used, Some(42));
        assert_eq!(
            parsed.header.as_ref().and_then(|h| h.parent.as_deref()),
            Some("p1")
        );

        // 没有 parentSession 的 seedLength 不作数(上游迁移同一判法)
        assert_eq!(header(r#","seedLength":3"#).seed_length, None);
        assert_eq!(
            header(r#","seedLength":3,"parentSession":"p1""#).seed_length,
            Some(3)
        );
    }

    /// 根目录在却列不出(权限):列表报错、parent_links 给 None——当成空的话,全量扫描会把会话
    /// 整批删掉、子代理全打回顶层。根不在才是确定没有
    #[cfg(unix)]
    #[test]
    fn an_unreadable_root_is_unknown_not_empty() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        std::fs::create_dir_all(root.join("--w--").join("s1")).unwrap();
        let adapter = DshAdapter::at(root.clone());
        assert_eq!(adapter.parent_links(), Some(Vec::new()));
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o000)).unwrap();
        // root 读得动没有权限的目录,前提不成立就不测
        if std::fs::read_dir(&root).is_err() {
            assert!(adapter.list_session_files().is_err());
            assert_eq!(adapter.parent_links(), None);
        }
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let missing = DshAdapter::at(dir.path().join("missing"));
        assert!(missing.list_session_files().unwrap().is_empty());
        assert_eq!(missing.parent_links(), Some(Vec::new()));
    }

    /// 日志一时读不出(锁、权限)而它又刚追加过:首行写下就不变,沿用上次读到的,会话不从列表里掉
    #[cfg(unix)]
    #[test]
    fn a_log_that_cannot_be_read_right_now_keeps_its_header() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("--w--").join("s1");
        std::fs::create_dir_all(&session).unwrap();
        let log = session.join("session.jsonl");
        std::fs::write(
            &log,
            "{\"type\":\"session\",\"version\":0,\"id\":\"s1\",\"createdAt\":1}\n",
        )
        .unwrap();
        let adapter = DshAdapter::at(dir.path().to_path_buf());
        assert_eq!(adapter.list_session_files().unwrap().len(), 1);
        let mut file = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        writeln!(
            file,
            "{{\"type\":\"turn/start\",\"seq\":0,\"time\":2,\"data\":{{}}}}"
        )
        .unwrap();
        drop(file);
        std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o000)).unwrap();
        let listed = adapter.list_session_files().unwrap();
        std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|r| r.native_id.as_str())
                .collect::<Vec<_>>(),
            vec!["s1"]
        );
    }

    /// A 派 B、B 派 C,B 的目录一时读不出:读到过的照旧报全(少了 B→A 的快照会让 scanner 把 C
    /// 从 A 下面挪到 B 下面),列表里 B 也还在;重启后从没读到过,parent_links 整份给 None
    #[cfg(unix)]
    #[test]
    fn a_session_directory_that_turns_unreadable_keeps_its_place() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("--w--");
        for (id, parent) in [("a", None), ("b", Some("a")), ("c", Some("b"))] {
            let session = project.join(id);
            std::fs::create_dir_all(&session).unwrap();
            let link = parent.map_or(String::new(), |p| {
                format!(r#","origin":"subagent","delegationDepth":1,"parentSession":"{p}""#)
            });
            let header =
                format!(r#"{{"type":"session","version":4,"id":"{id}","createdAt":1{link}}}"#);
            std::fs::write(session.join("session.v4.jsonl"), header + "\n").unwrap();
        }
        let warm = DshAdapter::at(dir.path().to_path_buf());
        let links = |adapter: &DshAdapter| {
            adapter.parent_links().map(|mut links| {
                links.sort();
                links
            })
        };
        let full = links(&warm);
        assert_eq!(full.as_ref().map(Vec::len), Some(2));
        assert_eq!(warm.list_session_files().unwrap().len(), 3);

        let b = project.join("b");
        std::fs::set_permissions(&b, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = std::fs::read_dir(&b).is_err(); // root 读得动
        let warm_now = (links(&warm), warm.list_session_files().unwrap().len());
        let cold = DshAdapter::at(dir.path().to_path_buf());
        let cold_now = (links(&cold), cold.list_session_files().unwrap().len());
        std::fs::set_permissions(&b, std::fs::Permissions::from_mode(0o755)).unwrap();
        if unreadable {
            assert_eq!(warm_now, (full.clone(), 3));
            assert_eq!(cold_now, (None, 2));
        }
        assert_eq!(links(&cold), full);
    }

    /// 读到过的会话换了一代日志,新的那份读不出(首帧坏、一时打不开):交回上一代,会话不从列表里
    /// 掉——换到解析不了的新路径的话,旧路径又不在枚举里,全量扫描会把它从索引里删掉
    #[test]
    fn a_new_generation_that_cannot_be_read_keeps_the_old_one() {
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("--w--").join("s1");
        std::fs::create_dir_all(&session).unwrap();
        let header = |version: u32| {
            format!(r#"{{"type":"session","version":{version},"id":"s1","createdAt":1}}"#) + "\n"
        };
        let (v0, v4) = (
            session.join("session.jsonl"),
            session.join("session.v4.jsonl"),
        );
        std::fs::write(&v0, header(0)).unwrap();
        let adapter = DshAdapter::at(dir.path().to_path_buf());
        let listed = || -> Vec<String> {
            let refs = adapter.list_session_files().unwrap();
            refs.into_iter().map(|r| r.file_path).collect()
        };
        let path = |p: &std::path::Path| vec![p.to_string_lossy().into_owned()];
        assert_eq!(listed(), path(&v0));

        std::fs::write(&v4, "not a header\n").unwrap();
        assert_eq!(listed(), path(&v0), "首帧坏的新一代不顶掉读得出的旧代");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&v4, header(4)).unwrap();
            std::fs::set_permissions(&v4, std::fs::Permissions::from_mode(0o000)).unwrap();
            // root 读得动没有权限的文件,前提不成立就不测
            let unreadable = std::fs::read(&v4).is_err();
            let now = listed();
            std::fs::set_permissions(&v4, std::fs::Permissions::from_mode(0o644)).unwrap();
            if unreadable {
                assert_eq!(now, path(&v0), "一时打不开的新一代不顶掉旧代");
            }
        }
        std::fs::write(&v4, header(4)).unwrap();
        assert_eq!(listed(), path(&v4));
    }

    /// 截点后紧跟着的回复另起一条:并进复制来的最后一条回复,折叠时会被一起折掉
    #[test]
    fn a_reply_right_after_the_cut_is_its_own() {
        let parsed = parsed(
            &[
                r#"{"type":"session","version":4,"id":"f1","createdAt":1,"isSeeded":true,"delegationDepth":0,"parentSession":"p1"}"#,
                r#"{"type":"user/message","seq":0,"time":10,"data":{"content":[{"type":"text","text":"parent question"}],"source":{"kind":"user"}}}"#,
                r#"{"type":"assistant/message","seq":1,"time":20,"data":{"message":{"content":[{"type":"text","text":"parent answer"}]}}}"#,
                r#"{"type":"session/end-seed","seq":2,"time":20,"data":{"inherited":true}}"#,
                r#"{"type":"assistant/message","seq":3,"time":30,"data":{"message":{"content":[{"type":"text","text":"the fork's own answer"}]}}}"#,
            ],
            false,
        );
        assert_eq!(
            texts(&parsed.messages),
            vec![
                (
                    Role::System,
                    MessageKind::Meta,
                    "── 2 messages inherited from the parent session ──"
                ),
                (Role::Assistant, MessageKind::Text, "the fork's own answer"),
            ]
        );
    }

    /// 复制来的那段里的图片不解码(收尾要折掉,还占会话自己的解码额度);截点之后照常解码
    #[test]
    fn images_after_the_cut_are_decoded() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let user = |seq: u32| {
            format!(
                r#"{{"type":"user/message","seq":{seq},"time":{seq},"data":{{"content":[{{"type":"text","text":"look"}},{{"type":"image","media_type":"image/png","data":"{png}"}}],"source":{{"kind":"user"}}}}}}"#
            )
        };
        let (inherited, own) = (user(0), user(2));
        let parsed = parsed(
            &[
                r#"{"type":"session","version":4,"id":"f1","createdAt":1,"isSeeded":true,"parentSession":"p1"}"#,
                &inherited,
                r#"{"type":"session/end-seed","seq":1,"time":1,"data":{"inherited":true}}"#,
                &own,
            ],
            true,
        );
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[1].images.len(), 1);
    }

    #[test]
    fn log_names_carry_their_format_generation() {
        assert_eq!(log_generation("session.jsonl"), Some((0, false)));
        assert_eq!(log_generation("session.jsonl.zstd"), Some((0, true)));
        assert_eq!(log_generation("session.v3.jsonl.zstd"), Some((3, true)));
        assert_eq!(log_generation("session.v12.jsonl"), Some((12, false)));
        // dsh 不会写的名字:v0 不带版本号、没有前导零;锁文件与别的 artifacts 不是日志
        for name in [
            "session.v0.jsonl",
            "session.v03.jsonl.zstd",
            "session.v.jsonl",
            "session.v3a.jsonl",
            "session.v3.jsonl.tmp",
            "session.lock",
            "notes.jsonl",
        ] {
            assert_eq!(log_generation(name), None, "{name}");
        }
    }
}
