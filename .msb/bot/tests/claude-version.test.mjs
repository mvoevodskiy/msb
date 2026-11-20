/** Native metadata/cache only, with synthetic binaries; never starts a provider turn. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaudeVersionReader } from '../src/agent/claude-version.mjs';
import { resolveNativeClaude, isNativeClaudeFile } from '../shared/claude-binary.mjs';
const pause = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function home(t) { const p = await fs.mkdtemp(path.join(os.tmpdir(),'claude-version-')); t.after(() => fs.rm(p,{recursive:true,force:true})); return p; }
async function script(root, name, body, mode = 0o644) { const file = path.join(root,name); await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,body,{mode}); return file; }
const reader = opts => createClaudeVersionReader({ resolveBin: () => 'fixture', fileFingerprint: () => 'A', ...opts });

test('real metadata subprocess reads only native version once per unchanged fingerprint', async t => {
  const root = await home(t), count = path.join(root,'reads');
  const file = await script(root,'native.mjs', `import fs from 'node:fs'; if(process.argv[2]!=='--version') throw Error('only version'); fs.appendFileSync(${JSON.stringify(count)},'x'); process.stdout.write('2.1.300 (Claude Code)');`);
  const read = createClaudeVersionReader({ resolveBin: () => file });
  const env = { HOME: root, PATH: path.dirname(process.execPath) };
  assert.equal(await read(env),'2.1.300'); assert.equal(await read(env),'2.1.300');
  assert.equal(await fs.readFile(count,'utf8'),'x');
});

test('changed fingerprint during minimum reread interval returns unknown, then probes actual new binary', async () => {
  let at = 0, fp = 'A', reads = 0;
  const read = reader({ now: () => at, fileFingerprint: () => fp, readVersion: () => { reads++; return fp === 'A' ? '2.1.300' : '2.1.154'; } });
  assert.equal(await read(),'2.1.300'); fp='B';at=100;
  assert.equal(await read(),'unknown'); assert.equal(reads,1);
  at=15000; assert.equal(await read(),'2.1.154'); assert.equal(reads,2);
});

test('unknown retries use old 15-second backoff doubling and cap at five minutes', async () => {
  let at=0, reads=0, result='unknown';
  const read=reader({now:()=>at,readVersion:()=>{reads++;return result;}});
  for (const [i,time] of [0,15000,45000,105000,225000,465000,765000].entries()) {
    at=time;assert.equal(await read(),'unknown');assert.equal(reads,i+1);
    at=time+1;assert.equal(await read(),'unknown');assert.equal(reads,i+1);
  }
  at=1065000;result='2.1.300';assert.equal(await read(),'2.1.300');assert.equal(reads,8);
  at+=999999;assert.equal(await read(),'2.1.300');assert.equal(reads,8);
});

test('concurrent same-installation readers share exactly one pending native query', async () => {
  const gate=pause();let count=0;
  const read=reader({readVersion:()=>{count++;return gate.promise;}});
  const calls=[read(),read(),read()];await new Promise(setImmediate);assert.equal(count,1);
  gate.resolve('2.1.300');assert.deepEqual(await Promise.all(calls),['2.1.300','2.1.300','2.1.300']);
});

test('a late result from a replaced binary cannot unlock or overwrite the new installation', async () => {
  const a=pause(),b=pause();let fp='A';
  const read=reader({fileFingerprint:()=>fp,readVersion:()=>fp==='A'?a.promise:b.promise});
  const first=read();await new Promise(setImmediate);fp='B';
  const second=read();await new Promise(setImmediate);b.resolve('2.1.154');
  assert.equal(await second,'2.1.154');a.resolve('2.1.300');assert.equal(await first,'unknown');
  assert.equal(await read(),'2.1.154');
});

test('fingerprint changed while the query ran is rejected even without another caller', async () => {
  let fp='A';
  const read=reader({fileFingerprint:()=>fp,readVersion:()=>{fp='B';return '2.1.300';}});
  assert.equal(await read(),'unknown');
});

test('unavailable fingerprint retains the last cached version as old SB did', async () => {
  let fp='A',calls=0;
  const read=reader({fileFingerprint:()=>fp,readVersion:()=>{calls++;return '2.1.300';}});
  assert.equal(await read(),'2.1.300');fp=null;assert.equal(await read(),'2.1.300');assert.equal(calls,1);
});

test('no native binary and thrown probes return unknown, never a guessed supported version', async () => {
  assert.equal(await createClaudeVersionReader({resolveBin:()=>null})(),'unknown');
  assert.equal(await reader({readVersion:()=>{throw Error('fixture');}})(),'unknown');
});

test('oversized native version output fails closed instead of trusting its first version token', async t => {
  const root=await home(t),file=await script(root,'oversize.mjs', "process.stdout.write('2.1.300 '+ 'x'.repeat(20000));");
  assert.equal(await createClaudeVersionReader({resolveBin:()=>file})({HOME:root}),'unknown');
});

test('hung --version process is killed within its bound and returns unknown', { timeout: 20000 }, async t => {
  const root=await home(t),file=await script(root,'stalled.mjs', "process.stdout.write('2.1.300');setInterval(()=>{},100);");
  const started=performance.now();
  assert.equal(await createClaudeVersionReader({resolveBin:()=>file})({HOME:root}),'unknown');
  assert.ok(performance.now()-started<15000);
});

test('native resolver rejects wrapper, JS shim and symlink aliases before executing metadata', async t => {
  const root=await home(t);
  const shim=await script(root,'ext/shim/bin/claude','#!/bin/sh\nexit 99\n',0o755);
  const js=await script(root,'ext/shim/run-turn.mjs',"throw Error('shim must never execute');");
  const alias=path.join(root,'bin/claude');await fs.mkdir(path.dirname(alias),{recursive:true});await fs.symlink(shim,alias);
  assert.equal(isNativeClaudeFile(shim),false);assert.equal(isNativeClaudeFile(js),false);assert.equal(isNativeClaudeFile(alias),false);
  const env={HOME:root,MSB_REAL_CLAUDE:alias,PATH:path.dirname(alias)};
  const resolve=cfg=>resolveNativeClaude(cfg,{systemCandidates:[]});
  assert.equal(resolve(env),null);
  assert.equal(await createClaudeVersionReader({resolveBin:resolve})(env),'unknown');
});


test('JAR1 IIA alias chooses its own native override and isolated cache', async t => {
  const root=await home(t);
  const a=await script(root,'a.mjs',"process.stdout.write('2.1.300 (Claude Code)');");
  const b=await script(root,'b.mjs',"process.stdout.write('2.1.154 (Claude Code)');");
  const { readClaudeVersion }=await import('../src/agent/claude-version.mjs');
  const env={HOME:root,PATH:path.dirname(process.execPath),IIA_REAL_CLAUDE:a};
  assert.equal(resolveNativeClaude(env,{systemCandidates:[]}),a);
  assert.equal(await readClaudeVersion(env),'2.1.300');
  assert.equal(await readClaudeVersion({...env,IIA_REAL_CLAUDE:b}),'2.1.154');
});
