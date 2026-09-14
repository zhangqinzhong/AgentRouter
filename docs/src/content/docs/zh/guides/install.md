---
title: 安装并启动 AgentRouter
pageTitle: 安装并启动 AgentRouter
eyebrow: 快速开始
lead: 按运行场景在桌面应用、npm CLI 和 Docker 三种发行方式中选择并完成安装，然后验证管理界面与模型网关地址。CLI 要求 Node.js 22 或更高版本。
---

## 选择发行方式

| 方式 | 适合场景 | 入口 | 默认管理地址 | 默认网关地址 |
| --- | --- | --- | --- | --- |
| 桌面应用 | 日常本机使用、托盘、多开 Agent App、桌面集成 | 应用界面、`agentrouter` | 应用内窗口 | `http://127.0.0.1:3466` |
| npm CLI | 终端、SSH、无 Electron 环境、进程管理器 | `agentrouter` | `http://127.0.0.1:3458` | `http://127.0.0.1:3466` |
| Docker | 常驻服务器、容器运维、统一浏览器入口 | Nginx | 与网关共用公开地址 | `http://127.0.0.1:3458`（默认端口映射） |

桌面版 / CLI 中，管理 UI 与模型网关使用不同端口。CLI 的 `3458` 是管理端口，默认模型网关端口是 `3466`；Docker 通过 Nginx 把管理 UI 和模型网关合并到同一公开入口。

## 安装桌面应用

1. 打开 [AgentRouter Releases](https://github.com/zhangqinzhong/AgentRouter/releases/latest)。
2. macOS 按芯片选择 Apple Silicon（arm64）或 Intel（x64）的 DMG/ZIP；Windows 选择 EXE，Linux 选择 AppImage。
3. 安装并打开 **AgentRouter**。
4. 添加供应商和模型，在 **API 密钥** 中创建客户端 Key，然后点击侧边栏的服务按钮启动网关。

页面显示运行中后，模型网关默认监听 `http://127.0.0.1:3466`。可通过侧边栏的服务按钮启动或暂停网关。

## 桌面版更新

App 已内置本仓库的 Releases 更新源，通过应用内“检查更新”获取新版本，无需设置环境变量。1.1.2 提供 macOS、Windows 和 Linux 安装包。

macOS 包使用本地签名，尚未 Apple 公证，自动安装升级尚未验证；可从 Releases 手动下载替换。

## 安装 npm CLI

要求 Node.js 22 或更高版本：

CLI 包尚未发布到 npm；使用以下源码安装步骤：

```sh
git clone --branch v1.1.2 --depth 1 https://github.com/zhangqinzhong/AgentRouter.git
cd AgentRouter
npm ci
npm run build:assets
npm pack --workspace @zhangqinzhong/agentrouter --ignore-scripts
npm install -g ./zhangqinzhong-agentrouter-1.1.2.tgz
agentrouter --help
agentrouter ui
```

`agentrouter ui` 会启动后台服务并打开浏览器。无桌面环境使用 `agentrouter ui --no-open`，生产前台托管使用 `agentrouter serve --no-open`。完整命令和按 Agent 配置启动的说明见 [CLI 安装与命令参考](../cli/)。

## 使用 Docker

在源码仓库根目录执行：

```sh
docker compose up -d --build
```

打开 <http://127.0.0.1:3458>。Docker 只发布 Nginx 单入口，管理 UI 和模型网关共用该地址。首次启动后仍需添加供应商 / 模型、创建 AgentRouter 客户端 Key，并通过侧边栏的服务按钮启动网关。端口、鉴权、持久化、备份和远程部署见 [Docker 部署](../docker/)。

## 验证安装

完成供应商、模型和 AgentRouter 客户端 Key 配置后：

1. 在侧边栏确认状态为运行中。
2. 请求当前部署的 `/health`；成功时应返回 `200` 和运行状态。
3. 用 AgentRouter 客户端 Key 向兼容路径发送一个最小模型请求。
4. 在 **日志** 页面确认请求模型、最终供应商 / 模型、状态码和耗时。

管理界面能打开并不代表模型网关已经可用。没有供应商 / 模型时，Docker 的 `/health` 返回 `502` 属于预期行为。

## 数据位置

| 方式 | 配置位置 |
| --- | --- |
| 桌面 / CLI（macOS、Linux） | `~/.agentrouter` |
| 桌面 / CLI（Windows） | `%APPDATA%\agentrouter` |
| Docker | `/data/.agentrouter`，应持久化挂载 `/data` |

AgentRouter 当前配置存储在 `config.sqlite` 中；`config.json` 只在没有 SQLite 配置时作为旧版迁移或 Docker 首次引导来源。不要在 AgentRouter 运行时直接编辑 SQLite。
