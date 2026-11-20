/** Fake JSON-RPC peer checks the Codex transport without auth or network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodexAppServerTurn } from '../adapters/codex-app-server.mjs';
import { finalizeParsed } from '../adapters/codex.mjs';

const id = '01912345-1234-7123-8123-123456789abc';
const other = '01912345-1234-7123-8123-123456789def';
const peer = `#!/usr/bin/env node
const readline = require('node:readline');
const scenario=process.env.SCENARIO; const tid='${id}', other='${other}';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const usage=n=>({inputTokens:n,cachedInputTokens:10,cacheWriteInputTokens:0,outputTokens:20,reasoningOutputTokens:0});
const event=(method,params)=>send({method,params});
const reader=readline.createInterface({input:process.stdin});
reader.on('close',()=>{if(scenario==='graceful')setTimeout(()=>require('node:fs').writeFileSync(process.env.MARKER,'flushed'),150)});
reader.on('line',line=>{const m=JSON.parse(line); if(!m.id)return;
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='thread/start'||m.method==='thread/resume'){if(scenario==='server')return send({id:999,method:'item/tool/requestUserInput',params:{}}); if(scenario==='resume-error')return send({id:m.id,error:{code:-32600,message:'no rollout'}}); send({id:m.id,result:{thread:{id:scenario==='wrong'?other:tid}}});}
if(m.method==='turn/start'){
 if(scenario==='record-start')require('node:fs').writeFileSync(process.env.MARKER,'started');
 send({id:m.id,result:{turn:{id:'turn-1'}}});
 if(scenario==='steer'||scenario==='unknown'||scenario==='stopped')return;
 if(scenario==='close-partial'||scenario==='close-websocket'){
  event('item/completed',{threadId:tid,turnId:'turn-1',item:{id:'msg',type:'agentMessage',text:'finished fragment'}});
  if(scenario==='close-websocket')process.stderr.write('websocket closed before completion');
  return setTimeout(()=>process.exit(1),30);
 }
 if(scenario==='same-usage'){event('thread/tokenUsage/updated',{threadId:tid,turnId:'turn-1',tokenUsage:{total:usage(100)}});event('thread/tokenUsage/updated',{threadId:tid,turnId:'turn-1',tokenUsage:{total:usage(100)}})}
 else if(scenario==='one-usage')event('thread/tokenUsage/updated',{threadId:tid,turnId:'turn-1',tokenUsage:{total:usage(300)}});
 else if(scenario==='resume'){event('thread/tokenUsage/updated',{threadId:tid,turnId:'turn-1',tokenUsage:{total:usage(100)}});event('thread/tokenUsage/updated',{threadId:tid,turnId:'turn-1',tokenUsage:{total:usage(300)}})}
 else if(scenario!=='no-usage')event('thread/tokenUsage/updated',{threadId:tid,turnId:'turn-1',tokenUsage:{total:usage(300)}});
 event('item/completed',{threadId:tid,turnId:'turn-1',item:{id:'msg',type:'agentMessage',text:'answer'}});
 event('turn/completed',{threadId:tid,turn:{id:'turn-1',status:scenario==='failed'?'failed':'completed',error:scenario==='failed'?{message:'failed fixture'}:null,items:[]}});
}
if(m.method==='turn/steer'){
 if(m.params.threadId!==tid||m.params.expectedTurnId!=='turn-1')process.exit(9);
 if(scenario==='unknown')return send({id:m.id,result:{turnId:'wrong'}});
 send({id:m.id,result:{turnId:'turn-1'}});
 event('turn/completed',{threadId:tid,turn:{id:'turn-1',status:'completed',items:[{id:'msg',type:'agentMessage',text:'steered'}]}});
}
});`;
async function run(scenario, options = {}) {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-server-test-'));
 const bin = path.join(dir,'peer'); await fs.writeFile(bin,peer,{mode:0o700});
 try { return await runCodexAppServerTurn({ bin, cwd:dir, childEnv:{...process.env,SCENARIO:scenario}, prompt:'test', timeoutMs:1000, ...options }); }
 finally { await fs.rm(dir,{recursive:true,force:true}); }
}
test('new turn collects text, usage and native ID', async()=>{let seen;const out=await run('normal',{onThreadStarted:id=>seen=id});assert.equal(seen,id);assert.equal(out.parsedOut.text,'answer');assert.equal(out.parsedOut.usage.input_tokens,300);assert.equal(out.res.code,0)});
test('resume uses changed total and leaves missing usage unknown',async()=>{const a=await run('resume',{resumeId:id});assert.equal(a.parsedOut.usage.input_tokens,300);const b=await run('no-usage',{resumeId:id});assert.equal(b.parsedOut.usage,null)});
test('resume rejects foreign thread',async()=>{const out=await run('wrong',{resumeId:id});assert.equal(out.res.code,1);assert.equal(out.parsedOut.threadId,null)});
test('failed turn retains partial text and reports error',async()=>{const out=await run('failed');assert.equal(out.parsedOut.assistantText,'answer');assert.equal(out.parsedOut.turnFailed,'failed fixture');assert.equal(out.res.code,1)});
test('a refused resume gives existing recovery guidance without starting a replacement thread',async()=>{const out=await run('resume-error',{resumeId:id});assert.equal(out.parsedOut.resumeRejected,true);const result=finalizeParsed({...out,resumeRequested:id});assert.match(result.text,/\/sessions/);assert.match(result.text,/\/newtask/);assert.equal(result.ok,false)});
test('ordinary process failure preserves partial text; only evidenced websocket errors use the interruption notice',async()=>{const ordinary=await run('close-partial',{resumeId:id});const first=finalizeParsed({...ordinary,resumeRequested:id});assert.equal(first.partial,true);assert.equal(first.text,'finished fragment');const cut=await run('close-websocket',{resumeId:id});const second=finalizeParsed({...cut,resumeRequested:id});assert.match(second.text,/связь с моделью оборвалась/);assert.match(second.text,/finished fragment/)});
test('steer binds thread and turn, then invalidates handle',async()=>{let handle, cleared=false, status;const out=await run('steer',{onSteerReady:h=>{if(!h){cleared=true;return}handle=h;h.steer('correction').then(x=>status=x.status)}});assert.equal(status,'accepted');assert.equal(out.parsedOut.text,'steered');assert.ok(cleared);assert.deepEqual(await handle.steer('late'),{status:'rejected'})});
test('mismatching ack is unknown and timeout closes',async()=>{let status;const out=await run('unknown',{timeoutMs:700,onSteerReady:h=>{if(h)h.steer('x').then(x=>status=x.status)}});assert.equal(status,'unknown');assert.equal(out.res.code,1)});
test('unsupported server request fails closed',async()=>{const out=await run('server');assert.equal(out.res.code,1);assert.match(out.parsedOut.turnFailed,/server request unsupported/i)});
test('invalidated handle rejects without sending input',async()=>{let status;const out=await run('stopped',{timeoutMs:700,onSteerReady:h=>{if(h){h.invalidate();h.steer('x').then(x=>status=x.status)}}});assert.equal(status,'rejected');assert.equal(out.res.code,1)});

test('resume retains one total or repeated identical totals',async()=>{const a=await run('one-usage',{resumeId:id});assert.equal(a.parsedOut.usage.input_tokens,300);const b=await run('same-usage',{resumeId:id});assert.equal(b.parsedOut.usage.input_tokens,100)});

test('allows graceful EOF flush before sending a signal',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'app-server-flush-'));const bin=path.join(dir,'peer'),marker=path.join(dir,'marker');await fs.writeFile(bin,peer,{mode:0o700});try{const out=await runCodexAppServerTurn({bin,cwd:dir,childEnv:{...process.env,SCENARIO:'graceful',MARKER:marker},prompt:'test',timeoutMs:1000});assert.equal(out.res.code,0);assert.equal(await fs.readFile(marker,'utf8'),'flushed')}finally{await fs.rm(dir,{recursive:true,force:true})}});

test('a stop before launch does not try to spawn app-server', async () => {
  const out = await runCodexAppServerTurn({ signal: AbortSignal.abort(), bin: undefined });
  assert.equal(out.parsedOut.turnFailed, 'Codex stopped');
  assert.equal(out.parsedOut.threadId, null);
});

test('a stop on thread announcement settles before submitting the prompt', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-server-stop-before-turn-'));
  const bin = path.join(dir, 'peer');
  const marker = path.join(dir, 'turn-start');
  const controller = new AbortController();
  let readiness = 0;
  try {
    await fs.writeFile(bin, peer, { mode: 0o700 });
    const out = await runCodexAppServerTurn({
      bin, cwd: dir, childEnv: { ...process.env, SCENARIO: 'record-start', MARKER: marker },
      prompt: 'fixture', timeoutMs: 1000, signal: controller.signal,
      onThreadStarted: () => controller.abort(),
      onSteerReady: () => { readiness++; },
    });
    assert.equal(out.parsedOut.threadId, id);
    assert.equal(out.parsedOut.turnFailed, 'Codex stopped');
    assert.equal(readiness, 0);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
