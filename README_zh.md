# AgentRouter

[English](README.md) · [下载安装](https://github.com/zhangqinzhong/AgentRouter/releases/latest) · [使用文档](docs/README.md#中文指南)

**在一个桌面应用里管理编程 Agent、模型供应商和启动档案。**

区分个人与公司配置，在常用终端中启动对应 Agent，并查看经过本地网关的请求与用量。

## 安装

从 [Releases](https://github.com/zhangqinzhong/AgentRouter/releases/latest) 下载对应安装包：

| 平台 | 安装包 |
| --- | --- |
| macOS Apple Silicon | `mac-Apple-Silicon-arm64.dmg` |
| macOS Intel | `mac-Intel-x64.dmg` |
| Windows | `.exe` |
| Linux | `.AppImage` |

App 内置本仓库更新源。macOS 安装包使用本地签名，尚未经过 Apple 公证。

## 配置第一个 Agent

1. 在 **供应商** 中添加 API 地址、凭据、协议和模型。
2. 打开 **Agent 配置档案**，选择 Agent 和使用的模型。
3. 选择作用范围：需要区分个人、公司配置时，使用「仅从 AgentRouter 打开」；需要接管 Agent 的日常配置时，使用全局范围。
4. CLI 档案可设置启动别名和启动终端。macOS 支持 Otty、iTerm2 和系统终端，默认使用 Otty；终端应用需自行安装。
5. 保存后，点击卡片上的终端按钮启动。旁边的复制按钮可直接复制启动命令。

网关默认地址为 `http://127.0.0.1:3466`，运行状态显示在侧边栏。

### 用短命令启动

例如，给 `CodexCompany` 档案设置别名 `ccwork`：

```sh
ccwork
# 原来的命令也可以继续使用：
agentrouter CodexCompany
```

别名绑定档案，修改显示名称不影响启动目标；停用或删除档案时，对应别名命令会自动移除。

Claude Code 和 Codex 档案支持 **默认 / YOLO** 权限模式。YOLO 跳过权限确认；Codex 同时关闭沙盒限制。设置对该档案的 CLI 启动生效，使用别名时也会自动带上。

其他选项可在 **高级设置 → 附加启动参数** 中填写，每行一个参数。包含空格的路径仍作为一个参数传递，无需添加 shell 引号。

## 主要功能

| 功能 | 内容 |
| --- | --- |
| Agent 档案 | 独立配置、模型选择、环境变量、启动别名、CLI 参数与终端选择 |
| 供应商 | 兼容 API 接入、模型发现、连通性检测和多凭据管理 |
| 全局路由 | 按条件选择模型、改写请求、重试与备用模型 |
| 日志与观测 | 请求和响应、路由结果、首 Token 耗时、输出速率、平均吞吐率和工具轨迹 |
| 用量概览 | 请求数、Token、缓存用量、变化趋势与成本估算 |
| 工具扩展 | Fusion、MCP、ToolHub 和网关扩展 |

支持 Claude Code、Codex、OpenCode、Grok CLI、Kimi CLI、Kilo Code、Pi、ZCode、WorkBuddy 和 Claude Design 档案。各 Agent 可用的 CLI、App 启动方式不同，Agent 软件及模型供应商服务需单独配置。

固定使用一个模型时，在档案中选择即可；需要按请求条件分流或设置备用模型时，再配置全局路由。

## 本地数据

macOS、Linux 的配置与运行数据位于 `~/.agentrouter`，Windows 位于 `%APPDATA%\agentrouter`。

在 **设置 → 日志与观测 → 日志保存天数** 调整请求记录保存期限，默认 1 天，按滚动 24 小时计算。日志和观测共用请求数据，过期记录、关联轨迹和无引用正文会一起清理。概览用量统计独立保存，可单独重置。

macOS 支持 **⌘W** 关闭窗口，网关继续运行；退出 AgentRouter 才会退出应用。

## 从源码运行

需要 Node.js 22 或更新版本。

```sh
git clone https://github.com/zhangqinzhong/AgentRouter.git
cd AgentRouter
npm ci
npm run build:assets
node packages/cli/dist/main/cli.js ui
```

浏览器管理界面地址为 `http://127.0.0.1:3458`。CLI 包目前未发布到 npm，从源码安装的方法见 [CLI 文档](packages/cli/README_zh.md)。

## 使用指南

- [代码地图](docs/src/content/docs/zh/guides/code-map.md)

- [Agent 档案与启动选项](docs/src/content/docs/zh/configuration/profiles.md)
- [供应商配置](docs/src/content/docs/zh/guides/provider.md)
- [日志、保存期限与速率计算](docs/src/content/docs/zh/configuration/observability.md)
- [Docker 部署](docs/src/content/docs/zh/guides/docker.md)
- [版本说明](https://github.com/zhangqinzhong/AgentRouter/releases) · [更新记录](CHANGELOG.md)

## 许可证与致谢

采用 [MIT 许可证](LICENSE)。AgentRouter 基于 [Claude Code Router](https://github.com/musistudio/claude-code-router) 开发，保留上游版权与许可证声明。
