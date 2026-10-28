---
title: 数据来源
---

在 **设置 → 数据来源** 中添加独立 Claude Code 或 Codex 实例的数据目录。用量采集和会话索引使用同一份配置。

- Claude Code：选择 `CLAUDE_CONFIG_DIR` 对应目录（内含 `projects`），或直接选择 `projects` 目录。
- Codex：选择 `CODEX_HOME` 对应目录，或单独选择 `sessions`、`archived_sessions` 目录。
- 默认目录与 AgentRouter 管理的配置档案自动识别。重复目录按真实路径去重。

停用目录会停止后续扫描；移除目录不会删除客户端原始文件或已采集的历史用量。客户端需要在本地保存 Token 用量，才能计入统计。
