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

/** Prefer a validated stream sample; only legacy rows fall back to TPOT. */
export function outputRateForRequestLog(entry: Parameters<typeof outputRateFromTpot>[0] & {
  outputTokensPerSecond?: number;
  streamSpeedSampleStatus?: string;
}): number | undefined {
  if (!entry.isStream) return undefined;
  if (entry.streamSpeedSampleStatus !== undefined || entry.outputTokensPerSecond !== undefined) {
    const rate = entry.outputTokensPerSecond;
    return entry.streamSpeedSampleStatus === "complete" &&
      rate !== undefined && Number.isFinite(rate) && rate >= 0
      ? rate
      : undefined;
  }
  return outputRateFromTpot(entry);
}
