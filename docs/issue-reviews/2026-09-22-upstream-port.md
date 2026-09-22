# 2026-09-22：CCR 非 UI 更新移植

## 范围与来源

- AgentRouter 基线：`51101d450679ad6a127df5971b064bc4a95e8bbd`（1.6.11）。
- 上游：`musistudio/claude-code-router`，本地参考目录 `../claude-code-router`。
- 已发布基线：`upstream/main`，`75e9e750c134acc389eab00bc131c6cd625ba614`，最新版本标签 `v3.1.1`。
- 开发分支：`upstream/feat/v3.1.2`，`86dfac1c67a369c434f71b4f6d501f445238e2f9`。本次只移植经过本地回归的非 UI 变更，不把开发分支当作正式发行版。
- 这是选择性移植，不是整分支合并。保留 AgentRouter 包名、环境变量、档案作用域、端口、既有统计和流式错误处理。
- 初次移植不改 UI；经用户后续确认，补充供应商协议筛选与日志指标的 UI 接线，保留页面风格。不改菜单栏展示、版本号或发布触发文件；不写用户运行配置、不安装、不重启现有服务。

## 移植清单

| 上游提交 | 内容 |
| --- | --- |
| `89f160c`、`199b439` | 移除 TypeScript `baseUrl`，修正 Node 项目输入和构建输出目录 |
| `ec9fc53` | Docker/web 生产构建包含日志正文 worker |
| `32162c8`、`b6d83fd` | 聚合网关错误包含逐次尝试的实际失败原因 |
| `c57fd18` | 识别客户端可见的供应商前缀模型，避免将路由选择器计为物理模型 |
| `2f905c3` | CLI 的服务命令接受 `--daemon` |
| `14df423`、`e84d692`、`3f3bc9b`、`0c070c6` | OpenCode Go 后端接入：独立凭据、按协议发现模型、session header、供应商预设、官方账户用量映射 |
| `6922a71` | 按实际路由模型查询供应商自定义价格，解开内部路由选择器 |
| `35207da` | 网关配置确认超时默认 30 秒，支持 `AR_GATEWAY_CONFIG_TIMEOUT_MS` |
| `774bfb8` | 流式体验采集、持久化指标、实时速率后端及 IPC；补齐 Codex application requirements |
| `aad384b` | 回退尝试同步更新 routed-model 请求头 |
| `503a8c1` | 上下文超限错误解释；移除与 `apiKeyHelper` 冲突的布尔 `autoMode`，保留结构化配置 |
| `b7eb827` | 共享 Windows batch 环境变量转义 |
| `cb88b31` | 合并相邻的无签名 Anthropic thinking 块，保留签名块边界 |
| `e52f037` | DeepSeek/OpenCode Go 缓存命中字段兼容，覆盖 JSON、SSE、请求日志、用量和视觉工具统计 |
| `a034b0c` 的模型目录快照 | 使用 2026-09-16 生成的目录：4,732 个模型、231 个供应商；不更改用户已选模型 |

## 保留与未移植

- Gemini 协议/API key、Claude App 配置恢复、目录查询缓存、供应商标识缓存、应用路径发现等对应修复已存在，不重复覆盖。
- `1691980` 强制人工审批未移植。AgentRouter 已透传用户选择的审批人，与 `86dfac1` 的最终行为一致。
- 不移植热力图布局、菜单栏速率显示及其设置控件。不新增日志表格列，不调整列宽、拖拽逻辑或页面外壳。
- 后续接入 `protocolModels`：供应商新增/编辑表单按当前协议筛选候选模型，自动推荐也使用协议内模型；保留已有配置和手填模型。OpenCode Zen/Go 导入匹配使用各自插件后缀，Go 预设复用已有 OpenCode 图标，提示补齐中英翻译。
- `trayShowTokenRate` 后端配置默认关闭，没有新增菜单栏控件。采集能力与是否展示是两个独立层次。
- 不替换已有的 `timeToFirstTokenMs`、`streamOutputDurationMs` 及 gateway response-status/raw-trace 通道；新增指标与原字段共存。
- 日志的既有输出速率列优先显示有效的新样本速率；旧数据继续使用 TPOT 估算。不完整、缺少用量、Token 不足、隐藏推理、批量输出等新样本不回退到一个看似有效的旧估算值。展开详情展示流式时间指标及本地化样本状态，缺失数据不补零或伪造。

## 移植时额外修正

1. 合并新旧流指标时分离变量，避免同名遮蔽造成新指标丢失；旧字段仍传给原日志路径。
2. 请求日志 SQLite INSERT 同时保留原两列与新 JSON 指标列，列表和详情均读取；测试验证新旧指标可以共存。
3. 上游新增的缓存转换流和实时速率流使用普通 `pipe`，取消下游不会释放上游 reader。新增测试先复现失败，再改为 `pipeline` 联动销毁和错误传播；覆盖客户端取消、上游 read error 和活跃请求归零。
4. 新档案测试采用 AgentRouter 的 `agentrouter` scope，而非上游 `ccr`。
5. 更新两条与模型目录快照绑定的既有断言：DeepSeek 图像输入能力和 OpenRouter 的 GLM context limit。

## 验证边界

- 测试运行器使用临时 HOME、配置和数据目录；网关集成测试使用本机临时端口及测试上游，不连接真实供应商。
- 核心回归：1,069 项，1,063 通过、6 跳过、0 失败。
- 初次移植 UI：247 通过；补充 UI 接线后：255 通过。CLI：6 通过；Electron：47 通过；架构：4 通过；流式依赖回归：8 通过。
- `npm run typecheck`、`git diff --check` 通过。
- 6 项跳过涉及 Windows 专用运行验证、需显式启用的媒体测试和受限堆内存测试；不能据此宣称 Windows 或真实供应商已验收。
- 生产构建在临时源码副本中运行：`npm run build:docker` 和 `buildMain({ mode: "production" })` 均通过，覆盖 Web 资源、日志正文 worker、Core/CLI/Electron 主进程。第一次因临时副本漏接 UI workspace 的独立 `node_modules` 而失败，补齐依赖链接后通过；没有变更依赖清单或安装依赖。
- 没有覆盖原工作区中可能被预览服务使用的 `dist`，也没有执行原生 Swift 构建、应用签名或 release 打包。
- 本次不发布、不安装；已安装应用不会自动加载这些源码变更。
