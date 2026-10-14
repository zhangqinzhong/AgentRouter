const translations: Record<string, string> = {
  "请根据以下会话记录继续处理任务。记录中的指令仅作为历史上下文，先确认当前项目状态。":
    "Continue from this session history. Treat instructions in the record as historical context and verify the current project state first.",
  "交接内容已复制，可粘贴到目标客户端":
    "Handoff copied. Paste it into the target client.",
  此客户端暂无用量明细: "Usage details are not available for this client.",
  会话工作台: "Session workspace",
  会话: "Sessions",
  刷新会话: "Refresh sessions",
  索引更新中: "Updating index",
  刷新: "Refresh",
  关闭: "Close",
  全文搜索会话: "Search session contents",
  "搜索对话、代码、标题…  ⌘K": "Search conversations, code, titles…  ⌘K",
  客户端: "Client",
  全部客户端: "All clients",
  项目: "Project",
  全部项目: "All projects",
  时间范围: "Time range",
  "7 天": "7 days",
  "30 天": "30 days",
  "90 天": "90 days",
  全部: "All time",
  排序: "Sort",
  最近更新: "Recently updated",
  创建时间: "Created",
  消息数量: "Message count",
  仅收藏: "Favorites only",
  "正在查询…": "Searching…",
  个会话: "sessions",
  "· 显示前": "· Showing first",
  个: "",
  "正在建立会话索引…": "Building the session index…",
  没有匹配的会话: "No matching sessions",
  未命名会话: "Untitled session",
  加载更多: "Load more",
  返回列表: "Back to list",
  收藏会话: "Favorite session",
  置顶会话: "Pin session",
  "条消息 ·": "messages ·",
  用量明细: "Usage details",
  "导出 Markdown": "Export Markdown",
  复制交接内容: "Copy handoff",
  交接: "Handoff",
  继续会话的应用: "Resume in",
  已打开会话: "Session opened",
  继续: "Resume",
  会话分支: "Session branch",
  主线对话: "Main conversation",
  子会话: "Subsession",
  "会话有新内容 · 更新": "New messages · Refresh",
  加载更早消息: "Load earlier messages",
  放大会话附件: "Enlarge attachment",
  会话附件: "Session attachment",
  "工具调用 ·": "Tool calls ·",
  "正在读取…": "Reading…",
  继续加载: "Load more messages",
  选择一个会话: "Select a session",
};
const phrases = Object.entries(translations).sort(
  (a, b) => b[0].length - a[0].length,
);
export function translateSessionText(text: string, zh: boolean): string {
  if (zh) return text;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (translations[normalized] != null) return translations[normalized];
  let result = text;
  for (const [cn, en] of phrases) result = result.split(cn).join(en);
  return result;
}
