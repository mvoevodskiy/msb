/** Telegram size after HTML entities, preserving old page10/number controls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/menu-fixture.mjs';
import {loadState,saveState} from '../src/state.mjs';
import {sessionListScreen,selectedSessionText} from '../src/telegram/screens/session-list.mjs';
const id=n=>'ext:codex:0199a213-81c0-7800-8aa1-'+String(n).padStart(12,'0');
const visible=html=>html.replace(/<\/?b>/g,'').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const entry=(n,extra={})=>({id:id(n),engine:'cc',providerId:'codex',firstPrompt:'x'.repeat(200),lastPrompt:'y'.repeat(200),project:'p'.repeat(40),messageCount:1,lastActivity:'2099-01-01T00:00:00Z',...extra});
for(const [label,extra]of [
 ['menu project40',{}],['existing project255',{project:'p'.repeat(255)}],
 ['escaped captions',{firstPrompt:'<>&'.repeat(80),lastPrompt:'&><'.repeat(80),project:'<&>'.repeat(80)}],
 ['astral text',{firstPrompt:'p'+'🧠'.repeat(150),lastPrompt:'r'+'📄'.repeat(100),project:'📁'.repeat(60)}],
 ['oversized legacy project',{project:'p'.repeat(5000)}]
])test('session page size: '+label+' fits one Telegram message and keeps all ten actual choices',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),entries=Array.from({length:10},(_,i)=>entry(i,extra));await saveState({...((await loadState()).state),sessionHistory:entries,ccSessionId:id(9)});
 await f.callback('menu:sessions');const text=f.edits.at(-1);assert.equal(typeof text,'string');const body=visible(text);
 assert.ok(body.length<=4096,`Visible UTF16 length ${body.length} exceeds Telegram4096`);assert.equal(body.isWellFormed(),true,'Truncation must not split surrogate pairs');
 assert.ok(text.startsWith('📋 <b>Сессии</b> (10):'));assert.ok(body.includes('← текущая'));assert.equal((body.match(/1 сообщ\./g)||[]).length,10);
 const rows=f.editOptions.at(-1).reply_markup.inline_keyboard;assert.deepEqual(rows.slice(0,2).map(r=>r.length),[5,5]);assert.deepEqual(rows.slice(0,2).flat().map(b=>b.callback_data),entries.slice().reverse().map(r=>'session:'+r.id));assert.equal(rows.at(-1)[0].callback_data,'menu:back');
 assert.deepEqual((await loadState()).state.sessionHistory,entries,'Display clipping must not change retained metadata');
});
test('session page size control: normal old list text and controls stay byte-identical',()=>{
 const rows=[entry(1,{firstPrompt:'First',lastPrompt:undefined,project:undefined}),entry(2,{firstPrompt:'Second',lastPrompt:'Latest',project:'alpha',messageCount:2})];
 const view=sessionListScreen(rows,id(1));
 assert.equal(view.text,'📋 <b>Сессии</b> (2):\n\n2. Second\n   ↳ остановились на: «Latest»\n   [alpha] · только что · 2 сообщ.\n\n1. First ← текущая\n   [workspace] · только что · 1 сообщ.');
 assert.deepEqual(view.keyboard.inline_keyboard,[[{text:'1 ✓',callback_data:'session:'+id(1)},{text:'2',callback_data:'session:'+id(2)}],[{text:'« Назад',callback_data:'menu:back'}]]);
});
test('session page size: a single emoji description also stays well-formed at the old preview boundary',()=>{
 const view=sessionListScreen([entry(1,{firstPrompt:'🧠'.repeat(150),lastPrompt:undefined,project:undefined})],id(1));
 assert.equal(visible(view.text).isWellFormed(),true);
});

test('session page size: selected-description text keeps a valid Unicode boundary too',()=>{
 assert.equal(selectedSessionText(entry(1,{firstPrompt:'p'+'🧠'.repeat(150)})).isWellFormed(),true);
});
