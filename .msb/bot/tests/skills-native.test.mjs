/** Selected Codex must show real native metadata, never a Claude catalog or fake count. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {codexSkillsFixture} from './helpers/skills-codex-fixture.mjs';
import {loadState,saveState} from '../src/state.mjs';
const state=async()=>(await loadState()).state;
const buttons=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat()||[];
const text=f=>f.edits.at(-1)||'';
const find=(f,name)=>{const b=buttons(f).find(b=>b.text===name);assert.ok(b,'The old skill action must use native Codex metadata: '+name);return b.callback_data;};
const open=async(f,name)=>f.callback(find(f,name));
async function listingCalls(f){const calls=await f.readCalls();assert.ok(calls.some(c=>c.method==='skills/list'),'Selected Codex skills must come from the actual native read protocol');for(const c of calls)assert.ok(['initialize','initialized','skills/list'].includes(c.method),'Listing must not login/start/resume/write config or change a model');return calls.filter(c=>c.method==='skills/list');}

test('skills native: command uses initialized skills/list for captured cwd and only read methods, without profile changes',async t=>{
 const f=await codexSkillsFixture(t),before=await state(),store=await fs.readFile(f.storeFile,'utf8');await f.message('/skills');const calls=await listingCalls(f);assert.equal(calls.length,1);assert.deepEqual(calls[0].params,{cwds:[f.workspace],forceReload:true});assert.ok(f.messages.at(-1).includes('<b>Навыки</b>'));assert.ok(f.messageOptions.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.text==='📂 workspace (4)'));assert.deepEqual(await state(),before);assert.equal(await fs.readFile(f.storeFile,'utf8'),store);
});
test('skills native: an active project displays native repo scope separately from user/system skills',async t=>{
 const f=await codexSkillsFixture(t);await f.selectProject();await f.callback('menu:skills');assert.equal(find(f,'📂 workspace (3)'),'skills:folder:workspace');assert.equal(find(f,'📂 alpha (1)'),'skills:folder:project');await open(f,'📂 alpha (1)');assert.ok(text(f).includes('🧠 codex-project'));assert.equal(text(f).includes('codex-base'),false);const calls=await listingCalls(f);assert.ok(calls.every(c=>c.params.cwds[0]===f.project));
});
test('skills native: card/content read the native returned file, honor enabled and never present Claude-only files',async t=>{
 const f=await codexSkillsFixture(t);await f.callback('skills:folder:workspace');assert.equal(text(f).includes('claude-only'),false);assert.ok(text(f).includes('⏸ codex-paused'));await open(f,'🧠 codex-user');assert.ok(text(f).includes('Native description codex-user'));await open(f,'📄 Содержимое');assert.ok(text(f).includes('NATIVE_BODY_codex-user'));assert.equal(text(f).includes('CLAUDE_BODY_MUST_NOT_BE_CODEX'),false);assert.ok((await listingCalls(f)).length>=1);
});
for(const mode of ['error','wrong-cwd'])test('skills native: '+mode+' cannot masquerade as an empty or Claude-backed successful catalog',async t=>{
 const f=await codexSkillsFixture(t,mode),before=await state();await f.callback('menu:skills');await listingCalls(f);assert.match(text(f),/Не удалось получить список навыков/);assert.equal(text(f).includes('claude-only'),false);assert.equal(buttons(f).some(b=>b.callback_data==='skills:folder:workspace'),false);assert.deepEqual(await state(),before);
});
test('skills native control: an unauthorized skills view never starts a native process or reads metadata',async t=>{
 const f=await codexSkillsFixture(t),before=await state();await f.message('/skills',43);await f.callback('menu:skills',43);await f.callback('skills:folder:workspace',43);assert.deepEqual(await f.readCalls(),[]);assert.equal(f.messages.length,0);assert.equal(f.edits.length,0);assert.deepEqual(await state(),before);
});
test('skills native: a late read must not replace a newer navigation view or change the project',async t=>{
 const f=await codexSkillsFixture(t,'hold');await f.selectProject();const opening=f.callback('menu:skills');
 try{
  const until=Date.now()+1500;while(!(await f.readCalls()).some(c=>c.method==='skills/list')){assert.ok(Date.now()<until,'The production Codex route must start its read before testing its lifecycle');await new Promise(r=>setTimeout(r,5));}
  await f.callback('menu:back');const hub=text(f),edits=f.edits.length;await f.release();await opening;assert.equal(text(f),hub);assert.equal(f.edits.length,edits);assert.equal((await state()).activeProject,'alpha');const calls=await listingCalls(f);assert.ok(calls.every(c=>c.params.cwds[0]===f.project));
 }finally{await f.release();await opening.catch(()=>{});}
});
test('skills native: ordinary Claude discovery uses its old files and never queries Codex',async t=>{
 const f=await codexSkillsFixture(t);await saveState({...await state(),extAuthBypass:'claude',ccSessionId:'claude-skills-native-control'});await f.callback('skills:folder:workspace');assert.ok(text(f).includes('🧠 claude-only'));assert.equal(text(f).includes('codex-user'),false);assert.deepEqual(await f.readCalls(),[]);
});

test('skills native: slow metadata read releases the polling handler while its own render task is still pending',async t=>{
 const f=await codexSkillsFixture(t,'hold');let returned=false;const opening=f.callback('menu:skills',42,{waitForRender:false}).then(()=>{returned=true;});
 try{
  const until=Date.now()+1500;while(!(await f.readCalls()).some(c=>c.method==='skills/list')){assert.ok(Date.now()<until,'Native read must start before measuring polling responsiveness');await new Promise(r=>setTimeout(r,5));}
  const deadline=Date.now()+150;while(!returned && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.equal(returned,true,'Polling must accept commands while native skills are loading');
  assert.ok((f.bot[Symbol.for('msb.callbackTasks')]?.size||0)>0,'The read must still have an owned pending render task, not a fabricated immediate result');await f.callback('menu:back');assert.equal((await state()).extAuthBypass,'codex');
 }finally{await f.release();await opening.catch(()=>{});}
});

test('skills native: a slow /skills command releases polling and /stop cancels its owned read',async t=>{
 const f=await codexSkillsFixture(t,'hold');let returned=false;const opening=f.message('/skills',42,{waitForRender:false}).then(()=>{returned=true;});
 try{
  const until=Date.now()+1500;while(!(await f.readCalls()).some(c=>c.method==='skills/list')){assert.ok(Date.now()<until,'Command must reach native read before testing its polling lifecycle');await new Promise(r=>setTimeout(r,5));}
  const deadline=Date.now()+150;while(!returned && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.equal(returned,true,'Native metadata must not keep the command polling handler blocked');assert.ok((f.bot[Symbol.for('msb.callbackTasks')]?.size||0)>0);
  await f.message('/stop');await f.release();await opening;const tasks=[...(f.bot[Symbol.for('msb.callbackTasks')]||[])];await Promise.allSettled(tasks);assert.equal(f.messages.some(s=>s.includes('<b>Навыки')),false,'A stopped read must not deliver a stale catalog');
 }finally{await f.release();await opening.catch(()=>{});}
});
test('skills native control: Claude-only mode rejects a stale Codex catalog without calling another provider',async t=>{
 const f=await codexSkillsFixture(t);process.env.JARVIS_CC_ONLY='1';await f.callback('menu:skills');assert.deepEqual(await f.readCalls(),[]);assert.match(text(f),/Не удалось получить список навыков/);assert.equal((await state()).extAuthBypass,'codex');
});

test('skills native: a base-repo skill is not labeled as available in every independent project',async t=>{
 const f=await codexSkillsFixture(t);await f.callback('skills:folder:workspace');assert.ok(text(f).includes('🧠 codex-base'));assert.equal(text(f).includes('Доступны агенту всегда, в любом проекте.'),false);assert.ok(text(f).includes('Доступны агенту в текущем workspace.'));
 await f.selectProject();await f.callback('skills:folder:workspace');assert.equal(text(f).includes('codex-base'),false);assert.ok(text(f).includes('Доступны агенту всегда, в любом проекте.'));
});
