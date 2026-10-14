# 自有会话工作台

## 边界与来源

以 Wake 0.9.2（28098309788710ce3c8e83418a87e193b965551a）的 MIT 数据层为起点，代码完整纳入 `native/session-core`，保留原始 LICENSE。AgentRouter 自行维护解析器、索引、平台服务和测试。编译仅使用本仓库与 Cargo.lock 中的 registry 依赖；不引用 Wake 的 checkout、应用、索引或更新服务。

GPUI 桌面壳没有嵌入 Electron；React 页面调用自有 reader、CLI、MCP，共用一份索引和解析实现。现有用量计费数据库、ai-memory 知识库继续各自负责原有领域，不能将会话元数据的终身 token 累加到逐日用量中。

## 功能对应

| 能力 | AgentRouter 实现 |
| --- | --- |
| 多客户端会话 | 24 个客户端 ID，包括上游 23 类及 MiMo；原生目录、环境变量、独立 profile、自定义目录和远程镜像 |
| 会话检索 | 本地 SQLite FTS、中文与代码检索。有会话的客户端和项目在左侧主导航展开，点选后收窄会话列表。侧栏数字和列表用同一个时间范围，打开时是全部会话；收藏、排序、分页、命中消息与分支跳转留在会话页 |
| 转录阅读 | Markdown、代码高亮、折叠思考/工具/注入上下文、图片查看、主线与子代理、分段加载。普通打开落在最新一页的末尾；搜索命中仍从那条消息开始 |
| 管理 | 收藏、置顶、Markdown 导出、复制交接、原客户端继续；已有 AgentRouter 用量详情保留 |
| 实时更新 | 单写入者文件监听、增量更新、跨进程刷新信号、定期补扫；页面保留当前阅读位置 |
| 记忆文件 | 原生库仍可列出和读取；会话页不提供入口 |
| 活动统计 | 原生统计仍在库里；会话页不提供入口 |
| 清理 | 原生审阅、废纸篓和隐藏流程保留；会话页不提供入口 |
| SSH | 原生同步保留；会话页不提供主机管理，也不复制远程续接命令 |
| 客户端上下文 | 自带 CLI、只读 MCP、本地 Claude/Codex 插件市场、可选 SessionStart hook；安装由用户显式选择 |
| 外观 | 使用 AgentRouter 的语言、主题、侧栏与窗口布局，不增加第二层应用导航 |

MCP 工具名是 `ar_session_search`、`ar_session_list`、`ar_session_read`、`ar_session_projects`、`ar_session_memories`。新引用写成 `agentrouter://session/<key>#<seq>` 和 `agentrouter://memory/<key>`。历史 `wake_*` 调用仍从全文索引里排除，历史 `wake://` 引用仍能打开。服务名和可执行文件均为 AgentRouter，不依赖 Wake 程序。

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

- 阅读器在分页之前过滤 Meta，保留原始 seq；65 条可见消息跨页与搜索锚点有集成测试。普通打开带 `tail`，返回最后一页；同时带 seq 时仍从命中消息开始。
- 分支切换统一交给加载 effect；清除搜索锚点不会触发旧分支覆盖。Chrome 已验证搜索命中后切换真实 Claude 子代理分支。
- 收藏条件下推到 FTS 与降级查询的 SQL，先过滤再 LIMIT，防止较新的普通会话挤掉收藏；有限额的回归测试覆盖。
- 记忆列表、正文请求均检查最新请求及面板版本；并行操作按未完成数量维护忙碌状态。Chrome 已验证连续选择后正文属于最终选择。
- 会话页只保留检索和阅读。收藏、置顶、导出、交接、用量详情和本地 profile 续接仍在阅读器里。隐藏、废纸篓、活动统计、记忆文件和 SSH 不出现在这个页面；原生库里的对应实现保留。
- 本地构建原生程序使用临时文件加 rename 原子替换，避免 macOS 对原 inode 的签名缓存导致更新后 SIGKILL。
