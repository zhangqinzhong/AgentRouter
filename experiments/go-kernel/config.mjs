// Experimental CLIProxyAPI v8 adapter. Not imported by the production gateway.
export function candidateConfig({ provider, model, port, directory, token }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid isolated port");
  if (provider.enabled === false || provider.type !== "openai_chat_completions")
    throw new Error("This spike only supports enabled OpenAI Chat providers");
  if (!provider.models?.includes(model))
    throw new Error("Model is not configured on this provider");
  if (provider.extraBody || provider.extraHeaders || provider.transformer)
    throw new Error(
      "Provider overrides need explicit migration before testing",
    );
  const key = provider.credentials?.length
    ? provider.credentials.find((c) => c.enabled !== false && c.api_key)?.api_key
    : provider.api_key || provider.apiKey || provider.apikey;
  if (!key) throw new Error("No enabled API credential");
  const url = new URL(
    provider.api_base_url || provider.baseUrl || provider.baseurl,
  );
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Unsupported upstream URL");
  url.pathname = url.pathname
    .replace(/\/chat\/completions\/?$/, "")
    .replace(/\/$/, "");
  return {
    "config-version": 8,
    server: { host: "127.0.0.1", port, discovery: { enabled: false } },
    access: { "api-keys": [token] },
    management: {
      "allow-remote": false,
      "secret-key": "",
      "disable-control-panel": true,
      "disable-auto-update-panel": true,
    },
    oauth: { "auth-dir": `${directory}/auth` },
    plugins: { enabled: false, dir: `${directory}/plugins` },
    routing: { retry: { "request-retry": 0, "max-retry-credentials": 1 } },
    observability: {
      logs: {
        "request-log": false,
        "logging-to-file": false,
        "error-logs-max-files": 1,
      },
      usage: { "usage-statistics-enabled": false },
    },
    "api-keys": {
      "openai-compatibility": [
        {
          name: "ar-spike",
          "base-url": url.toString().replace(/\/$/, ""),
          keys: [{ "api-key": key }],
          models: [{ name: model, alias: "ar-spike-model" }],
        },
      ],
    },
  };
}
