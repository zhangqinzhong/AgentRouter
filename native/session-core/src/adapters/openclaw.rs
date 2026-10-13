use super::parse_utils::*;
use super::pi_format::{PiRender, PiRenderOptions};
use super::sqlite_ro::{open_sqlite_ro, strip_virtual_path, virtual_path};
use super::AgentAdapter;
use crate::models::*;
use anyhow::{anyhow, Result};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// OpenClaw(原 Clawdbot/Moltbot):状态目录 `~/.openclaw`(`OPENCLAW_STATE_DIR`
/// 可改道,老装机名 `~/.clawdbot`),会话按 agent 分桶在 `agents/<agentId>/` 下,
/// **两代存储并存、同扫**:
/// - 现版(2026.8+):`agent/openclaw-agent.sqlite`,session_windows(每个
///   session_id 一行,reset/rollover 后旧窗口保留)+ session_nodes(按 session_key
///   的活跃指针与 label)+ transcript_events(session_id, seq, event_json)——
///   event_json 就是 pi 系 SessionManager 的一行(首行 `{type:"session",cwd}`
///   header,其余带 id/parentId 的树形条目),`session_transcript_active_events`
///   按 active_position 给出当前可见分支,缺表/缺行时退回"最后一条为叶"回溯。
/// - 旧版:`sessions/<sessionId>.jsonl` 同格式明文,`sessions.json` 是按
///   session_key 的索引(label/model/totalTokens/spawnedBy)。
///
/// 同一会话被 `doctor --fix` 迁进库后旧 jsonl 仍在,同 native_id 双副本由
/// scanner 按 mtime 裁决(不变量 8⑦),这里不做二选一。
/// 消息形状即 pi-ai,渲染核心与 pi.rs 共用(pi_format);OpenClaw 独有的是
/// thinking 块、`runtimeContextCarrier` 归 Meta、compaction/branch_summary/
/// custom_message/session_info 四种条目。
///
/// 派生出来的子代理(`spawnedBy`)与面板上开的子会话(`parentSessionKey`)照常列出,经
/// `parent_links` 挂到父会话下。条目(库里的 entry_json 与旧版 sessions.json 同一个形状)
/// 记了父会话的确切 id(`parentSessionId` / `spawnedBySessionId`)就用它——库里的条目只描述
/// 这个键眼下那一窗,子会话键被复用时旧窗口用它自己那一行记的。只记了会话键的:库里的子会话
/// 挑那个键在它创建时用着的窗口(一个键 reset 之后对应好几个窗口);旧版只知道每个键眼下那
/// 一条,旧版的子会话就取它(旧版 OpenClaw 也是按键跳转)。同一会话两代都有时以库里的为准。
pub struct OpenclawAdapter {
    /// `<state dir>/agents`
    root: PathBuf,
    /// 每库一份窗口行缓存(键 = 库路径),按库(含 -wal)mtime 失效
    rows_cache: Mutex<HashMap<PathBuf, Arc<MtimeCache<Arc<Vec<ClawRow>>>>>>,
    /// 旧版 sessions.json 索引,每个 sessions 目录一份,按文件 mtime 失效
    index_cache: Mutex<HashMap<PathBuf, Arc<MtimeCache<LegacyIndex>>>>,
}

/// sessions.json 解析结果:sessionId → (会话键, 条目)
type LegacyIndex = Arc<HashMap<String, (String, Value)>>;

const DB_NAME: &str = "openclaw-agent.sqlite";
/// 转录事件 JSON 的已知非内容类型:静默跳过,表外计 unknown(格式漂移金丝雀)
const KNOWN_SKIP: &[&str] = &[
    "session",
    "thinking_level_change",
    "label",
    "custom",
    "reset",
];

impl OpenclawAdapter {
    pub fn new() -> Self {
        let home = super::home_dir().unwrap_or_default();
        // OPENCLAW_STATE_DIR 只是候选:里面真有 agents/ 才采信;默认 ~/.openclaw,
        // 只装过老版本的机器(无 .openclaw、有 .clawdbot)回落旧名——与上游
        // resolveStateDir 的判序一致
        let state = super::env_dir("OPENCLAW_STATE_DIR")
            .filter(|d| d.join("agents").is_dir())
            .unwrap_or_else(|| {
                let new = home.join(".openclaw");
                let legacy = home.join(".clawdbot");
                if !new.exists() && legacy.exists() {
                    legacy
                } else {
                    new
                }
            });
        Self::with_root(state.join("agents"))
    }

    fn with_root(root: PathBuf) -> Self {
        Self {
            root,
            rows_cache: Mutex::new(HashMap::new()),
            index_cache: Mutex::new(HashMap::new()),
        }
    }

    /// `agents/<agentId>/` 目录(构造时不要求存在,枚举时缺根降级为空)
    fn agent_dirs(&self) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| e.path())
            .collect();
        dirs.sort();
        dirs
    }

    fn rows_cache_of(&self, db: &Path) -> Arc<MtimeCache<Arc<Vec<ClawRow>>>> {
        Arc::clone(
            self.rows_cache
                .lock()
                .unwrap()
                .entry(db.to_path_buf())
                .or_insert_with(|| Arc::new(MtimeCache::new())),
        )
    }

    /// None = 库在却读不出(打不开、查询出错)
    fn rows(&self, db: &Path) -> Option<Arc<Vec<ClawRow>>> {
        let stamp = super::sqlite_ro::db_cache_stamp(db);
        self.rows_cache_of(db).get_or_try_build(stamp, || {
            let ro = open_sqlite_ro(db, "openclaw")?;
            query_rows(&ro.conn).map(Arc::new)
        })
    }

    /// 旧版 `sessions.json`:按 sessionId 的索引(原文件按会话键键)。没有这个文件是空的,
    /// 解不开也按空的算(上游写它是先写临时文件再改名,解不开就是坏了、不会自己好);
    /// 在却读不出(I/O)是 None
    fn legacy_index(&self, sessions_dir: &Path) -> Option<LegacyIndex> {
        let file = sessions_dir.join("sessions.json");
        let meta = match fs::metadata(&file) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Some(LegacyIndex::default())
            }
            Err(_) => return None,
        };
        let cache = Arc::clone(
            self.index_cache
                .lock()
                .unwrap()
                .entry(file.clone())
                .or_insert_with(|| Arc::new(MtimeCache::new())),
        );
        cache.get_or_try_build(mtime_ms(&meta), || {
            let text = fs::read_to_string(&file).ok()?;
            let map = match serde_json::from_str::<Value>(&text) {
                Ok(Value::Object(map)) => map,
                _ => Default::default(),
            };
            Some(Arc::new(
                map.into_iter()
                    .filter_map(|(key, v)| {
                        Some((v.get("sessionId")?.as_str()?.to_string(), (key, v)))
                    })
                    .collect(),
            ))
        })
    }

    fn legacy_hint(&self, path: &Path, native_id: &str) -> RowHint {
        let Some(dir) = path.parent() else {
            return RowHint::default();
        };
        let index = self.legacy_index(dir).unwrap_or_default();
        // topic 转录 `<sessionId>-topic-<id>.jsonl` 共用父会话的索引项
        let base = native_id.split("-topic-").next().unwrap_or(native_id);
        let Some((_, v)) = index.get(native_id).or_else(|| index.get(base)) else {
            return RowHint::default();
        };
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
        RowHint {
            label: s("label").or_else(|| s("displayName")),
            model: s("model"),
            tokens: v.get("totalTokens").and_then(Value::as_i64),
            channel: None,
            created_ms: 0,
            updated_ms: norm_ms(v.get("updatedAt").and_then(Value::as_i64).unwrap_or(0)),
            spawned: entry_spawned(v),
        }
    }

    fn build_meta(r: &SessionFileRef, p: &ClawParse, hint: &RowHint) -> SessionMeta {
        let title = p
            .name
            .clone()
            .or_else(|| hint.label.clone())
            .map(|t| clean_title_candidate(&t))
            .filter(|t| !t.is_empty())
            .or_else(|| title_from_messages(&p.messages))
            .unwrap_or_else(|| UNTITLED.to_string());
        SessionMeta {
            key: session_key(AgentId::Openclaw, "", &r.native_id),
            host: String::new(),
            id: r.native_id.clone(),
            agent: AgentId::Openclaw,
            title,
            project_path: p.cwd.clone(),
            project_name: project_name_of(&p.cwd),
            file_path: r.file_path.clone(),
            created_at: [p.created_at, hint.created_ms, r.mtime_ms]
                .into_iter()
                .find(|t| *t > 0)
                .unwrap_or(0),
            updated_at: [p.last_ts, hint.updated_ms, r.mtime_ms]
                .into_iter()
                .find(|t| *t > 0)
                .unwrap_or(0),
            message_count: p
                .messages
                .iter()
                .filter(|m| m.kind == MessageKind::Text)
                .count() as i64,
            size_bytes: r.size,
            git_branch: None,
            model: p
                .model
                .clone()
                .or_else(|| hint.model.clone())
                .filter(|m| !m.is_empty()),
            tokens_used: p.tokens_used.or(hint.tokens).filter(|t| *t > 0),
            archived: false,
            // 频道即启动面(telegram/discord/webchat…);cli/空不打徽章
            source: hint.channel.clone().filter(|c| !c.is_empty() && c != "cli"),
            spawned: hint.spawned,
            favorite: false,
            pinned: false,
        }
    }

    fn parse(&self, r: &SessionFileRef, decode_images: bool) -> Result<(SessionMeta, ClawParse)> {
        let path = Path::new(&r.file_path);
        if path.is_file() {
            // 旧版 jsonl:整文件即条目流,叶 = 最后一条
            let (entries, bad) = read_jsonl_entries(path)?;
            let mut p = render(linearize(entries, None), decode_images);
            p.unknown_lines += bad;
            let hint = self.legacy_hint(path, &r.native_id);
            let meta = Self::build_meta(r, &p, &hint);
            return Ok((meta, p));
        }
        let db = Path::new(strip_virtual_path(&r.file_path));
        let row = self
            .rows(db)
            .and_then(|rows| {
                rows.iter()
                    .find(|row| row.session_id == r.native_id)
                    .cloned()
            })
            .ok_or_else(|| anyhow!("openclaw session {} not in store", r.native_id))?;
        let ro = open_sqlite_ro(db, "openclaw")
            .ok_or_else(|| anyhow!("cannot open openclaw store {}", db.display()))?;
        let mut stmt = ro.conn.prepare(
            "SELECT seq, event_json FROM transcript_events WHERE session_id = ?1 ORDER BY seq",
        )?;
        let mut entries: Vec<(i64, Value)> = Vec::new();
        let mut unknown = 0u32;
        for row in stmt.query_map([&r.native_id], |x| {
            Ok((x.get::<_, i64>(0)?, x.get::<_, String>(1)?))
        })? {
            match row
                .ok()
                .and_then(|(seq, json)| serde_json::from_str::<Value>(&json).ok().map(|v| (seq, v)))
            {
                Some(entry) => entries.push(entry),
                None => unknown += 1,
            }
        }
        // 当前可见分支(按 active_position);表缺失/为空时退回树回溯
        let active: Vec<i64> = ro
            .conn
            .prepare(
                "SELECT event_seq FROM session_transcript_active_events
                 WHERE session_id = ?1 ORDER BY active_position",
            )
            .and_then(|mut s| {
                s.query_map([&r.native_id], |x| x.get::<_, i64>(0))
                    .map(|it| it.flatten().collect::<Vec<_>>())
            })
            .unwrap_or_default();
        let active_ix = (!active.is_empty()).then(|| {
            let by_seq: HashMap<i64, usize> = entries
                .iter()
                .enumerate()
                .map(|(i, (seq, _))| (*seq, i))
                .collect();
            active
                .iter()
                .filter_map(|s| by_seq.get(s).copied())
                .collect()
        });
        let values: Vec<Value> = entries.into_iter().map(|(_, v)| v).collect();
        let mut p = render(linearize(values, active_ix), decode_images);
        p.unknown_lines += unknown;
        let meta = Self::build_meta(r, &p, &row.hint);
        Ok((meta, p))
    }
}

/// 库内一条会话窗口(session_windows ⋈ session_nodes)
#[derive(Clone)]
struct ClawRow {
    session_id: String,
    session_key: String,
    parent: Option<ParentRef>,
    event_count: i64,
    content_len: i64,
    hint: RowHint,
}

/// 库行 / 旧版索引给解析结果补缺的元数据
#[derive(Clone, Default)]
struct RowHint {
    label: Option<String>,
    model: Option<String>,
    tokens: Option<i64>,
    channel: Option<String>,
    created_ms: i64,
    updated_ms: i64,
    /// agent 派生出来的子会话(`entry_spawned`);面板上新建的子会话、频道里的话题只记了
    /// parentSessionKey,那是用户自己的对话
    spawned: bool,
}

/// 条目是 agent 派生出来的:spawn 时写 spawnedBy / spawnedBySessionId;sessions_spawn 起的
/// 可见子会话只记 parentSessionKey,但 spawnDepth 一定 ≥ 1——上游的派生层级只由 spawn 声明,
/// 面板新建、fork、频道话题一律是 0
fn entry_spawned(entry: &Value) -> bool {
    ["spawnedBy", "spawnedBySessionId"]
        .iter()
        .any(|key| text_at(entry, key).is_some())
        || entry.get("spawnDepth").and_then(Value::as_i64).unwrap_or(0) > 0
}

/// 子会话指向父会话的线索
#[derive(Clone)]
enum ParentRef {
    /// 确切的那一条会话
    Session(String),
    /// 只有会话键:reset 之后一个键对应好几个窗口,按子会话开始的时间挑
    Key(String),
}

impl ParentRef {
    /// `entry` 是条目(库里只给这个键眼下那一窗);`own_key` 是库里窗口行自己记的
    /// spawned_by / parent_session_key(旧版没有)
    fn of(entry: Option<&Value>, own_key: Option<String>) -> Option<Self> {
        let s = |k: &str| optional_string(entry?.get(k));
        s("parentSessionId")
            .or_else(|| s("spawnedBySessionId"))
            .map(Self::Session)
            .or_else(|| {
                own_key
                    .or_else(|| s("spawnedBy"))
                    .or_else(|| s("parentSessionKey"))
                    .map(Self::Key)
            })
    }
}

/// 上游全部 ms 整数;防御性兼容秒,阈值与 parse_utils::to_epoch_ms 同一条线
fn norm_ms(v: i64) -> i64 {
    to_epoch_ms(&Value::from(v))
}

fn query_rows(conn: &rusqlite::Connection) -> Option<Vec<ClawRow>> {
    // Older installations use this database for cache/auth/memory only and
    // still keep transcripts in sessions/*.jsonl. Do not freeze those sources.
    let tables:i64=conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('session_windows','session_nodes','transcript_events')",[],|r|r.get(0)).ok()?;
    if tables==0{return Some(Vec::new())}

    let mut stmt = conn
        .prepare(
            "SELECT w.session_id, w.spawned_by, w.created_at, w.updated_at,
                    w.transcript_updated_at, w.started_at, w.model, w.channel, w.display_name,
                    n.label, n.display_name, n.entry_json,
                    COUNT(e.seq), COALESCE(SUM(LENGTH(e.event_json)), 0),
                    COALESCE(MAX(e.created_at), 0), w.session_key, w.parent_session_key
             FROM session_windows w
             LEFT JOIN session_nodes n ON n.session_key = w.session_key
             LEFT JOIN transcript_events e ON e.session_id = w.session_id
             GROUP BY w.session_id",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            let session_id: String = r.get(0)?;
            let created = norm_ms(r.get::<_, Option<i64>>(2)?.unwrap_or(0));
            let started = norm_ms(r.get::<_, Option<i64>>(5)?.unwrap_or(0));
            let updated = norm_ms(r.get::<_, Option<i64>>(3)?.unwrap_or(0));
            let transcript_updated = norm_ms(r.get::<_, Option<i64>>(4)?.unwrap_or(0));
            let last_event = norm_ms(r.get::<_, Option<i64>>(14)?.unwrap_or(0));
            let entry: Value = r
                .get::<_, Option<String>>(11)?
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null);
            let entry_str = |k: &str| entry.get(k).and_then(Value::as_str).map(String::from);
            let label = r
                .get::<_, Option<String>>(9)?
                .or(r.get::<_, Option<String>>(10)?)
                .or(r.get::<_, Option<String>>(8)?)
                .or_else(|| entry_str("label"))
                .or_else(|| entry_str("displayName"))
                .filter(|s| !s.trim().is_empty());
            let model = r
                .get::<_, Option<String>>(6)?
                .or_else(|| entry_str("model"));
            // 只有当前活跃窗口的 entry_json 归它;老窗口的 node 指向新窗口,
            // 计数不能张冠李戴
            let is_current = entry.get("sessionId").and_then(Value::as_str) == Some(&session_id);
            let tokens = is_current
                .then(|| entry.get("totalTokens").and_then(Value::as_i64))
                .flatten();
            let key_at = |ix: usize| {
                r.get::<_, Option<String>>(ix)
                    .map(|key| key.filter(|key| !key.is_empty()))
            };
            let spawned_by = key_at(1)?;
            let spawned = spawned_by.is_some() || (is_current && entry_spawned(&entry));
            let own_key = spawned_by.or(key_at(16)?);
            Ok(ClawRow {
                session_key: r.get(15)?,
                parent: ParentRef::of(is_current.then_some(&entry), own_key),
                event_count: r.get(12)?,
                content_len: r.get(13)?,
                hint: RowHint {
                    label,
                    model,
                    tokens,
                    channel: r.get(7)?,
                    created_ms: [started, created].into_iter().find(|t| *t > 0).unwrap_or(0),
                    updated_ms: [transcript_updated, last_event, updated]
                        .into_iter()
                        .max()
                        .unwrap_or(0),
                    spawned,
                },
                session_id,
            })
        })
        .ok()?
        .collect::<rusqlite::Result<Vec<_>>>()
        .ok();
    rows
}

/// 旧版会话目录里列得出来的转录:(主干, 路径, metadata)。归档 / 检查点、空文件与不是普通
/// 文件的不算——列表与关系里的 id 映射都按这一份,两边才不会对不上
fn legacy_transcripts(sessions_dir: &Path) -> Vec<(String, PathBuf, fs::Metadata)> {
    let Ok(entries) = fs::read_dir(sessions_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_legacy_transcript(&name) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            if !meta.is_file() || meta.len() == 0 {
                return None;
            }
            let stem = name.strip_suffix(".jsonl").unwrap_or(&name).to_string();
            Some((stem, entry.path(), meta))
        })
        .collect()
}

/// 每个会话 id 对应的列出来的转录主干:带话题的会话转录叫 `<id>-topic-<话题>.jsonl`
/// (上游 resolveSessionTranscriptPathInDir),枚举时 native id 是整个主干;有裸文件名的用它
fn legacy_stems(listed: impl IntoIterator<Item = String>) -> HashMap<String, String> {
    let mut stems = HashMap::new();
    for stem in listed {
        let id = stem.split("-topic-").next().unwrap_or(&stem).to_string();
        if id == stem {
            stems.insert(id, stem);
        } else {
            stems.entry(id).or_insert(stem);
        }
    }
    stems
}

/// 会话在 Wake 里的 id:库里有的用库里的,旧版的换成实际列出来的转录主干
fn listed_id<'a>(
    id: &'a str,
    in_db: &HashSet<&str>,
    stems: &'a HashMap<String, String>,
) -> &'a str {
    if in_db.contains(id) {
        return id;
    }
    stems.get(id).map_or(id, String::as_str)
}

/// 旧版转录文件名过滤:归档/回滚快照/压缩检查点都不是活会话
fn is_legacy_transcript(name: &str) -> bool {
    name.ends_with(".jsonl")
        && !name.starts_with('.')
        && !name.contains(".deleted.")
        && !name.contains(".reset.")
        && !name.contains(".checkpoint.")
}

/// (条目, 坏行数)
fn read_jsonl_entries(path: &Path) -> Result<(Vec<Value>, u32)> {
    let file = fs::File::open(path)?;
    let reader = BufReader::with_capacity(1 << 20, file);
    let mut out = Vec::new();
    let mut bad = 0u32;
    for row in jsonl_values(reader) {
        match row? {
            Some(v) => out.push(v),
            None => bad += 1,
        }
    }
    Ok((out, bad))
}

/// 树形条目 → 当前分支的线性序列(header 在首位)。`active` 给出(下标)显式
/// 分支时照单;否则以最后一条带 id 的条目为叶沿 parentId 回溯到根(pi
/// SessionManager 的默认叶语义,旧版 jsonl 只有这一种)。
fn linearize(mut entries: Vec<Value>, active: Option<Vec<usize>>) -> Vec<Value> {
    let header_ix = entries
        .iter()
        .position(|v| v.get("type").and_then(Value::as_str) == Some("session"));
    let chain: Vec<usize> = match active {
        Some(ix) => ix,
        None => {
            let by_id: HashMap<&str, usize> = entries
                .iter()
                .enumerate()
                .filter_map(|(i, v)| v.get("id").and_then(Value::as_str).map(|id| (id, i)))
                .collect();
            let mut chain = Vec::new();
            let mut seen = HashSet::new();
            let mut cursor = entries
                .iter()
                .rposition(|v| v.get("id").and_then(Value::as_str).is_some());
            while let Some(i) = cursor {
                if !seen.insert(i) {
                    break;
                }
                chain.push(i);
                cursor = entries[i]
                    .get("parentId")
                    .and_then(Value::as_str)
                    .and_then(|p| by_id.get(p).copied());
            }
            chain.reverse();
            chain
        }
    };
    let mut out = Vec::with_capacity(chain.len() + 1);
    if let Some(h) = header_ix {
        out.push(std::mem::take(&mut entries[h]));
    }
    for i in chain {
        if Some(i) != header_ix {
            out.push(std::mem::take(&mut entries[i]));
        }
    }
    out
}

struct ClawParse {
    cwd: String,
    created_at: i64,
    last_ts: i64,
    messages: Vec<TranscriptMessage>,
    model: Option<String>,
    tokens_used: Option<i64>,
    /// session_info 的 name(用户/自动命名),标题首选
    name: Option<String>,
    unknown_lines: u32,
}

fn entry_ts(v: &Value, msg: Option<&Value>) -> i64 {
    v.get("timestamp")
        .and_then(Value::as_str)
        .map(iso_ms)
        .filter(|t| *t > 0)
        .or_else(|| {
            msg.and_then(|m| m.get("timestamp"))
                .map(to_epoch_ms)
                .filter(|t| *t > 0)
        })
        .unwrap_or(0)
}

fn render(chain: Vec<Value>, decode_images: bool) -> ClawParse {
    let _image_budget = transcript_image_decode_budget(decode_images);
    let mut p = ClawParse {
        cwd: String::new(),
        created_at: 0,
        last_ts: 0,
        messages: Vec::new(),
        model: None,
        tokens_used: None,
        name: None,
        unknown_lines: 0,
    };
    let mut render = PiRender::new(
        PiRenderOptions {
            thinking_blocks: true,
            meta_carrier: true,
            raw_tool_results: true,
        },
        decode_images,
    );
    // 非 message 条目(compaction 摘要等)要按位置插在消息流里,故由 render
    // 接管 messages,这里只借它推进
    for v in &chain {
        let Some(typ) = v.get("type").and_then(Value::as_str) else {
            p.unknown_lines += 1;
            continue;
        };
        match typ {
            "session" => {
                if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                    p.cwd = c.to_string();
                }
                if let Some(t) = v.get("timestamp").and_then(Value::as_str) {
                    p.created_at = iso_ms(t);
                }
            }
            "message" => {
                let Some(msg) = v.get("message") else {
                    p.unknown_lines += 1;
                    continue;
                };
                let ts = entry_ts(v, Some(msg));
                p.last_ts = p.last_ts.max(ts);
                if !render.push(msg, ts) {
                    p.unknown_lines += 1;
                }
            }
            "model_change" => {
                if let Some(m) = v.get("modelId").and_then(Value::as_str) {
                    render.model = Some(m.to_string());
                }
            }
            "compaction" | "branch_summary" => {
                let ts = entry_ts(v, None);
                p.last_ts = p.last_ts.max(ts);
                if let Some(s) = v.get("summary").and_then(Value::as_str) {
                    if !s.trim().is_empty() {
                        let mut m = text_msg(Role::System, s, ts);
                        m.kind = MessageKind::CompactSummary;
                        render.messages.push(m);
                    }
                }
            }
            "custom_message" => {
                // 扩展注入进上下文的消息:display=true 才是给人看的,折叠为 Meta
                if v.get("display").and_then(Value::as_bool) == Some(true) {
                    let parsed = content_parts(v.get("content").unwrap_or(&Value::Null), false);
                    if !parsed.text.is_empty() {
                        let mut m = text_msg(Role::System, &parsed.text, entry_ts(v, None));
                        m.kind = MessageKind::Meta;
                        render.messages.push(m);
                    }
                }
            }
            "session_info" => {
                if let Some(n) = v.get("name").and_then(Value::as_str) {
                    let n = n.trim();
                    p.name = (!n.is_empty()).then(|| n.to_string());
                }
            }
            other if KNOWN_SKIP.contains(&other) => {}
            _ => p.unknown_lines += 1,
        }
    }
    p.messages = render.messages;
    p.model = render.model;
    p.tokens_used = render.tokens_used;
    assign_seq(&mut p.messages);
    p
}

impl AgentAdapter for OpenclawAdapter {
    fn agent(&self) -> AgentId {
        AgentId::Openclaw
    }

    fn list_session_files(&self) -> Result<Vec<SessionFileRef>> {
        let mut out = Vec::new();
        for dir in self.agent_dirs() {
            let db = dir.join("agent").join(DB_NAME);
            // 库在却读不出报 Err,scanner 冻结这一家这一轮(不变量 8①)——当成没有会话的话,
            // 这一轮会把库里的会话当"磁盘已删"清掉
            if db.is_file() {
                let rows = self
                    .rows(&db)
                    .ok_or_else(|| anyhow!("{} exists but could not be read", db.display()))?;
                out.extend(rows.iter().filter(|row| row.event_count > 0).map(|row| {
                    SessionFileRef {
                        agent: AgentId::Openclaw,
                        native_id: row.session_id.clone(),
                        file_path: virtual_path(&db, &row.session_id),
                        mtime_ms: row.hint.updated_ms,
                        size: row.content_len,
                    }
                }));
            }
            out.extend(legacy_transcripts(&dir.join("sessions")).into_iter().map(
                |(stem, path, meta)| SessionFileRef {
                    agent: AgentId::Openclaw,
                    native_id: stem,
                    file_path: path.to_string_lossy().to_string(),
                    mtime_ms: mtime_ms(&meta),
                    size: meta.len() as i64,
                },
            ));
        }
        Ok(out)
    }

    fn file_ref(&self, path: &Path) -> Option<SessionFileRef> {
        // 只认 agents/<id>/sessions/<name>.jsonl 这一层;归档/检查点同 list 过滤
        let name = path.file_name()?.to_string_lossy().to_string();
        if !is_legacy_transcript(&name) {
            return None;
        }
        let sessions = path.parent()?;
        if sessions.file_name()?.to_str()? != "sessions" {
            return None;
        }
        if sessions.parent()?.parent()? != self.root {
            return None;
        }
        default_file_ref(AgentId::Openclaw, path)
    }

    fn manages_parent_links(&self) -> bool {
        true
    }

    /// 库里的窗口与旧版索引一起认:父会话可能在另一个 agent 的库里(跨 agent 派生),也可能
    /// 只剩旧版 jsonl。库在却从没读成功过、索引读不出 = 不知道(None),库里的关系原样保留
    fn parent_links(&self) -> Option<Vec<(String, String)>> {
        // 库里的窗口取这一轮枚举读到的那份(`MtimeCache::latest`:扫描末尾才问到这里,库在扫描
        // 期间被写过时按戳重读就是把整个枚举查询再跑一遍)
        let mut snapshots = Vec::new();
        let mut legacy = Vec::new();
        let mut transcripts = Vec::new();
        for dir in self.agent_dirs() {
            let db = dir.join("agent").join(DB_NAME);
            if db.is_file() {
                snapshots.push(self.rows_cache_of(&db).latest()?);
            }
            let sessions = dir.join("sessions");
            legacy.push(self.legacy_index(&sessions)?);
            transcripts.extend(
                legacy_transcripts(&sessions)
                    .into_iter()
                    .map(|(stem, ..)| stem),
            );
        }
        // 各 agent 目录收齐了再定:裸文件名优先得在全集上成立,不能看目录先后
        let stems = legacy_stems(transcripts);
        let all_rows = || snapshots.iter().flat_map(|rows| rows.iter());
        // 没有事件的窗口不列(列表同一条),不算"库里那份"——迁进库时没带上事件、旧版 jsonl 还在的
        // 会话,列出来的是旧版那份。时间线上照样留着它(下面的 windows)
        let legacy_entries = || legacy.iter().flat_map(|index| index.iter());
        let in_db: HashSet<&str> = all_rows()
            .filter(|row| row.event_count > 0)
            .map(|row| row.session_id.as_str())
            .collect();
        // 会话键 → 库里它的全部窗口(创建时间, 会话 id),空的也算:它在时间线上占着一段,拿掉的话
        // 这段里派出的子代理会被挂到更早的那一窗。挑中的是空窗口时,`listed_id` 换成列出来的那份
        let mut windows: HashMap<&str, Vec<(i64, &str)>> = HashMap::new();
        for row in all_rows() {
            windows
                .entry(&row.session_key)
                .or_default()
                .push((row.hint.created_ms, &row.session_id));
        }
        for list in windows.values_mut() {
            list.sort_unstable();
        }
        let current: HashMap<&str, &str> = legacy_entries()
            .map(|(id, (key, _))| (key.as_str(), id.as_str()))
            .collect();
        // 库里的子会话:那个键在它创建时用着的窗口(不晚于它的最后一个,都晚于它就取最早的),
        // 库里没有这个键才退到旧版那一条
        let db_parent = |key: &str, at: i64| match windows.get(key) {
            Some(list) => list
                .iter()
                .rev()
                .find(|(start, _)| *start <= at)
                .or(list.first())
                .map(|(_, id)| *id),
            None => current.get(key).copied(),
        };
        // 旧版的子会话:那个键眼下那一条,旧版里没有这个键才退到库里最新的窗口
        let legacy_parent = |key: &str| {
            current
                .get(key)
                .copied()
                .or_else(|| windows.get(key)?.last().map(|(_, id)| *id))
        };
        // 子会话(列出来的 id)→ 父会话(列出来的 id)。先放库里每一窗记的,再拿旧版索引里的盖上:
        // 库里那份列出来的会话以库为准(旧版只记了父会话的键,下面不碰它);库里那份没事件、列出来
        // 的是旧版那份时,旧版索引里有这条会话的关系就用它,没有(子会话键 reset 后索引换成了新的
        // 那一条)就留着库里那一行记的
        let mut links: HashMap<&str, &str> = HashMap::new();
        for row in all_rows() {
            let parent = match row.parent.as_ref() {
                Some(ParentRef::Session(id)) => Some(id.as_str()),
                Some(ParentRef::Key(key)) => db_parent(key, row.hint.created_ms),
                None => None,
            };
            if let Some(parent) = parent {
                links.insert(
                    listed_id(&row.session_id, &in_db, &stems),
                    listed_id(parent, &in_db, &stems),
                );
            }
        }
        let legacy_children: Vec<(&str, ParentRef)> = legacy_entries()
            .filter(|(id, _)| !in_db.contains(id.as_str()))
            .filter_map(|(id, (_, entry))| Some((id.as_str(), ParentRef::of(Some(entry), None)?)))
            .collect();
        for (id, parent) in &legacy_children {
            let parent = match parent {
                ParentRef::Session(parent) => Some(parent.as_str()),
                ParentRef::Key(key) => legacy_parent(key),
            };
            if let Some(parent) = parent {
                links.insert(
                    listed_id(id, &in_db, &stems),
                    listed_id(parent, &in_db, &stems),
                );
            }
        }
        Some(super::link_keys(AgentId::Openclaw, links))
    }

    /// 关系记在子会话自己的条目里:多 location 下按子会话的胜出副本认边
    fn parent_links_in_child(&self) -> bool {
        true
    }

    /// 旧版的父子关系记在 `agents/<x>/sessions/sessions.json` 里,关系里的 id 又按会话目录里
    /// 列得出来的转录换算(`listed_id`):两样单独变了(删除也算)都要重取关系
    fn is_snapshot_event(&self, path: &Path) -> bool {
        path.parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "sessions")
            && path.ancestors().nth(3) == Some(self.root.as_path())
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "sessions.json" || is_legacy_transcript(name))
    }

    // quick_meta 不覆写:库行给不出标题的可靠来源(名字在 session_info 事件里),
    // 走全解析

    fn parse_session(&self, r: &SessionFileRef) -> Result<ParsedSession> {
        let (meta, p) = self.parse(r, false)?;
        Ok(ParsedSession::derive(meta, &p.messages, p.unknown_lines))
    }

    fn parse_transcript(&self, r: &SessionFileRef) -> Result<ParsedTranscript> {
        let (meta, p) = self.parse(r, true)?;
        Ok(ParsedTranscript {
            meta,
            mainline: p.messages,
            sidechains: Vec::new(),
            unknown_line_count: p.unknown_lines,
        })
    }

    fn cleanup_paths(&self, meta: &SessionMeta) -> Option<Vec<String>> {
        Some(self.session_paths(meta))
    }

    fn with_custom_root(&self, dir: PathBuf) -> Box<dyn AgentAdapter> {
        // 选中状态目录(~/.openclaw)或 agents 目录本身都认;目录尚不存在时按
        // 名字判:叫 agents 即是根,否则视作状态目录(远程挂载点 `.openclaw/agents`
        // 同步前就落在正确形态)
        let is_agents = dir.file_name().and_then(|n| n.to_str()) == Some("agents")
            || (!dir.join("agents").is_dir() && looks_like_agents(&dir));
        let root = if is_agents { dir } else { dir.join("agents") };
        Box::new(Self::with_root(root))
    }

    fn data_roots(&self) -> Vec<PathBuf> {
        vec![self.root.clone()]
    }
}

/// 目录里已有 `<x>/sessions` 或 `<x>/agent/openclaw-agent.sqlite` 形态的子目录
/// → 它本身就是 agents 根(用户把 agents 目录改名拷出来的情形)
fn looks_like_agents(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|it| {
            it.flatten().any(|e| {
                let p = e.path();
                p.join("sessions").is_dir() || p.join("agent").join(DB_NAME).is_file()
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod schema_tests {
 use super::*;
 #[test]
 fn legacy_database_without_session_tables_is_empty_not_unreadable(){
  let db=rusqlite::Connection::open_in_memory().unwrap();
  db.execute_batch("CREATE TABLE cache_entries (key TEXT); CREATE TABLE schema_meta (version INTEGER)").unwrap();
  assert!(query_rows(&db).unwrap().is_empty());
  db.execute_batch("CREATE TABLE session_windows (session_id TEXT)").unwrap();
  assert!(query_rows(&db).is_none(),"partial or damaged session schema must remain an error");
 }
}
