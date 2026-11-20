import test from 'node:test';
import assert from 'node:assert/strict';
import { beginTurnHistory } from '../src/telegram/history.mjs';
import { createInbox } from '../src/telegram/inbox.mjs';
import { createSteerAction } from '../src/telegram/steer-action.mjs';

const flush = async () => { for (let i=0; i<20; i++) await Promise.resolve(); };
const gate = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
async function fixture({ status='accepted', hold, voice=false, throwSend=false, now=Date.now } = {}) {
  const rows=[], sends=[], running=gate(), controller=new AbortController();
  const history=await beginTurnHistory({input:'initial',now,io:{mkdir:async()=>{},appendFile:async(file,text)=>rows.push({file,...JSON.parse(text)})}});
  history.provider('codex');
  const handle={active:true,isCurrent:async()=>true,steer:async text=>{sends.push(text);if(hold)await hold.promise;if(throwSend)throw Error('uncertain');return {status};}};
  const turn={controller,steer:handle,history};
  const inbox=createInbox({run:async entry=>{if(entry.text==='initial')await running.promise;},status:async()=>{},cancel:async()=>{}});
  const push=(text,voice=false)=>{const entry={text,voice,status:{message_id:101},ctx:{chat:{id:42},message:{text,from:{id:42},reply_to_message:{text:'quoted fixture',from:{id:99}}},me:{id:99}}};inbox.push(entry);return entry;};
  push('initial'); await flush();
  const entry=push(voice?'': 'correction token=secret-value',voice);
  const offer=inbox.steerCandidates()[0]; entry.steerOffer={token:offer.token,turn,handle};
  const action=createSteerAction({inbox,getActive:()=>turn,adminId:42,prepareVoice:async entry=>(entry.preparedVoice={transcript:'voice token=secret-value',prompt:'quoted fixture\n\nvoice token=secret-value'}),present:async()=>{},refresh:()=>{}});
  const click=()=>action({from:{id:42},chat:{id:42},callbackQuery:{data:'steer:'+offer.token,message:{message_id:101}},answerCallbackQuery:async()=>{}});
  const finish=()=>history.finish({status:'ok',text:'answer',delivered:true,result:{providerId:'codex'}});
  const close=async()=>{inbox.clear();running.resolve();await flush();await inbox.shutdown();};
  return {rows,sends,entry,inbox,history,click,finish,close,controller};
}
const transcript = rows => rows.filter(x=>x.file.includes('/transcripts/'));
const traces = rows => rows.filter(x=>x.file.includes('/traces/'));

test('accepted text and voice stay inside the original turn, with redaction and no duplicate', async()=>{
 for(const voice of [false,true]){
  const f=await fixture({voice});await f.click();await f.click();await f.finish();
  const entries=transcript(f.rows),user=entries.filter(x=>x.role==='user');
  assert.equal(user.length,2);assert.deepEqual(user.map(x=>x.turnId),[entries[0].turnId,entries[0].turnId]);
  assert.match(user[1].text,voice?/^voice/:/^correction/);assert.doesNotMatch(user[1].text,/secret-value|quoted fixture/);
  assert.deepEqual(entries.map(x=>x.role),['user','user','assistant']);assert.equal(traces(f.rows).length,1);assert.equal(traces(f.rows)[0].query,'initial');assert.equal(f.sends.length,1);await f.close();
 }
});

test('rejected, unavailable, unknown and thrown send add no accepted journal entry',async()=>{
 for(const status of ['rejected','unavailable','unknown','throw']){
  const f=await fixture({status,throwSend:status==='throw'});await f.click();await f.finish();
  assert.deepEqual(transcript(f.rows).map(x=>x.role),['user','assistant']);assert.equal(traces(f.rows).length,1);await f.close();
 }
});

test('stop and turn completion while ack is pending write a late accepted reply before assistant',async()=>{
 let clock=Date.parse('2026-11-17T12:00:00Z');
 const ack=gate(),f=await fixture({hold:ack,now:()=>clock});const click=f.click();await flush();
 assert.equal(f.sends.length,1); f.inbox.clear();f.controller.abort();
 let done=false;const finishing=f.finish().then(()=>done=true);await flush();assert.equal(done,false);
 clock+=10_000;ack.resolve();await click;await finishing;
 assert.ok(transcript(f.rows)[1].ts <= transcript(f.rows)[2].ts);
 assert.deepEqual(transcript(f.rows).map(x=>x.role),['user','user','assistant']);assert.equal(traces(f.rows).length,1);await f.close();
});

test('turn finishing before steer send prevents late correction and leaves FIFO',async()=>{
 const f=await fixture();const hold=gate();f.entry.steerOffer.handle.isCurrent=()=>hold.promise;
 const click=f.click();await flush();await f.finish();hold.resolve(true);await click;
 assert.deepEqual(f.sends,[]);assert.equal(f.inbox.steerEntries().length,1);assert.deepEqual(transcript(f.rows).map(x=>x.role),['user','assistant']);await f.close();
});

test('multiple tickets settle once and finish waits for all pending journal writes', async()=>{
 const writeGate=gate(),rows=[]; let n=0;
 const history=await beginTurnHistory({input:'initial',io:{mkdir:async()=>{},appendFile:async(file,text)=>{
   const row=JSON.parse(text); if(row.role==='user' && ++n===2)await writeGate.promise; rows.push({file,...row});
 }}});
 const a=history.reserveSteer('first'),b=history.reserveSteer('second');
 assert.equal(a.settle('accepted'),true);assert.equal(a.settle('accepted'),false);
 let done=false;const ending=history.finish({status:'ok',text:'answer',delivered:true}).then(()=>done=true);
 b.settle('accepted');await flush();assert.equal(done,false);writeGate.resolve();await ending;
 assert.deepEqual(transcript(rows).map(row=>row.text),['initial','first','second','answer']);
 assert.equal(traces(rows).length,1);assert.equal(history.reserveSteer('late'),null);
});

test('a failed accepted journal append does not fail turn completion or disclose its text', async()=>{
 const logs=[];let n=0;
 const history=await beginTurnHistory({input:'initial',log:line=>logs.push(line),io:{mkdir:async()=>{},appendFile:async()=>{if(++n===2)throw Error('private fixture');}}});
 history.reserveSteer('secret-value').settle('accepted');
 await history.finish({status:'ok',text:'answer',delivered:true});
 assert.ok(logs.length);assert.ok(logs.every(line=>!line.includes('secret-value')&&!line.includes('private fixture')));
});

test('confirmed Codex input keeps its provider and ordering even if the clock moves back', async()=>{
 let clock=Date.parse('2026-11-17T12:00:00Z'); const rows=[];
 const history=await beginTurnHistory({input:'initial',now:()=>clock,io:{mkdir:async()=>{},appendFile:async(file,text)=>rows.push({file,...JSON.parse(text)})}});
 const ticket=history.reserveSteer('correction'); clock-=5000; ticket.settle('accepted');
 await history.finish({status:'ok',text:'answer',delivered:true,result:{providerId:'codex'}});
 const entries=transcript(rows); assert.equal(entries[1].providerId,'codex');
 assert.ok(entries[0].ts <= entries[1].ts && entries[1].ts <= entries[2].ts);
});
