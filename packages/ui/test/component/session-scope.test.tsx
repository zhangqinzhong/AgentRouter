import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppI18nContext, appCopy } from "@agentrouter/ui/pages/home/shared/i18n.tsx";
import { nextSessionScope, SessionScopeNav } from "@agentrouter/ui/pages/home/components/session-scope.tsx";

const agents = [
  { id: "claude-code", name: "Claude Code", count: 12 },
  { id: "workbuddy", name: "WorkBuddy", count: 4 },
];
const projects = [{ path: "/Users/me/AgentRouter", name: "AgentRouter", count: 20 }];

test("session scope stays put when the sessions page is hidden", () => {
  assert.equal(nextSessionScope("claude-code", "claude-code", false), "claude-code");
  assert.equal(nextSessionScope("claude-code", "claude-code", true), "all");
  assert.equal(nextSessionScope("all", "workbuddy", true), "workbuddy");
});

test("sidebar lists agents and projects under the session scope", () => {
  const html = renderToStaticMarkup(
    <AppI18nContext.Provider value={appCopy.zh}>
      <SessionScopeNav
        agent="workbuddy"
        agents={agents}
        agentsOpen
        onSelectAgent={() => undefined}
        onSelectProject={() => undefined}
        onToggleAgents={() => undefined}
        onToggleProjects={() => undefined}
        project="all"
        projects={projects}
        projectsOpen
        sessionsVisible
      />
    </AppI18nContext.Provider>,
  );

  assert.match(html, />Agent</);
  assert.match(html, />项目</);
  assert.match(html, />Claude Code</);
  assert.match(html, />WorkBuddy</);
  assert.match(html, />AgentRouter</);
  assert.match(html, />12</);
  assert.match(html, />20</);
  assert.match(html, /aria-current="true"/);
  assert.equal(html.indexOf("Claude Code") < html.indexOf("WorkBuddy"), true);
});

test("collapsed session scope hides its rows", () => {
  const html = renderToStaticMarkup(
    <AppI18nContext.Provider value={appCopy.en}>
      <SessionScopeNav
        agent="all"
        agents={agents}
        agentsOpen={false}
        onSelectAgent={() => undefined}
        onSelectProject={() => undefined}
        onToggleAgents={() => undefined}
        onToggleProjects={() => undefined}
        project="all"
        projects={[]}
        projectsOpen
        sessionsVisible
      />
    </AppI18nContext.Provider>,
  );

  assert.match(html, />Agent</);
  assert.doesNotMatch(html, /Claude Code/);
  assert.doesNotMatch(html, /Projects/);
});
