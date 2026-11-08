/** Reachable old OC read list; no CLI model/service/auth/OS changes. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {openClawSkillsFixture,OC_LOADING,OC_UNAVAILABLE,OC_EMPTY,visibleHtml,assertBalanced} from './helpers/skills-openclaw-fixture.mjs';
import {loadState} from '../src/state.mjs';import {readEnvMap} from '../src/env/store.mjs';
const state=async()=>(await loadState()).state;
const last=f=>f.edits.at(-1)||f.messages.at(-1)||'';
const rows=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard||f.messageOptions.at(-1)?.reply_markup?.inline_keyboard||[];
const BACK=[[{text:'« Назад',callback_data:'skills:back-menu'}]];
async function called(f,count=1){const calls=await f.readCalls();assert.equal(calls.length,count,'OC list must reach the selected native CLI instead of a placeholder');for(const c of calls)assert.deepEqual(c.argv,['skills','list','--json','--eligible']);return calls;}
const until=async check=>{const deadline=Date.now()+3000;while(!await check()){assert.ok(Date.now()<deadline,'Owned native CLI barrier missing');await new Promise(r=>setTimeout(r,5));}};

const fixtureSkills=[{name:'Zeta',description:'Last',source:'workspace'},{name:'Beta',description:'Project',source:'repo-project'},{name:'Alpha',description:'First',source:'workspace',userInvocable:false},{name:'SYSTEM',description:'Hidden',source:'bundled'},{name:'Managed',source:'managed'},{name:'Bundled',source:'bundled'},{name:'Extra',source:'extra'},{name:'Other',source:'custom'}];
const NORMAL='🧩 <b>Навыки агента</b>\nДоступно: <b>7</b> · агент применяет сам; вручную — <code>/имя</code>\n\n<b>📂 Твои навыки</b>\n[+] <code>Alpha</code> — First\n[+] <code>Zeta</code> — Last\n\n<b>📁 Проект</b>\n[+] <code>Beta</code> — Project\n\n<b>🗂 Установленные</b>\n[+] <code>Managed</code>\n\n<b>📦 Встроенные</b>\n[+] <code>Bundled</code>\n\n<b>🧰 Дополнительные</b>\n[+] <code>Extra</code>\n\n<b>📦 custom</b>\n[+] <code>Other</code>';
test('OC skills: command uses the exact old grouped list, native args and only Back, without switching provider/profile',async t=>{
 const f=await openClawSkillsFixture(t,fixtureSkills),before=await state(),store=await fs.readFile(f.storeFile,'utf8');await f.message('/skills');await called(f);assert.equal(f.messages.at(-1),NORMAL);assert.deepEqual(f.messageOptions.at(-1).reply_markup.inline_keyboard,BACK);assert.equal(f.typingSignals.length,1);assert.deepEqual(await state(),before);assert.equal(await fs.readFile(f.storeFile,'utf8'),store);
});
for(const envelope of ['array','skills','eligible','items'])test('OC skills: '+envelope+' envelope retains String/trim, false invocable and group semantics',async t=>{
 const data=[null,5,{}, {name:'  Number  ',description:42,source:'  '},{name:'NoManual',description:'  Desc  ',source:'extra',userInvocable:false}],payload=envelope==='array'?data:{[envelope]:data};
 const f=await openClawSkillsFixture(t,payload);await f.message('/skills');await called(f);const text=f.messages.at(-1);assert.ok(text.includes('Доступно: <b>2</b>'));assert.ok(text.includes('<b>📦 Прочие</b>\n[+] <code>Number</code> — 42'));assert.ok(text.includes('[+] <code>NoManual</code> — Desc'));
});
for(const [mode,payload]of [['empty',[]],['badjson','{invalid'],['wrong-envelope',{skills:'not-array',eligible:[{name:'must-not-fall-through'}]}],['exit',[{name:'not-success'}]]])test('OC skills: '+mode+' keeps the old unavailable result and Back',async t=>{
 const f=await openClawSkillsFixture(t,payload,mode==='exit'?'exit':'ok');await f.message('/skills');await called(f);assert.equal(f.messages.at(-1),OC_UNAVAILABLE);assert.deepEqual(f.messageOptions.at(-1).reply_markup.inline_keyboard,BACK);
});
test('OC skills: a nonempty all-system list is the distinct old empty state',async t=>{
 const f=await openClawSkillsFixture(t,[{name:' system '},{name:'SyStEm'}]);await f.message('/skills');await called(f);assert.equal(f.messages.at(-1),OC_EMPTY);
});
test('OC skills: callback shows the old typing/loading step and final Back, without CLI cards or Add',async t=>{
 const f=await openClawSkillsFixture(t,fixtureSkills);await f.callback('menu:skills');await called(f);assert.equal(f.edits[0],OC_LOADING);assert.equal(f.edits.at(-1),NORMAL);assert.equal(f.typingSignals.length,1);assert.deepEqual(rows(f),BACK);assert.equal(f.editOptions[0].reply_markup,undefined);assert.equal(f.messages.length,0);
});
test('OC skills: failed loading edit is ignored, and final edit failure falls back to only the final reply',async t=>{
 const f=await openClawSkillsFixture(t,fixtureSkills);f.bot.api.editMessageText=async()=>{throw Error('fixture edit unavailable');};await f.callback('menu:skills');await called(f);assert.deepEqual(f.messages,[NORMAL]);assert.deepEqual(f.messageOptions.at(-1).reply_markup.inline_keyboard,BACK);
});
test('OC skills: nullish envelope priority accepts null skills but not an invalid nonnull skills field',async t=>{
 const f=await openClawSkillsFixture(t,{skills:null,eligible:[{name:'Eligible',source:'extra'}]});await f.message('/skills');await called(f);assert.ok(f.messages.at(-1).includes('<code>Eligible</code>'));
});
test('OC skills: unknown source and metadata are escaped, while unknown group order is stable',async t=>{
 const f=await openClawSkillsFixture(t,[{name:'B<&>',description:'Text <&>',source:'<source&>'},{name:'A',source:'unknown-z'},{name:'C',source:'unknown-a'}]);await f.message('/skills');await called(f);const text=f.messages.at(-1);assert.ok(text.includes('<b>📦 &lt;source&amp;&gt;</b>'));assert.ok(text.includes('<code>B&lt;&amp;&gt;</code> — Text &lt;&amp;&gt;'));assert.ok(text.indexOf('unknown-z')<text.indexOf('unknown-a'));assertBalanced(assert,text);
});
test('OC skills: description keeps the old 90 encoded-unit budget without splitting an HTML entity or Unicode pair',async t=>{
 const f=await openClawSkillsFixture(t,[{name:'Entity',description:'a'.repeat(88)+'<'},{name:'Astral',description:'b'.repeat(89)+'🧠'},{name:'Valid',description:'&'.repeat(30)}]);await f.message('/skills');await called(f);const text=f.messages.at(-1);assert.ok(text.includes('<code>Entity</code> — '+'a'.repeat(88)));assert.equal(text.includes('&l\n'),false);assert.ok(text.includes('<code>Astral</code> — '+'b'.repeat(89)));assert.equal(text.isWellFormed(),true);assert.ok(text.includes('<code>Valid</code> — '+'&amp;'.repeat(18)));assertBalanced(assert,text);
});
test('OC skills: native child gets the old HB environment filter while the parent remains unchanged',async t=>{
 const f=await openClawSkillsFixture(t);for(const k of ['JARVIS_CC_ONLY','BOT_TOKEN','ANTHROPIC_API_KEY','IIA_ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','SYNC_KEY','SYNC_URL','GIT_DIR','NPM_CONFIG_PREFIX','GITHUB_TOKEN'])process.env[k]='fixture-'+k;
 await f.message('/skills');const [call]=await called(f);for(const [k,present]of Object.entries(call.present)){assert.equal(present,k==='GITHUB_TOKEN',k);assert.equal(process.env[k],'fixture-'+k);}assert.equal(call.cwd,process.cwd());
});
test('OC skills: input form survives reading and no Claude/Codex session or source files change',async t=>{
 const f=await openClawSkillsFixture(t);await f.callback('settings:env:quick:CUSTOM_OC_SKILLS_FORM');const before=await state();await f.callback('menu:skills');await called(f);assert.deepEqual(await state(),before);await f.message('fixture-value');await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});assert.equal((await readEnvMap()).map.get('CUSTOM_OC_SKILLS_FORM'),'fixture-value');
});
test('OC skills: unauthorized requests do not start a native reader or expose data',async t=>{
 const f=await openClawSkillsFixture(t,fixtureSkills),before=await state();await f.message('/skills',43);await f.callback('menu:skills',43);assert.deepEqual(await f.readCalls(),[]);assert.equal(f.edits.length,0);assert.equal(f.messages.length,0);assert.deepEqual(await state(),before);
});
test('OC skills: a slow callback read does not block polling and cannot overwrite newer navigation',async t=>{
 const f=await openClawSkillsFixture(t,fixtureSkills,'hold');await f.callback('menu:skills',42,{waitForRender:false});
 try{await until(async()=> (await f.readCalls()).length===1);assert.equal(f.edits.at(-1),OC_LOADING);await f.callback('menu:back');const edits=f.edits.length,hub=f.edits.at(-1);await f.release();await Promise.allSettled([...(f.bot[Symbol.for('msb.callbackTasks')]||[])]);assert.equal(f.edits.length,edits);assert.equal(f.edits.at(-1),hub);}finally{await f.release();}
});
test('OC skills: a slow command is owned and /stop cancels it without a late list/error reply',async t=>{
 const f=await openClawSkillsFixture(t,fixtureSkills,'hold');await f.message('/skills',42,{waitForRender:false});
 try{await until(async()=> (await f.readCalls()).length===1);assert.ok((f.bot[Symbol.for('msb.callbackTasks')]?.size||0)>0);await f.message('/stop');await f.release();await Promise.allSettled([...(f.bot[Symbol.for('msb.callbackTasks')]||[])]);assert.equal(f.messages.some(s=>s.includes('<b>Навыки')),false);}finally{await f.release();}
});
test('OC skills: repeated views read fresh native JSON, not a fixed list or a persisted fake snapshot',async t=>{
 const f=await openClawSkillsFixture(t,[{name:'First'}]);await f.message('/skills');await f.setPayload([{name:'Second'}]);await f.callback('skills:back');await called(f,2);assert.equal(last(f).includes('<code>First</code>'),false);assert.ok(last(f).includes('<code>Second</code>'));
});
for(const callback of [false,true])test('OC skills: long '+(callback?'callback':'command')+' list preserves all entries in valid Telegram parts with only a final Back',async t=>{
 const names=Array.from({length:55},(_,i)=>'long-skill-'+String(i).padStart(3,'0')),payload=names.map(name=>({name,description:'d'.repeat(90),source:'bundled'}));const f=await openClawSkillsFixture(t,payload);
 const send=f.bot.api.sendMessage,edit=f.bot.api.editMessageText;
 f.bot.api.sendMessage=async(chat,text,...args)=>{assert.ok(visibleHtml(text).length<=4096,'Telegram send text capacity exceeded');return send(chat,text,...args);};
 f.bot.api.editMessageText=async(chat,id,text,...args)=>{assert.ok(visibleHtml(text).length<=4096,'Telegram edit text capacity exceeded');return edit(chat,id,text,...args);};
 if(callback)await f.callback('menu:skills');else await f.message('/skills');await called(f);
 const textParts=[...f.edits.filter(x=>x!==OC_LOADING),...f.messages],all=textParts.join('\n');assert.ok(textParts.length>1);for(const text of textParts){assert.ok(visibleHtml(text).length<=4096);assertBalanced(assert,text);}for(const name of names)assert.ok(all.includes('<code>'+name+'</code>'),name);assert.deepEqual(f.messageOptions.at(-1).reply_markup.inline_keyboard,BACK);assert.equal(all.includes('⏱'),false);
});
