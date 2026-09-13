#!/bin/sh
set -eu

AR_DATA_DIR="${AR_DATA_DIR:-/data}"
AR_WEB_HOST="${AR_WEB_HOST:-127.0.0.1}"
AR_WEB_PORT="${AR_WEB_PORT:-3459}"
AR_NGINX_PORT="${AR_NGINX_PORT:-8080}"
AR_GATEWAY_HOST="${AR_GATEWAY_HOST:-127.0.0.1}"
AR_GATEWAY_PORT="${AR_GATEWAY_PORT:-3456}"
AR_GATEWAY_CORE_PORT="${AR_GATEWAY_CORE_PORT:-3457}"
AR_PUBLIC_HOST="${AR_PUBLIC_HOST:-127.0.0.1}"
AR_PUBLIC_PORT="${AR_PUBLIC_PORT:-3458}"
AR_PUBLIC_BASE_URL="${AR_PUBLIC_BASE_URL:-http://${AR_PUBLIC_HOST}:${AR_PUBLIC_PORT}}"
AR_NO_GATEWAY="${AR_NO_GATEWAY:-0}"

if [ -z "${AR_WEB_AUTH_TOKEN:-}" ]; then
  AR_WEB_AUTH_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
fi
AR_WEB_AUTH_TOKEN_QUERY="$(node -e "process.stdout.write(encodeURIComponent(process.argv[1] || ''))" "${AR_WEB_AUTH_TOKEN}")"

export HOME="${AR_DATA_DIR}"
export AR_DATA_DIR
export AR_GATEWAY_CORE_PORT
export AR_GATEWAY_HOST
export AR_GATEWAY_PORT
export AR_NGINX_PORT
export AR_NO_GATEWAY
export AR_PUBLIC_BASE_URL
export AR_PUBLIC_HOST
export AR_PUBLIC_PORT
export AR_WEB_AUTH_TOKEN
export AR_WEB_AUTH_TOKEN_QUERY
export AR_WEB_HOST
export AR_WEB_PORT

CONFIG_DIR="${HOME}/.claude-code-router"
CONFIG_FILE="${CONFIG_DIR}/config.json"
APP_CONFIG_DB_FILE="${CONFIG_DIR}/config.sqlite"

mkdir -p "${CONFIG_DIR}" "${CONFIG_DIR}/app-data" /run/nginx /var/lib/nginx /var/log/nginx

if [ "${AR_DOCKER_INIT_CONFIG:-1}" != "0" ] && [ ! -f "${CONFIG_FILE}" ] && [ ! -f "${APP_CONFIG_DB_FILE}" ]; then
  node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configDir = path.join(process.env.HOME, ".claude-code-router");
const configFile = path.join(configDir, "config.json");
const gatewayHost = process.env.AR_GATEWAY_HOST || "0.0.0.0";
const gatewayPort = Number(process.env.AR_GATEWAY_PORT || "3456");
const gatewayCorePort = Number(process.env.AR_GATEWAY_CORE_PORT || "3457");
const publicBaseUrl = (process.env.AR_PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.AR_PUBLIC_PORT || "3458"}`).replace(/\/+$/, "");

fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(configFile, `${JSON.stringify({
  HOST: gatewayHost,
  PORT: gatewayPort,
  gateway: {
    coreHost: "127.0.0.1",
    corePort: gatewayCorePort,
    enabled: true,
    host: gatewayHost,
    port: gatewayPort
  },
  routerEndpoint: publicBaseUrl
}, null, 2)}\n`, { mode: 0o600 });
NODE
fi

if [ "${AR_DOCKER_SYNC_PUBLIC_ENDPOINT:-1}" != "0" ]; then
  node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configDir = path.join(process.env.HOME, ".claude-code-router");
const configFile = path.join(configDir, "config.json");
const appConfigDbFile = path.join(configDir, "config.sqlite");
const gatewayHost = process.env.AR_GATEWAY_HOST || "127.0.0.1";
const gatewayPort = Number(process.env.AR_GATEWAY_PORT || "3456");
const gatewayCorePort = Number(process.env.AR_GATEWAY_CORE_PORT || "3457");
const publicBaseUrl = (process.env.AR_PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.AR_PUBLIC_PORT || "3458"}`).replace(/\/+$/, "");

function syncConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  value.HOST = gatewayHost;
  value.PORT = gatewayPort;
  value.gateway = {
    ...(value.gateway && typeof value.gateway === "object" && !Array.isArray(value.gateway) ? value.gateway : {}),
    coreHost: "127.0.0.1",
    corePort: gatewayCorePort,
    enabled: true,
    host: gatewayHost,
    port: gatewayPort
  };
  value.routerEndpoint = publicBaseUrl;
  return value;
}

function syncJsonFile() {
  if (!fs.existsSync(configFile)) {
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
  fs.writeFileSync(configFile, `${JSON.stringify(syncConfig(parsed), null, 2)}\n`, { mode: 0o600 });
}

function syncSqliteConfig() {
  if (!fs.existsSync(appConfigDbFile)) {
    return;
  }
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    return;
  }
  const db = new Database(appConfigDbFile);
  try {
    const row = db.prepare("select value_json from app_config where key = ?").get("default");
    if (!row?.value_json) {
      return;
    }
    const parsed = JSON.parse(row.value_json);
    db.prepare("update app_config set value_json = ?, updated_at = ? where key = ?")
      .run(JSON.stringify(syncConfig(parsed)), new Date().toISOString(), "default");
  } finally {
    db.close();
  }
}

syncJsonFile();
syncSqliteConfig();
NODE
fi

cat > /etc/nginx/conf.d/default.conf <<EOF
server {
  listen ${AR_NGINX_PORT};
  server_name _;
  root /usr/share/nginx/html;
  index pages/home/index.html;
  absolute_redirect off;

  client_max_body_size 8m;

  location = / {
    return 302 /pages/home/index.html?ar_web_token=${AR_WEB_AUTH_TOKEN_QUERY};
  }

  location = /pages/home/index.html {
    if (\$arg_ar_web_token = "") {
      return 302 /pages/home/index.html?ar_web_token=${AR_WEB_AUTH_TOKEN_QUERY};
    }
    try_files /pages/home/index.html =404;
  }

  location = /api/ar/rpc {
    proxy_http_version 1.1;
    proxy_set_header Host ${AR_WEB_HOST}:${AR_WEB_PORT};
    proxy_set_header Origin http://${AR_WEB_HOST}:${AR_WEB_PORT};
    proxy_set_header Referer http://${AR_WEB_HOST}:${AR_WEB_PORT}/;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_pass http://${AR_WEB_HOST}:${AR_WEB_PORT};
  }

  location = /health {
    proxy_http_version 1.1;
    proxy_set_header Host ${AR_GATEWAY_HOST}:${AR_GATEWAY_PORT};
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_pass http://${AR_GATEWAY_HOST}:${AR_GATEWAY_PORT};
  }

  location ~ ^/(v1|v1beta|mcp|messages|chat/completions|responses|interactions)(/|$) {
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_set_header Connection "";
    proxy_set_header Host ${AR_GATEWAY_HOST}:${AR_GATEWAY_PORT};
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_pass http://${AR_GATEWAY_HOST}:${AR_GATEWAY_PORT};
  }

  location / {
    try_files \$uri \$uri/ /pages/home/index.html;
  }
}
EOF

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

if [ -x /app/node_modules/.bin/pm2-runtime ]; then
  exec /app/node_modules/.bin/pm2-runtime docker/pm2.config.cjs
fi

exec /app/packages/core/node_modules/.bin/pm2-runtime docker/pm2.config.cjs
