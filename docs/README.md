# AgentRouter Documentation

Bilingual documentation for AgentRouter, built with Astro. The documentation site is published from `main` at [zhangqinzhong.github.io/AgentRouter](https://zhangqinzhong.github.io/AgentRouter/).

## Local development

From the repository root, with Node.js 24:

```sh
npm ci --ignore-scripts
cd docs
npm ci
npm run dev
```

From `docs/`, run `npm run build` to build or `npm run preview` to preview. Both root and docs dependencies are required because the site reuses UI components from `packages/ui`.

## Content

- Chinese: `src/content/docs/zh/`
- English: `src/content/docs/en/`
- Release notes: `releases/`
- [Release configuration](releasing.md)
- [Data compatibility](compatibility.md)

Frontmatter provides the title, eyebrow, and lead. Headings form the table of contents; code blocks use Shiki highlighting.

## 中文指南

- [代码地图](src/content/docs/zh/guides/code-map.md)

- [安装与更新](src/content/docs/zh/guides/install.md)
- [CLI 命令](src/content/docs/zh/guides/cli.md)
- [供应商配置](src/content/docs/zh/configuration/providers.md)
- [Agent 配置](src/content/docs/zh/configuration/profiles.md)
- [日志保存与速率](src/content/docs/zh/configuration/observability.md)
- [数据目录](src/content/docs/zh/configuration/configuration-file.md)

## English guides

- [Code map](src/content/docs/en/guides/code-map.md)

- [Installation and updates](src/content/docs/en/guides/install.md)
- [CLI reference](src/content/docs/en/guides/cli.md)
- [Providers](src/content/docs/en/configuration/providers.md)
- [Agent profiles](src/content/docs/en/configuration/profiles.md)
- [Log retention and rates](src/content/docs/en/configuration/observability.md)
- [Data locations](src/content/docs/en/configuration/configuration-file.md)

## GitHub Pages

`.github/workflows/docs.yml` runs on `main` changes to the docs and supports manual dispatch. Enable GitHub Pages with GitHub Actions as its source before deploying.

`ASTRO_SITE` sets the absolute site URL; `ASTRO_BASE` sets its base path. Defaults are no absolute site URL and `/`. A repository Pages site requires its repository base path unless served through a custom domain. No public documentation URL is assumed.
