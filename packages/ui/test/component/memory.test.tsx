import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryDocument, MemoryEmpty, MemorySnippet, MemoryToolForm, MemoryView } from "@agentrouter/ui/pages/home/components/memory";
import { AppI18nContext, appCopy } from "@agentrouter/ui/pages/home/shared/i18n";
import { groupSidebarNavigation } from "@agentrouter/ui/pages/home/components/layout";
import { navigation } from "@agentrouter/ui/pages/home/shared/options";

test("memory is a native workspace page, without iframe, webview, or an engine install button", () => {
  const html = renderToStaticMarkup(<AppI18nContext.Provider value={appCopy.zh}><MemoryView /></AppI18nContext.Provider>);
  assert.match(html, /记忆/); assert.match(html, /项目记忆/); assert.match(html, /客户端/); assert.match(html, /设置/);
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.match(html, /max-w-\[1120px\]/);
  assert.doesNotMatch(html, /<iframe|<webview|Install engine/);
  assert.ok(groupSidebarNavigation(navigation).find((group) => group.id === "workspace")?.items.some((item) => item.id === "memory"));
});
test("stored markdown is rendered as inert text rather than executable upstream HTML", () => {
  const html = renderToStaticMarkup(<MemoryDocument text={'# Title\n\n<script>window.agentrouter.quitApp()</script>'} />);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script/);
});
test("missing runtime is distinguished from a stopped service", () => {
  assert.match(renderToStaticMarkup(<MemoryEmpty unavailable />), /runtime is missing/);
});
test("native page titles are not duplicated and snippets only admit safe highlight markup", () => {
  const html = renderToStaticMarkup(<MemoryDocument text={"# Title\n\nBody"} omitHeading="Title" />);
  assert.doesNotMatch(html, />Title</);
  assert.match(html, /Body/);
  const snippet = renderToStaticMarkup(<MemorySnippet text={"<mark>Found</mark><script>unsafe()</script>"} />);
  assert.match(snippet, /<mark[^>]*>Found<\/mark>/);
  assert.match(snippet, /&lt;script&gt;/);
  assert.doesNotMatch(snippet, /<script/);
});
test("native operation forms retain schema fields and structured argument escape hatch", () => {
  const html = renderToStaticMarkup(<MemoryToolForm tool={{ name: "memory_write_page", inputSchema: { type: "object", properties: { workspace: { type: "string" }, pinned: { type: "boolean" } }, required: ["workspace"] } }} scope={{ workspace: "floatboat", project: "backend" }} busy={false} onRun={() => undefined} />);
  assert.match(html, /floatboat/); assert.match(html, /pinned/); assert.match(html, /Use JSON arguments/);
});
