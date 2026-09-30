# 发布流程

## PR → CI → tag → Release

修复版本默认递增补丁号。发布 PR 同时更新根目录和四个 workspace 的 `package.json`、`package-lock.json`、`CHANGELOG.md`、`docs/releases/<version>.md`、`.github/release-request`。

提交前执行 `node build/verify-release-version.mjs`。PR CI 检查类型、采集器、核心、UI、原生视图差异和 Swift 测试。原生测试使用 `node build/test-native.mjs`，兼容旧版 SwiftPM 的资源解析；生产构建仍由 Xcode 编译资源。合并前用 `gh pr checks <PR> --watch` 确认全部通过，不跳过失败检查。

合并到 main 后，Release Kickoff 按 `.github/release-request` 创建 tag 并显式启动 Release（工作流 token 创建 tag 不会触发另一个 push 工作流）。不要同时手动推同名 tag。已有 tag 指向不同提交时停止，禁止移动已发布 tag。

Release 再次校验源码和版本，构建 Apple Silicon、Intel，发布 macOS 后继续 Windows、Linux。用 `gh run list --workflow release.yml` 和 `gh release view v<version>` 检查状态。

## 本机安装

在用户要求替换本机时，从 GitHub Release 下载匹配架构的 ZIP 和 `latest-mac.yml`。校验 ZIP 的 SHA-512 与更新元数据一致，并校验 app 签名、版本和原生 SQLite 模块。GitHub macOS 产物采用 ad-hoc 签名，未公证。

安装前用 SQLite backup API 备份现有数据库（包含 WAL 中已提交数据），记录配置摘要；保留旧 app 以便恢复。说明短暂网关中断后退出 app，将新 app 放到 /Applications 同卷临时路径并原子交换，启动并验证版本、数据库 quick_check、供应商配置和实际服务状态。失败则保留证据并恢复原 app，不重置数据库。

本机安装由当前机器执行，GitHub 托管 runner 无法替换用户的 /Applications。只要求 commit/push 的任务不自动发版或安装。

## 更新源

App 已内置以下地址，常规使用无需设置环境变量：

```text
https://github.com/zhangqinzhong/AgentRouter/releases/latest/download/
```

目录提供 `latest-mac.yml`、`latest.yml`、`latest-linux.yml` 及对应安装包。更新描述与安装包必须来自同一构建，文件名、大小和 SHA-512 校验值应一致。

仅在需要覆盖更新源时，完全退出 App 后运行：

```sh
open -a /Applications/AgentRouter.app --env AR_UPDATE_FEED_URL=https://github.com/zhangqinzhong/AgentRouter/releases/latest/download/
```

参数只对本次启动生效。更新源应提供 AgentRouter 自己的安装包，不应指向上游 Claude Code Router 的安装包。

## npm CLI

`@zhangqinzhong/agentrouter` 尚未发布到 npm。GitHub Releases 流程不执行 npm 发布。源码构建和安装见 [CLI 文档](../packages/cli/README_zh.md)。
