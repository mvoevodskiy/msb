/**
 * The old Delete card, applied to one bot's native server view and real turn path.
 * [Reference](reference/parity-mcp-contract.txt), [launcher fixture](helpers/mcp-launch-fixture.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {mcpFixture} from './helpers/mcp-fixture.mjs';
import {apifyA,supadata,nativeFixtures} from './helpers/mcp-launch-fixture.mjs';
import {runAgentTurn} from '../src/agent/turn.mjs';
import {runClaudeTurn} from '../src/agent/claude.mjs';
import {prepareMcpLaunch} from '../src/mcp/launch.mjs';
import {compactSession} from '../src/agent/compact.mjs';
import {compactCodex} from '../../../overlay/bot/ext/compact-codex.mjs';
import {prepareCodexMcp} from '../../../overlay/bot/ext/codex-mcp-launch.mjs';
import {codexNativeRemoval} from '../shared/mcp-native-scope.mjs';
import {loadState,saveState} from '../src/state.mjs';
import {readEnvMap,setEnvKey} from '../src/env/store.mjs';
import {codexManagedMcpName} from '../shared/codex-mcp-name.mjs';

const names=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat().map(row=>row.text) || [];
function button(f,label){
  const row=f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat().find(row=>row.text===label);
  assert.ok(row,label);
  return row.callback_data;
}
async function removal(f,label){
  await f.callback('mcp:folder:workspace');
  await f.callback(button(f,label));
  return button(f,'🗑 Удалить');
}
async function turn(native){
  const result=await runAgentTurn({prompt:'owned native removal fixture'});
  assert.equal(result.ok,true,result.text);
  return (await native.trace()).at(-1).argv;
}
function claudeDenied(argv){
  const index=argv.indexOf('--settings');
  return index<0?[]:JSON.parse(argv[index+1]).deniedMcpServers.map(row=>row.serverName);
}
function claudeAllowed(argv){
  return argv[argv.indexOf('--allowedTools')+1].split(',');
}
const codexMask=name=>'mcp_servers={'+JSON.stringify(name)+'={enabled=false}}';

test('native Claude removal affects only the chosen bot and preserves the shared file and key',async t=>{
  const f=await mcpFixture(t,'claude'),native=await nativeFixtures(f);
  const primary=process.env.MSB_BOT_ID,base=(await loadState()).state;
  const source=await fs.readFile(f.config,'utf8');
  await setEnvKey('SUPADATA_API_KEY',supadata);
  const action=await removal(f,'zulu');
  await f.callback(action);
  assert.ok(!names(f).includes('zulu') && names(f).includes('alpha<&'));
  const argv=await turn(native);
  assert.deepEqual(claudeDenied(argv),['zulu']);
  assert.ok(!claudeAllowed(argv).includes('mcp__zulu'));
  process.env.MSB_BOT_ID='other';
  try{
    await saveState(base);
    await f.callback(action);
    await f.callback('mcp:folder:workspace');
    assert.ok(names(f).includes('zulu'),'Another bot must reject the first bot’s deletion link');
    const other=await turn(native);
    assert.deepEqual(claudeDenied(other),[]);
    assert.ok(claudeAllowed(other).includes('mcp__zulu'));
  }finally{process.env.MSB_BOT_ID=primary;}
  assert.equal(await fs.readFile(f.config,'utf8'),source);
  assert.equal((await readEnvMap()).map.get('SUPADATA_API_KEY'),supadata);
});

test('an old native Claude delete link cannot follow a retargeted profile symlink',async t=>{
  const f=await mcpFixture(t,'claude'),native=await nativeFixtures(f);
  const a=f.config+'.a',b=f.config+'.b';
  const content=await fs.readFile(f.config,'utf8');
  await fs.rename(f.config,a);
  await fs.writeFile(b,content);
  await fs.symlink(a,f.config);
  const fromA=await removal(f,'zulu');
  await f.callback(fromA);
  assert.ok(!names(f).includes('zulu'));
  await fs.unlink(f.config);
  await fs.symlink(b,f.config);
  await f.callback(fromA);
  await f.callback('mcp:folder:workspace');
  assert.ok(names(f).includes('zulu'));
  assert.deepEqual(claudeDenied(await turn(native)),[]);
  const fromB=await removal(f,'zulu');
  assert.notEqual(fromA,fromB);
  await f.callback(fromB);
  assert.ok(!names(f).includes('zulu'));
  assert.equal(await fs.readFile(a,'utf8'),content);
  assert.equal(await fs.readFile(b,'utf8'),content);
});

test('Claude can re-add a removed native template without reviving other removed entries',async t=>{
  const f=await mcpFixture(t,'claude'),native=await nativeFixtures(f);
  const config=JSON.parse(await fs.readFile(f.config,'utf8'));
  config.mcpServers.supadata={url:'https://native.invalid/supadata'};
  const source=JSON.stringify(config);
  await fs.writeFile(f.config,source);
  await f.callback(await removal(f,'zulu'));
  await f.callback(await removal(f,'supadata'));
  await f.callback('mcp:add');
  await f.callback(button(f,'Supadata'));
  await f.message(supadata);
  assert.match(f.messages.at(-1),/подключён/);
  const argv=await turn(native);
  assert.ok(argv.includes('--mcp-config'));
  assert.deepEqual(claudeDenied(argv),['zulu']);
  assert.ok(claudeAllowed(argv).includes('mcp__supadata'));
  await f.callback(await removal(f,'supadata'));
  assert.ok(!names(f).includes('supadata'));
  assert.deepEqual(claudeDenied(await turn(native)).sort(),['supadata','zulu']);
  assert.equal(await fs.readFile(f.config,'utf8'),source);
});

test('Codex removes the inherited key from one launch and re-adds the template under its own key',async t=>{
  const f=await mcpFixture(t,'codex'),native=await nativeFixtures(f);
  const primary=process.env.MSB_BOT_ID,base=(await loadState()).state;
  const source=await fs.readFile(f.native,'utf8');
  await fs.writeFile(native.collision,'apify');
  await f.callback(await removal(f,'apify'));
  assert.ok(!names(f).includes('apify'));
  assert.ok((await turn(native)).includes(codexMask('apify')));
  process.env.MSB_BOT_ID='other';
  try{
    await saveState(base);
    await f.callback('mcp:folder:workspace');
    assert.ok(names(f).includes('apify'));
    assert.ok(!(await turn(native)).includes(codexMask('apify')));
  }finally{process.env.MSB_BOT_ID=primary;}
  await f.callback('mcp:add');
  await f.callback(button(f,'Apify'));
  await f.message(apifyA);
  assert.match(f.messages.at(-1),/подключён/);
  const argv=await turn(native);
  assert.ok(argv.includes(codexMask('apify')));
  assert.ok(argv.some(arg=>arg.startsWith('mcp_servers.'+codexManagedMcpName('apify')+'=')));
  await fs.unlink(native.collision);
  assert.ok(!(await turn(native)).includes(codexMask('apify')),'Do not override an absent native entry');
  assert.equal(await fs.readFile(f.native,'utf8'),source);
});

test('Codex cannot start an unfiltered turn when a recorded native removal cannot be checked',async t=>{
  const f=await mcpFixture(t,'codex'),native=await nativeFixtures(f);
  await fs.writeFile(native.collision,'native-shared');
  await f.callback(await removal(f,'native-shared'));
  await fs.writeFile(native.readError,'fixture read must fail');
  const result=await runAgentTurn({prompt:'owned unverified removal fixture'});
  assert.equal(result.ok,false);
  assert.match(result.text,/MCP/);
  const {state}=await loadState();
  const compact=await compactSession({...state,ccSessionId:'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53'},
    {compactProvider:compactCodex});
  assert.equal(compact.ok,false);
  assert.match(compact.error,/MCP/);
  assert.ok(!(await native.trace()).some(row=>row.kind==='codex-exec' || row.kind==='codex-compact'));
});


test('Claude compact keeps the native MCP removal active',async t=>{
  const f=await mcpFixture(t,'claude'),native=await nativeFixtures(f);
  await f.callback(await removal(f,'zulu'));
  const {state}=await loadState();
  const result=await compactSession({...state,ccSessionId:'fixture-claude-session'});
  assert.equal(result.ok,true,result.error);
  const {argv}=(await native.trace()).at(-1);
  assert.deepEqual(claudeDenied(argv),['zulu']);
  assert.ok(!claudeAllowed(argv).includes('mcp__zulu'));
});

test('Codex compact uses the same native MCP removal before resuming the thread',async t=>{
  const f=await mcpFixture(t,'codex'),native=await nativeFixtures(f);
  await fs.writeFile(native.collision,'native-shared');
  await f.callback(await removal(f,'native-shared'));
  await turn(native);
  const {state}=await loadState();
  const result=await compactSession(state,{compactProvider:compactCodex});
  assert.deepEqual(result,{ok:true});
  const {argv,kind}=(await native.trace()).at(-1);
  assert.equal(kind,'codex-compact');
  assert.ok(argv.includes(codexMask('native-shared')));
  assert.equal(argv.at(-1),'app-server');
});

test('a Codex catalog reply cannot grant deletion after the file symlink moves during the read',async t=>{
  const f=await mcpFixture(t,'codex',{mode:'hold'});
  const a=f.native+'.a',b=f.native+'.b';
  await fs.rename(f.native,a);
  await fs.writeFile(b,'# another owned native profile\n');
  await fs.symlink(a,f.native);
  await f.callback('mcp:folder:workspace',42,{wait:false});
  try{
    const deadline=Date.now()+3000;
    while(!(await f.calls()).some(row=>row.method==='config/read')){
      assert.ok(Date.now()<deadline,'The old profile read must start');
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    await fs.unlink(f.native);
    await fs.symlink(b,f.native);
  }finally{await f.release();}
  await Promise.allSettled([...(f.bot[Symbol.for('msb.callbackTasks')] || [])]);
  assert.match(f.edits.at(-1),/Не удалось получить список MCP-серверов/);
  assert.ok(!names(f).includes('native-only'));
});


test('a Codex launch cannot drop the new profile’s removal after the captured config moves',async t=>{
  const f=await mcpFixture(t,'codex'),native=await nativeFixtures(f);
  await fs.writeFile(native.collision,'native-shared');
  const a=f.native+'.a',b=f.native+'.b';
  await fs.rename(f.native,a);
  await fs.writeFile(b,'# another owned native profile\n');
  async function pointTo(file){
    await fs.unlink(f.native).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await fs.symlink(file,f.native);
  }
  await pointTo(a);
  await f.callback(await removal(f,'native-shared'));
  await pointTo(b);
  await f.callback(await removal(f,'native-shared'));
  await pointTo(a);
  const {state}=await loadState();
  const captured=await codexNativeRemoval(state,f.workspace,process.env);
  assert.equal(captured.scope,await fs.realpath(a));
  await pointTo(b);
  const prepare=removal=>prepareCodexMcp(path.join(f.home,'.local/bin/codex'),f.workspace,{
    ...process.env,MSB_TURN_MCP_REMOVE:JSON.stringify(removal),
  });
  const prepared=await prepare(captured);
  assert.equal(prepared.blocked,true,'Do not start the other profile unfiltered');
  assert.deepEqual(prepared.args,[]);

  const scopeB=await fs.realpath(b);
  const onlyB={...state,removedNativeMcp:{codex:{[scopeB]:['native-shared']}}};
  await pointTo(a);
  const capturedWithoutNames=await codexNativeRemoval(onlyB,f.workspace,process.env);
  assert.deepEqual(capturedWithoutNames,{scope:captured.scope,names:[]});
  await pointTo(b);
  assert.equal((await prepare(capturedWithoutNames)).blocked,true);
  const fresh=await codexNativeRemoval(onlyB,f.workspace,process.env);
  assert.ok((await prepare(fresh)).args.includes(codexMask('native-shared')));
});

test('Claude cannot start a different native profile after preparing the turn',async t=>{
  const f=await mcpFixture(t,'claude'),native=await nativeFixtures(f);
  const a=f.config+'.a',b=f.config+'.b';
  const content=await fs.readFile(f.config,'utf8');
  await fs.rename(f.config,a);
  await fs.writeFile(b,content);
  await fs.symlink(b,f.config);
  await f.callback(await removal(f,'zulu'));
  const {state}=await loadState();
  await fs.unlink(f.config);
  await fs.symlink(a,f.config);
  const mcp=await prepareMcpLaunch(state,'claude',process.env,f.workspace);
  await fs.unlink(f.config);
  await fs.symlink(b,f.config);
  await assert.rejects(runClaudeTurn({prompt:'owned scope fixture',providerId:'claude',cwd:f.workspace,mcp}),/Профиль Claude изменился/);
  assert.deepEqual(await native.trace(),[]);
  assert.deepEqual(claudeDenied(await turn(native)),['zulu']);
});
