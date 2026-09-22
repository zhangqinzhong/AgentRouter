import assert from 'node:assert/strict';
import test from 'node:test';
import { outputRateFromTpot, outputRateForRequestLog } from '../../src/lib/token-rate';
const sample = { isStream:true, outputTokens:101, durationMs:3000, timeToFirstTokenMs:1000 };
test('output rate uses inverse per-request TPOT',()=>assert.equal(outputRateFromTpot(sample),50));
test('TPOT includes time until request completion',()=>assert.equal(outputRateFromTpot({...sample,outputTokens:9,durationMs:1516,timeToFirstTokenMs:1474}),8000/42));
test('unavailable timing and non-streaming requests have no TPOT rate',()=>{
 for (const patch of [{isStream:false},{outputTokens:1},{outputTokens:0},{outputTokens:NaN},{timeToFirstTokenMs:undefined},{timeToFirstTokenMs:-1},{durationMs:NaN},{durationMs:1000},{durationMs:500}]) assert.equal(outputRateFromTpot({...sample,...patch}),undefined);
});

test("request logs prefer validated rates and preserve legacy estimates", () => {
  assert.equal(outputRateForRequestLog(sample), 50);
  assert.equal(outputRateForRequestLog({
    ...sample, outputTokensPerSecond: 80.5, streamSpeedSampleStatus: "complete"
  }), 80.5);
  assert.equal(outputRateForRequestLog({
    ...sample, isStream: false, outputTokensPerSecond: 80.5, streamSpeedSampleStatus: "complete"
  }), undefined);
});

test("invalid stream samples must not fall back to a plausible legacy rate", () => {
  for (const status of ["partial", "usage_missing", "insufficient_tokens", "unsupported_protocol", "hidden_reasoning", "batched_output"]) {
    assert.equal(outputRateForRequestLog({
      ...sample, outputTokensPerSecond: 80, streamSpeedSampleStatus: status
    }), undefined, status);
  }
  for (const rate of [undefined, NaN, Infinity, -1]) {
    assert.equal(outputRateForRequestLog({
      ...sample, outputTokensPerSecond: rate, streamSpeedSampleStatus: "complete"
    }), undefined);
  }
});
