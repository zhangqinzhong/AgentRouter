# AgentRouter 页面风格规范（扁平化 v1.4.0）

> 本文档是给后续页面重构的设计基准，不随仓库发布。
> 基准实现：概览（overview）、用量、会话、趋势、热力图 五个页面，发布于 v1.4.0。
> 目标：把剩余页面（监控 / 高级 / 设置类）统一到同一套视觉语言。

---

## 0. 设计系统与 `check:ui`（所有 UI 改动必读）

### 0.1 设计 token：唯一来源 `packages/ui/src/styles/tokens.css`

- `@theme { --*: initial; … }` 清空了 Tailwind 默认主题。**只有 tokens.css 里声明的值才会生成 utility**；写了不存在的 token（如 `text-emerald-650`、`rounded-4xl`）不会报错，但样式不会生效。
- 明暗两套变量写在同一文件的 `:root` / `:root[data-theme="dark"]` / `prefers-color-scheme: dark` 三处，新增语义色三处都要补。
- `globals.css` 只放组件/页面级 CSS（`.local-usage-page`、`--network-*`、`--tray-*` 等作用域变量），不再定义主题值。

| 类别 | 用法（优先） | 说明 |
|---|---|---|
| 表面 surface | `bg-background` / `bg-card` / `bg-popover` / `bg-muted` / `bg-sidebar` | 页面底 / 卡片 / 弹层 / 弱底色 |
| 文字 text | `text-foreground` / `text-muted-foreground`（text-muted）/ `text-popover-foreground` | 弱化态加 `/70` |
| 边框 border | `border-border`（细分隔 `border-border/70`）/ `border-input` / `ring-ring` | |
| 主色 primary | `bg-primary text-primary-foreground` | 主按钮、焦点（teal） |
| 品牌 brand | `bg-brand`（emerald 600/暗 500）、`text-brand-ink`（600/暗 400）、`bg-brand-soft`（emerald-500 10%） | 区块图标 chip、勾选、强调 |
| 危险 | `text-destructive` / `bg-destructive` | |
| 状态 status | `bg-status-ok` / `-warn` / `-error` / `-idle`（`var(--status-*)`） | `#22c55e` / `#f59e0b` / `#ef4444` / `#e7e7e7`（暗 `#3f3f46`） |
| 数据 data | `var(--data-input)` / `--data-output` / `--data-cache` / `--data-other`，或 `bg-data-*` | 输入 / 输出 / 缓存 token、"其他"行 |
| 字号 | `text-micro` 9px · `text-2xs` 10px · `text-label` 11px · `text-caption` 12px · `text-body` 13px · `text-body-sm` 14px · `text-title` 24px · `text-display` 28px；以及 `text-xs`…`text-7xl` | px 字号只设 font-size，行高继承（与旧 `text-[13px]` 写法一致） |
| 宽度 | `max-w-page`（1120px 文档页）/ `max-w-wide`（1600px 宽表格页）/ `max-w-sm`…`max-w-7xl` | |
| 圆角 radius | `rounded-sm` / `rounded-md`（= `--radius`，0.5rem）/ `rounded-lg` / `rounded-xl` / `rounded-2xl` / `rounded-full` | |
| 阴影 | `shadow-sm` / `shadow-md` / `shadow-lg` / `shadow-xl` / `shadow-2xl` | 悬浮层用 `shadow-xl` |
| 动效 | `duration-fast` 150ms · `duration-base` 300ms · `duration-slow` 500ms；`ease-out` / `ease-emphasized`；JS 动画用 `@/lib/motion` 的 `motionEase` | |
| 间距 | Tailwind 数字刻度（`p-4` = 1rem），由 `--spacing` 驱动 | |

"Legacy palette" 区块只保留现有页面在用的 Tailwind 色（emerald、slate、amber…），用于不改视觉的过渡；**新代码不要再用**，`check:ui` 的 `palette-color` 规则会拦住新增。需要新颜色时：先找语义 token；确实没有就在 tokens.css 加一个语义名（明暗都给值），并在 `packages/ui/src/lib/utils.ts` 的 tailwind-merge 配置里登记新的字号/宽度类名，否则 `cn()` 会把它误判成颜色而合并掉。

### 0.2 共享组件：控件的唯一入口 `@/components/ui/*`

| 需要 | 用 | 文件 |
|---|---|---|
| 按钮 | `Button`（`variant`: default/secondary/outline/ghost/subtle/destructive；`size`: default/sm/icon/iconSm；`unstyled` 只保留行为） | `button.tsx` |
| 输入 | `Input` / `Textarea` / `Label` / `Checkbox` / `Switch` | 同名文件 |
| 下拉选择 | `Select`（`options` 或 children） | `select.tsx` |
| 对话框 | `Dialog*` | `dialog.tsx` |
| 弹层 / 菜单 | `Popover`（目前没有独立 Menu 组件，菜单先用 Popover + Button 组合；需要时在 components/ui 新增 `menu.tsx`，不要在页面里手写） | `popover.tsx` |
| 标签页 | `Tabs` | `tabs.tsx` |
| 提示 | `Tooltip` | `tooltip.tsx` |
| Toast | `ToastStack` + `Toast`（页面里沿用 `FeedbackStack` / `LightToast` 别名） | `toast.tsx` |
| 加载 | `Spinner`（默认 16px，`className="h-3.5 w-3.5"` 调尺寸） | `spinner.tsx` |
| 空状态 | `EmptyState` | `empty-state.tsx` |
| 图标 | 从 `@/components/ui/icons` 导入（re-export lucide-react） | `icons.ts` |
| 卡片 / 徽章 | `Card` / `Badge` | 同名文件 |

缺少某个变体时**扩展共享组件**，不要在页面里用原生元素或 Radix/Base UI/lucide 直接拼。改共享组件会影响全局，改前先 grep 调用方，并附前后截图。

### 0.3 `check:ui` 规则

`npm run check:ui`（`build/check-ui.mjs`）扫描页面代码 `packages/ui/src/pages/**`、`packages/ui/src/lib/**`；`components/ui/**`（共享组件本身）和 `vendor/**`（第三方拷贝）不扫描。

| 规则 | 拦截 | 改法 |
|---|---|---|
| `raw-color` | `#fff`、`#007aff`、`rgb()/rgba()/hsl()/oklch()` 等颜色字面量 | 语义 token 或 `var(--data-input)` 这类 CSS 变量 |
| `arbitrary-value` | Tailwind 任意值 `w-[13px]`、`bg-x/[0.045]`、`[prop:value]` | token utility；确属一次性布局时放进共享组件。`data-[state=open]:`、`[&_svg]:` 这类**任意变体**不算 |
| `palette-color` | `text-emerald-600`、`bg-slate-100` 等原始色板 | `text-brand-ink`、`bg-brand-soft`、`text-muted-foreground`… |
| `primitive-import` | 页面直接 import `@radix-ui/*`、`@base-ui/react`、`lucide-react` | `@/components/ui/*`、`@/components/ui/icons` |
| `native-control` | 页面 JSX 里的 `<button>` / `<select>` | `Button`（含 `unstyled`）/ `Select` |

**基线只降不升**：`build/check-ui-baseline.json` 按"规则 × 文件"记录现有违规数。
- 某文件某规则的数量**超过**基线 → 失败，列出该文件所有命中位置。基线不能调高（`--update-baseline` 遇到增长同样失败），只能改代码。
- 数量**低于**基线 → 也失败，提示运行 `npm run check:ui -- --update-baseline` 把基线降下来并一起提交，防止以后回涨。
- 规则是正则扫描：注释里的内容会被忽略，但字符串里的 `<button` 或 `#abc` 也会命中；遇到误报优先改写法，不要加豁免。

规则自身的测试：`npm run test:ui-guard`（`tests/ui-guard/`，每条规则一个 pass / fail fixture；fail fixture 首行写 `Expected: N <rule> violations.`）。新增或修改规则必须同时更新 fixture。

接入点：PR CI（`pr-ci.yml` 的 Source checks）跑 `check:ui` 和 `test:ui-guard`；本地 `npm run hooks:install` 启用 `.githooks/pre-commit`，提交涉及 `packages/ui/src`、`build/check-ui*`、`tests/ui-guard` 时自动检查。

### 0.4 注意事项

- Tailwind v4 会自动扫描整个仓库里的类名（包括 Markdown 和 build 脚本）。fixtures 已用 `@source not` 排除；在脚本注释里写类名示例会生成多余 CSS，尽量避免。
- 改 token 值或共享组件后，用 `./node_modules/.bin/tailwindcss -i packages/ui/src/styles/globals.css -o /tmp/after.css` 和改动前的产物排序后 diff，确认只有预期变化。
- UI 改动在 PR 里附明暗、窄屏的前后截图（`output/flat-ui/` 为历史基准图）。

---

## 1. 设计立场

一句话：**文档流，不是卡片墙。** 页面是一篇自上而下的"报表"，区块之间靠留白和细分隔线组织，不靠一个个圆角大卡片盒子。

禁止：
- 大圆角卡片包裹整块内容（`rounded-2xl border shadow-sm` 包 section 的老写法）
- 渐变、玻璃拟态大面积使用（悬浮卡允许 `backdrop-blur` 小面积点缀）
- 重边框 + 重阴影叠加
- 每个区块自带独立的背景色块

允许的"盒子"只有三种：**悬浮层**（hover 卡、弹层、tooltip）、**行内徽章**（图标底、字母章）、**表格**。其余内容直接放在页面背景上。

## 2. 页面外壳几何（必须逐字复用）

所有页面统一 1120px 内容列，五页已对齐，参考实现：

```
概览/用量/趋势:  <div className="local-usage-page mx-auto w-full max-w-page px-5 py-6 sm:px-9 sm:py-8">
热力图(内部滚动): local-usage-page mx-auto flex h-full min-h-0 w-full max-w-page flex-col px-5 pb-0 sm:px-9
会话(vendor 包壳): local-usage-page mx-auto w-full max-w-page  ← 壳内 vendor 页面自己管 padding
宽表格页(日志/观测): local-usage-page mx-auto flex h-full min-h-0 w-full min-w-0 max-w-wide flex-col px-5 pb-0 sm:px-9
```

两种外壳已提取为常量（`page-primitives.tsx`），新页面直接引用：
- `documentPageClassName` — 1120px 文档页（表单/配置类）
- `tablePageClassName` — 1600px 宽表格页（多列表格确需宽度时）

⚠️ **"撑满"≠贴边**：宽表格页占满可用宽度，但必须保留 `px-5 sm:px-9` 页边留白、`max-w-wide`（1600px）上限（超宽屏居中收束），内容永远不许直接贴窗口左右边缘。

配套 CSS（`globals.css`，改动需谨慎）：

```css
.local-usage-page { padding-top: 64px; }   /* 避让 46px 自定义标题栏，勿删 */
.app-usage-surface > .app-page-content:not([data-view="usage"]):not([data-view="heatmap"])
  :not([data-view="sessions"]):not([data-view="trend"]):not([data-view="overview"]) { padding: 64px 20px 20px; }
```

⚠️ **新页面接入 checklist**：
1. 页面根元素加 `local-usage-page`（提供字体、oai-* 变量、顶栏避让）
2. 把自己的 `data-view` 加进上面那条 `:not()` 列表，否则顶 padding 会翻倍
3. `viewUsesInternalScroll()` 决定外层滚动还是内部滚动——普通文档流页面用外层滚动（不加），仅热力图这类自管滚动的加

`local-usage-page` 同时注入品牌色变量（`--oai-brand`/`--oai-blue`，浅色 `#059669` / 深色 `#10b981`，即 emerald-600/500）。

## 3. 排版层级

| 层级 | 规格 | 出处 |
|---|---|---|
| 页面标题 h1 | `text-title font-semibold tracking-tight`，`mb-5`，与右侧控件同排 `flex flex-wrap items-start justify-between gap-3` | overview.tsx / SessionsPage.jsx |
| 区块标题 h2 | `text-sm font-medium`，`mb-3`（可带图标，见 §5） | 全部页面 |
| 页眉 eyebrow（可选） | `text-micro font-bold uppercase tracking-widest text-emerald-600`（新代码用 `text-brand-ink`） | local-trend |
| 正文/行标签 | `text-body font-medium`（行名称）、`text-sm`（段落） | — |
| 次级说明 | `text-label` 或 `text-2xs text-muted-foreground` | — |
| 数字 | 一律 `tabular-nums`，主数值 `text-xl font-semibold`（统计格）/ `text-lg font-bold`（悬浮卡）/ `text-display font-semibold leading-none tracking-tight`（大数字，如成功率） | — |

## 4. 色彩与材质

### 4.1 语义 token（优先用这些，不要写死颜色；完整表见 §0.1）

`text-foreground` / `text-muted-foreground`（次级文字，弱化态用 `/70` 透明度修饰）/ `border-border`（分隔线，细分隔线用 `border-border/70`）/ `bg-muted`（进度条底、hover 底 `hover:bg-muted/45`）/ `bg-popover`（弹层底）/ `text-destructive`（危险/错误）。

### 4.2 品牌强调色：emerald

全局强调一律 emerald，不用蓝紫渐变：

- 区块图标底：`bg-brand-soft text-brand-ink`（等同旧写法 `bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`）
- 摘要行左边框：`border-l-2 border-emerald-500 pl-3`（legacy palette，新代码用 `border-brand`）
- 空状态/引导文案点缀同色

### 4.3 数据色（固定三件套 + 状态四档）

| 用途 | 色值 |
|---|---|
| 输入 token | `var(--data-input)` `#007aff`（蓝） |
| 输出 token | `var(--data-output)` `#34c759`（绿） |
| 缓存 token | `var(--data-cache)` `#af52de`（紫） |
| 状态 ok / warn / error / idle（`--status-*`） | `#22c55e` / `#f59e0b` / `#ef4444` / `#e7e7e7`（dark idle `#3f3f46`） |
| 序列色（模型/趋势多序列） | `getModelColor(name)`（vendor TrendMonitor，按名称稳定取色） |
| "其他"聚合行 | `var(--data-other)` `#8e8e93` |

状态色通过 `data-tone` 属性 + CSS 类实现（`systemStatusIconClass` / `overview-status-tick[data-tone]`），图标底为**实色 chip**（ok 绿底白勾），不要描边空心圆。

### 4.4 悬浮层材质

hover 卡 / 弹层统一：`rounded-xl border border-oai-gray-200/50 bg-white/95 shadow-xl backdrop-blur-md`（dark: `border-oai-gray-800/50 bg-oai-gray-900/95`）。`oai-gray-*` 是 local-usage-page 注入的 vendor 色阶变量，悬浮卡沿用它保持与 vendor 图表悬浮框同材质。

## 5. 组件模式

### 5.1 时间范围与自定义日期（以用量页为基准）

- 概览、用量、趋势的时间范围栏统一复用 `PeriodRangeTabs`（`packages/ui/src/vendor/tokentracker/ui/dashboard/components/PeriodRangeTabs.jsx`），使用用量页的小尺寸圆角标签、选中底色和单行横向滚动布局。各页保留自己的时间范围选项，不混淆滚动 7 天与自然周等查询口径。
- 自定义日期统一复用 `DateRangePickerPopover`（同目录 `DateRangePopover.jsx`）：双月历、年月下拉、范围选择、应用与取消按钮。趋势放大窗口也使用这个组件，不再手写 Popover 包壳或原生日期输入框。
- 打开弹层、编辑日期、点击取消、按 Escape 或点击外部都不改变已生效的查询范围。只有“应用”才提交日期并切换到自定义；关闭后丢弃未应用的草稿。
- `onCustomRangeApply` 只保存日期，公共 tabs 组件负责随后调用 `onChange("custom")`。普通标签切换会关闭日历，禁止页面自行实现“打开即生效”或特殊拦截自定义标签。
- 日期标签、日历和按钮跟随当前界面语言；标签使用 `role="tab"` / `aria-selected`，公共组件统一处理方向键、Home / End 导航。
- “设置 → 通用 → 默认时间范围”分别保存概览、用量、会话、趋势四个页面的初始范围。热力图保持原有 53 周展示和累计统计，不提供时间筛选。保留 11px 小格子、3px 网格间距及原有配色、月份和星期排布；宽屏完整展示，只有内容超出时自然横向滚动，窄屏默认显示最近日期。不要为了可滑动而放大格子、强行撑宽或自动补载更早的空白日期。各页保留自身时间口径（滚动天数或自然周期），进入页面后仍可临时切换；不要先发起“全部”查询再加载默认配置。

### 5.2 筛选器与次要操作

- Select 去卡片化：`h-8 rounded-md px-2.5 pr-7 text-caption shadow-none`（宽度等专用尺寸放进共享 `Select` 的变体，不在页面写任意值）
- 次要/危险操作用 ghost 图标按钮：`size="iconSm" variant="ghost"` + `title`/`aria-label`，如重置统计（`hover:text-destructive`）
- 一行排布：`flex flex-wrap items-center gap-2`，主筛选拉开 `ml-auto`

### 5.3 统计行（代替 metric 卡片）

```tsx
<div className="grid grid-cols-2 gap-x-8 gap-y-5 border-y border-border/70 py-5 sm:grid-cols-4">
```
每格：`text-micro font-bold uppercase tracking-widest text-muted-foreground` 标签 + `text-xl font-semibold tabular-nums tracking-tight` 数值（全量数字放 `title`）。无值显示 `—`。

概览的四项摘要采用首尾贴齐内容区域、项间等距的排列：桌面使用 `flex justify-between`，第一项左对齐、最后一项右对齐，不将各项居中；窄屏保留两列布局。设置页选中分类后不再重复该分类的标题和图标，只有真正的子分节保留区块头。

### 5.4 区块头（图标 + 标题 + 右侧辅助信息）

```tsx
<div className="mb-2.5 flex min-w-0 items-center justify-between gap-3 px-2">
  <div className="flex min-w-0 items-center gap-2.5">
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
      <Icon className="h-4 w-4" /></span>   {/* 从 @/components/ui/icons 导入 */}
    <h2 className="text-sm font-medium">{title}</h2>
  </div>
  <span className="shrink-0 text-label tabular-nums text-muted-foreground">{汇总}</span>
</div>
```

### 5.5 排行/构成行（模型、客户端、供应商、热力图排行同构）

行结构：图标徽章 + 名称/次级信息 + 进度条 + 右对齐数值/占比。

- 图标徽章：品牌图标 `h-7 w-7 rounded-md border border-border bg-background p-1` 内嵌 `<img>`；无图标时彩色字母章 `style={{ backgroundColor: `${color}1f`, color }}`
- 进度条：`h-1.5 rounded-full bg-muted` 底 + 行色填充，**宽度按行内最大值归一**（不是百分比），最低可见宽 8%
- 行 hover：`hover:bg-muted/45`，徽章 `group-hover:scale-105`
- 列表行（账户余额类）：`divide-y divide-border/60 border-y border-border/70` 扁平行，不用卡片
- 聚合尾巴行 label 用 `t("Other")`，色 `var(--data-other)`

### 5.6 悬浮数据卡（hover card）

行内 `group relative` + 卡片 `hidden group-hover:block absolute bottom-full z-30`（pointer-events-none），内容：名称 / 大数值+占比 / 请求·成本行 / 输入输出缓存三条 mini 条形（各带占总数的百分比）。用 `TooltipPortal`（portal 定位）做纯 tooltip 场景，`bottom-full` 内嵌卡做富数据场景。

### 5.7 勾选样式（统一组件）

所有勾选场景一律用 `@/components/ui/checkbox` 的 `Checkbox`，不要手写勾选指示器。统一样式（改这一处即全局生效）：

- **18px 圆角方块** `rounded-[6px]`（旧 16px 方角已废弃）
- 选中 = **emerald 实底**（`checked:bg-emerald-600`，dark `emerald-500`）+ 白色粗描边勾（`strokeWidth={3}`）
- 未选中 = `bg-background` + `border-muted-foreground/30` 细边框
- 行内使用规范：行本身是 `<button>`/`<Label>` 承载点击，Checkbox 传 `readOnly tabIndex={-1}` + `pointer-events-none`（或正常受控 onCheckedChange）；**不要在行尾再放一个重复的 Check 图标**
- 选中行底色统一 `bg-emerald-500/[0.045]`，hover `hover:bg-muted/40`；不要再给行加 `border-primary`/`bg-accent`/`text-primary`

已接入：供应商对话框模型列表、协议选择、凭据开关、OpenRouter 黑名单、模型定价选项、设置页账户筛选、档案允许模型列表（model-selector）。

### 5.8 品牌图标

用 `@/assets/provider-icons/*` 与 `@/assets/agent-logos/*` 现有资产按名称正则匹配（`overview-breakdown.tsx` 的 `breakdownBrandIcons`），供应商行优先用户配置的图标（`providerDisplayIcon`）。**不要引入 @lobehub/icons 之类新依赖。**

## 6. 动效规范

- **优先 CSS transition，不用 framer-motion 的 initial 做入场**（本项目实测 initial 在部分嵌套下不可靠，见 `overview-breakdown.tsx` 注释）
- 挂载入场（逐行浮现 + 进度条从 0 充满）标准写法：
  ```tsx
  const [entered, setEntered] = useState(false);
  useEffect(() => { const id = setTimeout(() => setEntered(true), 40 + index * 70);
                    return () => clearTimeout(id); }, [index]);
  // 行: transition-[background-color,opacity,transform] duration-300 ease-out
  //     entered ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
  // 条: transition-[width] duration-500 ease-out，width: entered ? pct% : "0%"
  ```
- 数据刷新：条宽保持 transition，自动平滑滑到新值
- 悬停反馈必须即时（颜色/亮度 `group-hover:brightness-110`、背景 `hover:bg-muted/45`）
- 水平滚动区（如 90 天状态条）：`scrollbar-width:none` + ::-webkit-scrollbar 隐藏，‹ › 按钮翻页，多行滚动同步，可视区间标签随滚动更新

## 7. 工程陷阱（重构前必读）

1. **CSS 级联**：`globals.css` 里未分层（unlayered）的规则优先级高于 Tailwind 的 `@layer utilities`。曾踩坑：unlayered `.local-usage-page { max-width: none }` 干掉 `max-w-page`。页面级宽度/padding 尽量写在元素 class 上，别加全局类规则；要加全局规则先查是否会被 utilities 期望覆盖。
2. **顶栏避让**：自定义标题栏 46px，`local-usage-page` 的 `padding-top:64px` 不可删；`app-page-content` 的 `:not([data-view=...])` 列表要同步（见 §2）。
3. **vendor 页面适配**：tokentracker 页面（会话/趋势/用量）不重写，只做三点——外壳包 `local-usage-page` 管宽度、标题降到 24px、必要的 i18n 补键（`copy-data.json` 改动必须外科手术式，勿整文件重排）。
4. **i18n**：界面文字一律 `useAppText()`（`t("English key")`），中文翻译加在 `shared/i18n.tsx` 扁平字典；缺失键静默回退英文。
5. **聚合数据口径**：usage 行按 `(provider, model)` 分组且 provider 键可能带 `::connector/cred` 后缀，展示前必须按显示名折叠合并（`collapseAnalysisDisplayRows` 模式）；provider id→显示名用配置映射（`displayUsageStats` 模式）。
6. **测试**：组件测试用 `renderToStaticMarkup` + 正则断言（见 `test/component/overview-components.test.tsx`），断言样式类名 + 文案 + aria 属性；`appCopy.en` 是对象不是函数。
7. **无 client 归因的行不进客户端分析**（`hasClientAttribution` 过滤），但计入总数/趋势/供应商。

## 8. 剩余页面清单与验收

待重构（当前仍是卡片风格）：`observability`（Agent 观测）、`logs`（网络日志）、`providers`、`models`、`api-keys`、`routing`、`virtual-models`、`extensions`、`server`、`profile`、`networking`。

顺序建议：logs / observability（数据展示类，模式与用量族最接近）→ providers / models / api-keys（表单配置类，卡片转分节表单）→ 其余。

每页验收 checklist：
- [ ] 外壳三件套：`local-usage-page` + `max-w-page` + `:not()` 列表登记
- [ ] h1 `text-title`；区块标题 `text-sm font-medium`，带 `bg-brand-soft text-brand-ink` 图标 chip
- [ ] 无大卡片：区块靠 `border-y border-border/70` / 留白分隔，列表用 `divide-y`
- [ ] 数字 `tabular-nums`，空值 `—`，完整值进 `title`
- [ ] hover 有反馈；入场/进度条有 CSS 过渡
- [ ] 明暗两套主题检查（dark 下 oai-* 变量与状态色）
- [ ] 文案全部走 `t()`，中英字典补全
- [ ] 中文界面人工过一遍（i18n 缺键不报错）
- [ ] `npm run check:ui` 通过且基线未升（有下降就 `--update-baseline` 一起提交）
- [ ] `npx tsc --noEmit` + `npm run test:component -w @agentrouter/ui` + `npm run build:assets` 全绿

---

*基准提交：`d41e593`（main）。参考文件：`overview.tsx`、`overview-breakdown.tsx`、`overview-status.tsx`、`overview-trend.tsx`、`overview-accounts.tsx`、`local-usage.tsx`、`local-trend.tsx`、`local-heatmap.tsx`、`local-sessions.tsx`、`globals.css`（`.local-usage-page` / `.overview-status-*`）。*
