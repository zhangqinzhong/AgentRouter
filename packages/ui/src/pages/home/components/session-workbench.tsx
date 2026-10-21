import { createElement, type ReactNode, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { common, createLowlight } from "lowlight";
import { ChevronRight } from "lucide-react";
type Message = {
  id: number;
  role: string;
  text: string;
  name?: string;
  truncated?: boolean;
};
// Consecutive calls remain individually inspectable without dominating the conversation.
export function groupTranscript(messages: Message[]): Message[][] {
  return messages.reduce<Message[][]>((groups, message) => {
    const last = groups[groups.length - 1];
    if (message.role === "tool" && last?.[0].role === "tool")
      last.push(message);
    else groups.push([message]);
    return groups;
  }, []);
}

type MemoryEntry = {
  path: string;
  start?: string;
  end?: string;
  note: string;
};
type MemoryCitation = { entries: MemoryEntry[]; rolloutIds: string[] };

// Codex appends one memory citation to a final answer. The outer tag is HTML,
// so skipHtml removes it; citation_entries and rollout_ids contain underscores
// and stay on screen as literal tags. Parse the block before Markdown.
function parseMemoryCitation(
  entriesText: string,
  rolloutText: string,
): MemoryCitation {
  const entries = entriesText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(.+):(\d+)-(\d+)\|note=\[(.*)\]$/.exec(line);
      if (!match) return { path: line, note: "" };
      return { path: match[1], start: match[2], end: match[3], note: match[4] };
    });
  return {
    entries,
    rolloutIds: rolloutText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function splitMemoryCitations(text: string): {
  body: string;
  citations: MemoryCitation[];
} {
  const fences: string[] = [];
  const masked = text.replace(/```[\s\S]*?```/g, (fence) => {
    const token = `\u0000${fences.length}\u0000`;
    fences.push(fence);
    return token;
  });
  const citations: MemoryCitation[] = [];
  const stripped = masked.replace(
    /<oai-mem-citation>\s*<citation_entries>([\s\S]*?)<\/citation_entries>\s*<rollout_ids>([\s\S]*?)<\/rollout_ids>\s*<\/oai-mem-citation>/g,
    (_match, entries, rollouts) => {
      const citation = parseMemoryCitation(entries, rollouts);
      if (citation.entries.length === 0 && citation.rolloutIds.length === 0)
        return "";
      citations.push(citation);
      return "";
    },
  );
  return {
    citations,
    body: stripped
      .replace(
        /\u0000(\d+)\u0000/g,
        (_match, index) => fences[Number(index)] ?? "",
      )
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+|\n+$/g, ""),
  };
}

function MemoryCitations({
  citations,
  zh,
}: {
  citations: MemoryCitation[];
  zh: boolean;
}) {
  if (citations.length === 0) return null;
  return (
    <details className="session-disclosure mt-3 text-xs leading-6 text-muted-foreground">
      <summary>
        <ChevronRight size={14} />
        {zh ? "记忆引用" : "Memory citation"}
      </summary>
      {citations.map((citation, index) => (
        <div key={index}>
          {citation.entries.map((entry, entryIndex) => (
            <div key={entryIndex} className="mt-1">
              {entry.note ? (
                <div className="break-words">{entry.note}</div>
              ) : null}
              <div className="font-mono break-words">
                {entry.start
                  ? `${entry.path}:${entry.start}-${entry.end}`
                  : entry.path}
              </div>
            </div>
          ))}
          {citation.rolloutIds.length > 0 && (
            <div className="mt-1">
              <div>{zh ? "来源会话" : "Source session"}</div>
              {citation.rolloutIds.map((id) => (
                <div key={id} className="font-mono break-words">
                  {id}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </details>
  );
}

const syntax = createLowlight(common);
function syntaxNodes(nodes: any[]): ReactNode[] {
  return nodes.map((node, i) =>
    node.type === "text"
      ? node.value
      : createElement(
          "span",
          { key: i, className: (node.properties?.className || []).join(" ") },
          syntaxNodes(node.children || []),
        ),
  );
}
export function TranscriptCode({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const text = String(children ?? "");
  const language = /language-([\w+-]+)/.exec(className || "")?.[1];
  // Never pass transcript HTML through dangerouslySetInnerHTML. Bound highlighting cost.
  const highlighted = useMemo(() => {
    if (!language || text.length > 50000 || !syntax.registered(language))
      return null;
    try {
      return syntaxNodes(syntax.highlight(language, text).children);
    } catch {
      return null;
    }
  }, [language, text]);
  return <code className={className}>{highlighted || children}</code>;
}

export function TranscriptMessage({
  message: m,
  zh,
  highlight,
}: {
  message: Message;
  zh: boolean;
  highlight?: string;
}) {
  // Keep injected context available, but out of the normal conversational reading flow.
  const context =
    m.role === "system" ||
    m.role === "developer" ||
    /^\s*<(codex_apps_client_time_context|turn_aborted|environment_context|system_reminder|external_codex_apps_open_page|codex_apps_client_context)>/.test(
      m.text,
    ) ||
    /^# AGENTS\.md instructions/.test(m.text);
  const externalTool = /^\s*\[external_agent_tool_(call|result)[:\]]/.test(
    m.text,
  );
  const folded =
    context || externalTool || m.role === "tool" || m.role === "thinking";
  const cited = useMemo(() => splitMemoryCitations(m.text), [m.text]);
  const match = highlight
    ? m.text.toLowerCase().indexOf(highlight.toLowerCase())
    : -1;
  const markedText =
    match < 0 ? (
      m.text
    ) : (
      <>
        {m.text.slice(0, match)}
        <mark className="bg-amber-200 text-black">
          {m.text.slice(match, match + highlight!.length)}
        </mark>
        {m.text.slice(match + highlight!.length)}
      </>
    );
  const content = (
    <>
      {folded ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 [overflow-wrap:anywhere]">
          {markedText}
        </pre>
      ) : (
        <div className="session-markdown text-[14px] leading-7 [overflow-wrap:anywhere]">
          {/* Claude 把 /effort 这类命令包在 command-name 等标签里。react-markdown 会把标签本身印成文字；跳过原始 HTML 后只留下标签里的内容。 */}
          {cited.body ? (
            <ReactMarkdown
              skipHtml
              remarkPlugins={[remarkGfm]}
              components={{
                code: TranscriptCode,
                img: ({ alt }) => (
                  <span className="text-muted-foreground">
                    [{zh ? "图片" : "Image"}
                    {alt ? `: ${alt}` : ""}]
                  </span>
                ),
                a: ({ href, children }) => (
                  <a
                    href={href && /^https?:\/\//i.test(href) ? href : undefined}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {children}
                  </a>
                ),
                table: ({ children }) => (
                  <div className="overflow-x-auto">
                    <table>{children}</table>
                  </div>
                ),
              }}
            >
              {cited.body}
            </ReactMarkdown>
          ) : null}
          <MemoryCitations citations={cited.citations} zh={zh} />
        </div>
      )}
      {m.truncated && (
        <p className="mt-2 text-xs text-muted-foreground">
          {zh ? "此条记录已截断" : "This record was truncated"}
        </p>
      )}
    </>
  );
  if (folded)
    return (
      <details className="session-disclosure mb-3 rounded-lg border border-border/40 bg-muted/15 px-3 py-2">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform " />
          {context
            ? zh
              ? "会话上下文"
              : "Session context"
            : m.role === "thinking"
              ? zh
                ? "思考过程"
                : "Thinking"
              : m.name || (zh ? "工具输出" : "Tool output")}
        </summary>
        <div className="mt-3 border-t border-border/40 pt-3">{content}</div>
      </details>
    );
  return (
    <div
      className={
        m.role === "user"
          ? "mb-6 ml-auto w-fit min-w-0 max-w-[min(90%,540px)] rounded-2xl bg-muted/70 px-4 py-3"
          : "mb-5 min-w-0 px-1"
      }
    >
      {content}
    </div>
  );
}

type TranscriptTool = {
  id: string;
  name: string;
  input?: string;
  input_preview?: string;
  output?: string;
};
export function TranscriptTools({
  tools,
  zh,
  highlight,
}: {
  tools: TranscriptTool[];
  zh: boolean;
  highlight?: string;
}) {
  if (!tools.length) return null;
  const first = tools[0];
  const preview = (first.input_preview || first.input || "")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return (
    <details className="session-disclosure mb-5 min-w-0 rounded-lg border border-border/50 bg-muted/20">
      <summary className="px-3 py-2.5 text-xs text-muted-foreground">
        <ChevronRight size={14} className="shrink-0" />
        <span className="shrink-0 font-medium text-foreground">
          {first.name}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{preview}</span>
        <span className="shrink-0">
          {tools.length} {zh ? "次调用" : "calls"}
        </span>
      </summary>
      <div className="border-t border-border/50 p-3">
        {tools.map((tool, i) => (
          <div key={tool.id || i} className="min-w-0 [&+&]:mt-4">
            <div className="mb-2 text-xs font-medium">{tool.name}</div>
            {[
              [zh ? "输入" : "Input", tool.input || tool.input_preview],
              [zh ? "输出" : "Output", tool.output],
            ].map(([label, value]) =>
              value ? (
                <div key={label} className="mb-3">
                  <div className="mb-1 text-[11px] text-muted-foreground">
                    {label}
                  </div>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-xs leading-6 [overflow-wrap:anywhere]">
                    {highlight &&
                    value.toLowerCase().includes(highlight.toLowerCase())
                      ? (() => {
                          const at = value
                            .toLowerCase()
                            .indexOf(highlight.toLowerCase());
                          return (
                            <>
                              {value.slice(0, at)}
                              <mark className="bg-amber-200 text-black">
                                {value.slice(at, at + highlight.length)}
                              </mark>
                              {value.slice(at + highlight.length)}
                            </>
                          );
                        })()
                      : value}
                  </pre>
                </div>
              ) : null,
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
