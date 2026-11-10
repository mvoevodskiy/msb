/** Old project UI → real handlers/state/filesystem; private HOME, no model/API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './helpers/menu-fixture.mjs';
import {loadState,saveState} from '../src/state.mjs';
import {readEnvMap} from '../src/env/store.mjs';
const PREFIX='Введи название проекта.\n\nЛатиницей, маленькими буквами, без пробелов. Можно цифры, дефис и подчёркивание.\nНапример: <code>youtube-asset</code>';
const INVALID='❌ Так не подойдёт.\n\nЛатиницей, маленькими буквами, без пробелов. Можно цифры, дефис и подчёркивание.\nНапример: <code>youtube-asset</code>';
const root=f=>path.join(path.dirname(f.workspace),'projects');
const buttons=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat() || [];
const exists=async p=>fs.stat(p).then(()=>true,()=>false);
const state=async()=>(await loadState()).state;
async function dirs(f,names){await fs.mkdir(root(f),{recursive:true});for(const name of names)await fs.mkdir(path.join(root(f),name));}
async function seeded(){const s=await state();const seed={...s,sessionEpoch:4,lastCcUsage:{inputTokens:73},parkedCcSessions:{claude:'fixture-inactive-session'},pendingCcSessionStarts:{claude:'fixture-first-a',codex:'fixture-first-b'},fixtureUntouched:'preserve'};await saveState(seed);return seed;}
function checkSelection(next,prev,name){
 assert.equal(next.activeProject,name);assert.equal(next.ccSessionId,undefined);
 assert.equal(next.lastCcUsage,undefined);assert.equal(next.parkedCcSessions,undefined);assert.equal(next.pendingCcSessionStarts,undefined);
 assert.equal(next.sessionEpoch,5);
 const rest=s=>Object.fromEntries(Object.entries(s).filter(([k])=>!['activeProject','ccSessionId','lastCcUsage','parkedCcSessions','pendingCcSessionStarts','sessionEpoch'].includes(k)));
 assert.deepEqual(rest(next),rest(prev));
}
async function until(check){const end=Date.now()+1500;while(!check()){assert.ok(Date.now()<end,'Ordinary text did not enter the runner');await new Promise(r=>setTimeout(r,5));}}

test('projects: empty command keeps old no-project text and create action',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await state();await f.message('/projects');
 assert.equal(f.messages.at(-1),'📁 Проектов пока нет.');
 assert.deepEqual(f.messageOptions.at(-1).reply_markup.inline_keyboard,[[{text:'➕ Новый проект',callback_data:'menu:newproject'}]]);
 assert.deepEqual(await state(),before);
});
test('projects: empty menu keeps the original return route',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await f.callback('menu:projects');
 assert.equal(f.edits.at(-1),'📁 Проектов пока нет.');
 assert.deepEqual(buttons(f).map(b=>b.callback_data),['menu:newproject','menu:back']);
});
test('projects: sorted list uses nine buttons per page and three per row, with active/default markers',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),names=['Alpha','_z','alpha-lower','beta','project-00','project-01','project-02','project-03','project-04','project-05','Я_Upper','я-lower'];
 await dirs(f,[...names].reverse());await saveState({...await state(),activeProject:names[1]});
 await f.callback('menu:projects');const rows=f.editOptions.at(-1).reply_markup.inline_keyboard;
 assert.ok(f.edits.at(-1).includes('📁 <b>Проекты</b> (12):'));
 assert.ok(f.edits.at(-1).includes('▸ '+names[1]+' — текущий'));assert.ok(f.edits.at(-1).includes(names[11]));
 assert.equal(rows[0][0].callback_data,'project:__default__');assert.equal(rows[0][0].text,'📂 ~/workspace');
 assert.deepEqual(rows.slice(1,4).map(r=>r.map(b=>b.callback_data)),[names.slice(0,3),names.slice(3,6),names.slice(6,9)].map(r=>r.map(n=>'project:'+n)));
 assert.equal(rows[1][1].text,'✓ '+names[1]);assert.ok(buttons(f).some(b=>b.callback_data==='projects:page:1'));
 await f.callback('projects:page:1');
 assert.deepEqual(buttons(f).filter(b=>b.callback_data.startsWith('project:')&&b.callback_data!=='project:__default__').map(b=>b.callback_data),names.slice(9).map(n=>'project:'+n));
 assert.ok(buttons(f).some(b=>b.text==='2/2'&&b.callback_data==='noop'));
 assert.ok(buttons(f).some(b=>b.callback_data==='projects:page:0'));assert.equal(buttons(f).at(-1).callback_data,'menu:back');
});
for(const target of ['alpha','__default__','same'])test('projects: '+target+' selection resets every old workspace conversation atomically',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await dirs(f,['alpha']);const before=await seeded();
 if(target!=='alpha'){before.activeProject='alpha';await saveState(before);}
 const store=await fs.readFile(f.storeFile,'utf8');await f.callback('project:'+(target==='same'?'alpha':target));
 checkSelection(await state(),before,target==='__default__'?undefined:'alpha');assert.equal(await fs.readFile(f.storeFile,'utf8'),store);
 assert.equal(f.edits.at(-1),target==='__default__'?'📂 Переключился на базовый workspace (<code>~/workspace</code>)':'📍 Переключился на проект <code>alpha</code>');
});
for(const target of ['missing','plain-file','../outside'])test('projects: missing or invalid target '+target+' cannot change the saved session',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await dirs(f,[]);await fs.writeFile(path.join(root(f),'plain-file'),'fixture');
 const before=await seeded();await f.callback('project:'+target);assert.deepEqual(await state(),before);
 assert.ok(f.messages.at(-1)?.startsWith('❌ Проект '));assert.ok(f.messages.at(-1)?.includes('не найден.'));
});
test('projects control: unauthorized owner cannot create, select or page through project actions',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await seeded();
 for(const data of ['menu:projects','menu:newproject','menu:cancel_newproject','project:alpha','project:__default__','projects:page:1'])await f.callback(data,43);
 assert.deepEqual(await state(),before);assert.equal(await exists(root(f)),false);assert.deepEqual(f.edits,[]);assert.deepEqual(f.messages,[]);
});
for(const[input,name]of [['My_Project-2','my_project-2'],['  alpha-2  ','alpha-2']])test('projects: menu create normalizes '+input+' and creates the old scaffold before activation',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await seeded();await f.callback('menu:newproject');
 assert.equal(f.edits.at(-1),PREFIX);assert.deepEqual(buttons(f),[{text:'✖ Отмена',callback_data:'menu:cancel_newproject'}]);
 await f.message(input);checkSelection(await state(),before,name);
 for(const child of ['memory','knowledge'])assert.equal(await exists(path.join(root(f),name,child)),true);
 assert.equal(f.messages.at(-1),`✔ Проект <code>${name}</code> создан и активирован.\n\nПиши задачу — агент уже в нём.`);
 assert.deepEqual(f.restartRequests,[]);
});
for(const input of ['two names','x'.repeat(41),'проект','alpha.dot','alpha/beta','   ','alpha!','alpha\nbeta'])test('projects: invalid menu name '+JSON.stringify(input)+' keeps the form for retry',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await seeded();await f.callback('menu:newproject');await f.message(input);
 assert.equal(f.messages.at(-1),INVALID);assert.deepEqual(await state(),before);assert.equal(await exists(root(f)),false);
 await f.message('RETRY-OK');checkSelection(await state(),before,'retry-ok');
});
test('projects: explicit cancel closes only the project input before the next ordinary task',async t=>{
 let turns=0;const f=await fixture(t,async()=>{turns++;return{ok:true,text:'fixture task'};},{overlay:false}),before=await state();
 await f.callback('menu:newproject');await f.callback('menu:cancel_newproject');await f.message('ordinary task');await until(()=>turns===1);
 assert.deepEqual(await state(),before);assert.equal(await exists(root(f)),false);assert.ok(f.deleted.includes(1));
});
test('projects control: an old project cancel cannot close a replacement env input',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await f.callback('menu:newproject');await f.callback('settings:env:quick:CUSTOM_API');
 await f.callback('menu:cancel_newproject');await f.message('fixture-value');await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});
 assert.equal((await readEnvMap()).map.get('CUSTOM_API'),'fixture-value');assert.equal(await exists(root(f)),false);
});
test('projects: reached slash exits the project form without saving the following task as a directory',async t=>{
 let turns=0;const f=await fixture(t,async()=>{turns++;return{ok:true,text:'fixture task'};},{overlay:false});
 await f.callback('menu:newproject');await f.message('/unknown_project_command');await f.message('ordinary task');await until(()=>turns===1);
 assert.equal(await exists(root(f)),false);
});
test('projects: registered status retains the old form priority and permits the actual name next',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await seeded();await f.callback('menu:newproject');await f.message('/status');await f.message('STATUS-RETRY');
 checkSelection(await state(),before,'status-retry');
});
test('projects: customized base workspace keeps projects beside that base, inside the synthetic HOME',async t=>{
 const f=await fixture(t,undefined,{overlay:false});f.workspace=path.join(f.home,'tenant','base');await fs.mkdir(f.workspace,{recursive:true});process.env.MSB_WORKSPACE_DIR=f.workspace;
 await f.callback('menu:newproject');await f.message('alpha');
 assert.equal(await exists(path.join(root(f),'alpha','memory')),true);
 assert.equal(await exists(path.join(f.home,'projects','alpha')),false);
});
test('projects: old /project new sanitizes separately and does not impose the menu lowercase/40 limit',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await seeded(),name='Upper_'+'A'.repeat(41);
 await f.message('/project new '+name+'!');checkSelection(await state(),before,name);
 assert.equal(await exists(path.join(root(f),name,'memory')),true);assert.equal(await exists(path.join(root(f),name,'knowledge')),true);
 assert.ok(f.messages.at(-1).includes(path.join(root(f),name)));
});
for(const alias of ['home','default'])test('projects: old /project '+alias+' returns to base and starts a fresh conversation',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await seeded();before.activeProject='alpha';await saveState(before);
 await f.message('/project '+alias);checkSelection(await state(),before,undefined);
 assert.equal(f.messages.at(-1),'📍 Переключился на <code>~/workspace</code>');
});
test('projects: /project workspace is an existing folder name, not an invented default alias',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await dirs(f,['workspace']);const before=await seeded();await f.message('/project workspace');checkSelection(await state(),before,'workspace');
});
test('projects: /project without a target reports the current project path without changing state',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await dirs(f,['alpha']);const before={...await state(),activeProject:'alpha'};await saveState(before);await f.message('/project');
 assert.equal(f.messages.at(-1),`📍 Активный проект: <code>alpha</code>\n📂 <code>${path.join(root(f),'alpha')}</code>`);assert.deepEqual(await state(),before);
});
for(const name of ['a'.repeat(70),'я'.repeat(30),'__default__','p~'+'e'.repeat(32)])test('projects: existing special name '+name.slice(0,12)+' has a bounded unambiguous callback',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await dirs(f,[name]);await f.callback('menu:projects');
 const button=buttons(f).find(b=>b.text===name);assert.ok(button,'An existing directory must have a real selection action');assert.ok(Buffer.byteLength(button.callback_data,'utf8')<=64);
 assert.notEqual(button.callback_data,'project:__default__');await f.callback(button.callback_data);assert.equal((await state()).activeProject,name);
});

test('projects: names from the filesystem are HTML escaped in the old list text',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await dirs(f,['alpha&beta','a<b']);await f.callback('menu:projects');
 assert.ok(f.edits.at(-1).includes('alpha&amp;beta'));assert.ok(f.edits.at(-1).includes('a&lt;b'));
 assert.ok(buttons(f).some(b=>b.text==='alpha&beta'));
});
test('projects control: unknown opaque selection cannot redraw or close a new env form',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await f.callback('settings:env:quick:CUSTOM_API');
 const edits=f.edits.length,replies=f.messages.length,before=await state();
 await f.callback('project:p~'+'0'.repeat(32));
 assert.equal(f.edits.length,edits);assert.equal(f.messages.length,replies);assert.deepEqual(await state(),before);
 await f.message('fixture-value');await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});
 assert.equal((await readEnvMap()).map.get('CUSTOM_API'),'fixture-value');
});

test('projects: create cannot follow an existing project symlink and modify a directory outside the project root',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),outside=path.join(f.home,'outside-projects');await dirs(f,[]);await fs.mkdir(outside);
 await fs.symlink(outside,path.join(root(f),'alpha'));const before=await seeded();
 await f.callback('menu:newproject');await f.message('alpha');
 assert.equal(await exists(path.join(outside,'memory')),false);assert.equal(await exists(path.join(outside,'knowledge')),false);assert.equal(await exists(path.join(outside,'.git')),false);
 assert.deepEqual(await state(),before);
});


test('projects: cancel deletes the actual fallback prompt instead of the original menu message',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await state();
 f.bot.api.editMessageText=async()=>{throw Error('fixture edit unavailable');};
 await f.callback('menu:newproject',42,{messageId:77});const promptId=f.messages.length;
 assert.equal(f.messages.at(-1),PREFIX);await f.callback('menu:cancel_newproject',42,{messageId:promptId});
 assert.deepEqual(f.deleted,[promptId]);assert.equal(f.deleted.includes(77),false);assert.deepEqual(await state(),before);assert.equal(await exists(root(f)),false);
});
test('projects: cancel from an older project prompt cannot close the replacement project input',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),before=await seeded();
 await f.callback('menu:newproject',42,{messageId:11});await f.callback('menu:newproject',42,{messageId:22});
 await f.callback('menu:cancel_newproject',42,{messageId:11});assert.deepEqual(f.deleted,[]);
 await f.message('replacement-project');checkSelection(await state(),before,'replacement-project');
});
