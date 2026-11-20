/** Native 0.166 metadata -> shared old views; owned paths, injected RPC, no auth/process. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {listCodexSkills} from '../codex-skills.mjs';
async function fixture(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),'msb-codex-skills-map-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const cwd=path.join(home,'project'),bin=path.join(home,'bin');await fs.mkdir(cwd);await fs.mkdir(bin);await fs.writeFile(path.join(bin,'codex'),'#!/bin/sh\nexit 88\n',{mode:0o700});const env={HOME:home,PATH:bin};const file=path.join(cwd,'SKILL.md'),body='---\nname: fixture\ndescription: Описание 🧠\n---\nBody';await fs.writeFile(file,body);const row={name:'fixture',description:'Описание 🧠',path:file,scope:'repo',enabled:true};const snapshot={engine:'cc',extAuthBypass:'codex',activeProject:'alpha',ccSessionId:'ext:codex:fixture-native-id'};return{home,cwd,file,body,env,row,snapshot};}
const response=(cwd,skills,errors=[])=>({ok:true,data:{data:[{cwd,skills,errors}]}});

test('Codex skills mapping: native scope/enabled and UTF8 size are used without requiring auth or changing snapshot',async t=>{
 const f=await fixture(t),before=structuredClone(f.snapshot),rows=['repo','user','system','admin'].map((scope,i)=>({...f.row,name:'fixture-'+scope,scope,enabled:i!==1}));let calls=0;
 const out=await listCodexSkills(f.snapshot,{cwd:f.cwd,env:f.env,read:async args=>{calls++;assert.equal(args.cwd,f.cwd);assert.equal(args.env.HOME,f.home);assert.equal(args.env.OPENAI_API_KEY,undefined);return response(f.cwd,rows);}});
 assert.equal(out.ok,true);assert.deepEqual(out.entries.map(r=>r.source),['project','workspace','workspace','workspace']);assert.equal(out.entries[1].disabled,true);assert.ok(out.entries.every(r=>r.size===Buffer.byteLength(f.body)&&r.providerId==='codex'&&r.fullPath===f.file));assert.deepEqual(f.snapshot,before);assert.equal(calls,1);assert.equal(await fs.access(path.join(f.home,'.codex/auth.json')).then(()=>true,()=>false),false);
});
test('Codex skills mapping: base repo is workspace scope when no project is selected',async t=>{
 const f=await fixture(t);delete f.snapshot.activeProject;const out=await listCodexSkills(f.snapshot,{cwd:f.cwd,env:f.env,read:async()=>response(f.cwd,[f.row])});assert.equal(out.entries[0].source,'workspace');
});
test('Codex skills mapping: canonical native cwd matches a valid selected symlink directory',async t=>{
 const f=await fixture(t),alias=path.join(f.home,'alias');await fs.symlink(f.cwd,alias);const canonical=await fs.realpath(f.cwd);const out=await listCodexSkills(f.snapshot,{cwd:alias,env:f.env,read:async()=>response(canonical,[f.row])});assert.equal(out.ok,true);assert.equal(out.entries[0].fullPath,f.file);
});
test('Codex skills mapping: files that disappear after native scanning are skipped, not replaced by another provider',async t=>{
 const f=await fixture(t),missing={...f.row,name:'missing',path:path.join(f.home,'missing','SKILL.md')};const out=await listCodexSkills(f.snapshot,{cwd:f.cwd,env:f.env,read:async()=>response(f.cwd,[f.row,missing],[{message:'fixture parse error',path:'fixture'}])});assert.equal(out.ok,true);assert.deepEqual(out.entries.map(r=>r.name),['fixture']);
});
test('Codex skills mapping: wrong/duplicate cwd, malformed envelopes and invalid required metadata cannot create a fake empty success',async t=>{
 const f=await fixture(t);const values=[{ok:true,data:{}},response(f.cwd+'-other',[f.row]),{ok:true,data:{data:[{cwd:f.cwd,skills:[f.row]},{cwd:f.cwd,skills:[f.row]}]}},response(f.cwd,[{...f.row,scope:'future-unknown'}]),response(f.cwd,[{...f.row,path:'relative/SKILL.md'}]),response(f.cwd,[{...f.row,enabled:null}]),response(f.cwd,[{...f.row,name:null}])];
 for(const value of values){const out=await listCodexSkills(f.snapshot,{cwd:f.cwd,env:f.env,read:async()=>value});assert.equal(out.ok,false);}
 const empty=await listCodexSkills(f.snapshot,{cwd:f.cwd,env:f.env,read:async()=>response(f.cwd,[])});assert.deepEqual(empty,{ok:true,entries:[]});
});
test('Codex skills mapping: foreign provider, OC, relative cwd, Claude-only and abort cannot start the native read',async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();let calls=0;const read=async()=>{calls++;throw Error('must not read');};
 for(const [snapshot,extra]of [[{...f.snapshot,extAuthBypass:'claude'},{}],[{...f.snapshot,engine:'oc'},{}],[f.snapshot,{cwd:'relative'}],[f.snapshot,{env:{...f.env,JARVIS_CC_ONLY:'1'}}],[f.snapshot,{signal:controller.signal}]])assert.equal((await listCodexSkills(snapshot,{cwd:f.cwd,env:f.env,read,...extra})).ok,false);
 assert.equal(calls,0);
});
