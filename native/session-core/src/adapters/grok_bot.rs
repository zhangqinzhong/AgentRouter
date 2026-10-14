use super::parse_utils::*;
use super::sqlite_ro::{split_virtual_path, virtual_path};
use super::AgentAdapter;
use crate::models::*;
use anyhow::{anyhow, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Grok Bot(xAI 的常驻 agent,桌面 app 由 Cursor 出品,bundle id `com.anysphere.sand`):bot 跑在
/// 云端电脑上,对话也存在那里,桌面端只在本机留一份**滚动缓存**——`<userData>/sand-client-persistence/`
/// (Electron 的 userData:macOS `~/Library/Application Support/Grok Bot`,Linux `~/.config/Grok Bot`,
/// Windows `%APPDATA%\Grok Bot`)。一个键一个文件,文件名是键的 base32(小写、无填充)加 `.blob`;
/// 编码后超过 240 字符的键改存 `<摘要>.kblob`,首行是 JSON 编码的键。写法是先写 `<名>.tmp` 再改名替换,
/// 读到的不会是半截。
/// - `sand.client.slice.account.<账号>.transcript.replicas.<对话 id>`:对话的本地副本
///   `{schemaVersion: 1, value: {entries, persistedAt, precedingTimestampMs?, …}}`。app 每个对话只留
///   最近 200 条(且不超过 768 KB)、最多留 24 个对话,7 天没写过的被它自己清掉;更早的只在云端
/// - `sand.client.slice.account.<账号>.roster.last-roster`:侧栏的全量列表,每个 bot / 群聊一行
///   (名字、描述、时间、是否从侧栏隐藏、最后一条消息的预览)
///
/// 一个对话一条会话(用户 2026-10-11 定:跟着缓存走)。有副本的按副本出消息,标题(bot 的名字)、
/// 创建时间与隐藏状态以列表为准;副本被清掉的退成一张卡片(描述 + 最后一条预览),不从 Wake 里
/// 消失。两种都如实列出,同一对话的胜负交 scanner 的 `dedup_rank`(副本恒胜,读不出时卡片接住),
/// 与 Antigravity 同法。格式按 0.68.1 的 app 源码与本机 14 份副本核对过
pub struct GrokBotAdapter {
    /// `sand-client-persistence` 目录
    root: PathBuf,
    /// 列表一个账号一份。按文件的 (mtime, size) 记住读出来过的版本与最后一次读成功的内容:同一个
    /// 文件版本只解析一次,解不开时交回上一次读到的(没读成功过是 None)
    rosters: Mutex<RosterCache>,
    /// 读出过键的 `.kblob`(键在首行):文件被删之后还认得出它是哪个账号的哪种切片,删除事件
    /// 要按它对账
    framed: Mutex<HashMap<PathBuf, Slice>>,
}

type FileStamp = (i64, i64);
/// 列表文件 → (读出来过的文件版本, 最后一次读成功的内容)
type RosterCache = HashMap<PathBuf, (FileStamp, Option<Arc<Roster>>)>;

const STORE_DIR: &str = "sand-client-persistence";
const ACCOUNT_SLICE: &str = "sand.client.slice.account.";
const REPLICAS: &str = "transcript.replicas.";
const ROSTER: &str = "roster.last-roster";
/// 键直接编码成文件名
const ENCODED: &str = ".blob";
/// 编码后太长的键:文件名是摘要,首行是键
const FRAMED: &str = ".kblob";
/// app 的上限:编码出的文件名(含 `.blob`)超过它,就改存摘要名的 `.kblob`
const MAX_ENCODED_NAME: usize = 240;
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
/// app 只认这一版副本;别的版本照样按形状读,记一笔未知,格式漂移看得出来
const REPLICA_SCHEMA: i64 = 1;
const NOT_CACHED: &str = "Grok Bot no longer caches this conversation on this computer — only its last message is available in AgentRouter.";
const EARLIER_ONLY_IN_APP: &str =
    "── Earlier messages of this conversation are only in Grok Bot ──";

impl GrokBotAdapter {
    pub fn new() -> Self {
        Self::at(super::electron_user_data("Grok Bot").join(STORE_DIR))
    }

    fn at(root: PathBuf) -> Self {
        Self {
            root,
            rosters: Mutex::new(HashMap::new()),
            framed: Mutex::new(HashMap::new()),
        }
    }

    /// 存储目录里与会话有关的文件(副本与列表)。根不在 = 确定没有;在却列不出报错(scanner 冻结这一轮)
    fn store_files(&self) -> Result<Vec<(PathBuf, Slice)>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        Ok(entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let slice = self.slice_at(&path)?;
                Some((path, slice))
            })
            .collect())
    }

    /// 路径上那份文件存的是哪一种切片;别的存储文件、不是存储文件的都是 None。`.kblob` 的键在
    /// 首行,读出来的记下:文件没了(删除事件)、一时读不出,照样认得出
    fn slice_at(&self, path: &Path) -> Option<Slice> {
        if !is_framed(path) {
            return file_key(path).and_then(|key| slice_of(&key));
        }
        // `.kblob` 的文件名就是它那个键的摘要:记下的键不会过时,不必每次打开文件
        if let Some(slice) = self.framed.lock().unwrap().get(path) {
            return Some(slice.clone());
        }
        let slice = file_key(path).and_then(|key| slice_of(&key))?;
        self.framed
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), slice.clone());
        Some(slice)
    }

    /// 一个账号的列表文件:键编码进文件名的直接算出来,只有编码后太长(`.kblob`)才列目录找——每个
    /// 副本的 `file_ref` 都要它,列表一变 watcher 就把同账号的副本全拿来重比
    fn roster_path(&self, account: &str) -> Option<PathBuf> {
        match store_file_name(&roster_key(account)) {
            Some(name) => Some(self.root.join(name)),
            None => self
                .store_files()
                .ok()?
                .into_iter()
                .find_map(|(path, slice)| {
                    matches!(&slice, Slice::Roster { account: a } if a == account).then_some(path)
                }),
        }
    }

    /// 某个账号的列表
    fn roster_for(&self, account: &str) -> Option<Arc<Roster>> {
        self.roster(&self.roster_path(account)?)
    }

    /// 一个列表文件。文件不在给 None;在却读不出、解不开都先交回上一次读到的。读不出(权限、锁)
    /// 不记这个版本,下次再读——记了的话错误过去之后 mtime / size 没变,连全量刷新都不会再读
    /// (2026-10-11 Codex review);读出来却解不开(写坏了)才记,同一个版本不再白解析
    fn roster(&self, path: &Path) -> Option<Arc<Roster>> {
        let Some(stamp) = stat_stamp(path) else {
            self.rosters.lock().unwrap().remove(path);
            return None;
        };
        if let Some((seen, roster)) = self.rosters.lock().unwrap().get(path) {
            if *seen == stamp {
                return roster.clone();
            }
        }
        // 读文件不持锁
        let raw = fs::read_to_string(path);
        let mut cache = self.rosters.lock().unwrap();
        let last = cache.get(path).and_then(|(_, last)| last.clone());
        let Ok(raw) = raw else {
            return last;
        };
        let roster = parse_value(path, &raw)
            .ok()
            .map(|v| Arc::new(parse_roster(&v)))
            .or(last);
        cache.insert(path.to_path_buf(), (stamp, roster.clone()));
        roster
    }

    fn parse(&self, r: &SessionFileRef) -> Result<(SessionMeta, Vec<TranscriptMessage>, u32)> {
        if let Some((file, id)) = card_parts(&r.file_path) {
            let roster = self
                .roster(file)
                .ok_or_else(|| anyhow!("cannot read the Grok Bot conversation list"))?;
            let row = roster
                .get(id)
                .ok_or_else(|| anyhow!("Grok Bot conversation {id} is not in the list"))?;
            return Ok(card(r, row));
        }
        let path = Path::new(&r.file_path);
        let replica = read_replica(path)?;
        let roster = match self.slice_at(path) {
            Some(Slice::Replica { account, .. }) => self.roster_for(&account),
            _ => None,
        };
        let row = roster
            .as_deref()
            .and_then(|roster| roster.get(&r.native_id));
        let meta = replica_meta(r, row, &replica.messages);
        if meta.message_count > 0 {
            return Ok((meta, replica.messages, replica.unknown));
        }
        // 一条正文都没有(只剩事件、全是不认识的条目):有列表行就按卡片出,挂在副本自己的路径上——
        // 报错退给卡片的话,每轮全量扫描都会把副本重读一遍、把卡片删了重插
        let row = row.ok_or_else(|| {
            anyhow!(
                "Grok Bot transcript has no readable messages: {}",
                r.file_path
            )
        })?;
        let (meta, messages, _) = card(r, row);
        Ok((meta, messages, replica.unknown))
    }
}

/// 键直接编码成的文件名(app 的写法,`<base32>.blob`)。编码出来超过 240 字符的键 app 改存成摘要名的
/// `.kblob`,给 None
pub fn store_file_name(key: &str) -> Option<String> {
    let mut name = String::with_capacity(key.len() * 8 / 5 + 1 + ENCODED.len());
    let (mut acc, mut bits) = (0u32, 0u32);
    for byte in key.bytes() {
        acc = ((acc << 8) | u32::from(byte)) & 0xffff;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            name.push(BASE32[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        name.push(BASE32[((acc << (5 - bits)) & 31) as usize] as char);
    }
    name.push_str(ENCODED);
    (name.len() <= MAX_ENCODED_NAME).then_some(name)
}

/// 文件名里的 base32 → 字节;与 app 一样拒绝非零的填充位
fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = BASE32.iter().position(|&a| a == c)? as u32;
        acc = ((acc << 5) | v) & 0x1fff;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    (acc & ((1 << bits) - 1) == 0).then_some(out)
}

/// 文件里存的键。None = 不是存储文件(写到一半的 `.tmp`、迁移标记)或读不出
fn file_key(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if let Some(stem) = name.strip_suffix(ENCODED) {
        return String::from_utf8(base32_decode(stem)?).ok();
    }
    if is_framed(path) {
        let mut line = String::new();
        BufReader::new(fs::File::open(path).ok()?)
            .read_line(&mut line)
            .ok()?;
        return serde_json::from_str(line.trim_end()).ok();
    }
    None
}

fn is_store_file(name: &str) -> bool {
    name.ends_with(ENCODED) || name.ends_with(FRAMED)
}

/// 编码后太长、改存摘要名的 `.kblob`(首行是键)
fn is_framed(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(FRAMED))
}

/// 读出来的文件内容 → 存的值(`.kblob` 跳过首行的键)
fn parse_value(path: &Path, raw: &str) -> Result<Value> {
    let body = if is_framed(path) {
        raw.split_once('\n').map_or("", |(_, value)| value)
    } else {
        raw
    };
    Ok(serde_json::from_str(body)?)
}

/// 与会话有关的两种键。账号段原样保留(app 存的是 URI 编码过的账号,同一账号的副本与列表靠它配对)
#[derive(Debug, PartialEq, Clone)]
enum Slice {
    Replica {
        account: String,
        conversation: String,
    },
    Roster {
        account: String,
    },
}

fn slice_of(key: &str) -> Option<Slice> {
    let (account, slice) = key.strip_prefix(ACCOUNT_SLICE)?.split_once('.')?;
    if account.is_empty() {
        return None;
    }
    let account = account.to_string();
    if slice == ROSTER {
        return Some(Slice::Roster { account });
    }
    // 子键按 encodeURIComponent 编码、`.` 写成 %2E,原样的 `.` 不会出现
    let sub = slice.strip_prefix(REPLICAS)?;
    (!sub.is_empty() && !sub.contains('.')).then(|| Slice::Replica {
        account,
        conversation: percent_decode(sub),
    })
}

fn roster_key(account: &str) -> String {
    format!("{ACCOUNT_SLICE}{account}.{ROSTER}")
}

/// 卡片的虚拟路径 `<列表文件>#<对话 id>` → (列表文件, 对话 id)。不碰磁盘,是不是列表交给随后读列表去认
fn card_parts(path: &str) -> Option<(&Path, &str)> {
    if !is_card(path) {
        return None;
    }
    let (file, id) = split_virtual_path(path)?;
    (!id.is_empty() && !id.contains(std::path::is_separator)).then(|| (Path::new(file), id))
}

/// 副本文件以存储后缀结尾,卡片的虚拟路径以 `#<对话 id>` 结尾——判断不碰磁盘(`dedup_rank` 在写事务里调)
fn is_card(path: &str) -> bool {
    !is_store_file(path)
}

// ---------------------------------------------------------------- 列表

type Roster = HashMap<String, Row>;

/// 列表里的一行:一个 bot,或一个群聊
struct Row {
    name: String,
    description: String,
    created_ms: i64,
    activity_ms: i64,
    hidden: bool,
    last_entry: String,
}

impl Row {
    fn parse(v: &Value) -> Self {
        let text = |pointer: &str| optional_string(v.pointer(pointer)).unwrap_or_default();
        let ms = |key: &str| v.get(key).map(to_epoch_ms).unwrap_or(0);
        Self {
            name: text("/name"),
            description: text("/description"),
            created_ms: ms("createdAt"),
            activity_ms: match ms("lastActivityAt") {
                0 => ms("updatedAt"),
                t => t,
            },
            hidden: true_at(v, "isHiddenFromSidebar"),
            last_entry: text("/lastEntry/text"),
        }
    }

    /// 这一行里会话用得上的全部东西的指纹,并进引用的 size:卡片的 size 就是它,副本的 size 是文件
    /// 大小加上它。副本也盖住卡片才用的描述与预览——副本读不出正文时退成卡片、挂在副本自己的路径上
    /// (2026-10-11 Codex review);只在 app 里改了名、藏了一下、来了新预览,副本没动也判得出脏
    fn fingerprint(&self) -> i64 {
        sidecar_fingerprint(&[
            &self.name,
            &self.description,
            &self.last_entry,
            if self.hidden { "hidden" } else { "" },
            &self.created_ms.to_string(),
            &self.activity_ms.to_string(),
        ])
    }
}

/// 读得出、却没有 rows 的(格式换了)当空列表:副本照列,只是没有卡片、标题退回第一句话
fn parse_roster(v: &Value) -> Roster {
    v.pointer("/value/rows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let id = row.get("id")?.as_str().filter(|id| !id.is_empty())?;
            Some((id.to_string(), Row::parse(row)))
        })
        .collect()
}

// ---------------------------------------------------------------- 引用与元数据

fn replica_ref(path: &Path, conversation: &str, row: Option<&Row>) -> Option<SessionFileRef> {
    let (mtime_ms, size) = stat_stamp(path).filter(|(_, size)| *size > 0)?;
    Some(SessionFileRef {
        agent: AgentId::GrokBot,
        native_id: conversation.to_string(),
        file_path: path.to_string_lossy().into_owned(),
        mtime_ms,
        size: size + row.map_or(0, Row::fingerprint),
    })
}

fn card_ref(roster: &Path, id: &str, row: &Row) -> SessionFileRef {
    SessionFileRef {
        agent: AgentId::GrokBot,
        native_id: id.to_string(),
        file_path: virtual_path(roster, id),
        mtime_ms: row.activity_ms,
        size: row.fingerprint(),
    }
}

fn base_meta(r: &SessionFileRef) -> SessionMeta {
    SessionMeta {
        key: session_key(AgentId::GrokBot, "", &r.native_id),
        host: String::new(),
        id: r.native_id.clone(),
        agent: AgentId::GrokBot,
        title: UNTITLED.to_string(),
        // bot 不在哪个项目目录里干活,落 Unknown project
        project_path: String::new(),
        project_name: project_name_of(""),
        file_path: r.file_path.clone(),
        created_at: 0,
        updated_at: 0,
        message_count: 0,
        size_bytes: r.size,
        git_branch: None,
        model: None,
        tokens_used: None,
        archived: false,
        source: None,
        spawned: false,
        favorite: false,
        pinned: false,
    }
}

fn row_title(row: &Row) -> Option<String> {
    Some(clean_title_candidate(&row.name)).filter(|title| !title.is_empty())
}

fn replica_meta(
    r: &SessionFileRef,
    row: Option<&Row>,
    messages: &[TranscriptMessage],
) -> SessionMeta {
    let first = messages.iter().filter_map(|m| m.timestamp).min();
    let last = messages.iter().filter_map(|m| m.timestamp).max();
    SessionMeta {
        title: row
            .and_then(row_title)
            .or_else(|| title_from_messages(messages))
            .unwrap_or_else(|| UNTITLED.to_string()),
        // bot 建出来的时刻就是对话开始的时刻;副本被截过头时第一条消息要晚得多
        created_at: row
            .map(|row| row.created_ms)
            .filter(|ms| *ms > 0)
            .or(first)
            .unwrap_or(r.mtime_ms),
        updated_at: last
            .or(row.map(|row| row.activity_ms).filter(|ms| *ms > 0))
            .unwrap_or(r.mtime_ms),
        // 你和 bot 的话;系统提示与事件不算
        message_count: messages
            .iter()
            .filter(|m| m.kind == MessageKind::Text && m.role != Role::System)
            .count() as i64,
        archived: row.is_some_and(|row| row.hidden),
        ..base_meta(r)
    }
}

/// 副本被清掉的对话:列表里的描述与最后一条预览,一条 System 消息承载,详情页与 FTS 都有着落
fn card(r: &SessionFileRef, row: &Row) -> (SessionMeta, Vec<TranscriptMessage>, u32) {
    let mut text = ParsedContent::default();
    text.push_text(&row.description);
    if !row.last_entry.is_empty() {
        text.push_text(&format!("Last message: {}", row.last_entry));
    }
    text.push_text(NOT_CACHED);
    let mut messages = vec![text_msg(Role::System, &text.text, row.activity_ms)];
    assign_seq(&mut messages);
    let created = if row.created_ms > 0 {
        row.created_ms
    } else {
        row.activity_ms
    };
    let meta = SessionMeta {
        title: row_title(row).unwrap_or_else(|| UNTITLED.to_string()),
        created_at: created,
        updated_at: row.activity_ms.max(created),
        archived: row.hidden,
        ..base_meta(r)
    };
    (meta, messages, 0)
}

// ---------------------------------------------------------------- 副本

struct Replica {
    messages: Vec<TranscriptMessage>,
    unknown: u32,
}

fn read_replica(path: &Path) -> Result<Replica> {
    replica(&parse_value(path, &fs::read_to_string(path)?)?)
        .ok_or_else(|| anyhow!("not a Grok Bot transcript: {}", path.display()))
}

/// 条目是聊天界面上的一行,`kind` 分九种(0.68.1 的 `Gg` 表):message(人说的话,或 bot 之间互发的
/// 消息)、send-message(bot 发给你的消息与卡片)、user-attachment、tool-call、notice、event、feedback、
/// voice-call、mcp-app。缓存只存聊天这一层,bot 在云端电脑上跑的命令不在里面
fn replica(v: &Value) -> Option<Replica> {
    let entries = v.pointer("/value/entries")?.as_array()?;
    let mut b = Builder::default();
    if v.get("schemaVersion").and_then(Value::as_i64) != Some(REPLICA_SCHEMA) {
        b.unknown += 1;
    }
    // 只留最近 200 条时,app 记下被截掉那段最后一条的时间
    let preceding = v.pointer("/value/precedingTimestampMs").map(to_epoch_ms);
    let first_seq = entries
        .first()
        .and_then(|e| e.get("seq"))
        .and_then(Value::as_i64);
    if preceding.is_some() || first_seq.is_some_and(|seq| seq > 1) {
        b.messages.push(text_msg(
            Role::System,
            EARLIER_ONLY_IN_APP,
            preceding.unwrap_or(0),
        ));
    }
    for entry in entries {
        b.entry(entry);
    }
    b.flush_attachments();
    let mut messages = b.messages;
    assign_seq(&mut messages);
    Some(Replica {
        messages,
        unknown: b.unknown,
    })
}

#[derive(Default)]
struct Builder {
    messages: Vec<TranscriptMessage>,
    unknown: u32,
    /// 用户附件排在它所属那条消息之前、带同一个 clientNonce:先攒着,并进那条消息;只发了附件的
    /// 单独成一条
    pending: Option<Attachments>,
}

struct Attachments {
    nonce: String,
    ts: i64,
    labels: Vec<String>,
}

impl Builder {
    fn entry(&mut self, e: &Value) {
        let Some(kind) = e.get("kind").and_then(Value::as_str) else {
            self.unknown += 1;
            return;
        };
        let ts = e.get("timestampMs").map(to_epoch_ms).unwrap_or(0);
        if kind == "user-attachment" {
            self.attachment(e, ts);
            return;
        }
        let typed_by_you =
            kind == "message" && str_at(e, "role") == "user" && e.get("fromAgent").is_none();
        let nonce = e.get("clientNonce").and_then(Value::as_str);
        let claimed = self
            .pending
            .take_if(|p| typed_by_you && nonce == Some(p.nonce.as_str()));
        self.flush_attachments();
        match kind {
            "message" => self.message(e, ts, claimed.map(|p| p.labels).unwrap_or_default()),
            "send-message" => self.send_message(e, ts),
            "tool-call" => self.tool_call(e, ts),
            "notice" => self.push(Role::System, str_at(e, "text"), ts),
            "voice-call" => self.push(Role::System, &voice_call(e), ts),
            "mcp-app" => {
                let uri = str_at(e, "resourceUri");
                self.push(Role::Assistant, &format!("[MCP app: {uri}]"), ts);
            }
            // 状态变化(自动化增删、改名、共享)与评价:不是对话,留个记录
            "event" => self.messages.push(meta_msg(&event_text(e), ts)),
            "feedback" => {
                let sentiment = ["sentiment", "state"]
                    .iter()
                    .find_map(|key| text_at(e, key))
                    .unwrap_or("given");
                self.messages
                    .push(meta_msg(&format!("Feedback: {sentiment}"), ts));
            }
            _ => self.unknown += 1,
        }
    }

    fn push(&mut self, role: Role, text: &str, ts: i64) {
        // 流式中的空占位(内容还没来)不成消息
        if !text.trim().is_empty() {
            self.messages.push(text_msg(role, text, ts));
        }
    }

    fn attachment(&mut self, e: &Value, ts: i64) {
        let label = attachment_label(e);
        let nonce = e.get("clientNonce").and_then(Value::as_str);
        if let (Some(pending), Some(nonce)) = (&mut self.pending, nonce) {
            if pending.nonce == nonce {
                pending.labels.push(label);
                return;
            }
        }
        self.flush_attachments();
        match nonce {
            // 认不出属于哪条消息的,直接成一条
            None => self.push(Role::User, &label, ts),
            Some(nonce) => {
                self.pending = Some(Attachments {
                    nonce: nonce.to_string(),
                    ts,
                    labels: vec![label],
                })
            }
        }
    }

    /// 没等到所属消息的附件单独成一条用户消息
    fn flush_attachments(&mut self) {
        if let Some(pending) = self.pending.take() {
            self.push(Role::User, &pending.labels.join("\n"), pending.ts);
        }
    }

    /// `message`:你说的话(role user),或者 bot 之间互发的消息——别的 bot 发给它的也记成 role user、
    /// 带 fromAgent;它发给别的 bot 的是 role assistant、带 toAgent。团队里另一个人说的带 fromUser
    fn message(&mut self, e: &Value, ts: i64, attachments: Vec<String>) {
        let content = str_at(e, "content");
        match e.get("role").and_then(Value::as_str) {
            Some("user") if e.get("fromAgent").is_some() => {
                let peer = name_of(e.get("fromAgent")).unwrap_or("another bot");
                let text = labelled(&format!("Message from {peer}"), content);
                self.push(Role::Assistant, &text, ts);
            }
            Some("user") => {
                let mut text = ParsedContent::default();
                text.push_text(&attachments.join("\n"));
                text.push_text(content);
                let text = match name_of(e.get("fromUser")) {
                    Some(person) => labelled(person, &text.text),
                    None => text.text,
                };
                self.push(Role::User, &text, ts);
            }
            Some("assistant") => {
                let text = match name_of(e.get("toAgent")) {
                    Some(peer) => labelled(&format!("Message to {peer}"), content),
                    None => content.to_string(),
                };
                self.push(Role::Assistant, &text, ts);
            }
            _ => self.unknown += 1,
        }
    }

    /// `send-message`:bot 发给你的一条消息或一张卡片。群聊里带 author(哪个 bot 发的)
    fn send_message(&mut self, e: &Value, ts: i64) {
        let Some(m) = e.get("message").filter(|m| m.is_object()) else {
            self.unknown += 1;
            return;
        };
        let kind = str_at(m, "type");
        let body = match kind {
            "text" => text_with_images(m),
            "attachment" => attachment_text(m),
            "widget" => widget_text(m, e),
            "email-draft" => email_draft_text(m, e),
            "slack-draft" => slack_draft_text(m),
            "secret-request" => secret_request_text(m, e),
            "connector" => {
                let connector = str_at(m, "connector");
                if str_at(m, "variant") == "connected" {
                    format!("Connected {connector}")
                } else {
                    format!("Asked to connect {connector}")
                }
            }
            "auto-review-approval" => approval_text(m),
            _ => {
                if !KNOWN_CARDS.contains(&kind) {
                    self.unknown += 1;
                }
                card_summary(kind, m)
            }
        };
        let text = match name_of(e.get("author")) {
            Some(author) => labelled(author, &body),
            None => body,
        };
        self.push(Role::Assistant, &text, ts);
    }

    /// bot 调的工具(聊天界面默认不显示;缓存里有就挂到它前面那条 bot 消息上)
    fn tool_call(&mut self, e: &Value, ts: i64) {
        let mut view = tool_call_view(
            str_at(e, "id").to_string(),
            str_at(e, "name"),
            &Value::Null,
            None,
            matches!(str_at(e, "status"), "error" | "failed"),
        );
        view.input_preview = make_preview(&Value::String(str_at(e, "summary").to_string()));
        let ix = merge_into_last_assistant(&mut self.messages, ts, ParsedContent::default(), "");
        self.messages[ix].tool_calls.push(view);
    }
}

/// 认得、但没有专门写法的卡片:按 app 自己预览卡片的取法抽几段文字(`card_summary`)
const KNOWN_CARDS: &[&str] = &[
    "cursor-agent",
    "credential-request",
    "user-form",
    "permission-request",
    "cookie-origin-approval",
    "mobile-tool-permission",
    "local-tool-permission",
    "connector-grant",
    "virtual-card-approval",
    "publish-approval",
    "connectors",
    "listener-connect",
    "team-access",
    "slack-connect",
    "scm-connect",
    "onepassword-connect",
    "bot-template-share",
];
/// 卡片里能当文字的字段(app 给卡片拼预览时认的那几个,加上名称类)
const CARD_TEXT_KEYS: &[&str] = &[
    "content",
    "text",
    "title",
    "label",
    "prompt",
    "summary",
    "reason",
    "description",
    "detail",
    "target",
    "action",
    "question",
    "body",
    "name",
    "serverName",
    "slug",
    "platform",
    "provider",
    "connectors",
    "toolId",
    "machineLabel",
];
const CARD_TEXT_MAX: usize = 8;

fn str_at<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn name_of(v: Option<&Value>) -> Option<&str> {
    text_at(v?, "name")
}

/// `**标签**` 起头的一段:群聊里是谁说的、bot 之间的消息是发给谁的。正文是空的(流式中还没来
/// 内容的占位)整段给空,`push` 才滤得掉——只剩一个名字的消息不是消息(2026-10-11 Codex review)
fn labelled(label: &str, body: &str) -> String {
    match body.trim() {
        "" => String::new(),
        body => format!("**{label}**\n\n{body}"),
    }
}

fn is_image_name(name: &str) -> bool {
    let ext = name.rsplit_once('.').map_or("", |(_, ext)| ext);
    [
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif", "bmp", "svg",
    ]
    .iter()
    .any(|known| ext.eq_ignore_ascii_case(known))
}

/// 你发的附件:文件在云端电脑上(`/home/box/…`),本机只有名字
fn attachment_label(e: &Value) -> String {
    let name = text_at(e, "file_name").unwrap_or_else(|| path_tail(str_at(e, "file_path")));
    if e.get("width").is_some() || is_image_name(name) {
        format!("[image: {name}]")
    } else {
        format!("[file: {name}]")
    }
}

/// 图片都是云端的地址或云端电脑上的路径,本机解不出来,留占位
fn text_with_images(m: &Value) -> String {
    let mut text = ParsedContent::default();
    text.push_text(str_at(m, "content"));
    for image in m
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        text.push_text(&match text_at(image, "alt") {
            Some(alt) => format!("[image: {alt}]"),
            None => IMAGE_PLACEHOLDER.to_string(),
        });
    }
    text.text
}

/// bot 发给你的文件
fn attachment_text(m: &Value) -> String {
    let url = str_at(m, "url");
    let name = text_at(m, "file_name").unwrap_or_else(|| path_tail(url));
    // 只有网页地址点得开;file:// 指的是云端电脑上的文件
    if url.starts_with("https://") || url.starts_with("http://") {
        format!("[file: {name}]({url})")
    } else {
        format!("[file: {name}]")
    }
}

/// 选项显示的文字:label,没有退回 value
fn option_label(option: &Value) -> Option<&str> {
    text_at(option, "label").or_else(|| text_at(option, "value"))
}

/// 让你选的问题卡片:问题、选项,和你选了什么
fn widget_text(m: &Value, e: &Value) -> String {
    let widget = m.get("widget").unwrap_or(&Value::Null);
    let options: Vec<&Value> = widget
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let mut out = ParsedContent::default();
    out.push_text(str_at(widget, "prompt"));
    let lines: Vec<String> = options
        .iter()
        .filter_map(|option| {
            let label = option_label(option)?;
            Some(match text_at(option, "description") {
                Some(description) => format!("- {label} — {description}"),
                None => format!("- {label}"),
            })
        })
        .collect();
    out.push_text(&lines.join("\n"));
    if let Some(answer) = text_at(e, "respondedValue") {
        // 回的是选项的 value,换回它的文字;自己填的原样
        let label = options
            .iter()
            .find(|option| str_at(option, "value") == answer)
            .and_then(|option| option_label(option))
            .unwrap_or(answer);
        out.push_text(&format!("Answer: {label}"));
    } else if true_at(e, "widgetSkipped") {
        out.push_text("Skipped");
    } else if true_at(e, "widgetDismissed") {
        out.push_text("Dismissed");
    }
    out.text
}

fn email_draft_text(m: &Value, e: &Value) -> String {
    let draft = m.get("draft").unwrap_or(&Value::Null);
    let to: Vec<&str> = draft
        .get("to")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut head = format!("Email draft: {}", str_at(draft, "subject").trim());
    if !to.is_empty() {
        head.push_str(&format!("\nTo: {}", to.join(", ")));
    }
    let mut out = ParsedContent::default();
    out.push_text(&head);
    out.push_text(str_at(draft, "body"));
    if let Some(state) = text_at(e, "draftSendState") {
        out.push_text(&format!("Status: {state}"));
    }
    out.text
}

fn slack_draft_text(m: &Value) -> String {
    let draft = m.get("draft").unwrap_or(&Value::Null);
    let mut out = ParsedContent::default();
    out.push_text(&format!(
        "Slack draft to {}",
        str_at(draft, "target").trim()
    ));
    out.push_text(str_at(draft, "body"));
    out.text
}

/// 向你要一个密钥:只有要什么、填没填,值本身从不在缓存里
fn secret_request_text(m: &Value, e: &Value) -> String {
    let request = m.get("secretRequest").unwrap_or(&Value::Null);
    let mut out = ParsedContent::default();
    out.push_text(&format!(
        "Requested a secret: {}",
        str_at(request, "label").trim()
    ));
    out.push_text(str_at(request, "description"));
    if true_at(e, "secretProvided") {
        out.push_text("Provided");
    }
    out.text
}

/// 要你批准的一步操作(自动审核)
fn approval_text(m: &Value) -> String {
    let approval = m.get("approval").unwrap_or(&Value::Null);
    let summary = str_at(approval, "summary").trim();
    let mut out = ParsedContent::default();
    out.push_text(&match text_at(approval, "status") {
        Some(status) => format!("Approval ({status}): {summary}"),
        None => format!("Approval: {summary}"),
    });
    if let Some(command) = text_at(approval, "command") {
        out.push_text(&format!("`{command}`"));
    }
    out.push_text(str_at(approval, "reason"));
    out.text
}

/// 其余卡片:类型名加上卡片里的几段文字
fn card_summary(kind: &str, m: &Value) -> String {
    let mut parts = Vec::new();
    collect_card_text(m, 0, &mut parts);
    let label = humanize(kind).unwrap_or_else(|| "Card".to_string());
    if parts.is_empty() {
        label
    } else {
        format!("{label}: {}", parts.join("\n"))
    }
}

fn collect_card_text(v: &Value, depth: usize, out: &mut Vec<String>) {
    if depth > 3 || out.len() >= CARD_TEXT_MAX {
        return;
    }
    match v {
        Value::Object(map) => {
            for (key, value) in map {
                match value {
                    Value::String(s) if CARD_TEXT_KEYS.contains(&key.as_str()) => {
                        let s = s.trim();
                        if !s.is_empty() && !out.iter().any(|seen| seen == s) {
                            out.push(s.to_string());
                        }
                    }
                    Value::Array(items) if CARD_TEXT_KEYS.contains(&key.as_str()) => {
                        let names: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
                        if !names.is_empty() {
                            out.push(names.join(", "));
                        }
                    }
                    _ => collect_card_text(value, depth + 1, out),
                }
                if out.len() >= CARD_TEXT_MAX {
                    return;
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_card_text(item, depth + 1, out);
            }
        }
        _ => {}
    }
}

/// `secret-request` → "Secret request";空的给 None
fn humanize(kind: &str) -> Option<String> {
    let words = kind.replace(['-', '_'], " ");
    let mut chars = words.trim().chars();
    let first = chars.next()?;
    Some(first.to_uppercase().chain(chars).collect())
}

fn voice_call(e: &Value) -> String {
    let secs = e
        .pointer("/call/durationMs")
        .and_then(Value::as_f64)
        .map_or(0, |ms| (ms / 1000.0).round() as i64);
    if secs > 0 {
        format!("Voice call ({}:{:02})", secs / 60, secs % 60)
    } else {
        "Voice call".to_string()
    }
}

fn event_text(e: &Value) -> String {
    let event = e.get("event").unwrap_or(&Value::Null);
    match str_at(event, "type") {
        "automation-changed" => format!(
            "Automation {}: {}",
            str_at(event, "action"),
            str_at(event, "automationName")
        ),
        "name-changed" => format!(
            "Renamed from “{}” to “{}”",
            str_at(event, "from"),
            str_at(event, "to")
        ),
        other => humanize(other).unwrap_or_else(|| "Event".to_string()),
    }
}

impl AgentAdapter for GrokBotAdapter {
    fn agent(&self) -> AgentId {
        AgentId::GrokBot
    }

    fn list_session_files(&self) -> Result<Vec<SessionFileRef>> {
        let files = self.store_files()?;
        let mut rosters: HashMap<&str, (&Path, Arc<Roster>)> = HashMap::new();
        for (path, slice) in &files {
            if let Slice::Roster { account } = slice {
                // 列表在却从没读成功过:报错,scanner 把这一家这一轮冻结住——当成"没有对话"会把
                // 卡片整批删掉
                let roster = self
                    .roster(path)
                    .ok_or_else(|| anyhow!("cannot read the Grok Bot conversation list"))?;
                rosters.insert(account.as_str(), (path.as_path(), roster));
            }
        }
        let mut refs = Vec::new();
        for (path, slice) in &files {
            if let Slice::Replica {
                account,
                conversation,
            } = slice
            {
                let row = rosters
                    .get(account.as_str())
                    .and_then(|(_, roster)| roster.get(conversation));
                refs.extend(replica_ref(path, conversation, row));
            }
        }
        // 有副本的对话也照列卡片:scanner 按 dedup_rank 取副本,副本被清掉、读不出时退回卡片
        for (path, roster) in rosters.values() {
            refs.extend(roster.iter().map(|(id, row)| card_ref(path, id, row)));
        }
        Ok(refs)
    }

    /// 副本文件,以及卡片的虚拟路径(scanner 按 file_path 重解析时用)
    fn file_ref(&self, path: &Path) -> Option<SessionFileRef> {
        if let Some((roster, id)) = path.to_str().and_then(card_parts) {
            return self
                .roster(roster)?
                .get(id)
                .map(|row| card_ref(roster, id, row));
        }
        let Some(Slice::Replica {
            account,
            conversation,
        }) = self.slice_at(path)
        else {
            return None;
        };
        let roster = self.roster_for(&account);
        let row = roster
            .as_deref()
            .and_then(|roster| roster.get(&conversation));
        replica_ref(path, &conversation, row)
    }

    /// 列表文件变了(改名、隐藏、新消息的预览),同一账号的副本的引用跟着变,它们自己却没动。
    /// 卡片的增删与重比走 `sessions_in`
    fn ref_dependents(&self, path: &Path) -> Vec<PathBuf> {
        let Some(Slice::Roster { account }) = self.slice_at(path) else {
            return Vec::new();
        };
        self.store_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(file, slice)| {
                matches!(&slice, Slice::Replica { account: a, .. } if *a == account).then_some(file)
            })
            .collect()
    }

    /// 列表文件此刻列着的卡片:bot 新建出来、从列表里删掉,卡片当场跟上。文件没了 = 这个账号一张
    /// 卡片都不剩;在却从没读成功过 = 不知道
    fn sessions_in(&self, path: &Path) -> Option<Vec<SessionFileRef>> {
        let Some(Slice::Roster { .. }) = self.slice_at(path) else {
            return None;
        };
        match self.roster(path) {
            Some(roster) => Some(
                roster
                    .iter()
                    .map(|(id, row)| card_ref(path, id, row))
                    .collect(),
            ),
            None => (!path.exists()).then(Vec::new),
        }
    }

    fn parse_session(&self, r: &SessionFileRef) -> Result<ParsedSession> {
        let (meta, messages, unknown) = self.parse(r)?;
        Ok(ParsedSession::derive(meta, &messages, unknown))
    }

    fn parse_transcript(&self, r: &SessionFileRef) -> Result<ParsedTranscript> {
        let (meta, messages, unknown) = self.parse(r)?;
        Ok(ParsedTranscript {
            meta,
            mainline: messages,
            sidechains: Vec::new(),
            unknown_line_count: unknown,
        })
    }

    /// 同一对话的副本永远压过列表里的卡片——卡片只是副本被清掉之后的占位
    fn dedup_rank(&self, path: &str) -> u8 {
        u8::from(is_card(path))
    }

    /// 对话本体在云端,副本是 app 的缓存——移走了它照样写回来。删除只记墓碑,不动任何文件
    /// (确认框因此叫 Hide)
    fn session_paths(&self, _meta: &SessionMeta) -> Vec<String> {
        Vec::new()
    }

    fn with_custom_root(&self, dir: PathBuf) -> Box<dyn AgentAdapter> {
        Box::new(Self::at(store_dir_of(dir)))
    }

    fn data_roots(&self) -> Vec<PathBuf> {
        vec![self.root.clone()]
    }
}

/// 自定义 location 选中的目录 → 存储目录:选的就是 `sand-client-persistence`(或直接放着存储文件的
/// 拷贝)用它本身,其余当 userData 目录。只看选中的路径本身,不存在时落 userData 形态
fn store_dir_of(dir: PathBuf) -> PathBuf {
    if dir.file_name().is_some_and(|name| name == STORE_DIR) {
        return dir;
    }
    let holds_store_files = fs::read_dir(&dir).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| is_store_file(&entry.file_name().to_string_lossy()))
    });
    if holds_store_files {
        dir
    } else {
        dir.join(STORE_DIR)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn file_names_and_store_keys_round_trip() {
        // 本机存储目录里的真实文件名(键本身不含任何对话内容):编码与解码都对着 app 的写法
        const UI_LAYOUT: &str = "sand.client.slice.ui-layout";
        const NAME: &str = "onqw4zbomnwgszlooqxhg3djmnss45ljfvwgc6lpov2a.blob";
        assert_eq!(store_file_name(UI_LAYOUT).as_deref(), Some(NAME));
        assert_eq!(file_key(Path::new(NAME)).as_deref(), Some(UI_LAYOUT));
        let key = "sand.client.slice.account.google-oauth2%7Cuser_01ABC.transcript.replicas.0f0f-1";
        let name = store_file_name(key).unwrap();
        assert_eq!(file_key(Path::new(&name)).as_deref(), Some(key));
        // 编码后超过 240 字符的键 app 存成摘要名的 .kblob
        assert_eq!(store_file_name(&roster_key(&"x".repeat(150))), None);
        // 字母表外的字符、非零的填充位、写到一半的 .tmp 都不是键
        assert_eq!(base32_decode("onqw1"), None);
        assert_eq!(base32_decode("ob"), None);
        assert_eq!(file_key(Path::new(&format!("{name}.tmp"))), None);
    }

    #[test]
    fn keys_split_into_account_and_slice() {
        assert_eq!(
            slice_of("sand.client.slice.account.github%7C42.transcript.replicas.36c7-b95a"),
            Some(Slice::Replica {
                account: "github%7C42".into(),
                conversation: "36c7-b95a".into()
            })
        );
        assert_eq!(
            slice_of(&roster_key("github%7C42")),
            Some(Slice::Roster {
                account: "github%7C42".into()
            })
        );
        for other in [
            "sand.client.slice.ui-layout",
            "sand.client.slice.account.github%7C42.send-journal",
            "sand.client.slice.account.github%7C42.transcript.replicas.",
            "sand.client.slice.account..roster.last-roster",
        ] {
            assert_eq!(slice_of(other), None, "{other}");
        }
    }

    #[test]
    fn cards_are_told_apart_from_replicas_without_touching_the_disk() {
        assert!(is_card("/x/sand-client-persistence/abc.blob#36c7"));
        assert!(!is_card("/x/sand-client-persistence/abc.blob"));
        assert!(!is_card("/x/sand-client-persistence/abc.kblob"));
        assert_eq!(
            card_parts("/x/abc.blob#36c7").map(|(file, id)| (file.to_path_buf(), id)),
            Some((PathBuf::from("/x/abc.blob"), "36c7"))
        );
        // 真实路径里也可能有 `#`(家目录叫 a#b):不是卡片
        assert_eq!(card_parts("/Users/a#b/x/abc.blob"), None);
        assert_eq!(card_parts("/Users/a#b/x/abc.blob.tmp"), None);
    }

    fn replica_of(entries: Value) -> Replica {
        replica(&json!({"schemaVersion": 1, "value": {"entries": entries, "persistedAt": 1}}))
            .unwrap()
    }

    #[test]
    fn attachments_join_the_message_they_were_sent_with() {
        let r = replica_of(json!([
            {"kind": "user-attachment", "id": "a1", "seq": 1, "timestampMs": 10, "clientNonce": "n1",
             "file_path": "/home/box/agent-data/up/shot.png", "file_name": "shot.png", "width": 10, "height": 10},
            {"kind": "message", "id": "m1", "seq": 2, "timestampMs": 10, "clientNonce": "n1",
             "role": "user", "content": "看这个"},
            {"kind": "user-attachment", "id": "a2", "seq": 3, "timestampMs": 20, "clientNonce": "n2",
             "file_path": "/home/box/agent-data/up/notes.pdf"},
            {"kind": "send-message", "id": "s1", "seq": 4, "timestampMs": 30,
             "message": {"type": "text", "content": "收到"}}
        ]));
        let texts: Vec<(Role, &str)> = r
            .messages
            .iter()
            .map(|m| (m.role, m.text.as_str()))
            .collect();
        assert_eq!(
            texts,
            vec![
                (Role::User, "[image: shot.png]\n\n看这个"),
                (Role::User, "[file: notes.pdf]"),
                (Role::Assistant, "收到"),
            ]
        );
        assert_eq!(r.unknown, 0);
    }

    #[test]
    fn unknown_kinds_and_card_types_are_counted() {
        let r = replica_of(json!([
            {"kind": "hologram", "id": "x", "seq": 1},
            {"kind": "send-message", "id": "y", "seq": 2, "timestampMs": 5,
             "message": {"type": "teleport", "title": "Beam me up"}},
            {"kind": "send-message", "id": "z", "seq": 3, "timestampMs": 6,
             "message": {"type": "connectors", "connectors": ["gmail", "notion"]}}
        ]));
        assert_eq!(r.unknown, 2, "未知的条目种类与卡片类型各记一笔");
        let texts: Vec<&str> = r.messages.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(
            texts,
            vec!["Teleport: Beam me up", "Connectors: gmail, notion"]
        );
    }

    /// 流式中的空占位不成消息:群聊里带 author 的、bot 之间互发的,标签不能把空正文顶成一条
    #[test]
    fn empty_streaming_messages_stay_out_even_with_a_label() {
        let r = replica_of(json!([
            {"kind": "send-message", "id": "s1", "seq": 1, "timestampMs": 5,
             "author": {"name": "Scout"}, "message": {"type": "text", "content": ""}},
            {"kind": "message", "id": "m1", "seq": 2, "timestampMs": 6, "role": "user",
             "fromAgent": {"name": "Scout"}, "content": " "},
            {"kind": "message", "id": "m2", "seq": 3, "timestampMs": 7, "role": "assistant",
             "toAgent": {"name": "Scout"}, "content": ""}
        ]));
        assert!(r.messages.is_empty(), "{:?}", r.messages);
    }

    /// 列表一时读不出(权限、锁):错误过去之后文件的 mtime / size 没变,也得重新读到
    #[cfg(unix)]
    #[test]
    fn a_roster_that_could_not_be_read_is_read_again() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let adapter = GrokBotAdapter::at(tmp.path().to_path_buf());
        let path = tmp
            .path()
            .join(store_file_name(&roster_key("github%7C1")).unwrap());
        fs::write(
            &path,
            r#"{"schemaVersion":4,"value":{"rows":[{"id":"c1","name":"Ada"}]}}"#,
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        // root 读得动没有权限的文件,前提不成立就不测
        if fs::read(&path).is_err() {
            assert!(adapter.roster(&path).is_none());
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(adapter
            .roster(&path)
            .is_some_and(|roster| roster.contains_key("c1")));
    }
}
