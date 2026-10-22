# Go 内核隔离试接

这是独立实验入口，不被 Electron、正式网关或客户端启动逻辑引用。尚未替换 ai-gateway。

## 当前范围

- 候选：官方 CLIProxyAPI v8.0.38，发布二进制 commit `0db19025`，MIT。
- 读取现有 AgentRouter `config.sqlite` 的 `default` 配置，SQLite 只读打开。
- 仅选择一个启用的 OpenAI Chat 供应商、一个启用凭据和一个模型，生成 CLIProxyAPI v8 配置；不复制档案、OAuth 登录态或全部供应商。
- 仅监听 `127.0.0.1:18328`。拒绝正式端口和已占用端口，不接管现有进程。
- 临时目录 0700、配置与日志 0600，随机本地访问令牌；关闭管理接口、管理页面下载、插件、局域网发现，使用内置模型目录。
- 子进程使用隔离 HOME 和明确的环境变量，不继承生产配置、代理或 GitHub Token。
- 正常结束、失败和 SIGINT/SIGTERM 均停止候选进程并清理临时配置及日志。只输出脱敏检查摘要。

## 运行

需要支持 `node:sqlite` 的 Node.js。先从官方 Release 下载匹配平台的二进制，核验 `checksums.txt` 后解压。

本次 macOS arm64 包：`CLIProxyAPI_8.0.38_darwin_aarch64.tar.gz`

SHA-256：`58899af288fc25bf5b9c8a59dc936ca375c331addfa7b4e4ecc1f13fba00d5d3`

```sh
node --test experiments/go-kernel/config.test.mjs
node experiments/go-kernel/smoke.mjs \
  --binary=/absolute/path/to/cli-proxy-api \
  --db="$HOME/.agentrouter/config.sqlite" \
  --provider=DeepSeek \
  --model=deepseek-flash \
  --port=18328
```

测试会向选中的现有供应商发送少量真实请求，消耗少量额度。退出码非零代表至少一项检查未通过。不是常驻服务，结束后端口释放。

## 2026-10-21 实测

正式 AgentRouter 始终为 PID 51677、端口 3466；未重启、替换或变更客户端连接。

| 检查 | DeepSeek / deepseek-flash | WorkGLM / glm-5.3-flash |
|---|---|---|
| 鉴权后模型发现 | 通过 | 通过 |
| 无凭据请求被拒绝（401） | 通过 | 通过 |
| OpenAI Chat 非流式正文 | 通过 | 通过 |
| OpenAI Chat SSE 正文与 DONE | 通过 | 通过 |
| Anthropic Messages SSE 转换与 message_stop | 通过 | 通过 |
| Responses SSE 转换与 completed | 通过 | 通过 |
| OpenAI 强制工具调用及参数 JSON | 通过 | 通过 |
| Anthropic 强制工具调用 SSE、参数 JSON、停止原因 | **400** | 通过 |
| 客户端取消流式读取后仍可访问模型列表 | 通过 | 通过 |

取消测试证明客户端可以中止读取且候选服务继续响应，不证明上游已停止生成或计费。

### 已发现的兼容差异

1. `/v1/models` 附带 Anthropic 请求头会改变模型列表格式和模型 ID。健康检查使用 OpenAI 请求头；Anthropic 请求头只发往 Messages 入口。
2. DeepSeek 的 Anthropic 强制工具调用返回 `Thinking mode does not support this tool_choice`；同参数目的的原生 OpenAI 调用成功。官方 v8.0.38 的 `internal/translator/openai/claude/openai_claude_request.go` 中 `ConvertClaudeRequestToOpenAIWithCompat` 将 `thinking.type=disabled` 映射到 `reasoning_effort`，这不等同于保留供应商所需的 `thinking` 字段。需要补充供应商适配并再次验证，不能据此宣称新核心已完整兼容。

## 尚未接入

- Responses 原生上游、Anthropic 原生上游、OAuth 账号；当前适配器明确拒绝不支持的协议。
- AR 多档案路由、凭据轮换、代理规则、供应商 extraBody/extraHeaders/transformer（检测到会拒绝），Fusion 与其他客户端兼容插件。
- AR 日志、用量和监控回传，生产 SQLite 写入。
- 真正 Codex/Claude Code 客户端会话、WebSocket、连续工具回合、重试/故障转移、并发压力与长连接测试。
- 桌面打包、升级和正式切换。

本实验验证配置自动转换、独立进程启动和基础协议链路可行；不能当作已完成生产内核迁移。

### 后续归因核对

当前运行的 AR 使用同一 DeepSeek 模型、Messages 强制工具请求实测返回 200、`get_weather` 和 `tool_use`，无错误事件。

用本地模拟上游捕获 CLIProxyAPI 实际发送的 JSON（无真实密钥、无远端请求）：

| 实验配置 | 上游 thinking | 上游 reasoning_effort |
|---|---|---|
| 初版通用适配配置 | 缺失 | low |
| 改回 DeepSeek 供应商名、原模型名 | 缺失 | low |
| 再声明 thinking levels 为 none/high | 缺失 | none |

初版适配器没有迁移模型思考能力，因此不能将此前失败简单归为候选内核缺陷；即使补充能力声明，通用 OpenAI 转换仍不等于 DeepSeek 专用 thinking 字段转换，需要完成供应商适配。当前 ai-gateway 的 DeepSeek 专用适配会写入 `thinking.type=disabled` 并删除 `reasoning_effort`。本轮测试对象为官方 CLIProxyAPI v8.0.38，未运行 CliRelay，不能据此评价 CliRelay 同场景表现。模拟上游固定返回 400 以终止请求，该状态码不是此次抓包验证的故障结论。
