/**
 * Old ADD_MCP through production Telegram, real core and a synthetic CLI.
 * [Contract](reference/parity-mcp-contract.txt), [fixture](helpers/mcp-launch-fixture.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runAgentTurn} from '../src/agent/turn.mjs';
import {mcpFixture} from './helpers/mcp-fixture.mjs';
import {nativeFixtures} from './helpers/mcp-launch-fixture.mjs';

const http={name:' Fixture_MCP ',type:'http ',url:' https://fixture.invalid/mcp?fixture=private-url ',headers:{
  Authorization:'fixture-private-marker-header','X-Another':'fixture-another-header',ignored:17,
}};
const stdio={name:'fixture-stdio',type:'stdio',command:' /fixture/never-run ',args:['--marker=fixture-private-argument',7,'']};
const block=value=>'[ADD_MCP]'+(typeof value==='string'?value:JSON.stringify(value))+'[/ADD_MCP]';
const success=name=>'Подключил MCP-сервер «'+name+'». Заработает со следующего сообщения.';
const invalid='Не понял настройки сервера — нужен адрес https и имя латиницей.';

async function prepare(t,provider){
  const f=await mcpFixture(t,provider,{runTurn:runAgentTurn});
  const native=await nativeFixtures(f);
  delete process.env.SKILL_INSTALL_ENABLED;
  return {f,native};
}

async function ask(f,native,text,opts){
  await native.respond('fixture-start\n'+text+'\nfixture-end',opts);
  const first=f.edits.length,posted=f.messages.length;
  await f.message('owned fixture asks to connect a server');
  const deadline=Date.now()+5000;
  for(;;){
    const reply=[...f.edits.slice(first),...f.messages.slice(posted)].find(line=>line.includes('fixture-end'));
    if(reply)return reply;
    assert.ok(Date.now()<deadline,'The controlled turn must finish');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}

const buttons=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat() ?? [];

for(const provider of ['claude','codex']){
  test('ADD_MCP: '+provider+' actual turn advertises both old transport schemas',async t=>{
    const {f,native}=await prepare(t,provider);
    await ask(f,native,'ordinary response');
    const call=(await native.trace()).at(-1);
    const prompt=provider==='claude'?call.argv[call.argv.indexOf('--append-system-prompt')+1]:call.prompt;
    assert.match(prompt,/\[ADD_MCP\].*"type":"http"/);
    assert.match(prompt,/"type":"stdio".*"args"/);
    assert.match(prompt,/Успех словами НЕ обещай до результата/);
  });

  test('ADD_MCP: '+provider+' connects the first definition and redraws the existing catalog without secrets',async t=>{
    const {f,native}=await prepare(t,provider);
    const nativeFile=provider==='claude'?f.config:f.native,original=await fs.readFile(nativeFile);
    const reply=await ask(f,native,block(http)+'\n'+block(stdio));
    assert.ok(reply.includes(success('fixture_mcp')),reply);
    assert.doesNotMatch(reply,/ADD_MCP|fixture-private-marker-header|private-url|fixture-private-argument/);
    await f.callback('mcp:folder:workspace');
    assert.ok(buttons(f).some(row=>row.text==='fixture_mcp'));
    assert.ok(!buttons(f).some(row=>row.text===stdio.name));
    assert.deepEqual(await fs.readFile(nativeFile),original);
  });
}

test('ADD_MCP: valid stdio is installed, and the existing plan renderer runs afterwards',async t=>{
  const {f,native}=await prepare(t,'claude');
  const reply=await ask(f,native,block(stdio)+'\n[КНОПКИ: plan]');
  assert.ok(reply.includes(success(stdio.name)),reply);
  assert.doesNotMatch(reply,/fixture-private-argument|ADD_MCP/);
  assert.equal(f.messageOptions.at(-1).reply_markup.inline_keyboard[0][0].callback_data,'plan:approve');
  await f.bot.stop();
  const diary=await fs.readFile(path.join(process.env.MSB_RUNTIME_ROOT,'bots/default/chat-diary.jsonl'),'utf8');
  assert.doesNotMatch(diary,/fixture-private-argument|ADD_MCP/);
  assert.ok(diary.includes('Подключил MCP-сервер'));
});

for(const [name,value] of [
  ['malformed JSON','{broken'],
  ['non-HTTPS',{...http,url:'http://fixture.invalid'}],
  ['one-character name',{...http,name:'a'}],
]){
  test('ADD_MCP: '+name+' gives the original error and cannot fall through to a later valid definition',async t=>{
    const {f,native}=await prepare(t,'claude');
    const reply=await ask(f,native,block(value)+'\n'+block(http));
    assert.ok(reply.includes(invalid),reply);
    assert.doesNotMatch(reply,/ADD_MCP|Подключил MCP|fixture-private/);
    await f.callback('mcp:folder:workspace');
    assert.ok(!buttons(f).some(row=>row.text==='fixture_mcp'));
  });
}

test('ADD_MCP: the shared disabled flag strips complete blocks without recording a server',async t=>{
  const {f,native}=await prepare(t,'codex');
  process.env.SKILL_INSTALL_ENABLED='0';
  const reply=await ask(f,native,block(http)+'\n'+block(stdio));
  assert.doesNotMatch(reply,/ADD_MCP|Подключил MCP|fixture-private/);
  await f.callback('mcp:folder:workspace');
  assert.ok(!buttons(f).some(row=>row.text==='fixture_mcp'));
});

test('ADD_MCP: returned partial Claude error text is processed like the old finalizer',async t=>{
  const {f,native}=await prepare(t,'claude');
  const reply=await ask(f,native,block(http),{error:true});
  assert.ok(reply.includes(success('fixture_mcp')),reply);
  assert.doesNotMatch(reply,/ADD_MCP|fixture-private/);
});
