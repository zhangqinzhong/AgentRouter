"use strict";
// Durable aggregate shards. No transcript bodies, arguments or resume state are
// persisted. A shard is usable only for the exact file inventory that produced it.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {isTimestampInRequestedDayRange} = require("./codex-rollout-parser");
const VERSION = 1;
const checksum = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function readContextShard(directory, key, {signature, from, to, timeZoneContext}) {
  if (!directory) return null;
  try {
    const {checksum: storedChecksum, ...entry} = JSON.parse(await fs.readFile(path.join(directory, `${key}.json`), "utf8"));
    if (storedChecksum !== checksum(entry)) return null;
    if (entry.version !== VERSION || entry.signature !== signature || entry.from !== (from || "") || !entry.parsed?.totals) return null;
    if (entry.to !== (to || "")) {
      // All-history queries advance their upper day at midnight. Unchanged
      // historical sessions remain valid if every observed event was already
      // inside the old bound. Future-dated records must be reparsed as it moves.
      if (from || !to || !entry.to || to < entry.to || !entry.parsed.observedThrough ||
          !isTimestampInRequestedDayRange(entry.parsed.observedThrough, {to: entry.to, timeZoneContext})) return null;
    }
    return entry.parsed;
  } catch { return null; } // Missing/corrupt caches always fall back to source logs.
}

async function writeContextShard(directory, key, {signature, from, to, parsed}) {
  if (!directory) return;
  const temp = path.join(directory, `.${key}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.mkdir(directory, {recursive:true,mode:0o700});
    const entry = {version:VERSION,signature,from:from||"",to:to||"",parsed};
    await fs.writeFile(temp, JSON.stringify({...entry,checksum:checksum(entry)}), {mode:0o600,flag:"wx"});
    await fs.rename(temp, path.join(directory, `${key}.json`));
  } catch { await fs.unlink(temp).catch(()=>{}); } // Statistics do not depend on a writable cache.
}
module.exports={readContextShard,writeContextShard};
