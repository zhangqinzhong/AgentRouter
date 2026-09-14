---
title: 代码地图
pageTitle: 代码地图
eyebrow: 开发参考
lead: AgentRouter 的模块职责、关键入口、启动与数据流，以及扩展用量采集时需要保持的边界。
---

## 仓库结构

```text
packages/electron/  Electron 主进程、窗口、托盘、IPC、更新
packages/cli/       命令行入口
packages/core/      配置、档案、网关、路由、日志、用量与工具服务
packages/ui/        React 主界面、托盘界面和共享 UI
vendor/ai-gateway/  保留的底层网关源码，需结合构建与运行时引用确认用途
build/             构建、测试、打包和产物校验脚本
scripts/           模型目录等辅助生成脚本
tests/             跨包架构、端到端与系统测试
docs/              Astro 文档站与 Markdown 文档
.github/workflows/ 文档部署、桌面发布和手动 Docker 发布
```

业务服务位于 core，Electron 和 CLI 负责不同运行入口，UI 通过通信接口调用服务。共享契约位于 `packages/core/src/contracts/`。跨包引用使用包别名，包边界由 `tests/architecture/` 检查。

## 文件入口索引

| 模块 | 入口 | 职责 |
| --- | --- | --- |
| 桌面进程与窗口 | [`packages/electron/src/main/main.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/electron/src/main/main.ts) | 初始化运行目录，再进入 main-app；窗口、菜单、托盘、更新属于桌面层。 |
| 桌面服务启动 | [`packages/electron/src/main/main-app.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/electron/src/main/main-app.ts) | 启动应用服务、托盘与更新检查；组织退出与恢复。 |
| 桌面通信桥 | [`packages/electron/src/main/preload.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/electron/src/main/preload.ts) | 向 renderer 暴露受控 API；IPC 的服务端处理在同目录 ipc.ts。 |
| CLI 入口 | [`packages/cli/src/cli.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/cli/src/cli.ts) | 解析命令、选择档案、准备网关并启动 Agent。 |
| 无桌面服务入口 | [`packages/core/src/entrypoints/server.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/entrypoints/server.ts) | 启动 Web 管理服务。 |
| Web 管理 API | [`packages/core/src/web/management-server.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/web/management-server.ts) | 为浏览器提供配置、启动、日志和统计等服务。 |
| 主界面 | [`packages/ui/src/pages/home/App.tsx`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/home/App.tsx) | 页面切换、配置草稿、保存和档案操作。 |
| 菜单栏界面 | [`packages/ui/src/pages/tray/TrayApp.tsx`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/tray/TrayApp.tsx) | 托盘弹出界面的 React 入口。 |
| 配置契约 | [`packages/core/src/contracts/app.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/contracts/app.ts) | AppConfig、ProfileConfig、路由规则及跨层数据结构。 |
| 配置读写 | [`packages/core/src/config/config.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/config/config.ts) | 配置加载、规范化、兼容和保存。 |
| 配置数据库 | [`packages/core/src/config/config-repository.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/config/config-repository.ts) | SQLite 配置及凭据的持久化访问。 |
| 档案应用与恢复 | [`packages/core/src/profiles/service.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/profiles/service.ts) | 生成 Agent 配置和包装脚本、管理认证，停用时恢复受管配置。 |
| 启动计划 | [`packages/core/src/profiles/launch-core.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/profiles/launch-core.ts) | 按档案生成可执行命令、参数和环境；识别档案名称、ID 与别名。 |
| 启动执行 | [`packages/core/src/profiles/launch-service.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/profiles/launch-service.ts) | 桌面启动、运行状态、CLI 启动器与终端唤起。 |
| 终端选择 | [`packages/core/src/profiles/terminal-launch.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/profiles/terminal-launch.ts) | Otty、iTerm2、系统终端的启动命令与前台激活配置。 |
| 别名与参数 | [`packages/core/src/profiles/aliases.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/profiles/aliases.ts) | 生成和清理别名脚本；launch-options.ts 组合 YOLO 与附加参数。 |
| 网关编排 | [`packages/core/src/gateway/application/gateway-service.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/gateway/application/gateway-service.ts) | 组织网关配置、子进程、日志同步和计费用量同步。 |
| 网关子进程 | [`packages/core/src/gateway/core-runtime/supervisor.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/gateway/core-runtime/supervisor.ts) | 启动底层网关、健康检查及进程生命周期。 |
| 路由插件 | [`packages/core/src/gateway/claude-code-router-plugin.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/gateway/claude-code-router-plugin.ts) | 将 AgentRouter 的档案和路由策略接入底层网关。 |
| 路由编译 | [`packages/core/src/routing/config-compiler.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/routing/config-compiler.ts) | 编译规则，检查模型与 fallback 引用。 |
| 请求记录 | [`packages/core/src/observability/request-log-store.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/observability/request-log-store.ts) | 请求记录与保存期限管理；正文由 request-log-body.ts 管理。 |
| 原始轨迹同步 | [`packages/core/src/observability/raw-trace-sync.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/observability/raw-trace-sync.ts) | 接收和消费底层网关轨迹，写入请求记录，并补充用量捕获。 |
| 用量存储与聚合 | [`packages/core/src/usage/store.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/usage/store.ts) | 记录网关用量、按时段和筛选条件聚合、重置概览统计。 |
| 计费同步 | [`packages/core/src/usage/billing-sync.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/usage/billing-sync.ts) | 同步底层网关的计费用量。 |
| Token 规范化 | [`packages/core/src/usage/normalization.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/usage/normalization.ts) | 处理不同协议的输入、输出、缓存等用量口径。 |
| 概览图表 | [`packages/ui/src/pages/home/components/dashboard.tsx`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/home/components/dashboard.tsx) | 概览卡片、趋势、热力图和分类统计的展示。 |
| 请求日志列表 | [`packages/ui/src/pages/home/components/network-logs.tsx`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/home/components/network-logs.tsx) | 日志查询展示、详情、首 Token 与速率列。 |
| 速率公式 | [`packages/ui/src/lib/token-rate.ts`](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/lib/token-rate.ts) | 输出速率与平均吞吐率的前端计算。 |

## 档案启动链路

```text
档案卡片“启动”
  → App.tsx 保存当前配置
  → preload.ts / ipc.ts
  → openProfileFromAr
  → applyProfileConfig：准备配置、凭据、包装脚本
  → terminal-launch.ts：打开所选终端
  → agentrouter <profile-id> cli
  → CLI 解析档案 → buildProfileLaunchPlan
  → 组合权限模式、附加参数与运行环境
  → 对应 Agent
```

终端输入别名时，从生成的别名脚本进入同一个 CLI。别名绑定档案 ID，不依赖显示名称；YOLO 和附加参数也在 CLI 启动计划中应用。App 启动走对应桌面应用适配分支，不等同于 CLI 终端启动。

## 网关与路由链路

```text
Agent / API 客户端
  → 本地网关入口
  → 底层网关运行时与 AgentRouter 路由插件
  → 档案规则、全局规则和协议适配
  → 供应商 / 模型
  → 响应返回客户端
```

`gateway/service.ts` 是兼容导出入口，主要编排逻辑在 `gateway/application/gateway-service.ts`。底层运行时由 `core-runtime/config-compiler.ts` 与 `supervisor.ts` 配置和启动。排查行为时，应沿实际运行时和插件入口追踪，不能只根据 `vendor/` 或旧文件名判断执行路径。

## 日志与用量链路

```text
网关原始轨迹 → raw-trace-sync.ts → 请求记录、轨迹与正文
                              └→ 用量补录
网关计费用量 → billing-sync.ts ──→ usage/store.ts

请求记录 / 正文 → 日志与观测界面
usage/store.ts → getUsageStats → IPC 或 Web API → 概览图表
```

日志和观测共享请求数据；概览另有用量数据库。二者的保存和重置行为不同。请求正文不是图表统计的主要存储结构，用量聚合也不应依赖正文一直存在。

## 数据目录

默认配置根目录：macOS / Linux 为 `~/.agentrouter`，Windows 为 `%APPDATA%\agentrouter`。实际路径由 `runtime/app-paths.ts` 和 `config/constants.ts` 决定，运行时可以覆盖。

| 相对配置根目录 | 内容 |
| --- | --- |
| `config.sqlite` | 配置与凭据 |
| `profiles/` | 独立档案配置及相关状态 |
| `bin/` | CLI 启动器、别名及 Agent 包装脚本 |
| `terminal-launchers/` | 需要脚本文件的终端启动入口 |
| `app-data/request-logs.sqlite` | 请求记录与关联轨迹 |
| `app-data/request-log-bodies/` | 请求及响应正文文件 |
| `app-data/raw-trace-spool/` | 原始轨迹同步暂存 |
| `app-data/usage.sqlite` | 概览用量明细与统计来源 |
| `app-data/context-archive.sqlite` | 上下文归档 |

日志保存期限会清理过期请求及其关联数据；概览统计单独重置。操作数据库时需区分配置、用量、正文和暂存数据，不能把整个数据目录视为缓存。

## 本机会话采集的扩展边界

当前没有 TokenTracker 式的通用本机会话扫描器。现有概览主要统计经过网关的用量，不能据此推断所有本地 Agent 的总用量。

| 扩展内容 | 相关位置 | 边界 |
| --- | --- | --- |
| 本地日志解析与增量扫描 | core 中新增采集模块；参考 `profiles/` 中的档案路径解析 | 不放入 renderer；识别默认目录和独立档案目录 |
| 采集结果持久化 | `usage/`、`storage/` 与共享契约 | 标记数据来源、事件身份与采集进度；先确定去重与重置语义 |
| 图表和筛选 | `dashboard.tsx`、`shared/usage.ts` | 展示来源与聚合口径，不在组件中扫描文件 |
| 桌面和 Web 查询 | `ipc.ts`、`preload.ts`、`management-server.ts` | 两个入口使用一致的查询契约 |

同一请求可能同时出现在 Agent 会话日志和网关记录中，不能直接相加。缓存与思考 Token 是否已包含在输入、输出或累计总量中，也需要按来源规范化。这些是扩展边界，不表示本机会话采集已经实现。

## 修改与验证入口

| 修改范围 | 验证命令 |
| --- | --- |
| 类型和跨层契约 | `npm run typecheck` |
| 配置、档案、路由、日志、用量 | `npm run test:core` |
| React 页面和图表 | `npm run test:ui` |
| Electron 菜单、窗口与集成 | `npm run test:electron` |
| 包依赖边界 | `npm run test:architecture` |
| 文档 | `npm run build --prefix docs` |

桌面产物由 `build/build.mjs` 与 `electron-builder.json` 组织；发布时由 `build/verify-release-version.mjs` 检查版本一致性。文档通过 `docs/src/docs-structure.ts` 注册导航，`main` 分支的文档变更触发 Docs 工作流，不需要重发桌面安装包。
