/** Bounded old OC read process; controlled streams, no CLI/auth/model/network. */
import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {readOpenClawSkills} from '../src/skills/openclaw.mjs';
const payload='[{"name":" Fixture ","description":" Text ","source":"workspace","userInvocable":false}]';
const expected=[{name:'Fixture',description:'Text',source:'workspace',userInvocable:false}];
function processFixture(run){const child=new EventEmitter(),kills=[];let closed=false,options;
 Object.assign(child,{stdout:new PassThrough(),exitCode:null,signalCode:null});const close=(code=0,signal=null)=>{if(closed)return;closed=true;child.exitCode=code;child.signalCode=signal;child.stdout.end();child.emit('close',code,signal);};child.kill=signal=>{kills.push(signal);close(null,signal);return true;};
 return{child,kills,close,get closed(){return closed;},get options(){return options;},spawn:(command,args,opts)=>{assert.equal(command,'openclaw');assert.deepEqual(args,['skills','list','--json','--eligible']);assert.equal(opts.cwd,undefined);assert.equal(opts.detached,true);assert.deepEqual(opts.stdio,['ignore','pipe','ignore']);options=opts;queueMicrotask(()=>run({child,close}));return child;}};}
const read=(f,options={})=>readOpenClawSkills({spawnProcess:f.spawn,...options});
test('OC reader: successful close parses exact old metadata and filters only the child environment',async()=>{
 const env={HOME:'/fixture',PATH:'/fixture/bin',BOT_TOKEN:'fake-bot',ANTHROPIC_API_KEY:'fake-a',IIA_ANTHROPIC_API_KEY:'fake-b',CLAUDE_CODE_OAUTH_TOKEN:'fake-c',SYNC_KEY:'fake-d',SYNC_URL:'fake-e',JARVIS_CC_ONLY:'1',GIT_DIR:'/fixture/git',NPM_CONFIG_PREFIX:'/fixture/npm',GITHUB_TOKEN:'fake-keep',KEEP:'value'},before={...env};const f=processFixture(({child,close})=>{child.stdout.write(payload);close();});assert.deepEqual(await read(f,{env}),expected);assert.deepEqual(env,before);assert.deepEqual(f.options.env,{HOME:'/fixture',PATH:'/fixture/bin',GITHUB_TOKEN:'fake-keep',KEEP:'value'});assert.equal(f.closed,true);assert.deepEqual(f.kills,[]);
});
for(const mode of ['invalid-json','nonzero-exit'])test('OC reader: '+mode+' is an unavailable empty result, not partial success',async()=>{
 const f=processFixture(({child,close})=>{child.stdout.write(mode==='invalid-json'?'not-json':payload);close(mode==='nonzero-exit'?2:0);});assert.deepEqual(await read(f),[]);assert.equal(f.closed,true);
});
test('OC reader: split UTF8 preserves JSON metadata without replacement characters',async()=>{
 const text='[{"name":"Brain 🧠","source":"workspace"}]',f=processFixture(({child,close})=>{const bytes=Buffer.from(text),cut=bytes.indexOf(Buffer.from('🧠'))+2;child.stdout.write(bytes.subarray(0,cut));queueMicrotask(()=>{child.stdout.write(bytes.subarray(cut));close();});});assert.equal((await read(f))[0].name,'Brain 🧠');
});
test('OC reader: already aborted operation never spawns',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;assert.deepEqual(await readOpenClawSkills({signal:controller.signal,spawnProcess:()=>{calls++;throw Error('must not spawn');}}),[]);assert.equal(calls,0);
});
test('OC reader: abort terminates its live child and waits for close',async()=>{
 const controller=new AbortController(),f=processFixture(()=>{}),p=read(f,{signal:controller.signal});controller.abort();assert.deepEqual(await p,[]);assert.equal(f.closed,true);assert.deepEqual(f.kills,['SIGINT']);
});
test('OC reader: deadline and excessive output terminate rather than returning a partial catalog',async()=>{
 const hung=processFixture(()=>{});assert.deepEqual(await read(hung,{timeoutMs:15}),[]);assert.equal(hung.closed,true);assert.deepEqual(hung.kills,['SIGTERM']);
 const flood=processFixture(({child})=>child.stdout.write('x'.repeat(256)));assert.deepEqual(await read(flood,{maxBytes:128}),[]);assert.equal(flood.closed,true);assert.deepEqual(flood.kills,['SIGTERM']);
});
test('OC reader: synchronous spawn failure and asynchronous ENOENT settle with no unowned work',async()=>{
 assert.deepEqual(await readOpenClawSkills({spawnProcess:()=>{throw Error('fixture-only');}}),[]);const f=processFixture(({child})=>child.emit('error',Object.assign(Error('fixture missing'),{code:'ENOENT'})));assert.deepEqual(await read(f),[]);assert.deepEqual(f.kills,[]);
});

test('OC reader metadata cleanup: observed leader exit fences late signals and releases inherited pipes',async()=>{
 const f=processFixture(()=>{}),controller=new AbortController(),originalKill=process.kill,groups=[];let p,unref=false;f.child.pid=42;f.child.unref=()=>{unref=true;};process.kill=(pid,signal)=>{groups.push([pid,signal]);return true;};
 try{p=read(f,{signal:controller.signal,cleanupGraceMs:20});f.child.exitCode=0;f.child.emit('exit',0,null);controller.abort();assert.deepEqual(groups,[]);const out=await Promise.race([p,new Promise((_,reject)=>setTimeout(()=>reject(new assert.AssertionError({message:'Inherited metadata pipe lacks a bounded cleanup'})),300))]);assert.deepEqual(out,[]);assert.equal(f.child.stdout.destroyed,true);assert.equal(unref,true);assert.deepEqual(groups,[]);}
 finally{f.close();if(p)await p;process.kill=originalKill;}
});
test('OC reader metadata cleanup: an unresponsive child cannot keep shutdown waiting forever',async()=>{
 const f=processFixture(()=>{}),controller=new AbortController();let p,unref=false;f.child.kill=signal=>{f.kills.push(signal);return true;};f.child.unref=()=>{unref=true;};
 try{p=read(f,{signal:controller.signal,cleanupGraceMs:20});controller.abort();assert.deepEqual(await Promise.race([p,new Promise((_,reject)=>setTimeout(()=>reject(new assert.AssertionError({message:'Metadata observer cleanup deadline missing'})),300))]),[]);assert.equal(unref,true);assert.equal(f.child.stdout.destroyed,true);}
 finally{f.close();if(p)await p;}
});


test('OC reader: canonical Claude key alias is removed from the child without changing the parent',async()=>{
 const env={PATH:'/fixture/bin',IIA_ANTHROPIC_API_KEY:'fixture-legacy',MSB_ANTHROPIC_API_KEY:'fixture-canonical',KEEP:'yes'},before={...env};const f=processFixture(({child,close})=>{child.stdout.write(payload);close();});
 assert.deepEqual(await read(f,{env}),expected);assert.deepEqual(env,before);assert.equal(Object.hasOwn(f.options.env,'IIA_ANTHROPIC_API_KEY'),false);assert.equal(Object.hasOwn(f.options.env,'MSB_ANTHROPIC_API_KEY'),false);assert.equal(f.options.env.KEEP,'yes');
});
