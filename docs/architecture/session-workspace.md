# 自有会话工作台

## 边界与来源

以 Wake 0.9.2（28098309788710ce3c8e83418a87e193b965551a）的 MIT 数据层为起点，代码完整纳入 `native/session-core`，保留原始 LICENSE。AgentRouter 自行维护解析器、索引、平台服务和测试。编译仅使用本仓库与 Cargo.lock 中的 registry 依赖；不引用 Wake 的 checkout、应用、索引或更新服务。

GPUI 桌面壳没有嵌入 Electron；React 页面调用自有 reader、CLI、MCP，共用一份索引和解析实现。现有用量计费数据库、ai-memory 知识库继续各自负责原有领域，不能将会话元数据的终身 token 累加到逐日用量中。

## 功能对应

| 能力 | AgentRouter 实现 |
| --- | --- |
| 多客户端会话 | 24 个客户端 ID，包括上游 23 类及 MiMo；原生目录、环境变量、独立 profile、自定义目录和远程镜像 |
| 会话检索 | 本地 SQLite FTS、中文与代码检索、客户端/项目/日期/收藏筛选、排序、分页、命中消息与分支跳转、自动展开工具命中并高亮 |
| 转录阅读 | Markdown、代码高亮、折叠思考/工具/注入上下文、图片查看、主线与子代理、分段加载 |
| 管理 | 收藏、置顶、Markdown 导出、复制交接、原客户端继续；已有 AgentRouter 用量详情保留 |
| 实时更新 | 单写入者文件监听、增量更新、跨进程刷新信号、定期补扫；页面保留当前阅读位置 |
| 记忆文件 | 按客户端/项目检索并读取笔记、规则和指令文件；来源启停与自定义来源 |
| 活动统计 | 主会话、用户提问、项目、连续活跃、热力图、每周趋势、客户端/项目/模型排行 |
| 清理 | 候选容量、保护收藏/置顶、服务器保存的审阅批次、执行前重验、系统废纸篓、恢复索引；共享数据库只隐藏 |
| SSH | 显式添加主机、同步启停、启动/刷新/手动同步、错误和时间状态、远程继续命令；仅拉取白名单来源 |
| 客户端上下文 | 自带 CLI、只读 MCP、本地 Claude/Codex 插件市场、可选 SessionStart hook；安装由用户显式选择 |
| 外观 | 使用 AgentRouter 的语言、主题、侧栏与窗口布局，不增加第二层应用导航 |

MCP 的 `wake_*` 工具名保留为协议兼容名称，服务名和可执行文件均为 AgentRouter；这不构成对 Wake 程序的依赖。历史查询工具输出不再被重复索引为新的对话内容。

## 生命周期与安全

索引位于当前 AgentRouter 配置目录的 `sessions/index.sqlite`；CLI/MCP 可用 `AR_SESSION_INDEX` 指定相同索引。`AR_SESSION_HOME` 用于隔离测试。

reader 由后端通过 stdin/stdout JSON 调用，不接受任意转录路径。Web 使用现有鉴权 RPC；Electron 使用 IPC。监听进程随父进程 stdin 关闭退出。共享索引只允许一个监听写入者。

转录中的 HTML 不执行，外链图片不自动请求，内嵌图片有类型和体积限制。客户端源文件和数据库只读。删除需要审阅批次并检查原文件状态，文件进入系统废纸篓；恢复按钮只在文件已由系统恢复后重建索引。共享数据库会话隐藏可撤销，不删除数据库记录。

MCP/插件不会随打开会话页面自动安装到客户配置。插件默认提供项目历史上下文；`AR_SESSION_ON_REQUEST=1` 关闭自动注入并要求明确查询。客户端仍自行决定是否调用工具。

## 构建与验证

需要 Rust 1.93、Node 22+，按目标平台/架构本机编译。`npm run build:assets` 打包 reader、CLI、MCP、插件、许可证及校验清单；afterPack 检查架构和散列。Docker 与 CI 已加入 Rust 工具链。

```sh
cargo test --manifest-path native/session-core/Cargo.toml
node --test tests/collector/session-workspace.test.cjs tests/collector/session-transcript.test.cjs
npm run test:ui
npm run typecheck
npm run build:assets
npx electron-builder --config build/electron-builder.local.cjs --mac --dir --publish never
```

2026-10-13 本机验收：原生核心 444 通过、2 个平台测试忽略；桥接/监听/插件与旧转录测试 9 通过；UI 282 通过。Chrome 实际检查了真实会话、代码搜索定位、MiMo 9 个会话及正文、记忆文件、活动统计、来源与清理候选。macOS arm64 本地开发签名包构建通过。Apple 在线时间戳请求曾失败，本地验收使用 `--config.mac.timestamp=none`，不改变正式发布配置。

验收边界：未连接新的真实 SSH 主机，未向用户客户端安装插件，未触发用户会话续接或删除；这些路径以原生测试及隔离夹具验证。没有宣称 Windows/Linux 实机或远程 CI 通过，没有替换正在使用的正式安装。

## 细节回归（2026-10-13）

- 阅读器在分页之前过滤 Meta，保留原始 seq；65 条可见消息跨页与搜索锚点有集成测试。
- 分支切换统一交给加载 effect；清除搜索锚点不会触发旧分支覆盖。Chrome 已验证搜索命中后切换真实 Claude 子代理分支。
- 收藏条件下推到 FTS 与降级查询的 SQL，先过滤再 LIMIT，防止较新的普通会话挤掉收藏；有限额的回归测试覆盖。
- 记忆列表、正文请求均检查最新请求及面板版本；并行操作按未完成数量维护忙碌状态。Chrome 已验证连续选择后正文属于最终选择。
- 阅读器通过适配器返回隐藏/废纸篓动作，不根据文件名中的 # 猜测。Grok Bot 真实缓存只允许隐藏；MiMo 与文件型夹具分别验证动作分类。
- 本地构建原生程序使用临时文件加 rename 原子替换，避免 macOS 对原 inode 的签名缓存导致更新后 SIGKILL。
