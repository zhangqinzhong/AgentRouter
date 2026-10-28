# 发布流程

## PR → CI → tag → Release

版本采用 `主版本.次版本.修订号`，按用户可见的兼容性影响选择：兼容修复为 patch；兼容的新功能、新客户端来源为 minor；不兼容的管理 API、CLI 或配置改动为 major。代码量和上游依赖版本不直接决定 AgentRouter 版本。普通改动合批发布，紧急修复可独立发 patch。

发布 PR 更新根目录和四个 workspace 的 `package.json`、`package-lock.json`、`CHANGELOG.md`、`docs/releases/<version>.md`、`.github/release-request` 和 `.github/release-plan.json`。发布计划声明上一个稳定版 `baseVersion`、`change`（major/minor/patch）及产品层面的 `reason`，由 PR 审查确认分类。CI 验证数字递增、基线 tag、版本一致、说明文件；patch 不允许包含 Features 更新项。

功能版和破坏性更新先发 `x.y.z-rc.1`；需要更早预览时可先发 `x.y.z-beta.1`。候选版全平台构建成功、校验并实际验证后，另开稳定版 PR，把版本改为 `x.y.z`，并在发布计划中设置 `candidate: "vx.y.z-rc.N"`。稳定版与候选版之间只允许版本、更新日志及发布说明变化；有源码变化必须先发下一个候选版。预发布在 GitHub 标记为 prerelease 且 `latest=false`，不进入稳定版更新源。

提交前执行 `node build/verify-release-version.mjs`。PR CI 检查类型、采集器、核心、UI、浏览器回归、Rust 会话引擎、原生视图差异及 Swift 测试。合并前检查 PR 的全部 CI 结果，解决失败后再合并。

合并到 main 后，Release Kickoff 验证计划，创建不可移动的 tag 并显式启动 Release。不要另行手动推同名 tag；已有 tag 指向不同提交时流程停止。

Release 对 Apple Silicon、Intel、Windows 和 Linux 并行构建，所有平台成功后汇总产物、合并 macOS 更新元数据，验证版本、文件大小、SHA-512 和必需平台。全部通过后创建草稿、上传完整产物和 `SHA256SUMS`，再核对 GitHub 资产摘要并公开发布。禁止先公开一半平台的稳定版；已公开版本的产物不覆盖，修复应发布新版本。发布中断可重跑同一个工作流，只有草稿产物可以被替换。

用 `gh run list --workflow release.yml`、`gh release view v<version>` 检查实际状态。Git tag、构建成功、Release 已公开、本机安装是不同交付状态，分别验证。

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
