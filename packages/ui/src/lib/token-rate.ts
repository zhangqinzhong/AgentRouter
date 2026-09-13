/** Per-request inverse TPOT. Durations are measured by the gateway in ms. */
export function outputRateFromTpot(entry: {
  isStream: boolean;
  outputTokens: number;
  durationMs: number;
  timeToFirstTokenMs?: number;
}): number | undefined {
  const { isStream, outputTokens, durationMs, timeToFirstTokenMs } = entry;
  if (!isStream || !Number.isFinite(outputTokens) || outputTokens <= 1 ||
    !Number.isFinite(durationMs) || timeToFirstTokenMs === undefined ||
    !Number.isFinite(timeToFirstTokenMs) || timeToFirstTokenMs < 0) return undefined;
  const decodeDurationMs = durationMs - timeToFirstTokenMs;
  return decodeDurationMs > 0 ? (outputTokens - 1) * 1_000 / decodeDurationMs : undefined;
}
