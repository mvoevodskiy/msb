/** Old long env deletion references through production handlers and a 64-byte transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './helpers/menu-fixture.mjs';
import {envFilePath,setEnvKey,readEnvMap} from '../src/env/store.mjs';
import {envScreen,envDeleteScreen} from '../src/telegram/screens.mjs';
import {loadState} from '../src/state.mjs';
const LONG='LONG_KEY_'+'A'.repeat(31);
const callback=(view,text)=>view.keyboard.inline_keyboard.flat().find(b=>b.text===text)?.callback_data;
function limitTransport(t,f){
 for(const [method,index] of [['sendMessage',2],['editMessageText',3]]){
  const send=f.bot.api[method].bind(f.bot.api);
  t.mock.method(f.bot.api,method,async(...args)=>{
   for(const row of args[index]?.reply_markup?.inline_keyboard||[])for(const b of row){
    if(b.callback_data&&Buffer.byteLength(b.callback_data)>64)throw Error('400 BUTTON_DATA_INVALID');
   }
   return send(...args);
  });
 }
}
const rendered=f=>({text:f.edits.at(-1),keyboard:{inline_keyboard:f.editOptions.at(-1).reply_markup?.inline_keyboard||[]}});

for(const overlay of [false,true])for(const runtimeProfile of ['msb','jar1'])test(`long env callback: 40-char create/decline/confirm, ${runtimeProfile}, overlay=${overlay}`,async t=>{
 let runs=0;const f=await fixture(t,async()=>{runs++;return{ok:true,text:'unexpected'};},{overlay,runtimeProfile});limitTransport(t,f);
 const before=(await loadState()).state,providers=await fs.readFile(f.storeFile,'utf8');
 await setEnvKey('KEEP','fixture-keep');
 await f.callback('settings:env:add');await f.message(LONG);await f.message('fixture-only-long-value');
 await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});
 const saved=await fs.readFile(envFilePath(),'utf8');await f.callback('settings:env');
 const open=callback(rendered(f),'🗑 '+LONG);assert.ok(open);assert.ok(Buffer.byteLength(open)<=64);
 await f.callback(open);assert.match(f.edits.at(-1),new RegExp(LONG));
 const yes=callback(rendered(f),'🗑 Да, удалить');assert.ok(yes);assert.ok(Buffer.byteLength(yes)<=64);
 await f.callback(callback(rendered(f),'« Нет'));assert.equal(await fs.readFile(envFilePath(),'utf8'),saved);
 await f.callback(open);await f.callback(callback(rendered(f),'🗑 Да, удалить'));
 assert.equal((await readEnvMap()).map.has(LONG),false);assert.equal((await readEnvMap()).map.get('KEEP'),'fixture-keep');
 assert.equal(runs,0);assert.deepEqual((await loadState()).state,before);assert.equal(await fs.readFile(f.storeFile,'utf8'),providers);
});

test('long env callback: pre-upgrade raw opening and literal short routes remain compatible',async t=>{
 const f=await fixture(t,undefined,{overlay:false});limitTransport(t,f);
 await setEnvKey('CUSTOM_API','fixture-value');
 assert.equal(callback(await envScreen(),'🗑 CUSTOM_API'),'settings:env:delete:CUSTOM_API');
 assert.equal(callback(envDeleteScreen('CUSTOM_API'),'🗑 Да, удалить'),'settings:env:confirm-delete:CUSTOM_API');
 await setEnvKey(LONG,'fixture-long',{...process.env});
 await f.callback('settings:env:delete:'+LONG);
 assert.ok(Buffer.byteLength(callback(rendered(f),'🗑 Да, удалить'))<=64);
 await f.callback(callback(rendered(f),'🗑 Да, удалить'));
 assert.equal((await readEnvMap()).map.has(LONG),false);assert.equal((await readEnvMap()).map.has('CUSTOM_API'),true);
});

test('long env callback: serialized confirmation resolves the same key in a fresh process',async t=>{
 const f=await fixture(t,undefined,{overlay:false});
 await setEnvKey(LONG,'fixture-long',process.env,{comment:'fixture metadata'});await setEnvKey('KEEP','fixture-keep');
 const confirm=callback(envDeleteScreen(LONG,'fixture metadata'),'🗑 Да, удалить');
 assert.ok(Buffer.byteLength(confirm)<=64);
 const route=fileURLToPath(new URL('../src/telegram/routes/settings.mjs',import.meta.url));
 const code=`import {handleSettingsRoute} from ${JSON.stringify(new URL('file://'+route).href)};
 await handleSettingsRoute({data:process.argv[1],state:{},pending:new Map(),chatId:42,bot:{api:{sendMessage:async()=>{}}},show:async view=>{for(const row of view.keyboard.inline_keyboard)for(const b of row)if(b.callback_data&&Buffer.byteLength(b.callback_data)>64)throw Error('400 BUTTON_DATA_INVALID');}});
 console.log('fresh-process-confirmed');`;
 const child=cp.spawnSync(process.execPath,['--input-type=module','-e',code,confirm],{env:{HOME:f.home,MSB_BOT_ID:'default',MSB_RUNTIME_PROFILE:'msb',PATH:path.dirname(process.execPath)},encoding:'utf8',timeout:5000});
 assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/fresh-process-confirmed/);
 assert.equal((await readEnvMap()).map.has(LONG),false);assert.equal((await readEnvMap()).map.get('KEEP'),'fixture-keep');
});

for(const key of ['EXISTING_'+'X'.repeat(191),'И'.repeat(25)])test('long env callback: existing key fits UTF8 transport without truncating data, '+key.length+' chars',async t=>{
 const f=await fixture(t,undefined,{overlay:false});limitTransport(t,f);
 await fs.writeFile(envFilePath(),`${key}=fixture-existing\nKEEP=fixture-keep\n`,{mode:0o600});
 await f.callback('settings:env');const open=callback(rendered(f),'🗑 '+key);assert.ok(open);await f.callback(open);
 assert.ok(f.edits.at(-1).includes(key));await f.callback(callback(rendered(f),'🗑 Да, удалить'));
 assert.equal((await readEnvMap()).map.has(key),false);assert.equal((await readEnvMap()).map.get('KEEP'),'fixture-keep');
});

test('long env callback: stale, malformed and foreign references cannot mutate another key',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await setEnvKey('KEEP','fixture-keep');
 const file=envFilePath(),raw=await fs.readFile(file,'utf8'),stat=await fs.stat(file,{bigint:true});
 for(const ref of ['k~'+'0'.repeat(32),'k~malformed','k~'+'A'.repeat(32)]){
  await f.callback('settings:env:delete:'+ref);await f.callback('settings:env:confirm-delete:'+ref);
 }
 assert.equal(await fs.readFile(file,'utf8'),raw);
 assert.equal((await fs.stat(file,{bigint:true})).ino,stat.ino,'unknown reference must not enter the env writer');
});

test('long env callback: unauthorized callback and protected key retain their guards',async t=>{
 const f=await fixture(t);await setEnvKey(LONG,'fixture-value');await setEnvKey('BOT_TOKEN','12345:'+'F'.repeat(30),process.env,{internal:true});
 const file=envFilePath(),before=await fs.readFile(file,'utf8');
 const yes=callback(envDeleteScreen(LONG),'🗑 Да, удалить');await f.callback(yes,43);
 await f.callback('settings:env:confirm-delete:BOT_TOKEN');
 assert.equal(await fs.readFile(file,'utf8'),before);assert.equal((await readEnvMap()).map.has(LONG),true);
});

test('long env callback: an obsolete reference does not redraw a newer active input as a list',async t=>{
 const f=await fixture(t);await f.callback('settings:env:quick:ACTIVE_INPUT');await f.message('fixture-active-value');
 const before=f.edits.length;
 for(const action of ['delete','confirm-delete'])await f.callback(`settings:env:${action}:k~${'0'.repeat(32)}`);
 assert.equal(f.edits.length,before,'a stale action must not disguise an active draft with an env-list redraw');
 await f.message('fixture active description');
 assert.equal((await readEnvMap()).map.get('ACTIVE_INPUT'),'fixture-active-value');
});
