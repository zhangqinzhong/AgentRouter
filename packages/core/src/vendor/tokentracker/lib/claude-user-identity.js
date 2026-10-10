const fs = require("node:fs");
const fsp = require("node:fs/promises");
const readline = require("node:readline");

function noteClaudeFork(aliases, obj) {
  const uuid = obj?.uuid;
  const parent = obj?.forkedFrom?.messageUuid;
  if (typeof uuid === "string" && uuid && typeof parent === "string" && parent && uuid !== parent) {
    aliases[uuid] = parent;
  }
}

function claudeUserIdentity(obj, aliases) {
  let uuid = typeof obj?.uuid === "string" && obj.uuid ? obj.uuid : null;
  if (!uuid) return null;
  const chain = new Set();
  while (!chain.has(uuid)) {
    chain.add(uuid);
    const parent = aliases[uuid];
    if (typeof parent !== "string" || !parent) return `u:${uuid}`;
    uuid = parent;
  }
  // Malformed cycles still collapse deterministically regardless of file order.
  return `u:${Array.from(chain).slice(Array.from(chain).indexOf(uuid)).sort()[0]}`;
}

async function collectClaudeForkAliases(files, cursors = {}, onFork = () => {}) {
  const aliases = Object.assign(Object.create(null), cursors.claudeForkAliases || {});
  for (const entry of files) {
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath || /[\\/]subagents[\\/]/.test(filePath)) continue;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const prev = cursors.files?.[filePath];
    const start = prev?.claudeForkIndexed && prev.inode === (stat.ino || 0) && prev.offset <= stat.size ? prev.offset || 0 : 0;
    if (start >= stat.size) continue;
    const stream = fs.createReadStream(filePath, { encoding: "utf8", start });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"forkedFrom"')) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type === "user") { noteClaudeFork(aliases, obj); onFork(obj); }
        } catch { /* Ignore incomplete or malformed JSONL records. */ }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (prev) prev.claudeForkIndexed = true;
  }
  return aliases;
}

module.exports = { noteClaudeFork, claudeUserIdentity, collectClaudeForkAliases };
