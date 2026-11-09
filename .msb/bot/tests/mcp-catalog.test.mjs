/** Reachable old MCP views through actual Telegram callback routing and owned native config. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mcpFixture} from './helpers/mcp-fixture.mjs';
import {loadState,saveState} from '../src/state.mjs';
const text=f=>f.edits.at(-1)||'';
const buttons=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat()||[];
const labels=f=>buttons(f).map(b=>b.text);
function button(f,name){const hit=buttons(f).find(b=>b.text===name);assert.ok(hit,name);return hit.callback_data;}

const forbidden=/fixture-private|repo-only/;
test('Claude MCP menu counts native user entries and renders old failure statuses without secrets',async t=>{
  const f=await mcpFixture(t),source=await fs.readFile(f.config,'utf8');
  await f.callback('menu:mcp');
  assert.deepEqual(labels(f),['📂 workspace (2)','« Назад']);
  await f.callback(button(f,'📂 workspace (2)'));
  assert.ok(text(f).includes('[x] <b>zulu</b> (stdio) — не запускается'));
  assert.ok(text(f).includes('[x] <b>alpha&lt;&amp;</b> (http) — нужен вход заново'));
  assert.ok(text(f).includes('Состояние на 06:07 UTC'));
  assert.deepEqual(labels(f),['zulu','alpha<&','➕ Добавить','« Назад']);
  assert.doesNotMatch(text(f),forbidden);
  assert.equal(await fs.readFile(f.config,'utf8'),source);
  assert.deepEqual(await f.calls(),[]);
});

test('Claude MCP empty and failed reads remain distinct',async t=>{
  const f=await mcpFixture(t);await fs.unlink(f.config);
  await f.callback('mcp:folder:workspace');assert.ok(text(f).includes('<i>Нет серверов</i>'));
  await fs.writeFile(f.config,'{"fixture-private-json":');
  await f.callback('mcp:folder:workspace');assert.match(text(f),/Не удалось получить список MCP-серверов/);
  assert.doesNotMatch(text(f),forbidden);
});

test('MCP old card opens a stored Claude name and bounds new references',async t=>{
  const f=await mcpFixture(t),long='длинное'.repeat(22);
  await fs.writeFile(f.config,JSON.stringify({mcpServers:{[long]:{command:'node'},legacy:{command:'node'}}}));
  await f.callback('mcp:folder:workspace');
  const data=button(f,long);assert.ok(Buffer.byteLength(data,'utf8')<=64);
  await f.callback(data);assert.ok(text(f).includes('Tools: <code>mcp__'+long+'__*</code>'));
  await f.callback('mcp:server:legacy');assert.ok(text(f).includes('Tools: <code>mcp__legacy__*</code>'));
});

test('Codex MCP reads only its actual user layer, with no auth probe or Claude fallback',async t=>{
  const f=await mcpFixture(t,'codex'),snapshot=(await loadState()).state;
  const config=await fs.readFile(f.native,'utf8'),store=await fs.readFile(f.storeFile,'utf8');
  await f.callback('menu:mcp');assert.deepEqual(labels(f),['📂 workspace (1)','« Назад']);
  await f.callback('mcp:folder:workspace');assert.match(text(f),/\[\+\] <b>native-only<\/b> \(http\)/);
  assert.doesNotMatch(text(f),forbidden);assert.ok(!labels(f).includes('zulu'));
  const q=await f.calls();assert.deepEqual(q.map(row=>row.method),['initialize','initialized','config/read','initialize','initialized','config/read']);
  assert.deepEqual(q[2].params,{includeLayers:true,cwd:f.workspace});
  assert.equal(await fs.readFile(f.native,'utf8'),config);assert.equal(await fs.readFile(f.storeFile,'utf8'),store);
  assert.deepEqual((await loadState()).state,snapshot);
});

for(const mode of ['error','wrong-root'])test('Codex MCP '+mode+' cannot fake an empty or foreign catalog',async t=>{
  const f=await mcpFixture(t,'codex',{mode});await f.callback('menu:mcp');
  assert.equal((await f.calls()).filter(row=>row.method==='config/read').length,1);
  assert.match(text(f),/Не удалось получить список MCP-серверов/);
  assert.doesNotMatch(text(f),forbidden);assert.ok(!labels(f).some(label=>label.includes('workspace')));
});

test('MCP catalog does not launch native code for an unauthorized callback',async t=>{
  const f=await mcpFixture(t,'codex');await f.callback('menu:mcp',43);await f.callback('mcp:folder:workspace',43);
  assert.deepEqual(await f.calls(),[]);assert.equal(f.edits.length,0);
});

test('MCP late config result cannot replace newer navigation',async t=>{
  const f=await mcpFixture(t,'codex',{mode:'hold'});
  try {
    await f.callback('menu:mcp',42,{wait:false});
    const until=Date.now()+1800;
    while(!(await f.calls()).some(row=>row.method==='config/read')) {
      assert.ok(Date.now()<until,'The native config read must start');await new Promise(r=>setTimeout(r,5));
    }
    await f.callback('menu:back');const latest=text(f),edits=f.edits.length;
    await f.release();await Promise.allSettled([...(f.bot[Symbol.for('msb.callbackTasks')]||[])]);
    assert.equal(text(f),latest);assert.equal(f.edits.length,edits);
  }finally{await f.release();}
});

test('MCP card references stay with the original provider and config root',async t=>{
  const f=await mcpFixture(t,'codex');await f.callback('mcp:folder:workspace');const ref=button(f,'native-only');
  const snapshot=(await loadState()).state;await saveState({...snapshot,extAuthBypass:'claude'});
  await fs.writeFile(f.config,JSON.stringify({mcpServers:{'native-only':{command:'node'}}}));
  await f.callback(ref);assert.match(text(f),/MCP-сервер не найден/);
  assert.ok(!text(f).includes('Tools:'));
});

test('OpenClaw MCP uses its own sorted old list with no card buttons and no URL credentials',async t=>{
  const f=await mcpFixture(t,'oc');await f.callback('menu:mcp');
  assert.deepEqual(await f.calls(),[{argv:['mcp','list','--json']}]);
  assert.match(text(f),/Подключено к движку: <b>2<\/b>/);
  assert.ok(text(f).indexOf('<b>alpha</b>')<text(f).indexOf('<b>zulu</b>'));
  assert.ok(text(f).includes('<code>https://fixture.invalid/mcp</code>'));
  assert.ok(text(f).includes('<code>node</code>'));assert.doesNotMatch(text(f),/fixture-private|user:pass|#private/);
  assert.deepEqual(labels(f),['➕ Добавить','« Назад']);
});

test('OpenClaw MCP distinguishes its empty catalog and accepts the old array envelope',async t=>{
  const f=await mcpFixture(t,'oc',{clawServers:{servers:[]}});await f.callback('menu:mcp');
  assert.match(text(f),/На движке сейчас нет настроенных MCP-серверов/);
  assert.deepEqual(labels(f),['➕ Добавить','« Назад']);
});
