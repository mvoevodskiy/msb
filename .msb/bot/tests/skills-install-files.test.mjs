/** Old filesystem hazards -> native writer controls in owned temporary directories only. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {writeInstalledSkill} from '../src/skills/install-writer.mjs';
import {payload} from './helpers/skills-install-fixture.mjs';
async function fixture(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),'msb-skill-files-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const root=path.join(home,'.agents/skills'),dir=path.join(root,payload.name),file=path.join(dir,'SKILL.md');await fs.mkdir(dir,{recursive:true});return{home,root,dir,file,target:{providerId:'codex',home,mirrorOpenClaw:false}};}
const emptyTemps=async dir=>assert.equal((await fs.readdir(dir)).some(name=>name.startsWith('.SKILL.')),false);
test('skill files: an existing skill symlink is replaced as an entry without overwriting the external source',async t=>{
 const f=await fixture(t),external=path.join(f.home,'external');await fs.writeFile(external,'external sentinel');await fs.symlink(external,f.file);const out=await writeInstalledSkill(payload,f.target);assert.equal(await fs.readFile(external,'utf8'),'external sentinel');assert.equal((await fs.lstat(f.file)).isSymbolicLink(),false);assert.equal(await fs.readFile(f.file+'.bak','utf8'),'external sentinel');assert.equal(out.replaced,true);await emptyTemps(f.dir);
});
test('skill files: an existing backup symlink cannot redirect backup publication outside the native skill',async t=>{
 const f=await fixture(t),external=path.join(f.home,'external');await fs.writeFile(external,'external sentinel');await fs.writeFile(f.file,'old skill');await fs.symlink(external,f.file+'.bak');await writeInstalledSkill(payload,f.target);assert.equal(await fs.readFile(external,'utf8'),'external sentinel');assert.equal(await fs.readFile(f.file+'.bak','utf8'),'old skill');assert.equal((await fs.lstat(f.file+'.bak')).isSymbolicLink(),false);await emptyTemps(f.dir);
});
test('skill files: a skill-directory symlink escaping the selected root leaves its external sentinel unchanged',async t=>{
 const f=await fixture(t),external=path.join(f.home,'external-dir');await fs.mkdir(external);await fs.writeFile(path.join(external,'SKILL.md'),'external sentinel');await fs.rmdir(f.dir);await fs.symlink(external,f.dir);await assert.rejects(writeInstalledSkill(payload,f.target),/escapes native root/);assert.equal(await fs.readFile(path.join(external,'SKILL.md'),'utf8'),'external sentinel');assert.deepEqual(await fs.readdir(external),['SKILL.md']);
});
test('skill files: a legitimate symlink of the native skills root remains supported',async t=>{
 const f=await fixture(t),configured=path.join(f.home,'configured-native-skills');await fs.rename(f.root,configured);await fs.symlink(configured,f.root);await writeInstalledSkill(payload,f.target);assert.equal((await fs.lstat(f.root)).isSymbolicLink(),true);assert.ok((await fs.readFile(path.join(configured,payload.name,'SKILL.md'),'utf8')).includes(payload.body));
});
test('skill files: replacement preserves existing user-selected mode and cleans its own temporary files',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,'old skill');await fs.chmod(f.file,0o640);await writeInstalledSkill(payload,f.target);assert.equal((await fs.stat(f.file)).mode & 0o777,0o640);await emptyTemps(f.dir);
});
test('skill files: aliasing native roots do not back up the newly written content over the actual previous version',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,'actual previous skill');await fs.mkdir(path.join(f.home,'.claude'));await fs.mkdir(path.join(f.home,'.openclaw'));await fs.symlink(f.root,path.join(f.home,'.claude/skills'));await fs.symlink(f.root,path.join(f.home,'.openclaw/skills'));
 const out=await writeInstalledSkill(payload,{...f.target,providerId:'claude',mirrorOpenClaw:true});assert.equal(out.written.length,2);assert.equal(await fs.readFile(f.file+'.bak','utf8'),'actual previous skill');await emptyTemps(f.dir);
});
test('skill files: abort during backup drains that operation but prevents the replacement and cleans owned temps',async t=>{
 const f=await fixture(t),controller=new AbortController();await fs.writeFile(f.file,'must survive');let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});const io={...fs,copyFile:async(...args)=>{entered();await gate;return fs.copyFile(...args);}};
 const work=writeInstalledSkill(payload,f.target,{io,signal:controller.signal});await started;controller.abort();release();await assert.rejects(work,{name:'AbortError'});assert.equal(await fs.readFile(f.file,'utf8'),'must survive');await emptyTemps(f.dir);
});
test('skill files: an already aborted install starts no file mutations',async t=>{
 const f=await fixture(t),controller=new AbortController(),before=await fs.readdir(f.dir);controller.abort();await assert.rejects(writeInstalledSkill(payload,f.target,{signal:controller.signal}),{name:'AbortError'});assert.deepEqual(await fs.readdir(f.dir),before);
});


test('skill files: an unreadable optional OpenClaw home skips only the mirror as old exists did',async t=>{
 const f=await fixture(t),optional=path.join(f.home,'.openclaw'),io={...fs,stat:async(file,...args)=>{if(file===optional)throw Object.assign(Error('fixture optional metadata failure'),{code:'EACCES'});return fs.stat(file,...args);}};
 const out=await writeInstalledSkill(payload,{...f.target,providerId:'claude',mirrorOpenClaw:true},{io});assert.equal(out.written.length,1);assert.ok((await fs.readFile(path.join(f.home,'.claude/skills',payload.name,'SKILL.md'),'utf8')).includes(payload.body));
});
