import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptMessage } from "../../src/pages/home/components/session-workbench";
test("transcripts render untrusted source text inertly and tools collapsed", () => {
  const html = renderToStaticMarkup(
    <TranscriptMessage
      zh
      message={{
        id: 1,
        role: "tool",
        name: "Read",
        text: '<img src="https://example.invalid/track" onerror="alert(1)"><script>bad()</script>',
        truncated: true,
      }}
    />,
  );
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /已截断/);
});

test("conversation renders Markdown without executing HTML or fetching images", () => {
  const html = renderToStaticMarkup(
    <TranscriptMessage
      zh
      message={{
        id: 2,
        role: "assistant",
        text: "## Result\n\n**Done**\n\n```ts\nconst x = 1;\n```\n\n![tracking](https://example.invalid/pixel)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))",
      }}
    />,
  );
  assert.match(html, /<h2>Result<\/h2>/);
  assert.match(html, /<strong>Done<\/strong>/);
  assert.match(html, /<pre><code/);
  assert.doesNotMatch(html, /<img|<script|href="javascript:/);
});
test("injected context stays accessible but collapsed", () => {
  const html = renderToStaticMarkup(
    <TranscriptMessage
      zh
      message={{
        id: 3,
        role: "assistant",
        text: "<codex_apps_client_time_context>context</codex_apps_client_time_context>",
      }}
    />,
  );
  assert.match(html, /会话上下文/);
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(html, /context/);
});

test('code highlighting escapes transcript HTML and unknown language remains readable',()=>{
 const html=renderToStaticMarkup(<TranscriptMessage zh message={{id:1,role:'assistant',text:'```js\nconst html = "<script>bad()</script>";\n```'}}/>);
 assert.match(html,/hljs-keyword/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
});

test('a code-search hit highlights literal characters inside folded tool output', () => {
 const html=renderToStaticMarkup(<TranscriptMessage zh highlight="useEffect(" message={{id:1,role:'tool',text:'before useEffect( after <script>x</script>'}}/>);
 assert.match(html,/<mark[^>]*>useEffect\(<\/mark>/);assert.doesNotMatch(html,/<script>/);assert.match(html,/工具输出/);
});
