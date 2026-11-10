/** Old env description route + file/UI/prompt consumers; synthetic HOME only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture } from './helpers/menu-fixture.mjs';
import { envFilePath,readEnvMap,listEnvEntries,setEnvKey,deleteEnvKey } from '../src/env/store.mjs';
import { envScreen } from '../src/telegram/screens.mjs';
import { loadState } from '../src/state.mjs';
import { buildSystemPrompt } from '../src/agent/system-prompt.mjs';
import { agentOptionsReport } from './helpers/agent-options.mjs';
import { parseClaudeArgv,buildPrompt } from '../../../overlay/bot/ext/adapters/parse-args.mjs';
const SECRET='fixture-description-only-value-6c86';
const DESC='Описание <личного> сервиса';
const entry=async(key='CUSTOM_API')=>(await listEnvEntries()).find(r=>r.key===key);
const stage=async(f,key='CUSTOM_API')=>{
 await f.callback(`settings:env:quick:${key}`);await f.message(SECRET);return f.messages.length;
};
const skip=async(f,id=f.messages.length)=>f.callback('settings:env:skip-comment',42,{messageId:id});
const until=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('turn missing');};

for(const overlay of [false,true]) for(const origin of ['name','quick']) {
 test(`env description: ${origin}, overlay=${overlay}, waits for description before one atomic save`,async t=>{
  const f=await fixture(t,undefined,{overlay});const state=(await loadState()).state,store=await fs.readFile(f.storeFile,'utf8');
  if(origin==='name'){await f.callback('settings:env:add');await f.message('CUSTOM_API');}
  else await f.callback('settings:env:quick:CUSTOM_API');
  await f.message(SECRET);
  assert.equal((await readEnvMap()).map.has('CUSTOM_API'),false,'value must remain transient until completion');
  assert.equal(process.env.CUSTOM_API,undefined);
  assert.equal(f.messages.at(-1),'Описание для <code>CUSTOM_API</code> (необязательно, видно тебе и агенту):');
  assert.deepEqual(f.messageOptions.at(-1).reply_markup.inline_keyboard,[[{text:'Пропустить →',callback_data:'settings:env:skip-comment'}]]);
  const promptId=f.messages.length;await f.message(DESC);
  assert.equal((await readEnvMap()).map.get('CUSTOM_API'),SECRET);
  assert.equal((await entry()).comment,DESC);
  assert.match(await fs.readFile(envFilePath(),'utf8'),/# Описание <личного> сервиса\nCUSTOM_API=/);
  assert.match(f.messages.at(-1),/📝 Описание &lt;личного&gt; сервиса/);
  assert.doesNotMatch(f.messages.at(-1),new RegExp(SECRET));
  assert.deepEqual(f.deleted,[promptId],'only the bot description prompt is removed');
  assert.deepEqual((await loadState()).state,state);assert.equal(await fs.readFile(f.storeFile,'utf8'),store);
  assert.deepEqual(f.restartRequests,[]);
 });
}

for(const completion of ['skip','blank']) test(`env description: ${completion} preserves existing metadata and adds none for a new key`,async t=>{
 const f=await fixture(t,undefined,{overlay:false});
 await fs.writeFile(envFilePath(),'# Existing description\nCUSTOM_API=fixture-before\n',{mode:0o600});
 for(const key of ['CUSTOM_API','NEW_API']){
  const id=await stage(f,key);
  if(completion==='skip')await skip(f,id);else await f.message('   ');
  assert.equal((await readEnvMap()).map.get(key),SECRET);
  assert.equal((await entry(key)).comment,key==='CUSTOM_API'?'Existing description':undefined);
  assert.doesNotMatch(f.messages.at(-1),/📝/,'skip does not repeat an older description in success');
 }
});

test('env description: metadata list caps/escapes at 300, delete confirmation includes it without value',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),description='<tag>'+ 'a'.repeat(310);
 await setEnvKey('CUSTOM_API',SECRET,process.env,{comment:description});
 const view=await envScreen();assert.ok(view.text.includes('└ <i>&lt;tag&gt;'+ 'a'.repeat(295)+'…</i>'));
 assert.doesNotMatch(view.text,new RegExp(SECRET));
 await f.callback('settings:env:delete:CUSTOM_API');
 assert.ok(f.edits.at(-1).includes('📝 <i>&lt;tag&gt;'));
 assert.doesNotMatch(f.edits.at(-1),new RegExp(SECRET));
 await f.callback('settings:env');assert.equal((await entry()).comment,description);
 await f.callback('settings:env:confirm-delete:CUSTOM_API');
 assert.equal((await readEnvMap()).map.has('CUSTOM_API'),false);
 assert.equal((await fs.readFile(envFilePath(),'utf8')).includes(description),false);
});

test('env description: updating metadata preserves raw unrelated lines and deletion cannot attach it to the next key',async t=>{
 await fixture(t,undefined,{overlay:false});
 const raw='# Header\n\nKEEP="fixture quoted=value"\n# older raw note\n# target description\nCUSTOM_API=old\nNEXT=fixture-next\n';
 await fs.writeFile(envFilePath(),raw,{mode:0o600});
 assert.equal((await entry()).comment,'target description');
 await setEnvKey('CUSTOM_API',SECRET,process.env,{comment:DESC});
 let body=await fs.readFile(envFilePath(),'utf8');assert.ok(body.startsWith('# Header\n\nKEEP="fixture quoted=value"\n# older raw note\n'));
 assert.equal((await entry()).comment,DESC);
 await setEnvKey('CUSTOM_API','fixture-next-value');assert.equal((await entry()).comment,DESC);
 await deleteEnvKey('CUSTOM_API');body=await fs.readFile(envFilePath(),'utf8');
 assert.equal((await entry('NEXT')).comment,undefined);assert.ok(body.includes('# older raw note'));
 assert.equal(body.includes('# '+DESC),false);assert.equal((await fs.stat(envFilePath())).mode&0o777,0o600);
});

for(const comment of ['injected\nBOT_TOKEN=bad','injected\rBAD=x','injected\0text']) {
 test('env description: metadata cannot inject env rows or NUL: '+JSON.stringify(comment),async t=>{
  await fixture(t,undefined,{overlay:false});
  await setEnvKey('KEEP','fixture-keep');const before=await fs.readFile(envFilePath(),'utf8');
  await assert.rejects(setEnvKey('CUSTOM_API',SECRET,process.env,{comment}),/описан|строк|NUL/i);
  assert.equal(await fs.readFile(envFilePath(),'utf8'),before);assert.equal(process.env.CUSTOM_API,undefined);
 });
}

test('env description: names/comments reach only an active custom capability, never file values',async t=>{
 const f=await fixture(t,undefined,{overlay:false});
 await setEnvKey('CUSTOM_API',SECRET,process.env,{comment:DESC});
 await setEnvKey('WITHOUT_NOTE','fixture-another-value');
 await setEnvKey('FILE_ONLY','fixture-file-only', {HOME:f.home,MSB_BOT_ID:'default'}, {comment:'not active'});
 const prompt=await buildSystemPrompt({workspace:f.home});
 assert.ok(prompt.includes('CUSTOM_API: '+DESC));assert.ok(prompt.includes('WITHOUT_NOTE: добавлен через /settings'));
 for(const text of [SECRET,'fixture-another-value','FILE_ONLY: not active'])assert.equal(prompt.includes(text),false);
});

for(const provider of ['claude','codex'])test(`env description: production ${provider} turn passes metadata through its existing prompt route`,async()=>{
 const out=agentOptionsReport(provider,'auto','opus','high','2.1.316',true),call=out.calls[0];
 const parsed=parseClaudeArgv(call.args),prompt=provider==='codex'?await buildPrompt(parsed,call.prompt,{providerId:provider}):parsed.appendSystemPrompt;
 assert.ok(prompt.includes('FIXTURE_CUSTOM_API: fixture custom description'));
 assert.equal(prompt.includes('fixture-env-description-value-79f1'),false);
 assert.equal(call.provider,provider);
});

for(const control of ['settings:env','settings:env:cancel','settings:back','/unknown_command']) {
 test(`env description: ${control} cancels transient value before a later task`,async t=>{
  let turns=0;const f=await fixture(t,async()=>{turns++;return{ok:true,text:'ordinary task'};},{overlay:false});
  await stage(f);
  if(control.startsWith('/'))await f.message(control);else await f.callback(control);
  assert.equal((await readEnvMap()).map.has('CUSTOM_API'),false);
  await f.message('ordinary task');await until(()=>turns===1);
  assert.equal((await readEnvMap()).map.has('CUSTOM_API'),false);
 });
}

for(const via of ['text','skip'])test(`env description: whole-form deadline applies at comment via ${via}`,async t=>{
 let clock=1_000_000;const f=await fixture(t,undefined,{overlay:false,now:()=>clock});
 await f.callback('settings:env:add');clock+=590_000;await f.message('CUSTOM_API');
 clock+=10_000;await f.message(SECRET);const id=f.messages.length;
 assert.equal((await readEnvMap()).map.has('CUSTOM_API'),false);clock++;
 if(via==='text')await f.message(DESC);else await skip(f,id);
 assert.equal((await readEnvMap()).map.has('CUSTOM_API'),false);
 assert.ok(f.messages.at(-1).startsWith('⏳ Время на ввод переменной истекло'));
});

test('env description: only current prompt in its originating chat can skip',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),old=await stage(f,'OLD_API');
 const fresh=await stage(f,'CUSTOM_API');
 await skip(f,old);assert.equal((await readEnvMap()).map.has('CUSTOM_API'),false);
 await f.callback('settings:env:skip-comment',42,{chatId:43,messageId:fresh});
 assert.equal((await readEnvMap()).map.has('CUSTOM_API'),false);
 await skip(f,fresh);assert.equal((await readEnvMap()).map.get('CUSTOM_API'),SECRET);
 assert.equal((await readEnvMap()).map.has('OLD_API'),false);
});

test('env description: a failed completion notification never rolls back an already saved key',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await stage(f);
 f.bot.api.sendMessage=async()=>{throw Error('fixture completion notification failed');};
 await assert.rejects(f.message(DESC),/completion notification failed/);
 assert.equal((await readEnvMap()).map.get('CUSTOM_API'),SECRET);assert.equal((await entry()).comment,DESC);
});

test('env description: registered /settings preserves the old comment stage until actual completion',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await stage(f);await f.message('/settings');
 assert.equal((await readEnvMap()).map.has('CUSTOM_API'),false);
 await f.message(DESC);assert.equal((await entry()).comment,DESC);
 assert.equal((await readEnvMap()).map.get('CUSTOM_API'),SECRET);
});

for(const action of ['cancel','replace','shutdown'])test(`env description: delayed prompt is removed after ${action} without reviving its draft`,async t=>{
 const f=await fixture(t,undefined,{overlay:false});let entered,release;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const send=f.bot.api.sendMessage.bind(f.bot.api);
 t.mock.method(f.bot.api,'sendMessage',async(chat,text,...rest)=>{
  if(text.startsWith('Описание для <code>CUSTOM_API</code>')){entered();await gate;}
  return send(chat,text,...rest);
 });
 await f.callback('settings:env:quick:CUSTOM_API');const held=f.message(SECRET);
 t.after(async()=>{release();await held;});await started;
 let replacement;
 if(action==='cancel')await f.callback('settings:env');
 else if(action==='replace'){await f.callback('settings:env:quick:NEW_API');await f.message('fixture-new-value');replacement=f.messages.length;}
 else await f.bot.stop();
 release();await held;const late=f.messages.length;
 assert.ok(f.deleted.includes(late),'closed form must not leave a newly delivered dead prompt');
 assert.equal((await readEnvMap()).map.has('CUSTOM_API'),false);
 if(action==='replace'){
  assert.equal(f.deleted.includes(replacement),false);await skip(f,replacement);
  assert.equal((await readEnvMap()).map.get('NEW_API'),'fixture-new-value');
 }
});

test('env description: nearest comment attaches only across adjacent comment rows, never blank or malformed lines',async t=>{
 await fixture(t,undefined,{overlay:false});
 await fs.writeFile(envFilePath(),'# attached\nCUSTOM_API=one\n# detached\n\nBLANK=two\n# detached too\nnot-an-assignment\nINVALID=three\n# earlier\n# last\nLAST=four\n# old\n#\nEMPTY=five\n',{mode:0o600});
 assert.equal((await entry()).comment,'attached');assert.equal((await entry('LAST')).comment,'last');
 for(const key of ['BLANK','INVALID','EMPTY'])assert.equal((await entry(key)).comment,undefined);
 await setEnvKey('LAST','fixture-replacement',process.env,{comment:''});
 assert.equal((await entry('LAST')).comment,undefined,'explicit internal empty clears without inheriting an earlier note');
});
