import { expect, test, type Page } from "@playwright/test";
import type { RequestLogEntry } from "../../packages/core/src/contracts/app";
import { createEmptyAgentAnalysis } from "../../packages/ui/src/pages/home/shared/usage";
import { disposeCliWebRuntime, startCliWebServer, type CliWebRuntime } from "./cli-web-runtime";

let runtime: CliWebRuntime;
test.beforeAll(async () => { runtime = await startCliWebServer("flat-pages-e2e"); });
test.afterAll(async () => { if (runtime) await disposeCliWebRuntime(runtime); });

const request: RequestLogEntry = {
  cacheReadTokens: 640, cacheWriteTokens: 0, client: "codex", costUsd: 0.012,
  createdAt: "2026-09-18T12:00:00Z", credentialChain: [], credentialSaturated: false,
  durationMs: 1400, id: 1, inputTokens: 1200, isStream: true, method: "POST",
  model: "gpt-5.2", ok: true, outputTokens: 180, path: "/v1/responses",
  provider: "OpenAI", reasoningTokens: 0, requestBody: { encoding: "utf8", sizeBytes: 2, text: "{}", truncated: false },
  requestHeaders: {}, requestId: "request-flat-01", routeAttemptCount: 1, routeHopCount: 1,
  routeTraceTruncated: false, retryAttempts: [], responseBody: { encoding: "utf8", sizeBytes: 2, text: "{}", truncated: false },
  responseHeaders: {}, statusCode: 200, timeToFirstTokenMs: 160, totalTokens: 2020, url: "/v1/responses"
};

async function prepare(page: Page, language: "en" | "zh" = "en", theme: "light" | "dark" = "light", logs = true) {
  await page.addInitScript((value) => localStorage.setItem("ar.ui.language", value), language);
  await page.route("**/api/ar/rpc", async (route) => {
    const { method, args } = route.request().postDataJSON();
    if (method === "getRequestLogs") {
      const filter = args?.[0] ?? {};
      const items = filter.query && !`${request.model} ${request.provider}`.toLowerCase().includes(filter.query.toLowerCase())
        ? [] : [request];
      return route.fulfill({ json: { ok: true, value: {
        generatedAt: request.createdAt, items, options: { credentials: [], models: [request.model], providers: [request.provider] },
        page: 1, pageSize: filter.pageSize ?? 25, total: items.length, totalPages: 1
      } } });
    }
    if (method === "getRequestLogDetail") return route.fulfill({ json: { ok: true, value: request } });
    if (method === "getAgentAnalysis") {
      const snapshot = createEmptyAgentAnalysis(args?.[0]?.range ?? "24h");
      const session = {
        ...snapshot.totals, agent: "codex" as const, client: "codex", costUsd: 0.012, durationMs: 1400,
        id: "session-flat-01", lastSeenAt: request.createdAt, models: ["gpt-5.2"], providers: ["OpenAI"],
        requestCount: 1, startedAt: request.createdAt, topTools: [], totalTokens: 2020
      };
      snapshot.sessions = [session];
      snapshot.scannedRequestCount = 1;
      snapshot.requestScanLimit = 1000;
      snapshot.selectedSession = args?.[0]?.sessionId ? {
        conversation: [], endpoints: [], errors: [], models: [], requests: [], routes: [],
        session, statusCodes: [], subagents: [], tools: [], totals: session,
        trace: {
          agent: "codex", durationMs: 1400, endedAt: request.createdAt, errorCount: 0, id: "trace-flat-01",
          llmRunCount: 1, maxDepth: 1, rootRunId: "root", runCount: 0, runs: [],
          sessionId: session.id, startedAt: request.createdAt, subagentRunCount: 0, toolRunCount: 0
        }
      } : undefined;
      return route.fulfill({ json: { ok: true, value: snapshot } });
    }
    await route.continue();
  });
  await page.goto(`${runtime.baseUrl}/?ar_web_token=${runtime.token}`);
  await page.waitForFunction(() => Boolean(window.agentrouter?.getConfig));
  await page.evaluate(async ({ theme, logs }) => {
    const config = await window.agentrouter!.getConfig();
    config.theme = theme;
    config.gateway.enabled = false;
    config.Providers = [
      { name: "OpenAI", api_base_url: "http://127.0.0.1:9/v1", api_key: "test-only", models: ["gpt-5.2", "gpt-5.2-mini"], type: "openai_chat_completions" },
      { name: "Anthropic", api_base_url: "http://127.0.0.1:9/v1", api_key: "test-only", models: ["claude-sonnet-4"], type: "anthropic" }
    ];
    config.profile.profiles = [
      { id: "codex-dev", agent: "codex", name: "Codex Development", model: "OpenAI/gpt-5.2", enabled: false, scope: "agentrouter", surface: "cli" }
    ];
    config.observability = { ...config.observability, requestLogs: logs, agentAnalysis: true };
    config.botConfigs = [];
    await window.agentrouter!.saveConfig(config);
    await window.agentrouter!.setOnboardingFinished?.();
  }, { theme, logs });
  await page.reload();
  await expect(page.getByRole("button", { name: language === "en" ? "Providers" : "供应商", exact: true })).toBeVisible();
}

const pages = [
  { view: "logs", en: "Logs", zh: "日志", titleEn: "Request logs", titleZh: "请求日志" },
  { view: "observability", en: "Observability", zh: "观测", titleEn: "Observability", titleZh: "可观测" },
  { view: "providers", en: "Providers", zh: "供应商", titleEn: "Providers", titleZh: "供应商" },
  { view: "models", en: "Models", zh: "模型", titleEn: "Models", titleZh: "模型" },
  { view: "api-keys", en: "API Keys", zh: "API 密钥", titleEn: "API keys", titleZh: "API 密钥" },
  { view: "profile", en: "Agent Profiles", zh: "Agent 配置档案", titleEn: "Agent profiles", titleZh: "Agent 配置档案" },
  { view: "routing", en: "Global Routing", zh: "全局路由", titleEn: "Global routing", titleZh: "全局路由" },
  { view: "virtual-models", en: "Fusion", zh: "Fusion", titleEn: "Fusion", titleZh: "Fusion" },
  { view: "extensions", en: "Extensions", zh: "扩展", titleEn: "Extensions", titleZh: "扩展" },
  { view: "settings", en: "Settings", zh: "设置", titleEn: "Settings", titleZh: "设置" }
];

for (const language of ["en", "zh"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`flat pages: ${language}, ${theme}, desktop`, async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 1440, height: 1000 });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await prepare(page, language, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      for (const item of pages) {
        await page.getByRole("button", { name: item[language], exact: true }).click();
        const content = page.locator(`.app-page-content[data-view="${item.view}"]`);
        await expect(content.getByRole("heading", { name: language === "en" ? item.titleEn : item.titleZh, level: 1, exact: true })).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(content.locator(".local-usage-page")).toHaveCSS("padding-top", "64px");
        await expect(content).toHaveCSS("padding-top", "0px");
        await expect(content).toHaveCSS("background-color", theme === "dark" ? "rgb(20, 20, 20)" : "rgb(255, 255, 255)");
        await expect(content.locator(".local-usage-page")).toHaveCSS("max-width", ["logs", "observability"].includes(item.view) ? "1600px" : "1120px");
        await expect(content.getByRole("heading", { level: 1 })).toHaveCSS("font-size", "24px");
        await expect.poll(() => content.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
        await expect(content.locator("[data-view]").first()).toHaveCSS("opacity", "1");
        if (language === "zh") await page.screenshot({ path: testInfo.outputPath(`${item.view}-${theme}.png`) });
      }
      expect(errors).toEqual([]);
    });
  }
}

test("settings navigation, theme, language, and server fields save inline", async ({ page }) => {
  await prepare(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const content = page.locator('.app-page-content[data-view="settings"]');
  await content.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await content.getByRole("button", { name: "General", exact: true }).click();
  await expect(content.getByRole("heading", { name: "Server", exact: true })).toBeVisible();
  await expect(content.getByLabel("Host", { exact: true })).toHaveValue(/127\.0\.0\.1|localhost|0\.0\.0\.0/);
  await content.getByRole("button", { name: "Logs & Observability", exact: true }).click();
  await content.getByLabel("Log retention days").selectOption("7");
  await expect.poll(() => page.evaluate(async () => (await window.agentrouter!.getConfig()).observability.retentionDays)).toBe(7);
  await content.getByRole("button", { name: "Appearance", exact: true }).click();
  await content.getByLabel("Language", { exact: true }).selectOption("zh");
  await expect(content.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "供应商", exact: true }).click();
  await expect(page.locator('.app-page-content[data-view="providers"]')).toBeVisible();
});

test("system theme changes update both the report shell and manual theme overrides", async ({ page }) => {
  await prepare(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const theme = page.getByLabel("Theme", { exact: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await theme.selectOption("system");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator(".app-page-content")).toHaveCSS("background-color", "rgb(20, 20, 20)");
  await theme.selectOption("light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator(".app-page-content")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await theme.selectOption("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("creating a bot from a profile returns to the unchanged unsaved profile draft", async ({ page }) => {
  await prepare(page);
  await page.getByRole("button", { name: "Agent Profiles", exact: true }).click();
  await page.getByRole("button", { name: "Edit Codex Development", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Edit Profile", exact: true });
  await profile.getByLabel("Profile name").fill("Codex unsaved draft");
  await profile.getByLabel("Entry mode").selectOption("app");
  await profile.getByRole("switch", { name: "Bot", exact: true }).check();
  await profile.getByLabel("Select bot").selectOption({ label: "Add new bot" });
  const bot = page.getByRole("dialog", { name: "Add bot", exact: true });
  await expect(bot).toBeVisible();
  await expect(profile).toHaveCount(0);
  await expect(page.locator('.app-page-content[data-view="settings"]')).toBeVisible();
  await bot.getByRole("button", { name: "Cancel", exact: true }).click();
  const settings = page.locator('.app-page-content[data-view="settings"]');
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  await settings.getByRole("button", { name: "Bots", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await settings.getByRole("button", { name: "Back to profile", exact: true }).click();
  await expect(profile).toBeVisible();
  await expect(profile.getByLabel("Profile name")).toHaveValue("Codex unsaved draft");
  await expect(profile.getByLabel("Entry mode")).toHaveValue("app");
  await expect.poll(() => page.evaluate(async () => (await window.agentrouter!.getConfig()).profile.profiles[0].name)).toBe("Codex Development");
});

test("observability ranges, agent filtering, and trace details remain usable", async ({ page }) => {
  await prepare(page);
  await page.getByRole("button", { name: "Observability", exact: true }).click();
  const content = page.locator('.app-page-content[data-view="observability"]');
  await content.getByRole("button", { name: "7d", exact: true }).click();
  await expect(content.getByRole("button", { name: "7d", exact: true })).toHaveAttribute("aria-pressed", "true");
  await content.getByLabel("Filter agent").selectOption("codex");
  await expect(content.getByLabel("Filter agent")).toHaveValue("codex");
  await content.getByRole("button", { name: "Details", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Trace Detail", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.getByText("Session not found or outside the selected range", { exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "Close", exact: true }).click();
  await expect(detail).toHaveCount(0);
});

test("log search, empty results, page size, and expansion survive the layout change", async ({ page }) => {
  await prepare(page);
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  const content = page.locator('.app-page-content[data-view="logs"]');
  await content.getByLabel("Search request logs").fill("no-matches");
  await expect(content.getByText("No request logs match the current filters.", { exact: true })).toBeVisible();
  await content.getByRole("button", { name: "Clear filters", exact: true }).click();
  await content.getByLabel("Request log page size").selectOption("50");
  await expect(content.getByLabel("Request log page size")).toHaveValue("50");
  const row = content.locator("button.network-row:visible").first();
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(content.locator(".network-detail:visible").first()).toBeVisible();
});

test("disabled request logs can be enabled from their page", async ({ page }) => {
  await prepare(page, "en", "light", false);
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await page.getByRole("button", { name: "Enable request logs", exact: true }).click();
  await expect(page.getByLabel("Search request logs")).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.agentrouter!.getConfig()).observability.requestLogs)).toBe(true);
});

test("narrow Chinese pages keep controls reachable without page-wide overflow", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, "zh");
  for (const item of pages) {
    await page.getByRole("button", { name: item.zh, exact: true }).click();
    const content = page.locator(`.app-page-content[data-view="${item.view}"]`);
    await expect(content.getByRole("heading", { level: 1 })).toBeVisible();
    await expect.poll(() => content.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect(content.locator("[data-view]").first()).toHaveCSS("opacity", "1");
    if (["settings", "profile", "providers", "logs"].includes(item.view)) await page.screenshot({ path: testInfo.outputPath(`${item.view}-narrow.png`) });
  }
});
