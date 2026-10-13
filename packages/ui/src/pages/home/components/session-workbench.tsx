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
          <ReactMarkdown
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
            {m.text}
          </ReactMarkdown>
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
      <details className="group mb-4 rounded-lg border border-border/40 bg-muted/15 px-3 py-2">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
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
          ? "mb-7 ml-auto w-fit max-w-[95%] rounded-2xl rounded-tr-sm bg-muted/70 px-5 py-3"
          : "mb-7 px-1"
      }
    >
      {content}
    </div>
  );
}
