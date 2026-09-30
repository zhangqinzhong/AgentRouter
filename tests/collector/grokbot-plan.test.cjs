const test = require('node:test');
const assert = require('node:assert/strict');
const {fetchCursorSandUsageStatus} = require('../../packages/core/src/vendor/tokentracker/lib/cursor-config');
test('Grok Bot JSON quota preserves Heavy plan, percentage and reset without falling back to Cursor plan', async () => {
  const result = await fetchCursorSandUsageStatus({accessToken:'fixture',fetchImpl:async (url,options) => {
    assert.equal(url,'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus');
    assert.equal(options.headers['Content-Type'],'application/json');
    assert.equal(options.headers['x-cursor-client-type'],'sand');
    return {status:200,json:async()=>({grokPlanLabel:'SuperGrok Heavy',cursorPlanName:'Pro',usagePercent:4.99,nextResetTimestampUtc:'2026-10-06T06:56:21.529Z'})};
  }});
  assert.equal(result.grokPlanLabel,'SuperGrok Heavy');
  assert.equal(result.usagePercent,4.99);
  assert.equal(result.nextResetAt,'2026-10-06T06:56:21.529Z');
  const missing = await fetchCursorSandUsageStatus({accessToken:'fixture',fetchImpl:async()=>({status:200,json:async()=>({cursorPlanName:'Pro'})})});
  assert.equal(missing.grokPlanLabel,null);
});
