/** Native read transport with controlled streams; no CLI/auth/model/network. */
import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {readCodexSkillList} from '../codex-skills-rpc.mjs';
function transport(respond,{closeOnEnd=true}={}) {
 const child=new EventEmitter(),requests=[],kills=[];let closed=false,ended=false,buffer='';
 Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),exitCode:null,signalCode:null});
 const close=(code=0,signal=null)=>{if(closed)return;closed=true;child.exitCode=code;child.signalCode=signal;child.stdout.end();child.emit('close',code,signal);};
 child.kill=name=>{kills.push(name);close(null,name);return true;};
 const send=message=>child.stdout.write(JSON.stringify(message)+'\n');
 child.stdin.on('data',chunk=>{buffer+=chunk.toString();let n;while((n=buffer.indexOf('\n'))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);requests.push(q);queueMicrotask(()=>respond(q,{send,child,close}));}});
 child.stdin.on('finish',()=>{ended=true;if(closeOnEnd)queueMicrotask(()=>close());});
 return {child,requests,kills,close,get closed(){return closed;},get ended(){return ended;},spawn:(command,args,opts)=>{assert.equal(command,'fixture-codex');assert.deepEqual(args,['app-server']);assert.equal(opts.cwd,'/fixture/project');assert.equal(opts.detached,true);return child;}};
}
const run=(f,extra={})=>readCodexSkillList({command:'fixture-codex',cwd:'/fixture/project',env:{PATH:'/fixture/bin'},spawnProcess:f.spawn,...extra});
const until=async check=>{const end=Date.now()+1000;while(!check()){assert.ok(Date.now()<end,'Controlled stream barrier missing');await new Promise(r=>setTimeout(r,2));}};
const data={data:[{cwd:'/fixture/project',skills:[],errors:[]}]};

test('native skills RPC: only initialize, initialized and forced scoped list are sent, then child closes',async()=>{
 const f=transport((q,{send})=>{if(q.method==='initialize')send({id:1,result:{userAgent:'fixture'}});if(q.method==='skills/list')send({id:2,result:data});});
 const out=await run(f);assert.deepEqual(out,{ok:true,data});assert.deepEqual(f.requests.map(q=>q.method),['initialize','initialized','skills/list']);assert.deepEqual(f.requests[2].params,{cwds:['/fixture/project'],forceReload:true});assert.equal(f.closed,true);assert.deepEqual(f.kills,[]);
});
test('native skills RPC: a result waits for close instead of leaving an unowned process behind',async()=>{
 const f=transport((q,{send})=>{if(q.method==='initialize')send({id:1,result:{}});if(q.method==='skills/list')send({id:2,result:data});},{closeOnEnd:false});let settled=false;const p=run(f).then(v=>{settled=true;return v;});await until(()=>f.ended);assert.equal(settled,false);f.close();assert.equal((await p).ok,true);assert.equal(f.closed,true);
});
for(const phase of ['initialize','skills/list'])test('native skills RPC: '+phase+' error is bounded and cannot expose server details',async()=>{
 const f=transport((q,{send})=>{if(q.method===phase)send({id:q.id,error:{code:-32603,message:'private fixture server detail'}});else if(q.method==='initialize')send({id:1,result:{}});});const out=await run(f);assert.equal(out.ok,false);assert.equal(out.error,phase==='initialize'?'initialize':'list');assert.equal(JSON.stringify(out).includes('private fixture'),false);assert.equal(f.closed,true);
});
test('native skills RPC: no response to server approval/tool requests is sent by a read',async()=>{
 const f=transport((q,{send})=>{if(q.method==='initialize')send({id:99,method:'tool/requestUserInput',params:{}});});const out=await run(f);assert.deepEqual(out,{ok:false,error:'server_request'});assert.deepEqual(f.requests.map(q=>q.method),['initialize']);assert.equal(f.requests.some(q=>q.id===99),false);
});
test('native skills RPC: malformed/primitive/stale frames and duplicate init cannot fabricate or duplicate a list',async()=>{
 const f=transport((q,{send,child})=>{if(q.method==='initialize'){child.stdout.write('null\n[]\ninvalid\n');send({id:2,result:{wrong:'early'}});send({id:1,result:{}});send({id:1,result:{}});}if(q.method==='skills/list')send({id:2,result:data});});assert.deepEqual(await run(f),{ok:true,data});assert.equal(f.requests.filter(q=>q.method==='skills/list').length,1);
});
test('native skills RPC: split UTF8 chunks preserve Unicode metadata',async()=>{
 const value={data:[{cwd:'/fixture/project',skills:[{description:'Brain 🧠'}],errors:[]}]};
 const f=transport((q,{send,child})=>{if(q.method==='initialize')send({id:1,result:{}});if(q.method==='skills/list'){const bytes=Buffer.from(JSON.stringify({id:2,result:value})+'\n'),cut=bytes.indexOf(Buffer.from('🧠'))+2;child.stdout.write(bytes.subarray(0,cut));queueMicrotask(()=>child.stdout.write(bytes.subarray(cut)));}});assert.deepEqual((await run(f)).data,value);
});
test('native skills RPC: already aborted reads never spawn a process',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;const out=await readCodexSkillList({command:'fixture-codex',cwd:'/fixture/project',signal:controller.signal,spawnProcess:()=>{calls++;throw Error('must not spawn');}});assert.deepEqual(out,{ok:false,aborted:true});assert.equal(calls,0);
});
test('native skills RPC: abort closes the owned live process and waits for terminal cleanup',async()=>{
 const f=transport(()=>{}, {closeOnEnd:false}),controller=new AbortController(),p=run(f,{signal:controller.signal});await until(()=>f.requests.length===1);controller.abort();assert.deepEqual(await p,{ok:false,aborted:true});assert.equal(f.closed,true);assert.deepEqual(f.kills,['SIGINT']);
});
test('native skills RPC: a deadline terminates a process that ignores stdin EOF',async()=>{
 const f=transport(()=>{}, {closeOnEnd:false});assert.deepEqual(await run(f,{timeoutMs:15}),{ok:false,error:'timeout'});assert.equal(f.closed,true);assert.deepEqual(f.kills,['SIGTERM']);
});
test('native skills RPC: bounded output fails without a parser or process leak',async()=>{
 const f=transport((q,{child})=>{if(q.method==='initialize')child.stdout.write('x'.repeat(256));});assert.deepEqual(await run(f,{maxBytes:128}),{ok:false,error:'output_limit'});assert.equal(f.closed,true);
});
test('native skills RPC: early close and synchronous spawn failure settle as failures',async()=>{
 const f=transport((q,{close})=>{if(q.method==='initialize')close(1);});assert.deepEqual(await run(f),{ok:false,error:'closed'});assert.deepEqual(await readCodexSkillList({command:'fixture-codex',cwd:'/fixture/project',spawnProcess:()=>{throw Error('fixture-only');}}),{ok:false,error:'spawn'});
});
