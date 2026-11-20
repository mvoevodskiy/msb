/**
 * Old MCP Add/form/card/delete through production Telegram ingress and owned bot data.
 * [Catalog fixture](helpers/mcp-fixture.mjs), [old source contract](reference/parity-mcp-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {mcpFixture} from './helpers/mcp-fixture.mjs';
import {codexManagedMcpName} from '../shared/codex-mcp-name.mjs';
import {envFilePath,readEnvMap} from '../src/env/store.mjs';
import {msbRoot} from '../src/paths.mjs';
import {loadState,saveState} from '../src/state.mjs';

const key='apify_api_fixture_bot_a';
const text=f=>f.edits.at(-1)||'';
const buttons=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat()||[];
const labels=f=>buttons(f).map(item=>item.text);

function callbackFor(f,label) {
  const button=buttons(f).find(item=>item.text===label);
  assert.ok(button,label);
  return button.callback_data;
}

async function addApify(f,token=key) {
  await f.callback('mcp:setup:apify');
  assert.match(text(f),/Отправь API токен \(начинается с <code>apify_api_<\/code>/);
  await f.message(token);
}

test('MCP Add shows only absent templates and the old Claude workspace Back',async t=>{
  const f=await mcpFixture(t);
  await fs.writeFile(f.config,JSON.stringify({mcpServers:{supadata:{url:'https://fixture.invalid/mcp'}}}));
  await f.callback('mcp:add');
  assert.match(text(f),/Добавить MCP сервер/);
  assert.match(text(f),/Шаблоны:/);
  assert.match(text(f),/подключи MCP сервер \[название\]/);
  assert.deepEqual(labels(f),['Apify','« Назад']);
  assert.equal(callbackFor(f,'« Назад'),'mcp:folder:workspace');
  assert.equal(f.editOptions.at(-1).link_preview_options?.is_disabled,true);
});

test('OpenClaw MCP Add uses its own registry and the old engine-list Back',async t=>{
  const f=await mcpFixture(t,'oc',{clawServers:{mcp:{servers:{supadata:{command:'fixture'},apify:{command:'fixture'}}}}});
  await f.callback('mcp:add');
  assert.deepEqual(await f.calls(),[{argv:['mcp','list','--json']}]);
  assert.match(text(f),/Шаблоны уже подключены/);
  assert.deepEqual(labels(f),['« Назад']);
  assert.equal(callbackFor(f,'« Назад'),'menu:mcp');
});

test('Codex Apify form writes only the current bot key and exposes the saved entry',async t=>{
  const f=await mcpFixture(t,'codex');
  const globalFile=path.join(msbRoot(),'.env');
  const siblingFile=envFilePath({...process.env,MSB_BOT_ID:'sibling'});
  const globalSource='APIFY_API_KEY=apify_api_fixture_global\n';
  const siblingSource='APIFY_API_KEY=apify_api_fixture_sibling\n';
  await fs.mkdir(path.dirname(siblingFile),{recursive:true});
  await fs.writeFile(globalFile,globalSource);
  await fs.writeFile(siblingFile,siblingSource);
  const before=await fs.readFile(f.native,'utf8');
  await addApify(f);
  assert.equal((await readEnvMap()).map.get('APIFY_API_KEY'),key);
  assert.ok(f.deleted.includes(99),'Delete the accepted key message');
  assert.match(f.messages.at(-1),/apify<\/b> подключён/);
  assert.ok(!f.messages.some(message=>message.includes(key)));
  await f.callback('mcp:folder:workspace');
  assert.ok(labels(f).includes('apify'));
  assert.equal(await fs.readFile(f.native,'utf8'),before);
  assert.equal(await fs.readFile(globalFile,'utf8'),globalSource);
  assert.equal(await fs.readFile(siblingFile,'utf8'),siblingSource);
});

test('Claude Supadata form shows the old prefix and accepts a key without changing native config',async t=>{
  const f=await mcpFixture(t);
  const before=await fs.readFile(f.config,'utf8');
  await f.callback('mcp:setup:supadata');
  assert.match(text(f),/Отправь API ключ \(начинается с <code>sd_<\/code>/);
  assert.match(text(f),/https:\/\/dash.supadata.ai/);
  await f.message('  sd_fixture_claude  ');
  assert.ok(f.deleted.includes(99));
  assert.equal((await readEnvMap()).map.get('SUPADATA_API_KEY'),'sd_fixture_claude');
  assert.equal(await fs.readFile(f.config,'utf8'),before);
  await f.callback('mcp:folder:workspace');
  assert.ok(labels(f).includes('supadata'));
});

test('MCP form consumes invalid prefix and whitespace once without writing a key',async t=>{
  const f=await mcpFixture(t);
  await f.callback('mcp:setup:apify');
  await f.message('wrong-prefix');
  assert.match(f.messages.at(-1),/Токен Apify должен начинаться с <code>apify_api_<\/code>/);
  await f.callback('mcp:setup:supadata');
  await f.message('sd_fixture broken');
  assert.match(f.messages.at(-1),/Ключ не должен содержать пробелов или переносов/);
  assert.ok(!(await readEnvMap()).map.has('APIFY_API_KEY'));
  assert.ok(!(await readEnvMap()).map.has('SUPADATA_API_KEY'));
  assert.deepEqual(f.deleted,[]);
});

test('MCP form never writes to a new engine after a switch in another owner chat',async t=>{
  const f=await mcpFixture(t,'codex');
  process.env.CLAUDE_CODE_OAUTH_TOKEN='fixture-claude-token';
  await f.callback('mcp:setup:apify');
  await f.callback('ext:conn:set:claude',42,{chatId:190});
  assert.ok(!(await loadState()).state.extAuthBypass);
  await f.message(key);
  assert.match(f.messages.at(-1),/Движок изменился/);
  assert.ok(f.deleted.includes(99));
  assert.ok(!(await readEnvMap()).map.has('APIFY_API_KEY'));
  await f.callback('mcp:folder:workspace');
  assert.ok(!labels(f).includes('apify'));
});

test('MCP delete clears only the bot registration and keeps the saved service key',async t=>{
  const f=await mcpFixture(t,'codex');
  const before=await fs.readFile(f.native,'utf8');
  await addApify(f);
  await f.callback('mcp:folder:workspace');
  await f.callback(callbackFor(f,'apify'));
  assert.ok(text(f).includes('mcp__'+codexManagedMcpName('apify')+'__*'));
  const action=callbackFor(f,'🗑 Удалить');
  assert.ok(Buffer.byteLength(action,'utf8')<=64);
  await f.callback(action);
  assert.ok(!labels(f).includes('apify'));
  assert.ok(labels(f).includes('native-only'));
  assert.equal((await readEnvMap()).map.get('APIFY_API_KEY'),key);
  assert.equal(await fs.readFile(f.native,'utf8'),before);
});

test('MCP registrations and keys are independent for two bot IDs sharing one native home',async t=>{
  const f=await mcpFixture(t,'codex');
  const primary=process.env.MSB_BOT_ID;
  const baseState=(await loadState()).state;
  const native=await fs.readFile(f.native,'utf8');
  await addApify(f);
  process.env.MSB_BOT_ID='other';
  try {
    await saveState(baseState);
    await f.callback('mcp:folder:workspace');
    assert.ok(!labels(f).includes('apify'));
    const other='apify_api_fixture_bot_b';
    await addApify(f,other);
    assert.equal((await readEnvMap()).map.get('APIFY_API_KEY'),other);
    await f.callback('mcp:folder:workspace');
    await f.callback(callbackFor(f,'apify'));
    await f.callback(callbackFor(f,'🗑 Удалить'));
    assert.ok(!labels(f).includes('apify'));
    assert.equal((await readEnvMap()).map.get('APIFY_API_KEY'),other);
  }finally{process.env.MSB_BOT_ID=primary;}
  assert.equal((await readEnvMap()).map.get('APIFY_API_KEY'),key);
  await f.callback('mcp:folder:workspace');
  assert.ok(labels(f).includes('apify'));
  assert.equal(await fs.readFile(f.native,'utf8'),native);
});

test('MCP setup from an unauthorized sender never arms or writes the form',async t=>{
  const f=await mcpFixture(t);
  await f.callback('mcp:setup:apify',43);
  await f.message(key,43);
  assert.deepEqual(f.edits,[]);
  assert.ok(!(await readEnvMap()).map.has('APIFY_API_KEY'));
});
