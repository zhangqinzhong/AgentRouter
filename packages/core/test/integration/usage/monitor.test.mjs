import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createBetterSqliteDatabase} from '../../../src/storage/sqlite-native.ts';
import {readGatewayMonitor,weightedPercentile} from '../../../src/usage/monitor.ts';

test('monitor uses request-weighted percentiles, measured TTFT and zero-filled minutes',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'ar-monitor-'));
 const db=createBetterSqliteDatabase(':memory:');
 const logPath=path.join(dir,'logs.db'), logs=createBetterSqliteDatabase(logPath);
 try{
  db.exec('CREATE TABLE usage_events (request_id TEXT, created_at TEXT, provider TEXT, model TEXT, status_code INTEGER, duration_ms INTEGER, total_tokens INTEGER)');
  logs.exec('CREATE TABLE request_logs (created_at TEXT, time_to_first_token_ms INTEGER)');
  const now=new Date(),from=new Date(now.getTime()-3600000),at=new Date(now.getTime()-30000).toISOString();
  const insert=db.prepare('INSERT INTO usage_events VALUES (?,?,?,?,?,?,?)');
  for(let i=0;i<20;i++) insert.run(String(i),at,'provider','model',i===19?500:200,i===19?10000:100,10);
  insert.run('old','2000-01-01T00:00:00.000Z','provider','model',500,999999,99999);
  logs.prepare('INSERT INTO request_logs VALUES (?,?)').run(at,250);
  logs.prepare('INSERT INTO request_logs VALUES (?,?)').run(at,null);
  logs.close();
  const result=readGatewayMonitor(db,{where:'created_at >= ?',params:[from.toISOString()]},from,now,logPath);
  assert.equal(result.latencyP95Ms,100);assert.equal(result.latencyP50Ms,100);
  assert.equal(result.ttftSamples,1);assert.equal(result.ttftP50Ms,250);
  assert.equal(result.minutes.length,60);assert.equal(result.minutes.reduce((s,r)=>s+r.requests,0),20);
  assert.equal(result.failures.length,1);assert.equal(result.failures[0].id,'19');
  const unavailable=readGatewayMonitor(db,{where:'1=0',params:[]},from,now,path.join(dir,'missing.db'));
  assert.equal(unavailable.latencyP95Ms,null);assert.equal(unavailable.ttftP50Ms,null);
  assert.equal(weightedPercentile([],0.5),null);
 }finally{if(logs.open)logs.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
