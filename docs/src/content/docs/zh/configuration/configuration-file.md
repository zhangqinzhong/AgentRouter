---
title: 配置数据库位置
pageTitle: 配置数据库位置
eyebrow: 详细配置
lead: 找到 AgentRouter 桌面 App 默认维护的 SQLite 配置数据库。
---

## 默认位置

- macOS/Linux：`~/.agentrouter/config.sqlite`
- Windows：`%APPDATA%\agentrouter\config.sqlite`

Docker 设置 `HOME=/data`，因此配置数据库位于 `/data/.agentrouter/config.sqlite`；持久化挂载时请挂载整个 `/data` 目录，以保证配置数据库和相关文件都被保存。

## 生效方式

AgentRouter 的运行配置存储在 SQLite 中。旧版 `config.json` 只会在没有 SQLite 配置时作为迁移来源读取一次，迁移完成后继续编辑 `config.json` 不会影响当前配置。

建议通过桌面 UI 修改配置，或在 **Settings** 中导出备份。不要在 AgentRouter 运行时直接编辑 `config.sqlite`；SQLite 还会维护同目录的 `config.sqlite-wal` 和 `config.sqlite-shm` 辅助文件。

## 相关数据

| 内容 | macOS/Linux 默认位置 |
| --- | --- |
| 请求日志与观测 | `~/.agentrouter/app-data/request-logs.sqlite` |
| 请求与响应正文 | `~/.agentrouter/app-data/request-log-bodies/` |
| 概览用量统计 | `~/.agentrouter/app-data/usage.sqlite` |
| Agent 配置、会话及缓存 | `~/.agentrouter/profiles/` |

Windows 默认把应用数据放在 `%APPDATA%\agentrouter` 下。旧目录和内部协议名称可能保留用于兼容；不要只凭旧名称删除会话或配置文件。日志保存天数不控制 Agent 会话、插件缓存和概览用量统计。

Docker 入口脚本仍使用 `/data/.claude-code-router` 做兼容引导，主程序当前数据目录为 `/data/.agentrouter`。挂载或备份整个 `/data`，不要只保留其中一个子目录。
