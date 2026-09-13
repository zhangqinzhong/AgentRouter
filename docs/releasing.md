# AgentRouter 版本发布

AgentRouter 使用独立的 1.x 版本号，当前为 1.1.2。上游仓库版本号不作为 AgentRouter 发布版本。

## 版本与检查

根目录及 `packages/core`、`packages/ui`、`packages/cli`、`packages/electron` 的 `package.json` 版本应一致，同时同步 `package-lock.json` 的根包和 workspace 版本。更新 `CHANGELOG.md` 和 `docs/releases/<版本>.md` 后执行：

```sh
node build/verify-release-version.mjs
npm run typecheck
npm run test:core
npm run test:ui
npm run test:electron
```

桌面版本来自 `packages/electron/package.json`，打包不会自动递增版本。同版本的重复构建不会被当作更高版本的更新。

## GitHub Releases

发布仓库：<https://github.com/zhangqinzhong/AgentRouter/releases>

推送验证后的提交及 `v<版本>` 标签，触发 `.github/workflows/release.yml`。例如版本更新为 1.0.2 后：

```sh
git tag -a v1.0.2 -m "AgentRouter 1.0.2"
git push --atomic origin HEAD refs/tags/v1.0.2
```

工作流检查版本和源码，构建两种 macOS 架构并合并更新描述，再构建上传 Windows 和 Linux 安装包。macOS 当前使用本地签名，未配置 Developer ID 或 Apple 公证。正式签名构建需提供证书和公证凭据，并验证完整升级流程。

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
