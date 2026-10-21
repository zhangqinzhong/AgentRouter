import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptMessage, TranscriptTools } from "../../src/pages/home/components/session-workbench";
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
test("claude command envelopes show the command text without wrapper tags", () => {
  const command = renderToStaticMarkup(
    <TranscriptMessage
      zh
      message={{
        id: 4,
        role: "user",
        text: "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>",
      }}
    />,
  );
  assert.match(command, /\/effort\s+effort/);
  assert.doesNotMatch(command, /command-name|command-message|command-args/);

  const stdout = renderToStaticMarkup(
    <TranscriptMessage
      zh
      message={{
        id: 5,
        role: "user",
        text: "<local-command-stdout>Set effort level to max (this session only).</local-command-stdout>",
      }}
    />,
  );
  assert.match(stdout, /Set effort level to max \(this session only\)\./);
  assert.doesNotMatch(stdout, /local-command-stdout/);
});

test("codex memory citations render the file, note, and source session", () => {
  const html = renderToStaticMarkup(
    <TranscriptMessage
      zh
      message={{
        id: 6,
        role: "assistant",
        text: "本轮完成了源码更新和静态核对。\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:398-400|note=[Reverified ZCode source and version instead of relying on the historical audit]\nMEMORY.md:12-14|note=[note with <script>alert(1)</script>]\n</citation_entries>\n<rollout_ids>\n01a0b39a-7943-7623-bd7a-5adf4c4c4c7c\n</rollout_ids>\n</oai-mem-citation>",
      }}
    />,
  );
  assert.match(html, /本轮完成了源码更新和静态核对/);
  assert.match(html, /记忆引用/);
  assert.match(html, /Reverified ZCode source and version instead of relying on the historical audit/);
  assert.match(html, /MEMORY\.md:398-400/);
  assert.match(html, /来源会话/);
  assert.match(html, /01a0b39a-7943-7623-bd7a-5adf4c4c4c7c/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /citation_entries|rollout_ids|oai-mem-citation|<script>/);

  const quoted = renderToStaticMarkup(
    <TranscriptMessage
      zh
      message={{
        id: 7,
        role: "assistant",
        text: "格式如下：\n\n```\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[keep this example]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>\n```\n",
      }}
    />,
  );
  assert.match(quoted, /keep this example/);
  assert.match(quoted, /&lt;citation_entries&gt;/);
  assert.doesNotMatch(quoted, /记忆引用/);

  const emptyRollout = renderToStaticMarkup(
    <TranscriptMessage
      message={{
        id: 8,
        role: "assistant",
        text: "Checked.\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:650-650|note=[historical branch only]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>",
      }}
      zh={false}
    />,
  );
  assert.match(emptyRollout, /Memory citation/);
  assert.match(emptyRollout, /historical branch only/);
  assert.match(emptyRollout, /MEMORY\.md:650-650/);
  assert.doesNotMatch(emptyRollout, /Source session|citation_entries/);
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


test("tool clusters expose inputs and outputs with one disclosure and escape source HTML", () => {
  const html = renderToStaticMarkup(<TranscriptTools zh highlight="needle" tools={[{id:"tool-1",name:"Read",input:'<script>needle</script>',output:'done'}]} />);
  assert.equal((html.match(/<details/g) || []).length, 1);
  assert.doesNotMatch(html, /<details[^>]*open|<script>/);
  assert.match(html, /输入/);
  assert.match(html, /输出/);
  assert.match(html, /<mark[^>]*>needle<\/mark>/);
  assert.match(html, /done/);
});
