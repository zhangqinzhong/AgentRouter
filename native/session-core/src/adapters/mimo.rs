//! MiMo Code(小米 MiMo 团队的终端 coding agent,github.com/XiaomiMiMo/MiMo-Code,MIT;
//! issue #77)。从 OpenCode fork 出来:`<数据根>/mimocode.db` 的 session / message / part
//! 三表与 OpenCode v1 同名,part 的 JSON 同形,正文解码走 opencode.rs 的
//! `parse_v1_messages`。分家的地方(与 ZCode 同一个理由,不能当孪生实例):
//!
//! - session 表没有 model / tokens 三列(fork 自 2026-01 的 OpenCode,那时还没有这几列),
//!   OpenCode 的枚举 SQL 对它 prepare 就失败。模型取助手消息的 `modelID`,token 按调用累加
//!   `tokens.input / output / reasoning`(与 OpenCode 会话列同一个口径)。
//! - 一个会话里不止一条"道":`message.agent_id` 为 `main` 的是主线,同会话的子代理(actor 的
//!   subagent 模式,`explore-1` 这类)各写各的道。会话本身显示哪条照 MiMo 自己界面的
//!   `selectMessages`:有 main 用 main;peer 模式派出的子会话把自己那几轮写在以子会话 id 命名的
//!   道上;都没有(`ask:` 旁问的宿主会话)用最新的那条。其余的道各是一条子会话(Kimi 的
//!   `agents/<非 main>` 同形):原生 id `<会话>/<actor id>`(`lane_id`),父会话写在 id 里
//!   (`parent_in_path`:停在直接父会话上、不能单独恢复),标题是派活时那句 description(没给时
//!   它等于 agent 类型名,退回收到的任务),跟着所在会话归档,token 各算各的道;派它的 actor
//!   调用跳得过去。运行时自己派的那几种(见下)的道是簿记、不列;fork 复制来的道(每条消息都早于
//!   会话的创建)也不列。
//! - 会导入别家的会话(`external_import`:Claude Code、Codex、OpenCode,用户在 MiMo 里点导入):
//!   导进来的消息原样复制进 main 道,`message_ids` 记着哪些是导入的。那几家 Wake 本来就索引着,
//!   只有导入的会话不列;导入后在 MiMo 里接着聊过的照列,导入的那段折成一条标记、token 不算。
//!   `message_ids` 读不出的老记录分不清哪些是导入的,整条当导入。
//! - fork(`Session.fork`)把原会话的消息复制进新会话(新 id、保留原时间)、不记父会话:复制来的
//!   消息时间都早于新会话的创建时间,按这一条折成一条标记,token 与模型只算之后的(Codex / ZCode
//!   的分叉同一个理由)。
//! - 哪些会话显示照 MiMo 的 `session/visibility.ts`:顶层会话与 peer 子会话都显示;运行时自己派的
//!   checkpoint-writer / dream / distill(`SYSTEM_SPAWNED_AGENT_TYPES`)的宿主子会话是簿记、
//!   不是对话,不列。自动整理记忆的 "Auto Dream" / "Auto Distill" 顶层会话 MiMo 自己照列(带
//!   Auto 徽章),这里也列,但不算用户开的会话(`spawned`)。
//!
//! 用户消息带 `provenance`(钩子、主机自动化、别的 agent 发来的)就不是人打的字,归 Meta(MiMo
//! 自己起标题也这么认);钩子发来的、收件箱投递的文本块本身就标了 synthetic。助手消息
//! `summary: true` 是压缩出的摘要、带 `checkpoint` 块的那条是检查点重建的上下文,都折成摘要。
//! 标题来源 `fallback` 时标题只是占位的 "Untitled",退回首条提问(2026-09 之前的老库占位是空串)。
//!
//! 数据根:它用的 xdg-basedir 5.1.0 在三个平台都给 `~/.local/share/mimocode`(`XDG_DATA_HOME`
//! 覆盖),设了 `MIMOCODE_HOME` 就是 `$MIMOCODE_HOME/data`。它的 README 说 macOS 在
//! `~/Library/Application Support/mimocode`、Windows 在 `%LOCALAPPDATA%\mimocode`,与代码对不上,
//! 两处都只当候选(真有库才采信,Devin 同款)。`MIMOCODE_DB` 与渠道库(`mimocode-<渠道>.db`)
//! 只有测试与开发构建用,不跟。库里同时存着账号的 access / refresh token,所以不做远程同步。
//!
//! 本机没装 MiMo Code:格式全按源码(main 2026-10-22,v0.1.15 之后)推断、**未经真机验证**,
//! fixture 合成。
use super::opencode::{parse_v1_messages, V1Query};
use super::parse_utils::*;
use super::sqlite_ro::{
    db_cache_stamp, has_table, open_sqlite_ro, split_virtual_path, strip_virtual_path,
    table_columns, virtual_path, SqliteRo,
};
use super::{AgentAdapter, ParentInPath};
use crate::models::*;
use anyhow::{anyhow, Result};
use rusqlite::{Connection, OptionalExtension as _};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const DB_NAME: &str = "mimocode.db";
/// XDG data 根下的目录名
const DATA_DIR: &str = "mimocode";
/// 运行时自己派的 agent(MiMo 的 `SYSTEM_SPAWNED_AGENT_TYPES`):它们的宿主子会话与道不是对话
const SYSTEM_AGENTS: [&str; 3] = ["checkpoint-writer", "dream", "distill"];
/// 自动整理记忆的顶层会话(MiMo 的 `isSystemSession` 按标题认)
const SYSTEM_TITLES: [&str; 2] = ["Auto Dream", "Auto Distill"];

/// 同会话子代理那条道作为子会话时的原生 id:`<会话>/<actor id>`(两段里都没有 `/`:会话 id 是
/// `ses_…`,actor id 是 `<agent>-<n>`)
fn lane_id(session: &str, actor: &str) -> String {
    format!("{session}/{actor}")
}

/// `lane_id` 反过来:原生 id 拆成 (会话, 道);会话本身没有道
fn split_lane(id: &str) -> (&str, Option<&str>) {
    match id.split_once('/') {
        Some((session, actor)) => (session, Some(actor)),
        None => (id, None),
    }
}

/// 道子会话的父会话(`parent_in_path`):虚拟路径 `<库>#<会话>/<actor id>` 里的会话 id;会话本身
/// 给 None
fn lane_parent(path: &Path) -> Option<String> {
    let (_, id) = split_virtual_path(path.to_str()?)?;
    let (session, actor) = split_lane(id);
    actor.map(|_| session.to_string())
}

/// actor 工具派活调用跳去的子会话(`ToolCallView::child_id`):metadata 记着会话与 actor。peer 是
/// 另一个会话(actor id 就是它的会话 id),同会话的子代理是这个会话里的一条道;指回会话自己的
/// (缺了 actorId,分不出是哪条道)不算
fn actor_child(session: &str, metadata: &Value) -> Option<String> {
    let target = optional_string(metadata.get("sessionId"))?;
    let child = match optional_string(metadata.get("actorId")) {
        Some(actor) if actor != target => lane_id(&target, &actor),
        _ => target,
    };
    (child != session).then_some(child)
}

/// part 的类型(`text` / `tool` / `checkpoint` …)
fn part_type(part: &Value) -> Option<&str> {
    part.get("type").and_then(Value::as_str)
}

pub struct MimoAdapter {
    db: PathBuf,
    /// 列出来的会话与道子会话,按库戳缓存一轮扫描内的重复调用(枚举查询带全表相关子查询)
    rows_cache: MtimeCache<Arc<Vec<MiRow>>>,
}

/// 列出来的一条:会话本身(`query_rows`),或会话里同会话子代理的一条道(`query_lanes`)
struct MiRow {
    /// 原生 id:会话 id,或道的 `lane_id`
    id: String,
    /// 消息所在的会话
    session: String,
    /// 道子会话读的那条道;None = 会话本身(读要显示的那条)
    actor: Option<String>,
    /// 道子会话的项目与归档跟着所在的会话
    directory: String,
    /// 会话的标题;道子会话是派活时那句 description(没给是空串,退回收到的任务)
    title: String,
    /// 标题来源 `fallback`:占位的 "Untitled"
    placeholder_title: bool,
    created_ms: i64,
    updated_ms: i64,
    archived: bool,
    /// part.data 字节数(会话算全部道)——SessionFileRef.size 的脏判据(单条取行时不算)
    content_len: i64,
    /// 会话自己那一行的 parent_id;道子会话的父会话在 id 里(`lane_parent`)
    parent: Option<String>,
}

impl MiRow {
    /// `query_rows` 与 `query_lanes` 共用的列序:会话 id、道(会话本身是 NULL)、目录、标题、标题
    /// 来源、起止时间、归档时间、parent_id、part 字节数。缺列给默认值:老库不得整家消失
    fn from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let session: String = r.get(0)?;
        let actor: Option<String> = r.get(1)?;
        Ok(Self {
            id: match &actor {
                Some(actor) => lane_id(&session, actor),
                None => session.clone(),
            },
            session,
            actor,
            directory: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            placeholder_title: r.get::<_, Option<String>>(4)?.as_deref() == Some("fallback"),
            created_ms: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
            updated_ms: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
            archived: r.get::<_, Option<i64>>(7)?.is_some(),
            parent: r
                .get::<_, Option<String>>(8)?
                .filter(|parent| !parent.is_empty()),
            content_len: r.get::<_, Option<i64>>(9)?.unwrap_or(0),
        })
    }

    /// 不是用户开的会话:子会话(peer 子代理、旁问、工作流的一步、同会话子代理的道),与自动整理
    /// 记忆的那两种
    fn spawned(&self) -> bool {
        self.actor.is_some()
            || self.parent.is_some()
            || SYSTEM_TITLES.contains(&self.title.as_str())
    }
}

/// 逐版加进来的表与列各自在不在(初始 schema 里的不用探)
#[derive(Clone, Copy)]
struct MiSchema {
    /// 刚建好、还没迁移的库没有会话表:确定没有会话
    sessions: bool,
    /// message.agent_id(2026-05 起;之前一个会话只有一条道)
    lanes: bool,
    /// message.agent_id 还可以为空:2026-05-21 加这一列时主线的消息留着 NULL,05-26 才补成 'main'
    /// 并改成 NOT NULL。停在这几天之间的库,NULL 就是主线(`agent`)
    null_main: bool,
    /// session.title_source(2026-09 起)
    title_source: bool,
    /// external_import 表(2026-06 起)
    imports: bool,
    /// actor_registry 带着 session_id / mode / agent:它 2026-05-15 由 task_registry 改名而来,
    /// 05-21 重建之后才是这个形状,只探表名会把中间那几天的库读挂
    actors: bool,
}

impl MiSchema {
    /// 查询出错(文件不是 SQLite、读到一半出错)往上交,别当成没有
    fn probe(conn: &Connection) -> rusqlite::Result<Self> {
        let actors = table_columns(conn, "actor_registry");
        // agent_id 在不在、是不是 NOT NULL
        let agent_id: Option<bool> = conn
            .query_row(
                "SELECT \"notnull\" FROM pragma_table_info('message') WHERE name = 'agent_id'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(Self {
            sessions: has_table(conn, "session")?,
            lanes: agent_id.is_some(),
            null_main: agent_id == Some(false),
            title_source: table_columns(conn, "session").contains("title_source"),
            imports: has_table(conn, "external_import")?,
            actors: ["session_id", "mode", "agent"]
                .iter()
                .all(|c| actors.contains(*c)),
        })
    }

    /// 消息在哪条道(`col` 是 agent_id 列,带表名):`null_main` 的库里 NULL 算 main。别的库原样用
    /// 列,(session_id, agent_id) 索引照走
    fn agent(&self, col: &str) -> String {
        if self.null_main {
            format!("COALESCE({col}, 'main')")
        } else {
            col.to_string()
        }
    }

    /// 会话要显示的那条道(MiMo 界面的 `selectMessages`):有 main 用 main,peer 子会话用以它自己的
    /// id 命名的那条,都没有用最新消息所在的那条。`sid` 是会话 id 的 SQL 表达式;老库只有一条道
    fn lane(&self, sid: &str) -> Option<String> {
        let agent = self.agent("x.agent_id");
        self.lanes.then(|| {
            format!(
                "(CASE WHEN EXISTS (SELECT 1 FROM message x WHERE x.session_id = {sid} AND {agent} = 'main') THEN 'main'
                       WHEN EXISTS (SELECT 1 FROM message x WHERE x.session_id = {sid} AND {agent} = {sid}) THEN {sid}
                       ELSE (SELECT {agent} FROM message x WHERE x.session_id = {sid} ORDER BY x.id DESC LIMIT 1) END)"
            )
        })
    }

    /// 列哪些会话(枚举的 WHERE)。一是 MiMo 的 `classifySession`:顶层会话与 peer 子会话恒显示,
    /// 宿主着运行时自己派的 agent 的子会话不显示。二是导入的会话只在 MiMo 里接着聊过才列——main 道
    /// 里有不是导入的消息(导入只写 main 道);导入记录分不清哪些是导入的(`message_ids` 为空或读
    /// 不出),整条当导入。导入那几个子查询都不相关、整条语句只建一次:按 s.id 取的相关写法每条
    /// 消息求值一遍、每遍整表扫 external_import(它在 session_id 上没有索引),一千条导入就要好几秒
    fn listed(&self) -> String {
        let mut conds = Vec::new();
        if self.actors {
            conds.push(format!(
                "NOT (COALESCE(s.parent_id, '') != ''
                      AND NOT EXISTS (SELECT 1 FROM actor_registry a WHERE a.session_id = s.id AND a.mode = 'peer')
                      AND EXISTS (SELECT 1 FROM actor_registry a WHERE a.session_id = s.id AND a.agent IN ({})))",
                system_agents()
            ));
        }
        if self.imports {
            conds.push(format!(
                "(s.id NOT IN (SELECT session_id FROM external_import)
                  OR (s.id NOT IN (SELECT session_id FROM external_import
                                   WHERE message_ids IS NULL OR NOT json_valid(message_ids))
                      AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND {} = 'main'
                                  AND m.id NOT IN {})))",
                self.agent("m.agent_id"),
                imported_ids(None)
            ));
        }
        if conds.is_empty() {
            "1".to_string()
        } else {
            conds.join(" AND ")
        }
    }

    /// 转录读哪些消息(`V1Query::filter`,`?1` = 会话 id):会话读要显示的那条道、导入过就去掉
    /// 导入的;道子会话读它那条道
    fn transcript(&self, row: &MiRow, imported: bool) -> Option<String> {
        let lane = match &row.actor {
            Some(actor) => Some(sql_text(actor)),
            None => self.lane("?1"),
        };
        let conds: Vec<String> = [
            lane.map(|lane| format!("{} = {lane}", self.agent("agent_id"))),
            imported.then(|| format!("id NOT IN {}", imported_ids(Some("?1")))),
        ]
        .into_iter()
        .flatten()
        .collect();
        (!conds.is_empty()).then(|| conds.join(" AND "))
    }
}

/// SQL 字符串字面量(单引号转义)
fn sql_text(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 运行时自己派的 agent,拼进 `IN (…)`
fn system_agents() -> String {
    SYSTEM_AGENTS
        .iter()
        .map(|a| sql_text(a))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 导入来的消息 id(`external_import.message_ids`);`scope` 给了(会话 id 的 SQL 表达式)就只取
/// 那个会话的。不是合法 JSON 的按空的算;只取字符串元素——`NOT IN` 的列表里混进一个 NULL,整个
/// 条件就是 NULL、一条都选不中。消息 id 是主键,左边只放它一列、不配会话 id:换成 (会话, 消息) 对
/// 的话,SQLite 没法一次判完列表里有没有 NULL,每次没命中都把整份列表扫一遍(一千多条导入时列
/// 一遍会话要两秒多)
fn imported_ids(scope: Option<&str>) -> String {
    let scope = scope
        .map(|sid| format!(" AND e.session_id = {sid}"))
        .unwrap_or_default();
    format!(
        "(SELECT j.value FROM external_import e,
                 json_each(CASE WHEN json_valid(e.message_ids) THEN e.message_ids ELSE '[]' END) j
          WHERE j.type = 'text'{scope})"
    )
}

/// 一次会话解析的产物:正文之外还带枚举列里没有的 token 累计
struct Parsed {
    messages: Vec<TranscriptMessage>,
    unknown: u32,
    tokens: i64,
}

impl MimoAdapter {
    pub fn new() -> Self {
        // AgentRouter supported MIMO_HOME as a data directory before the native
        // MiMo parser. Keep that contract; MIMOCODE_HOME uses the official /data
        // layout and takes precedence when both are set.
        if super::env_dir("MIMOCODE_HOME").is_none() {
            if let Some(root) = super::env_dir("MIMO_HOME") {
                return Self::with_db(root.join(DB_NAME));
            }
        }
        let home = super::home_dir().unwrap_or_default();
        let local = home.join(".local").join("share").join(DATA_DIR);
        // MIMOCODE_HOME 必须是绝对路径(MiMo 自己对相对路径直接报错)
        let mimo_home = super::env_dir("MIMOCODE_HOME")
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join("data"));
        let xdg = super::env_dir("XDG_DATA_HOME").map(|dir| dir.join(DATA_DIR));
        // README 的说法(与 xdg-basedir 的实现对不上):macOS 的 Application Support、Windows 的
        // %LOCALAPPDATA%;别的平台上不存在,无条件作候选无害
        let app_support = home
            .join("Library")
            .join("Application Support")
            .join(DATA_DIR);
        let local_appdata = home.join("AppData").join("Local").join(DATA_DIR);
        let hit = mimo_home
            .iter()
            .chain(&xdg)
            .chain([&local, &app_support, &local_appdata])
            .find(|dir| dir.join(DB_NAME).is_file())
            .cloned();
        // 哪儿都没有库:环境变量指着的位置(MiMo 在同一个环境里会写到那里),再回落默认位置
        let root = hit.unwrap_or_else(|| mimo_home.or(xdg).unwrap_or(local));
        Self::with_db(root.join(DB_NAME))
    }

    pub(crate) fn default_adapters() -> Vec<Box<dyn AgentAdapter>> {
        let primary = Self::new();
        let mut roots = primary.data_roots();
        // Reuse only the previous directory resolver (MIMO_DB and surviving
        // default/XDG stores), never its generic OpenCode transcript parser.
        for root in super::opencode::OpencodeAdapter::mimo().data_roots() {
            if root.is_file() && !roots.contains(&root) {
                roots.push(root);
            }
        }
        roots.into_iter().map(|db| Box::new(Self::with_db(db)) as Box<dyn AgentAdapter>).collect()
    }

    fn with_db(db: PathBuf) -> Self {
        Self {
            db,
            rows_cache: MtimeCache::new(),
        }
    }

    fn open(&self) -> Option<SqliteRo> {
        open_sqlite_ro(&self.db, "mimo-code")
    }

    /// 列出来的会话与道子会话(没有正文的不收),按库(含 -wal)戳缓存。None = 库在却读不出
    /// (打不开、查询出错)
    fn rows(&self) -> Option<Arc<Vec<MiRow>>> {
        let stamp = db_cache_stamp(&self.db);
        self.rows_cache.get_or_try_build(stamp, || {
            let ro = self.open()?;
            let schema = MiSchema::probe(&ro.conn).ok()?;
            let mut rows = query_rows(&ro.conn, schema, None).ok()?;
            // 列出来的会话里的道才是子会话(导入的、簿记的会话里的不算)
            let listed: HashSet<&str> = rows.iter().map(|row| row.session.as_str()).collect();
            let lanes: Vec<MiRow> = query_lanes(&ro.conn, schema, None)
                .ok()?
                .into_iter()
                .filter(|lane| listed.contains(lane.session.as_str()))
                .collect();
            rows.extend(lanes);
            rows.retain(|row| row.content_len > 0);
            Some(Arc::new(rows))
        })
    }

    fn parse(
        &self,
        r: &SessionFileRef,
        decode_images: bool,
    ) -> Result<(SessionMeta, Vec<TranscriptMessage>, u32)> {
        let _image_budget = transcript_image_decode_budget(decode_images);
        if Path::new(strip_virtual_path(&r.file_path)) != self.db.as_path() {
            return Err(anyhow!("mimo code database is outside adapter roots"));
        }
        let ro = self
            .open()
            .ok_or_else(|| anyhow!("cannot open mimo code db"))?;
        let schema = MiSchema::probe(&ro.conn)?;
        let (session, actor) = split_lane(&r.native_id);
        let row = match actor {
            None => query_rows(&ro.conn, schema, Some(session))?,
            Some(actor) => query_lanes(&ro.conn, schema, Some((session, actor)))?,
        }
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("mimo code session {} not in db", r.native_id))?;
        let parsed = parse_messages(&ro, &row, schema, decode_images)?;
        let meta = build_meta(r, &row, &parsed);
        Ok((meta, parsed.messages, parsed.unknown))
    }
}

fn build_meta(r: &SessionFileRef, row: &MiRow, parsed: &Parsed) -> SessionMeta {
    let project_path = canonical_project_path(&row.directory);
    SessionMeta {
        key: session_key(AgentId::Mimo, "", &row.id),
        host: String::new(),
        id: row.id.clone(),
        agent: AgentId::Mimo,
        title: session_title(&row.title, row.placeholder_title, &parsed.messages),
        project_name: project_name_of(&project_path),
        project_path,
        file_path: r.file_path.clone(),
        created_at: if row.created_ms > 0 {
            row.created_ms
        } else {
            r.mtime_ms
        },
        updated_at: if row.updated_ms > 0 {
            row.updated_ms
        } else {
            r.mtime_ms
        },
        message_count: parsed
            .messages
            .iter()
            .filter(|m| m.kind == MessageKind::Text)
            .count() as i64,
        size_bytes: r.size,
        git_branch: None,
        // 同一会话会换模型,取最后一条助手消息用的
        model: parsed.messages.iter().rev().find_map(|m| m.model.clone()),
        tokens_used: (parsed.tokens > 0).then_some(parsed.tokens),
        archived: row.archived,
        source: None,
        spawned: row.spawned(),
        favorite: false,
        pinned: false,
    }
}

/// 自定义 location:选中库文件本身就用它;选中 `MIMOCODE_HOME`(里面是 data/)或 XDG data 根
/// (里面是 mimocode/)往下找一层;其余当数据目录本身。MiMo Code 不做远程同步,没有"同步前
/// 目录还不存在"的挂载点,可以看存在性(OpenCode 的 custom_db_paths 同样)
fn custom_db(dir: PathBuf) -> PathBuf {
    if dir.extension().is_some_and(|ext| ext == "db") {
        return dir;
    }
    ["data", DATA_DIR]
        .iter()
        .map(|sub| dir.join(sub).join(DB_NAME))
        .find(|db| db.is_file())
        .unwrap_or_else(|| dir.join(DB_NAME))
}

/// 枚举 / 单会话取行
fn query_rows(
    conn: &Connection,
    schema: MiSchema,
    id: Option<&str>,
) -> rusqlite::Result<Vec<MiRow>> {
    if !schema.sessions {
        return Ok(Vec::new());
    }
    let title_source = if schema.title_source {
        "s.title_source"
    } else {
        "NULL"
    };
    // 单会话取行按主键找,不卡列不列(列表那一步卡过)、不算字节数(parse 拿的是 r.size)。
    // 枚举用 octet_length:只读记录头、不碰溢出页,工具输出动辄几十 KB,LENGTH 得把它们整份读
    // 出来数字符;字节数照样是合格的脏判据
    let (content_len, filter) = match id {
        Some(_) => ("0", "s.id = ?1".to_string()),
        None => (
            "(SELECT COALESCE(SUM(octet_length(p.data)), 0) FROM part p WHERE p.session_id = s.id)",
            schema.listed(),
        ),
    };
    let sql = format!(
        "SELECT s.id, NULL, s.directory, s.title, {title_source}, s.time_created, s.time_updated,
                s.time_archived, s.parent_id, {content_len}
         FROM session s WHERE {filter}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(id), MiRow::from_sql)?;
    rows.collect()
}

/// 同会话子代理的道:不是所在会话要显示的那条,不是运行时自己派的(那几种是簿记),至少有一条消息
/// 不早于会话的创建(只有 fork 复制来的消息的道,原会话里已经有一份);时间只按这些消息算,项目与
/// 归档跟着所在的会话。更新时间取消息的 time_updated:它是这条道的变更戳,消息原地改写(事后补写
/// token 之类)时 part 字节数未必变,拿创建时间当戳,增量扫描就认不出、一直留着旧值。`one` 给了
/// (会话, actor id) 就只取那一条、不算字节数。按道判的两条放在 HAVING、每条道求一遍:放进 WHERE
/// 就是每条消息一遍,"要显示哪条道"那个 CASE 的 ELSE 还要把整个会话排一遍序
fn query_lanes(
    conn: &Connection,
    schema: MiSchema,
    one: Option<(&str, &str)>,
) -> rusqlite::Result<Vec<MiRow>> {
    let Some(shown) = schema.lane("m.session_id") else {
        return Ok(Vec::new());
    };
    // 派活时那句 description;没给时它等于 agent 类型名,算没有
    let (description, system) = if schema.actors {
        (
            "(SELECT NULLIF(a.description, a.agent) FROM actor_registry a
              WHERE a.session_id = m.session_id AND a.actor_id = m.agent_id)",
            format!(
                " AND NOT EXISTS (SELECT 1 FROM actor_registry a WHERE a.session_id = m.session_id
                                  AND a.actor_id = m.agent_id AND a.agent IN ({}))",
                system_agents()
            ),
        )
    } else {
        ("NULL", String::new())
    };
    // `m.agent_id != 'main'` 也不收 NULL:`null_main` 的库里那是主线
    let (content_len, parts, which) = match one {
        Some(_) => ("0", "", " AND m.session_id = ?1 AND m.agent_id = ?2"),
        None => (
            "SUM(octet_length(p.data))",
            " LEFT JOIN part p ON p.message_id = m.id",
            "",
        ),
    };
    let sql = format!(
        "SELECT m.session_id, m.agent_id, s.directory, {description}, NULL, MIN(m.time_created),
                MAX(m.time_updated), s.time_archived, NULL, {content_len}
         FROM message m JOIN session s ON s.id = m.session_id{parts}
         WHERE m.agent_id != 'main' AND m.time_created >= s.time_created{which}
         GROUP BY m.session_id, m.agent_id
         HAVING m.agent_id != {shown}{system}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&str> = one.map(|(s, a)| vec![s, a]).unwrap_or_default();
    let lanes = stmt.query_map(rusqlite::params_from_iter(params), MiRow::from_sql)?;
    lanes.collect()
}

/// OpenCode 的 v1 两表循环 + MiMo 自己的几处差异(见模块注释):只读这条会话的那条道、导入的
/// 不读;助手消息逐条带模型与 token;actor 派活的调用跳到它派出的子会话;provenance 归 Meta,
/// 检查点与压缩摘要折成摘要;fork 复制来的那段折成一条、token 不算;导入过的会话开头留一条标记
fn parse_messages(
    ro: &SqliteRo,
    row: &MiRow,
    schema: MiSchema,
    decode_images: bool,
) -> Result<Parsed> {
    // 导入只写在会话的 main 道上
    let import = match row.actor {
        None => import_of(&ro.conn, schema, &row.session)?,
        Some(_) => None,
    };
    let query = V1Query {
        filter: schema.transcript(row, import.is_some()),
        ..V1Query::OPENCODE
    };
    let mut tokens = 0i64;
    // 已拼出几条消息;最后一条 fork 复制来的(含)之前有几条
    let mut built = 0usize;
    let mut inherited = 0usize;
    let (mut messages, unknown) = parse_v1_messages(
        ro,
        &row.session,
        decode_images,
        &query,
        |md, parts, role, message| {
            // fork 复制来的:时间早于会话(道子会话是它那条道)的起点
            let ts = md
                .pointer("/time/created")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let copied = row.created_ms > 0 && ts > 0 && ts < row.created_ms;
            // 一次调用 = input + output + reasoning,与 OpenCode 会话列同一个口径;拼不出消息的
            // 失败 turn 照算
            if role == Role::Assistant && !copied {
                tokens += ["input", "output", "reasoning"]
                    .iter()
                    .filter_map(|k| md.get("tokens")?.get(k)?.as_i64())
                    .sum::<i64>();
            }
            let Some(m) = message else { return };
            built += 1;
            if copied {
                inherited = built;
            }
            // 共用解析每个 tool 块按序出一个调用
            let tools = parts.iter().filter(|p| part_type(p) == Some("tool"));
            for (part, call) in tools.zip(&mut m.tool_calls) {
                call.child_id = part
                    .pointer("/state/metadata")
                    .and_then(|metadata| actor_child(&row.session, metadata));
            }
            // 检查点重建的上下文:带 checkpoint 块、只有 synthetic 文本(共用解析给成 Meta)的那条
            if m.kind == MessageKind::Meta
                && parts.iter().any(|p| part_type(p) == Some("checkpoint"))
            {
                m.kind = MessageKind::CompactSummary;
            }
            match role {
                Role::Assistant => {
                    m.model = optional_string(md.get("modelID"));
                    if true_at(md, "summary") {
                        m.kind = MessageKind::CompactSummary;
                    }
                }
                Role::User if md.get("provenance").is_some_and(|p| !p.is_null()) => {
                    m.kind = MessageKind::Meta;
                }
                _ => {}
            }
        },
    )?;
    collapse_inherited(&mut messages, inherited, "session");
    // 导入的那段(转录里已经去掉)在开头留一条标记,与分叉复制来的那段同一种折法——内容本体在原来
    // 那家 agent 的会话里
    if let Some((source, count)) = import.filter(|(_, count)| *count > 0) {
        let from = match source.as_str() {
            "cc" => Some(AgentId::ClaudeCode),
            other => AgentId::from_str(other),
        }
        .map_or(source.as_str(), |agent| agent.display_name());
        messages.insert(
            0,
            collapsed_marker(
                count as usize,
                &format!("imported from {from}"),
                row.created_ms,
            ),
        );
    }
    assign_seq(&mut messages);
    Ok(Parsed {
        messages,
        unknown,
        tokens,
    })
}

/// 这个会话的导入记录:来源(cc / codex / opencode)与导入了几条。没有导入表、没导入过给 None
fn import_of(
    conn: &Connection,
    schema: MiSchema,
    sid: &str,
) -> rusqlite::Result<Option<(String, i64)>> {
    if !schema.imports {
        return Ok(None);
    }
    conn.query_row(
        "SELECT source, CASE WHEN json_valid(message_ids) THEN json_array_length(message_ids) ELSE 0 END
         FROM external_import WHERE session_id = ?1 ORDER BY time_imported DESC LIMIT 1",
        [sid],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

impl AgentAdapter for MimoAdapter {
    fn agent(&self) -> AgentId {
        AgentId::Mimo
    }

    fn list_session_files(&self) -> Result<Vec<SessionFileRef>> {
        // 库不在 = 没有会话;库在却读不出报 Err,scanner 冻结这一家这一轮(不变量 8①)——
        // 当成没有会话的话,这一轮会把整家会话当"磁盘已删"清掉
        if !self.db.is_file() {
            return Ok(Vec::new());
        }
        let rows = self
            .rows()
            .ok_or_else(|| anyhow!("{} exists but could not be read", self.db.display()))?;
        Ok(rows
            .iter()
            .map(|row| SessionFileRef {
                agent: AgentId::Mimo,
                native_id: row.id.clone(),
                file_path: virtual_path(&self.db, &row.id),
                mtime_ms: row.updated_ms,
                // 道子会话跟着会话归档,而 MiMo 归档只改会话那一行:归档那一位并进引用,道的戳没动
                // 也会重解析(Kimi 的子代理同款)
                size: row.content_len + i64::from(row.archived),
            })
            .collect())
    }

    fn manages_parent_links(&self) -> bool {
        true
    }

    /// 子会话那一行的 parent_id,取这一轮枚举读到的那份(`MtimeCache::latest`,OpenCode 同款:
    /// 扫描末尾才问到这里,按戳重读就是把整个枚举查询再跑一遍);还没枚举过就现读。库不在 =
    /// 没有关系;库在却从没读成功过 = 不知道(None),库里的关系原样保留。道子会话的父会话写在
    /// 它的 id 里(`parent_in_path`),不在这里报
    fn parent_links(&self) -> Option<Vec<(String, String)>> {
        if !self.db.is_file() {
            return Some(Vec::new());
        }
        let rows = self.rows_cache.latest().or_else(|| self.rows())?;
        Some(super::link_keys(
            AgentId::Mimo,
            rows.iter()
                .filter_map(|row| Some((row.id.as_str(), row.parent.as_deref()?))),
        ))
    }

    /// 关系记在子会话自己那一行:多 location 下按子会话的胜出副本认边
    fn parent_links_in_child(&self) -> bool {
        true
    }

    fn parent_in_path(&self) -> Option<ParentInPath> {
        Some(lane_parent)
    }

    fn parse_session(&self, r: &SessionFileRef) -> Result<ParsedSession> {
        let (meta, messages, unknown) = self.parse(r, false)?;
        Ok(ParsedSession::derive(meta, &messages, unknown))
    }

    fn parse_transcript(&self, r: &SessionFileRef) -> Result<ParsedTranscript> {
        let (meta, messages, unknown) = self.parse(r, true)?;
        Ok(ParsedTranscript {
            meta,
            mainline: messages,
            sidechains: Vec::new(),
            unknown_line_count: unknown,
        })
    }

    fn data_roots(&self) -> Vec<PathBuf> {
        vec![self.db.clone()]
    }

    fn with_custom_root(&self, dir: PathBuf) -> Box<dyn AgentAdapter> {
        Box::new(Self::with_db(custom_db(dir)))
    }
}
