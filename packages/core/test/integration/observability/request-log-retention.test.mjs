import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RequestLogStore } from '@agentrouter/core/observability/request-log-store.ts';
import { RequestRouteTraceRecorder } from '@agentrouter/core/observability/route-trace.ts';
import { createBetterSqliteDatabase } from '@agentrouter/core/storage/sqlite-native.ts';

const record = (id, age) => {
  const time = new Date(Date.now() - age * 86400000).toISOString();
  const trace = new RequestRouteTraceRecorder(Date.now());
  trace.captureIngress();
  return {requestId:id,eventId:id,method:'POST',path:'/v1/responses',url:'http://example.invalid/v1/responses',startedAt:time,completedAt:time,durationMs:1,statusCode:200,requestBody:Buffer.from(JSON.stringify({input:id.repeat(200000)})),requestHeaders:{'content-type':'application/json'},responseHeaders:{'content-type':'application/json'},responseBodyText:'{}',routeTrace:trace.finish()};
};

test('retention changes reclaim expired bodies and route traces while preserving in-range requests', async () => {
  const root=mkdtempSync(path.join(tmpdir(),'ar-retention-'));
  const file=path.join(root,'logs.sqlite');
  const store=new RequestLogStore(file);
  let db;
  try {
    await store.maintainRetention(30);
    await store.record(record('recent',0));
    await store.record(record('three-days',3));
    await store.record(record('eight-days',8));
    db=await createBetterSqliteDatabase(file);
    const refs=db.prepare('SELECT request_id,request_body_ref FROM request_logs').all();
    const body=(id)=>{const ref=refs.find(r=>r.request_id===id).request_body_ref;return path.join(root,'request-log-bodies',ref.slice(0,2),ref);};
    assert.equal(refs.length,3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM request_route_traces').get().n,3);
    await store.maintainRetention(7);
    assert.deepEqual(db.prepare('SELECT request_id FROM request_logs ORDER BY request_id').all().map(r=>r.request_id),['recent','three-days']);
    assert.equal(existsSync(body('eight-days')),false);
    assert.equal(existsSync(body('three-days')),true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM request_route_traces').get().n,2);
    // A query-only connection must not run its default one-day retention.
    const query=new RequestLogStore(file,undefined,false);
    try { await query.initialize(); assert.equal(db.prepare('SELECT COUNT(*) n FROM request_logs').get().n,2); } finally {await query.close();}
    await store.maintainRetention(1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM request_logs').get().n,1);
    assert.equal(existsSync(body('three-days')),false);
    assert.equal(existsSync(body('recent')),true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM request_route_traces').get().n,1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally { db?.close(); await store.close(); rmSync(root,{recursive:true,force:true}); }
});

test('startup applies the configured retention before any default cleanup', async () => {
  const root=mkdtempSync(path.join(tmpdir(),'ar-retention-startup-'));const file=path.join(root,'logs.sqlite');
  const seed=new RequestLogStore(file);
  try {
    await seed.maintainRetention(30);await seed.record(record('three-days',3));await seed.close();
    const reopened=new RequestLogStore(file);
    try {await reopened.maintainRetention(7);const db=await createBetterSqliteDatabase(file);try{assert.equal(db.prepare('SELECT COUNT(*) n FROM request_logs').get().n,1);}finally{db.close();}}finally{await reopened.close();}
  } finally {await seed.close();rmSync(root,{recursive:true,force:true});}
});
