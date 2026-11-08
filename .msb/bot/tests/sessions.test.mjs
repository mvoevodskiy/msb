/** Old sessions UI -> production handlers/state; synthetic HOME and fake Telegram only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './helpers/menu-fixture.mjs';
import {loadState,saveState,updateState} from '../src/state.mjs';
import {readEnvMap} from '../src/env/store.mjs';
const EMPTY='Нет сохранённых сессий. Напиши что-нибудь, чтобы начать первую.';
const state=async()=>(await loadState()).state;
function edit(f){const text=f.edits.at(-1);assert.equal(typeof text,'string','The saved-session route must render a view');return text;}
const sid=(provider,n)=>provider==='claude'?`claude-history-${n}`:provider==='qwen'?`ext:qwen:history-session-${n}`:`ext:${provider}:0199a213-81c0-7800-8aa1-${String(n).padStart(12,'0')}`;
const row=(provider,n,extra={})=>({id:sid(provider,n),engine:'cc',providerId:provider,firstPrompt:`fixture-first-${provider}-${n}`,messageCount:1,startedAt:'2026-01-01T00:00:00Z',lastActivity:'2099-01-01T00:00:00Z',...extra});
const buttons=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat() || [];
async function seed(entries,extra={}) {
 const before={...await state(),sessionHistory:entries,sessionEpoch:4,fixtureUnrelated:'keep',...extra};await saveState(before);return before;
}
async function project(f,name){await fs.mkdir(path.join(path.dirname(f.workspace),'projects',name),{recursive:true});}

test('sessions: empty command restores the old text with no reset shortcut',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await state();await f.message('/sessions');
 assert.equal(f.messages.at(-1),EMPTY);assert.equal(f.messageOptions.at(-1)?.reply_markup,undefined);assert.deepEqual(await state(),before);
});
test('sessions: empty menu retains only the old Back route',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await state();await f.callback('menu:sessions');
 assert.equal(edit(f),EMPTY);assert.deepEqual(buttons(f),[{text:'« Назад',callback_data:'menu:back'}]);assert.deepEqual(await state(),before);
});
test('sessions: old insertion order, ten per page, five buttons per row and current marker',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entries=Array.from({length:12},(_,i)=>row('codex',i));
 // Deliberately contradictory activity dates: old order is reverse insertion.
 entries[0].lastActivity='2099-12-31T00:00:00Z';await seed(entries,{ccSessionId:entries[11].id});await f.callback('menu:sessions');
 const text=edit(f),rows=f.editOptions.at(-1).reply_markup.inline_keyboard;
 assert.ok(text.startsWith('📋 <b>Сессии</b> (12) — стр. 1:'));
 assert.deepEqual(f.editOptions.at(-1).link_preview_options,{is_disabled:true});
 assert.ok(text.includes('1. fixture-first-codex-11 ← текущая'));
 assert.ok(text.indexOf('10. fixture-first-codex-2')<text.indexOf('1. fixture-first-codex-11'));
 assert.equal(text.includes('fixture-first-codex-0'),false);
 assert.deepEqual(rows.slice(0,2).map(r=>r.map(b=>b.text)),[['1 ✓','2','3','4','5'],['6','7','8','9','10']]);
 assert.deepEqual(rows.slice(0,2).flat().map(b=>b.callback_data),entries.slice(2).reverse().map(r=>'session:'+r.id));
 assert.ok(buttons(f).some(b=>b.text==='11-12 »'&&b.callback_data==='sessions:page:1'));
});
test('sessions: page callbacks preserve numbers, reverse text within the page and old previous label',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entries=Array.from({length:12},(_,i)=>row('codex',i));await seed(entries);await f.callback('sessions:page:1');
 const text=edit(f);assert.ok(text.startsWith('📋 <b>Сессии</b> (12) — стр. 2:'));
 assert.ok(text.indexOf('12. fixture-first-codex-0')<text.indexOf('11. fixture-first-codex-1'));
 assert.deepEqual(buttons(f).map(b=>[b.text,b.callback_data]),[['11','session:'+entries[1].id],['12','session:'+entries[0].id],['« 1-10','sessions:page:0'],['« Назад','menu:back']]);
});
for(const provider of ['claude','codex','cursor','qwen'])test('sessions: '+provider+' sees only its own current core-engine ledger, including legacy ID rows',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),own=row(provider,1),legacy=row(provider,2);delete legacy.providerId;delete legacy.engine;
 const foreign=['claude','codex','cursor','qwen'].filter(p=>p!==provider).map(p=>row(p,3));
 const wrongEngine=row(provider,4,{engine:'oc',firstPrompt:'foreign-engine-must-not-show'});
 const before=await seed([own,...foreign,legacy,wrongEngine],{extAuthBypass:provider,ccSessionId:own.id});await f.callback('menu:sessions');
 assert.ok(edit(f).includes(own.firstPrompt));assert.ok(edit(f).includes(legacy.firstPrompt));
 for(const entry of [...foreign,wrongEngine])assert.equal(edit(f).includes(entry.firstPrompt),false);
 assert.equal(buttons(f).filter(b=>b.callback_data.startsWith('session:')).length,2);assert.deepEqual(await state(),before);
});
test('sessions: a declared provider inconsistent with its encoded ID is never offered',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await seed([row('codex',1,{providerId:'claude',firstPrompt:'inconsistent-must-not-show'})]);await f.callback('menu:sessions');
 assert.equal(edit(f),EMPTY);
});
test('sessions: old prompt/project/continuation fields are escaped and bounded without invented counts',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1,{firstPrompt:'<first>& '+'x'.repeat(220),lastPrompt:'<last>& '+'y'.repeat(140),project:'a<b',messageCount:3});
 await seed([entry],{ccSessionId:entry.id});await f.callback('menu:sessions');const text=edit(f);
 assert.ok(text.includes('&lt;first&gt;&amp;'));assert.ok(text.includes('↳ остановились на: «&lt;last&gt;&amp;'));
 assert.ok(text.includes('[a&lt;b] · только что · 3 сообщ.'));assert.equal(text.includes('x'.repeat(220)),false);assert.equal(text.includes('y'.repeat(140)),false);assert.ok(text.includes('…'));
});
test('sessions: an equal normalized last prompt has no duplicate continuation line',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await seed([row('codex',1,{firstPrompt:'first  prompt',lastPrompt:'first\nprompt'})]);await f.callback('menu:sessions');
 assert.ok(edit(f).includes('first prompt'));assert.equal(edit(f).includes('остановились на'),false);
});
test('sessions: future and local minute/hour/day activity follow the old relative labels',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),now=Date.now();await seed([0,2*60000,2*3600000,2*86400000].map((age,i)=>row('codex',i,{lastActivity:new Date(now-age).toISOString()})));await f.callback('menu:sessions');
 for(const text of ['только что','2 мин назад','2 ч назад','2 дн назад'])assert.ok(edit(f).includes(text),text);
});
test('sessions: invalid page callback cannot redraw a newer env input or change state',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await f.callback('settings:env:quick:CUSTOM_HISTORY');const edits=f.edits.length,before=await state();await f.callback('sessions:page:bad');
 assert.equal(f.edits.length,edits);assert.deepEqual(await state(),before);
 await f.message('fixture-value');await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});assert.equal((await readEnvMap()).map.get('CUSTOM_HISTORY'),'fixture-value');
});
test('sessions: an out-of-range page clamps to the last actual page',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entries=Array.from({length:12},(_,i)=>row('codex',i));await seed(entries);await f.callback('sessions:page:999');
 assert.ok(edit(f).includes('— стр. 2:'));assert.equal(buttons(f)[0].callback_data,'session:'+entries[1].id);
});
for(const [provider,id]of [['claude','fixture-'+'x'.repeat(90)],['codex','ext:codex:fixture-long-'+'x'.repeat(70)],['qwen','ext:qwen:'+'я'.repeat(40)]])test('sessions: '+provider+' long native ID has a working bounded callback',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row(provider,1,{id});await seed([entry],{extAuthBypass:provider});await f.callback('menu:sessions');
 const button=buttons(f).find(b=>b.text==='1');assert.ok(button,'A real saved row needs a real selection action');assert.ok(Buffer.byteLength(button.callback_data,'utf8')<=64);
 await f.callback(button.callback_data);assert.equal((await state()).ccSessionId,id);
});
test('sessions: same-project selection resumes the saved ID, clearing only its own parked/pending slot',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1,{project:'alpha'});await project(f,'alpha');
 const before=await seed([entry],{activeProject:'alpha',lastCcUsage:{inputTokens:73},parkedCcSessions:{claude:'keep-claude',codex:sid('codex',9)},pendingCcSessionStarts:{claude:'keep-claude-token',codex:'cancel-codex-token'}}),store=await fs.readFile(f.storeFile,'utf8');
 await f.callback('session:'+entry.id);const next=await state();assert.equal(next.ccSessionId,entry.id);assert.equal(next.activeProject,'alpha');assert.equal(next.sessionEpoch,5);assert.equal(next.lastCcUsage,undefined);
 assert.deepEqual(next.parkedCcSessions,{claude:'keep-claude'});assert.deepEqual(next.pendingCcSessionStarts,{claude:'keep-claude-token'});assert.deepEqual(next.sessionHistory,before.sessionHistory);assert.equal(next.fixtureUnrelated,before.fixtureUnrelated);assert.equal(await fs.readFile(f.storeFile,'utf8'),store);
 assert.equal(edit(f),'✔ Переключился: fixture-first-codex-1 [alpha]');
});
test('sessions: selecting another project clears all old-cwd slots and tokens in the ID transition',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1,{project:'beta'});await project(f,'alpha');await project(f,'beta');
 await seed([entry],{activeProject:'alpha',parkedCcSessions:{claude:'old-alpha'},pendingCcSessionStarts:{claude:'old-a',codex:'old-b'},lastCcUsage:{inputTokens:3}});await f.callback('session:'+entry.id);const next=await state();
 assert.equal(next.activeProject,'beta');assert.equal(next.ccSessionId,entry.id);assert.equal(next.sessionEpoch,5);assert.equal(next.parkedCcSessions,undefined);assert.equal(next.pendingCcSessionStarts,undefined);assert.equal(next.lastCcUsage,undefined);
});
test('sessions: a saved base conversation restores the base cwd and its ID together',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1);await project(f,'alpha');await seed([entry],{activeProject:'alpha',parkedCcSessions:{claude:'old-alpha'},pendingCcSessionStarts:{claude:'old-a'}});
 await f.callback('session:'+entry.id);const next=await state();assert.equal(next.activeProject,undefined);assert.equal(next.ccSessionId,entry.id);assert.equal(next.parkedCcSessions,undefined);assert.equal(next.pendingCcSessionStarts,undefined);
});
test('sessions: a missing target project cannot change the current ID, project or profile',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1,{project:'missing'}),before=await seed([entry],{activeProject:'alpha'});
 await f.callback('session:'+entry.id);assert.deepEqual(await state(),before);assert.ok(f.messages.at(-1)?.includes('не найден'));
});
for(const reference of ['fixture-unknown-native-id','s~'+'0'.repeat(32)])test('sessions control: unknown '+reference.slice(0,12)+' cannot close a newer env input or pick an arbitrary native ID',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await f.callback('settings:env:quick:CUSTOM_HISTORY');const before=await state(),edits=f.edits.length;
 await f.callback('session:'+reference);assert.deepEqual(await state(),before);assert.equal(f.edits.length,edits);
 await f.message('fixture-value');await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});assert.equal((await readEnvMap()).map.get('CUSTOM_HISTORY'),'fixture-value');
});
test('sessions control: a stale Codex row cannot switch or overwrite the now selected Claude provider',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1);const before=await seed([entry],{extAuthBypass:'claude',ccSessionId:'keep-claude'});const store=await fs.readFile(f.storeFile,'utf8');
 await f.callback('session:'+entry.id);assert.deepEqual(await state(),before);assert.equal(await fs.readFile(f.storeFile,'utf8'),store);
});
test('sessions control: unauthorized owner cannot list, page, select or reset conversations',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1),before=await seed([entry]);
 await f.message('/sessions',43);await f.message('/newtask',43);
 for(const data of ['menu:sessions','sessions:page:1','session:'+entry.id,'menu:newtask'])await f.callback(data,43);
 assert.deepEqual(await state(),before);assert.deepEqual(f.edits,[]);assert.deepEqual(f.messages,[]);
});
for(const command of ['newtask','clear'])test('sessions: /'+command+' retains the old ledger and allows an explicit resume',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1),before=await seed([entry]);await f.message('/'+command);let next=await state();
 assert.equal(next.ccSessionId,undefined);assert.deepEqual(next.sessionHistory,before.sessionHistory);
 assert.equal(f.messages.at(-1),command==='newtask'?'🆕 Новая сессия. Предыдущий контекст сброшен.':'🧹 Контекст сброшен. Начинаем с чистого листа.');
 await f.callback('session:'+entry.id);next=await state();assert.equal(next.ccSessionId,entry.id);assert.equal(next.sessionEpoch,6);assert.deepEqual(next.sessionHistory,before.sessionHistory);
});
test('sessions: menu new-task keeps the old edited message and retained-history route',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1),before=await seed([entry]);await f.callback('menu:newtask');
 assert.equal(edit(f),'🆕 Новая сессия. Предыдущая сохранена — найдёшь в /sessions.\n\nПиши.');assert.deepEqual((await state()).sessionHistory,before.sessionHistory);assert.equal((await state()).ccSessionId,undefined);
});


test('sessions: valid selection retains the old pending env input ownership',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1);await seed([entry]);await f.callback('settings:env:quick:CUSTOM_HISTORY');
 await f.callback('session:'+entry.id);assert.equal((await state()).ccSessionId,entry.id);
 await f.message('fixture-value');await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});assert.equal((await readEnvMap()).map.get('CUSTOM_HISTORY'),'fixture-value');
});
test('sessions: nonempty command uses the same old list and disables URL previews',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1);await seed([entry]);await f.message('/sessions');
 assert.ok(f.messages.at(-1).startsWith('📋 <b>Сессии</b> (1):'));assert.equal(f.messageOptions.at(-1).reply_markup.inline_keyboard[0][0].callback_data,'session:'+entry.id);assert.deepEqual(f.messageOptions.at(-1).link_preview_options,{is_disabled:true});
});
test('sessions control: ambiguous repeated IDs are not offered or selected as another project',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1),before=await seed([entry,{...entry,project:'other'}]);await f.callback('menu:sessions');assert.equal(edit(f),EMPTY);
 await f.callback('session:'+entry.id);assert.deepEqual(await state(),before);
});
test('sessions control: Claude-only conflict cannot offer or install a Codex history ID',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1),before=await seed([entry]);process.env.JARVIS_CC_ONLY='1';
 await f.callback('menu:sessions');assert.equal(edit(f),EMPTY);await f.callback('session:'+entry.id);assert.deepEqual(await state(),before);
});
for(const change of ['provider','row-project'])test('sessions: '+change+' changing during directory validation invalidates the old selection without partial state writes',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1,{project:'alpha'});await project(f,'alpha');await seed([entry]);
 let entered,release;const checking=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});t.after(()=>release());
 const stat=fs.stat.bind(fs),target=path.join(path.dirname(f.workspace),'projects','alpha');
 t.mock.method(fs,'stat',async(file,...args)=>{if(String(file)===target){entered();await gate;}return stat(file,...args);});
 const selecting=f.callback('session:'+entry.id);await checking;
 await updateState(s=>{
  if(change==='provider'){s.extAuthBypass='claude';s.ccSessionId='keep-newer-claude';s.sessionEpoch++;}
  else s.sessionHistory=[{...entry,project:'beta'}];
  return s;
 });const newer=await state();release();await selecting;assert.deepEqual(await state(),newer);assert.equal(f.edits.length,0);
});


test('sessions: a directory permission error keeps the current conversation and shows no private filesystem detail',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1,{project:'alpha'});await project(f,'alpha');const before=await seed([entry]),target=path.join(path.dirname(f.workspace),'projects','alpha'),stat=fs.stat.bind(fs);
 t.mock.method(fs,'stat',async(file,...args)=>{if(String(file)===target)throw Object.assign(Error('fixture-private-fs-detail-'+target),{code:'EACCES'});return stat(file,...args);});
 await f.callback('session:'+entry.id);assert.deepEqual(await state(),before);assert.equal(f.messages.at(-1),'❌ Не удалось открыть сохранённую сессию. Текущая беседа не изменена.');
 assert.equal(f.messages.join('').includes('fixture-private-fs-detail'),false);assert.equal(f.messages.join('').includes(target),false);
});
test('sessions: a post-selection Telegram delivery failure cannot claim that the conversation was unchanged',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entry=row('codex',1);await seed([entry]);
 f.bot.api.editMessageText=async()=>{throw Error('fixture Telegram delivery failed');};f.bot.api.sendMessage=async()=>{throw Error('fixture Telegram delivery failed');};
 await assert.rejects(f.callback('session:'+entry.id),/fixture Telegram delivery failed/);assert.equal((await state()).ccSessionId,entry.id);assert.equal(f.messages.some(s=>s.includes('беседа не изменена')),false);
});
