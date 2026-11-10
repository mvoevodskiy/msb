/**
 * Old OpenClaw template form through production Telegram ingress.
 * [Source evidence](reference/parity-mcp-contract.txt), [form](../src/telegram/forms/mcp.mjs).
 * Each subprocess uses an owned temporary config and synthetic service key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {mcpFixture} from './helpers/mcp-fixture.mjs';
import {botRoot} from '../src/paths.mjs';
import {loadState,saveState} from '../src/state.mjs';
import {readEnvMap,setEnvKey} from '../src/env/store.mjs';

const original={gateway:{mode:'local',port:19311},mcp:{servers:{control:{command:'test-fixture'}}}};
const supadata='sd_openclaw_synthetic';
const apify='apify_api_openclaw_synthetic';
const buttons=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat() || [];

async function prepare(t,{owned=true,fail=false,foreign=false}={}){
  const f=await mcpFixture(t,'oc');
  const stateDir=owned?path.join(botRoot(),'openclaw'):path.join(f.home,'.openclaw');
  const config=path.join(stateDir,'openclaw.json');
  await fs.mkdir(stateDir,{recursive:true,mode:0o700});
  await fs.writeFile(config,JSON.stringify(original),{mode:0o600});
  process.env.OPENCLAW_CONFIG_PATH=config;
  process.env.OPENCLAW_STATE_DIR=stateDir;
  const other=path.join(f.home,'different-gateway.json');
  if(foreign)await fs.writeFile(other,JSON.stringify(original),{mode:0o600});
  const fixture=JSON.stringify({config,log:path.join(f.home,'mcp-protocol.jsonl'),fail,other:foreign?other:null});
  const source=[
    "import fs from 'node:fs';",
    'const fixture='+fixture+';',
    'const argv=process.argv.slice(2);',
    "fs.appendFileSync(fixture.log,JSON.stringify({argv,config:process.env.OPENCLAW_CONFIG_PATH})+'\\n');",
    "const file=process.env.OPENCLAW_CONFIG_PATH;",
    "const state=JSON.parse(fs.readFileSync(file,'utf8'));",
    "if(argv.join(' ')==='mcp list --json'){console.log(JSON.stringify(state.mcp.servers));process.exit(0);}",
    "if(argv.join(' ')==='config get gateway.mode --json'){console.log(JSON.stringify(state.gateway.mode));process.exit(0);}",
    "if(argv.join(' ')==='gateway call config.get --json'){console.log(JSON.stringify({path:fs.realpathSync(fixture.other || file),config:state}));process.exit(0);}",
    "if(argv.join(' ')==='mcp reload')process.exit(0);",
    "if(fixture.fail){console.error('untrusted service setup diagnostic');process.exit(1);}",
    "let name,entry;",
    "if(argv[0]==='config' && argv[1]==='set' && argv[2]==='--batch-file'){",
    " const [operation]=JSON.parse(fs.readFileSync(argv[3],'utf8'));",
    " name=operation.path.split('.').at(-1); entry=operation.value;",
    "}else if(argv[0]==='config' && argv[1]==='patch' && argv[2]==='--stdin'){",
    " const patch=JSON.parse(fs.readFileSync(0,'utf8')); [name,entry]=Object.entries(patch.mcp.servers)[0];",
    "}else if(argv[0]==='mcp' && argv[1]==='add' && argv.includes('--no-probe')){",
    " name=argv[2]; const headers=Object.fromEntries(argv.flatMap((arg,i)=>arg==='--header'?[argv[i+1].split(/=(.*)/s).slice(0,2)]:[]));",
    " entry={url:argv[argv.indexOf('--url')+1],transport:argv[argv.indexOf('--transport')+1],headers};",
    "}else if(argv.join(' ')==='config file'){console.log(file);process.exit(0);}",
    "if(!name || !entry || Object.hasOwn(state.mcp.servers,name))process.exit(7);",
    "state.mcp.servers[name]=entry;fs.writeFileSync(file,JSON.stringify(state));",
  ].join('\n');
  const bin=path.join(f.home,'.local/bin/openclaw');
  await fs.writeFile(bin,'#!'+process.execPath+'\n'+source,{mode:0o700});
  return {...f,ocConfig:config};
}

async function setup(f,name='Supadata'){
  await f.callback('mcp:add');
  const template=buttons(f).find(button=>button.text===name);
  assert.ok(template,'Expected the old template button');
  await f.callback(template.callback_data);
  assert.match(f.edits.at(-1),name==='Supadata'?/Отправь API ключ.*sd_/:/Отправь API токен.*apify_api_/);
}

for(const [label,name,value,key,header,headerValue,url] of [
  ['Supadata','supadata',supadata,'SUPADATA_API_KEY','x-api-key',supadata,'https://api.supadata.ai/mcp'],
  ['Apify','apify',apify,'APIFY_API_KEY','Authorization','Bearer '+apify,'https://mcp.apify.com'],
]){
  test('OpenClaw form: '+label+' registers the old HTTP template in the owned profile',async t=>{
    const f=await prepare(t);
    await setup(f,label);
    await f.message(value);
    const active=JSON.parse(await fs.readFile(f.ocConfig,'utf8'));
    assert.deepEqual(active.mcp.servers[name],{url,transport:'streamable-http',headers:{[header]:headerValue}});
    assert.deepEqual(active.mcp.servers.control,original.mcp.servers.control);
    assert.deepEqual(active.gateway,original.gateway);
    assert.equal((await readEnvMap()).map.get(key),value);
    assert.match(f.messages.at(-1),/подключён.*Ключ сохранён/);
    assert.ok(f.deleted.includes(99));
    assert.doesNotMatch(JSON.stringify(await f.calls()),new RegExp(value));
    await f.callback('mcp:add');
    assert.ok(!buttons(f).some(button=>button.text===label));
  });
}

test('OpenClaw form: invalid input is consumed once before any key or native write',async t=>{
  const f=await prepare(t);
  await setup(f);
  await f.message('wrong_key');
  assert.match(f.messages.at(-1),/Ключ Supadata должен начинаться/);
  assert.equal((await readEnvMap()).map.has('SUPADATA_API_KEY'),false);
  assert.deepEqual(JSON.parse(await fs.readFile(f.ocConfig,'utf8')),original);
  assert.ok((await f.calls()).every(call=>call.argv?.join(' ')==='mcp list --json'));
});

for(const failure of ['native write rejected','shared profile']){
  test('OpenClaw form: '+failure+' leaves the key only in the current bot and reports no connection',async t=>{
    const f=await prepare(t,{owned:failure!=='shared profile',fail:failure==='native write rejected'});
    await setup(f);
    await f.message(supadata);
    assert.equal((await readEnvMap()).map.get('SUPADATA_API_KEY'),supadata);
    assert.deepEqual(JSON.parse(await fs.readFile(f.ocConfig,'utf8')),original);
    assert.match(f.messages.at(-1),/Ключ.*сохранён.*Быстрые инструменты подключить не удалось/s);
    assert.doesNotMatch(f.messages.at(-1),/уже работает|untrusted service setup diagnostic|sd_openclaw_synthetic/);
    if(failure==='shared profile')assert.ok((await f.calls()).every(call=>call.argv?.join(' ')==='mcp list --json'));
  });
}

test('OpenClaw form: a Claude enrollment keeps the base key when the OC form adds the same service',async t=>{
  const f=await prepare(t);
  const state=(await loadState()).state;
  await saveState({...state,managedMcp:{claude:{supadata:{template:'supadata',key:'SUPADATA_API_KEY'}}}});
  await setEnvKey('SUPADATA_API_KEY','sd_claude_synthetic');
  await setup(f);
  await f.message(supadata);
  const keys=(await readEnvMap()).map;
  assert.equal(keys.get('SUPADATA_API_KEY'),'sd_claude_synthetic');
  assert.equal(keys.get('SUPADATA_API_KEY_OC'),supadata);
  assert.equal(JSON.parse(await fs.readFile(f.ocConfig,'utf8')).mcp.servers.supadata.headers['x-api-key'],supadata);
});

test('OpenClaw form: an active Gateway reporting another physical config cannot be written',async t=>{
  const f=await prepare(t,{foreign:true});
  await setup(f);
  await f.message(supadata);
  assert.equal((await readEnvMap()).map.get('SUPADATA_API_KEY'),supadata);
  assert.deepEqual(JSON.parse(await fs.readFile(f.ocConfig,'utf8')),original);
  assert.ok((await f.calls()).some(call=>call.argv?.join(' ')==='gateway call config.get --json'));
  assert.ok(!(await f.calls()).some(call=>call.argv?.includes('--batch-file')));
  assert.match(f.messages.at(-1),/Быстрые инструменты подключить не удалось/);
});

test('OpenClaw form: retargeting the native path while the form is open keeps both profiles intact',async t=>{
  const f=await prepare(t);
  await setup(f);
  const other=path.join(botRoot(),'different-openclaw');
  await fs.mkdir(other,{mode:0o700});
  process.env.OPENCLAW_STATE_DIR=other;
  process.env.OPENCLAW_CONFIG_PATH=path.join(other,'openclaw.json');
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(original),{mode:0o600});
  await f.message(supadata);
  assert.equal((await readEnvMap()).map.get('SUPADATA_API_KEY'),supadata);
  assert.deepEqual(JSON.parse(await fs.readFile(f.ocConfig,'utf8')),original);
  assert.deepEqual(JSON.parse(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH,'utf8')),original);
  assert.ok(!(await f.calls()).some(call=>call.argv?.includes('--batch-file')));
  assert.match(f.messages.at(-1),/Быстрые инструменты подключить не удалось/);
});

test('OpenClaw form: a second stale prompt cannot replace the registered native entry',async t=>{
  const f=await prepare(t);
  await setup(f);
  await f.message(supadata);
  await f.callback('mcp:setup:supadata');
  await f.message('sd_openclaw_second_synthetic');
  const entry=JSON.parse(await fs.readFile(f.ocConfig,'utf8')).mcp.servers.supadata;
  assert.equal(entry.headers['x-api-key'],supadata);
  assert.equal((await f.calls()).filter(call=>call.argv?.includes('--batch-file')).length,1);
  assert.match(f.messages.at(-1),/Быстрые инструменты подключить не удалось/);
});
