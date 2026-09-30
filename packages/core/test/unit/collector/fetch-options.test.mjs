import test from 'node:test';
import assert from 'node:assert/strict';
import { collectorFetchOptions } from '@agentrouter/core/collector/fetch-options.ts';
test('worker bridge transfers OAuth forms as encoded bodies without signals', () => {
 const options = collectorFetchOptions({method:'POST',signal:new AbortController().signal,body:new URLSearchParams({grant_type:'refresh_token',refresh_token:'test+ &value'})});
 const transferred = structuredClone(options);
 assert.equal(transferred.body,'grant_type=refresh_token&refresh_token=test%2B+%26value');
 assert.equal(transferred.headers['content-type'],'application/x-www-form-urlencoded;charset=UTF-8');
 assert.equal('signal' in transferred,false);
 const explicit = collectorFetchOptions({headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({a:'b'})});
 assert.equal(explicit.headers['content-type'],'application/x-www-form-urlencoded');
 assert.equal(collectorFetchOptions({body:'{"a":1}'}).body,'{"a":1}');
});
