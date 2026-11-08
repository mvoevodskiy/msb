/** Readonly view transport contract; synthetic HTML, no bot/network/provider/profile. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverView} from '../src/telegram/view-delivery.mjs';
import {assertBalanced,visibleHtml} from './helpers/skills-openclaw-fixture.mjs';
import {beginCommandRender,cancelCallbackRenders} from '../shared/callback-renders.mjs';
const keyboard={inline_keyboard:[[{text:'« Назад',callback_data:'skills:back-menu'}]]};
const longView=()=>({text:'<b>'+('А🧠&amp;'.repeat(1800))+'</b>',keyboard,disablePreview:true});

test('view delivery: ordinary HTML and marker-looking metadata remain byte-exact in one edit',async()=>{
 const view={text:'<b>Название</b>\n<code>[INSTALL_SKILL] [PLAN]</code> &lt;meta&gt;',keyboard},edits=[],replies=[],message={message_id:31};
 assert.equal(await deliverView(view,{edit:async part=>{edits.push(part);return message;},reply:async part=>replies.push(part)}),message);
 assert.deepEqual(edits,[view]);assert.deepEqual(replies,[]);
});
test('view delivery: an encoded HTML message over 4096 raw units still stays single when its visible text fits',async()=>{
 const view={text:'<code>'+'&amp;'.repeat(3000)+'</code>',keyboard},sent=[];
 await deliverView(view,{reply:async part=>sent.push(part)});assert.deepEqual(sent,[view]);
});
test('view delivery: long entity/Unicode text keeps all content, balanced tags and only the final original keyboard',async()=>{
 const view=longView(),sent=[];const last=await deliverView(view,{reply:async part=>{sent.push(part);return{message_id:sent.length};}});
 assert.ok(sent.length>1);assert.deepEqual(last,{message_id:sent.length});
 for(const [index,part]of sent.entries()){assert.ok(visibleHtml(part.text).length<=4096);assert.equal(part.text.isWellFormed(),true);assertBalanced(assert,part.text);assert.deepEqual(part.keyboard,index===sent.length-1?keyboard:{inline_keyboard:[]});assert.equal(part.disablePreview,true);}
 assert.equal(sent.map(part=>visibleHtml(part.text)).join(''),visibleHtml(view.text));
});
test('view delivery: callback edits the original only once then replies in order without changing the caller contract',async()=>{
 const calls=[],view=longView();await deliverView(view,{edit:async part=>calls.push(['edit',part]),reply:async part=>calls.push(['reply',part])});
 assert.ok(calls.length>1);assert.equal(calls[0][0],'edit');assert.equal(calls.slice(1).every(([kind])=>kind==='reply'),true);assert.deepEqual(calls.at(-1)[1].keyboard,keyboard);assert.equal(calls.some(([,part])=>part.text.includes('⏱')),false);
});
test('view delivery: newer navigation stops all remaining parts after an already accepted delivery drains',async()=>{
 const bot={},scope=beginCommandRender(bot,{chat:{id:42}}),calls=[];let accepted,release;
 const entered=new Promise(resolve=>{accepted=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const task=deliverView(longView(),{scope,edit:async part=>{calls.push(part);accepted();await gate;return{message_id:3};},reply:async part=>calls.push(part)});
 await entered;beginCommandRender(bot,{chat:{id:42}});release();assert.deepEqual(await task,{message_id:3});assert.equal(calls.length,1);
});
test('view delivery: a cancelled view sends no part',async()=>{
 const bot={},scope=beginCommandRender(bot,{chat:{id:42}});cancelCallbackRenders(bot,42);let calls=0;assert.equal(await deliverView(longView(),{scope,reply:async()=>calls++}),undefined);assert.equal(calls,0);
});
test('view delivery: transport failure does not claim a final delivery or keep sending later parts',async()=>{
 const error=Error('fixture delivery failure');let calls=0;
 await assert.rejects(deliverView(longView(),{reply:async()=>{calls++;throw error;}}),actual=>actual===error);assert.equal(calls,1);
});


test('view delivery: a short inline command at a chunk boundary stays whole in one part',async()=>{
 const view={text:'x'.repeat(4080)+'<code>skill-066--</code>'+'tail'.repeat(100),keyboard},parts=[];
 await deliverView(view,{reply:async part=>parts.push(part.text)});assert.ok(parts.some(text=>text.includes('<code>skill-066--</code>')),'A native skill command must remain copyable as one token');assert.equal(parts.map(visibleHtml).join(''),visibleHtml(view.text));
});
