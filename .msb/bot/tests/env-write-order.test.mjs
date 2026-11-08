/**
 * Production env mutations under a held first read, no sleeps/network/credentials.
 * [Old xK contract](./reference/parity-env-write-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { envFilePath, setEnvKey, deleteEnvKey, readEnvMap } from '../src/env/store.mjs';
import { writeEnvKey, botEnvPath } from '../../../overlay/bot/ext/env.mjs';

async function home(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'msb-env-order-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const env={HOME:dir,MSB_BOT_ID:'default'}, file=envFilePath(env);
 assert.equal(botEnvPath(env,dir),file);
 await fs.mkdir(path.dirname(file),{recursive:true});
 await fs.writeFile(file,'# fixture, unchanged raw line\nDELETE_ME=fixture-delete\nKEEP=fixture-keep\n',{mode:0o600});
 return {env,file};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

const actions={
 core:(env)=>setEnvKey('CORE_KEY','fixture-core',env),
 provider:(env)=>writeEnvKey('CURSOR_API_KEY','fixture-provider',env),
 delete:(env)=>deleteEnvKey('DELETE_ME',env),
 secondCore:(env)=>setEnvKey('SECOND_KEY','fixture-second',env),
 secondProvider:(env)=>writeEnvKey('QWEN_API_KEY','fixture-qwen',env),
};
for(const [first,second,want,removed] of [
 ['core','secondCore',['CORE_KEY','SECOND_KEY'],false],
 ['core','delete',['CORE_KEY'],true],
 ['delete','secondCore',['SECOND_KEY'],true],
 ['core','provider',['CORE_KEY','CURSOR_API_KEY'],false],
 ['provider','core',['CURSOR_API_KEY','CORE_KEY'],false],
 ['provider','secondProvider',['CURSOR_API_KEY','QWEN_API_KEY'],false],
]) test(`env write order: ${first} → ${second} retains both committed changes`,async t=>{
 const {env,file}=await home(t), firstRead=deferred(),release=deferred();
 const read=fs.readFile.bind(fs),mkdir=fs.mkdir.bind(fs);let reads=0;
 // Target directory already exists. Its idempotent mkdir is an immediate
 // Promise so provider's pre-read await cannot introduce filesystem timing.
 t.mock.method(fs,'mkdir',async(dir,...args)=>String(dir)===path.dirname(file)?undefined:mkdir(dir,...args));
 t.mock.method(fs,'readFile',async(...args)=>{
  if(String(args[0])!==file)return read(...args);
  const n=++reads,body=await read(...args);
  if(n===1){firstRead.resolve();await release.promise;}
  return body;
 });
 let a,b;
 t.after(async()=>{release.resolve();await Promise.allSettled([a,b].filter(Boolean));});
 a=actions[first](env);await firstRead.promise;
 b=actions[second](env);
 await Promise.resolve();
 // The unqueued baseline reaches readFile after at most the completed mkdir.
 // Finish that writer while A is held, making lost-update deterministic. The
 // serialized implementation cannot enter B and is released before awaiting it.
 if(reads>1)await b;
 release.resolve();
 const settled=await Promise.allSettled([a,b]);
 assert.ok(settled.every(r=>r.status==='fulfilled'),'both mutations must succeed');
 const {map}=await readEnvMap(env);
 for(const key of want)assert.ok(map.has(key),`${key} lost by a stale env snapshot`);
 assert.equal(map.has('DELETE_ME'),!removed);
 assert.equal(map.get('KEEP'),'fixture-keep');
 assert.equal((await fs.stat(file)).mode&0o777,0o600);
 assert.match(await fs.readFile(file,'utf8'),/^# fixture, unchanged raw line/m);
});

test('env write order: failed rename rejects its caller, then releases later mutations',async t=>{
 const {env,file}=await home(t),rename=fs.rename.bind(fs);let fail=true;
 t.mock.method(fs,'rename',async(from,to)=>{
  if(String(to)===file&&fail){fail=false;throw Object.assign(Error('fixture rename failed'),{code:'EIO'});}
  return rename(from,to);
 });
 await assert.rejects(actions.core(env),/fixture rename failed/);
 assert.equal(env.CORE_KEY,undefined);
 await actions.provider(env);
 const {map}=await readEnvMap(env);
 assert.equal(map.has('CORE_KEY'),false);
 assert.equal(map.get('CURSOR_API_KEY'),'fixture-provider');
});

test('env write order: queued destinations and env objects remain in their originating profile',async t=>{
 const a=await home(t),b={HOME:a.env.HOME,MSB_BOT_ID:'other'};
 await Promise.all([setEnvKey('FIRST_KEY','fixture-first',a.env),setEnvKey('SECOND_KEY','fixture-second',b)]);
 assert.equal((await readEnvMap(a.env)).map.has('SECOND_KEY'),false);
 assert.equal((await readEnvMap(b)).map.has('FIRST_KEY'),false);
 assert.equal(a.env.SECOND_KEY,undefined);assert.equal(b.FIRST_KEY,undefined);
});
