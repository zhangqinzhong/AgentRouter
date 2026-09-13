# 旧版本兼容与数据目录

AgentRouter 1.x 的桌面/CLI 配置目录：

- macOS/Linux：`~/.agentrouter`
- Windows：`%APPDATA%\agentrouter`

旧目录 `.claude-code-router`、启动脚本 `ccr-*` 和部分已保存的 provider ID、会话路径及协议标识仍可能用于兼容读取。不要仅凭旧名称删除文件，或直接替换持久化 ID。配置和会话迁移后，应通过对应 Agent 配置确认仍能访问原有会话。

日志和观测共用请求数据。日志保存天数只控制请求记录、关联轨迹及正文文件，不清理 Agent 会话、插件、浏览器缓存和概览用量统计。

菜单栏及弹窗只使用 AgentRouter 图标。旧的随机和彩色图标选择会归一为 AgentRouter。自动更新源为本仓库的 GitHub Releases，`AR_UPDATE_FEED_URL` 可覆盖默认地址。

从旧的 3.0.22 开发构建切换到 AgentRouter 1.x 时，首次需要手动安装。后续版本沿 1.x 递增；macOS 包暂未 Apple 公证，自动安装升级尚未验证。
