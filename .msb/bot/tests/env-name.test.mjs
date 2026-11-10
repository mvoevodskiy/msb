/** Old name-stage normalization and bounds; real form/store/runner, synthetic data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixture} from './helpers/menu-fixture.mjs';
import {readEnvMap,envFilePath,setEnvKey} from '../src/env/store.mjs';
import {loadState} from '../src/state.mjs';
import {agentOptionsReport} from './helpers/agent-options.mjs';
const MIN='Имя переменной должно быть минимум 2 символа (A-Z, 0-9, _). Попробуйте снова:';
const MAX='Имя слишком длинное (максимум 40 символов). Попробуй короче:';
const finish=async(f)=>{await f.message('fixture-name-value');await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});};

for(const [input,key] of [['_a','_A'],['1a','1A'],['a-b','AB'],[' a pi key ','APIKEY'],['a'.repeat(40),'A'.repeat(40)],['a-'.repeat(40),'A'.repeat(40)]]){
 test('env name: old normalized '+JSON.stringify(input)+' reaches the same store key',async t=>{
  const f=await fixture(t),state=(await loadState()).state,providers=await fs.readFile(f.storeFile,'utf8');
  await f.callback('settings:env:add');await f.message(input);
  assert.equal(f.messages.at(-1),`Ок. Пришли значение для <code>${key}</code>.`);
  await finish(f);assert.equal((await readEnvMap()).map.get(key),'fixture-name-value');assert.equal(process.env[key],'fixture-name-value');
  assert.deepEqual((await loadState()).state,state);assert.equal(await fs.readFile(f.storeFile,'utf8'),providers);
  assert.deepEqual(f.restartRequests,[]);
 });
}
for(const [input,notice] of [['A',MIN],['!!!',MIN],[' ',MIN],['A'.repeat(41),MAX]]){
 test('env name: '+JSON.stringify(input)+' retains name input for a valid retry',async t=>{
  const f=await fixture(t,undefined,{overlay:false});await f.callback('settings:env:add');await f.message(input);
  assert.equal(f.messages.at(-1),notice);assert.equal((await readEnvMap()).map.size,0);
  await f.message('VALID_RETRY');await finish(f);assert.equal((await readEnvMap()).map.get('VALID_RETRY'),'fixture-name-value');
  assert.equal((await readEnvMap()).map.size,1);
 });
}

test('env name: normalization cannot bypass protected-name refusal',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await f.callback('settings:env:add');
 await f.message(' claude_code_ oauth_ token ');
 assert.equal(f.messages.at(-1),'⛔ <code>CLAUDE_CODE_OAUTH_TOKEN</code> — системный ключ.\n\nДля смены ключа Claude: /settings → 🔌 Подключение.');
 assert.equal((await readEnvMap()).map.size,0);assert.deepEqual(f.restartRequests,[]);
});

test('env name: invalid-name retries retain the original ten-minute deadline',async t=>{
 let clock=1_000_000;const f=await fixture(t,undefined,{overlay:false,now:()=>clock});
 await f.callback('settings:env:add');clock+=590_000;await f.message('A');assert.equal(f.messages.at(-1),MIN);
 clock+=10_001;await f.message('VALID_BUT_LATE');assert.ok(f.messages.at(-1).startsWith('⏳ Время на ввод переменной истекло'));
 assert.equal((await readEnvMap()).map.size,0);
});

test('env name: direct store accepts old _/digit names, keeps legacy lengths and rejects injection characters',async t=>{
 await fixture(t,undefined,{overlay:false});
 for(const key of ['_A','1A','EXISTING_'+'X'.repeat(191)])await setEnvKey(key,'fixture-direct');
 const file=envFilePath(),before=await fs.readFile(file,'utf8');
 for(const key of ['', 'A=B','A\nB','A\0B','A-B','lowercase','A B'])await assert.rejects(setEnvKey(key,'fixture-invalid'));
 assert.equal(await fs.readFile(file,'utf8'),before);
});

for(const provider of ['claude','codex'])for(const key of ['_A','1A'])test(`env name: ${key} reaches the production ${provider} CLI environment`,()=>{
 const report=agentOptionsReport(provider,'auto','opus','high','2.1.316',false,key);
 assert.deepEqual(report.calls[0].namedEnv,{name:key,valuePresent:true});
 assert.equal(report.calls[0].provider,provider);
});
