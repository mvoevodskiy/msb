/**
 * Old ADD_MCP through production Telegram, real core and a synthetic CLI.
 * [Contract](reference/parity-mcp-contract.txt), [fixture](helpers/mcp-launch-fixture.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runAgentTurn} from '../src/agent/turn.mjs';
import {loadState,saveState} from '../src/state.mjs';
import {botRoot,statePath} from '../src/paths.mjs';
import {readEnvMap,setEnvKey} from '../src/env/store.mjs';
import {codexManagedMcpName} from '../shared/codex-mcp-name.mjs';
import {mcpFixture} from './helpers/mcp-fixture.mjs';
import {nativeFixtures} from './helpers/mcp-launch-fixture.mjs';

const http={name:' Fixture_MCP ',type:'http ',url:' https://fixture.invalid/mcp?fixture=private-url ',headers:{
  Authorization:'fixture-private-marker-header','X-Another':'fixture-another-header',ignored:17,
}};
const stdio={name:'fixture-stdio',type:'stdio',command:' /fixture/never-run ',args:['--marker=fixture-private-argument',7,'']};
const block=value=>'[ADD_MCP]'+(typeof value==='string'?value:JSON.stringify(value))+'[/ADD_MCP]';
const success=name=>'Подключил MCP-сервер «'+name+'». Заработает со следующего сообщения.';
const invalid='Не понял настройки сервера — нужен адрес https и имя латиницей.';

async function prepare(t,provider,runTurn=runAgentTurn){
  const f=await mcpFixture(t,provider,{runTurn});
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
    const reply=[...f.edits.slice(first),...f.messages.slice(posted)].find(line=>line.includes('fixture-start') || line.includes('fixture-end'));
    if(reply)return reply;
    assert.ok(Date.now()<deadline,'The controlled turn must finish');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}

const buttons=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat() ?? [];
async function launch(native){
  await native.respond('fixture complete');
  const result=await runAgentTurn({prompt:'owned next-turn fixture'});
  assert.equal(result.ok,true,result.text);
  return (await native.trace()).at(-1);
}
async function remove(f,name){
  await f.callback('mcp:folder:workspace');
  const row=buttons(f).find(button=>button.text===name);
  assert.ok(row,name);
  await f.callback(row.callback_data);
  const action=buttons(f).find(button=>button.text==='🗑 Удалить');
  assert.ok(action);
  await f.callback(action.callback_data);
}

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
    const {state}=await loadState();
    const record=state.managedMcp[provider].fixture_mcp;
    const privateFile=path.join(botRoot(),'mcp-config',record.custom+'.json');
    assert.equal((await fs.stat(privateFile)).mode&0o777,0o600);
    assert.doesNotMatch(JSON.stringify(state),/fixture-private-marker-header|private-url/);
    const expected={type:'http',url:http.url.trim(),headers:{Authorization:http.headers.Authorization,'X-Another':http.headers['X-Another']}};
    assert.deepEqual(JSON.parse(await fs.readFile(privateFile,'utf8')),expected);

    const next=await launch(native);
    assert.doesNotMatch(JSON.stringify(next.argv),/fixture-private-marker-header|private-url/);
    if(provider==='claude'){
      assert.equal(next.mode,0o600);
      assert.deepEqual(JSON.parse(next.projection).mcpServers.fixture_mcp,expected);
      assert.ok(next.argv[next.argv.indexOf('--allowedTools')+1].includes('mcp__fixture_mcp'));
      await assert.rejects(fs.stat(next.file),{code:'ENOENT'});
    }else{
      const alias=codexManagedMcpName('fixture_mcp');
      assert.ok(next.profile.includes('[mcp_servers.'+JSON.stringify(alias)+']'));
      assert.ok(next.profile.includes('url = '+JSON.stringify(expected.url)));
      assert.ok(next.profile.includes(JSON.stringify('X-Another')+' = '+JSON.stringify(expected.headers['X-Another'])));
      assert.equal(next.profileMode,0o600);
      assert.equal(next.privateHandoffPresent,false);
      await assert.rejects(fs.lstat(next.profileFile),{code:'ENOENT'});
    }

    await remove(f,'fixture_mcp');
    assert.ok(!buttons(f).some(button=>button.text==='fixture_mcp'));
    await assert.rejects(fs.stat(privateFile),{code:'ENOENT'});
    const after=await launch(native);
    assert.equal(provider==='claude'?after.projection:after.profile,null);
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
  const reply=await ask(f,native,block(http),{error:true,assistant:true});
  assert.ok(reply.includes(success('fixture_mcp')),reply);
  assert.doesNotMatch(reply,/ADD_MCP|fixture-private/);
});

for(const provider of ['claude','codex']){
  test('ADD_MCP: '+provider+' preserves a stdio command and only string arguments on the next launch',async t=>{
    const {f,native}=await prepare(t,provider);
    const reply=await ask(f,native,block(stdio));
    assert.ok(reply.includes(success(stdio.name)));
    const next=await launch(native);
    assert.doesNotMatch(JSON.stringify(next.argv),/fixture-private-argument/);
    const expected={type:'stdio',command:stdio.command.trim(),args:[stdio.args[0],'']};
    if(provider==='claude'){
      assert.deepEqual(JSON.parse(next.projection).mcpServers[stdio.name],expected);
    }else{
      assert.ok(next.profile.includes('command = '+JSON.stringify(expected.command)));
      assert.ok(next.profile.includes('args = ['+expected.args.map(value=>JSON.stringify(value)).join(', ')+']'));
    }
  });
}

test('ADD_MCP: provider switch cannot redirect a completed model registration or its credentials',async t=>{
  const {f,native}=await prepare(t,'codex',async options=>{
    const result=await runAgentTurn(options);
    const {state}=await loadState();
    await saveState({...state,extAuthBypass:undefined,ccSessionId:undefined});
    return result;
  });
  assert.ok((await ask(f,native,block(http))).includes(success('fixture_mcp')));
  const {state}=await loadState();
  assert.equal(state.extAuthBypass,undefined);
  assert.ok(state.managedMcp.codex.fixture_mcp);
  assert.equal(state.managedMcp.claude,undefined);
  assert.equal((await launch(native)).projection,null);
  await saveState({...state,extAuthBypass:'codex'});
  assert.ok((await launch(native)).profile.includes(http.headers.Authorization));
});

test('ADD_MCP: an identically named registration in a second bot has its own credential and deletion',async t=>{
  const {f,native}=await prepare(t,'codex');
  assert.ok((await ask(f,native,block(http))).includes(success('fixture_mcp')));
  const state=(await loadState()).state;
  const prior=process.env.MSB_BOT_ID;
  const shared=await fs.readFile(f.native);
  process.env.MSB_BOT_ID='other';
  try{
    await saveState({engine:'cc',extAuthBypass:'codex'});
    assert.equal((await launch(native)).profile,null);
    const other={...http,headers:{Authorization:'fixture-other-profile-header'}};
    assert.ok((await ask(f,native,block(other))).includes(success('fixture_mcp')));
    const launched=await launch(native);
    assert.ok(launched.profile.includes(other.headers.Authorization));
    assert.ok(!launched.profile.includes(http.headers.Authorization));
    assert.notEqual((await loadState()).state.managedMcp.codex.fixture_mcp.custom,state.managedMcp.codex.fixture_mcp.custom);
    await remove(f,'fixture_mcp');
    assert.equal((await launch(native)).profile,null);
  }finally{process.env.MSB_BOT_ID=prior;}
  assert.ok((await launch(native)).profile.includes(http.headers.Authorization));
  assert.deepEqual(await fs.readFile(f.native),shared);
});

test('ADD_MCP: replaces one bot-owned template of the same name and preserves its service key',async t=>{
  const {f,native}=await prepare(t,'claude');
  const {state}=await loadState();
  await saveState({...state,managedMcp:{claude:{supadata:{template:'supadata',key:'SUPADATA_API_KEY'}}}});
  await setEnvKey('SUPADATA_API_KEY','sd_fixture_old_template');
  assert.ok((await ask(f,native,block({...http,name:'Supadata'}))).includes(success('supadata')));
  const previous=(await loadState()).state.managedMcp.claude.supadata;
  const previousFile=path.join(botRoot(),'mcp-config',previous.custom+'.json');
  assert.ok((await ask(f,native,block({...stdio,name:'Supadata'}))).includes(success('supadata')));
  const second=(await loadState()).state.managedMcp.claude.supadata;
  assert.notEqual(second.custom,previous.custom);
  await assert.rejects(fs.stat(previousFile),{code:'ENOENT'});
  assert.equal(JSON.parse((await launch(native)).projection).mcpServers.supadata.type,'stdio');
  await remove(f,'supadata');
  assert.equal((await loadState()).state.managedMcp,undefined);
  assert.equal((await readEnvMap()).map.get('SUPADATA_API_KEY'),'sd_fixture_old_template');
});

test('ADD_MCP: a storage failure reports the old error and publishes no registration',async t=>{
  const {f,native}=await prepare(t,'codex');
  await fs.writeFile(path.join(botRoot(),'mcp-config'),'owned blocking fixture');
  const reply=await ask(f,native,block(http));
  assert.match(reply,/Не получилось подключить сервер — попробуй ещё раз\./);
  assert.doesNotMatch(reply,/fixture-private|Подключил MCP|ADD_MCP/);
  assert.equal((await loadState()).state.managedMcp,undefined);
});

test('ADD_MCP: /stop after receiving model output prevents the registration and its success message',async t=>{
  let release,arrived;
  const done=new Promise(resolve=>{arrived=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const {f,native}=await prepare(t,'claude',async options=>{
    const result=await runAgentTurn(options);
    arrived();
    await gate;
    return result;
  });
  await native.respond(block(http));
  try{
    await f.message('owned cancellation fixture');
    await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(Error('Model result missing')),3500).unref())]);
    await f.message('/stop');
  }finally{release();}
  await f.bot.stop();
  assert.ok(f.edits.includes('Моя остановочка ✋🏽⛔️'));
  assert.ok(![...f.edits,...f.messages].some(text=>text.includes('Подключил MCP')));
  assert.equal((await loadState()).state.managedMcp,undefined);
});

test('ADD_MCP: a Codex transport error cannot register a server from its error message',async t=>{
  const {f,native}=await prepare(t,'codex');
  const reply=await ask(f,native,'not an installation',{error:'fixture-error-start\n'+block(stdio)+'\nfixture-end'});
  assert.doesNotMatch(reply,/Подключил MCP|ADD_MCP|fixture-private-argument/);
  assert.equal((await loadState()).state.managedMcp,undefined);
});

test('ADD_MCP: /stop while the new registry bytes are staged prevents publishing the entry',async t=>{
  const {f,native}=await prepare(t,'claude');
  await native.respond(block(http));
  let staged,release;
  const ready=new Promise(resolve=>{staged=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const write=fs.writeFile;
  fs.writeFile=async (file,body,opts)=>{
    await write(file,body,opts);
    if(file===statePath()+'.tmp.'+process.pid && JSON.parse(body).managedMcp?.claude?.fixture_mcp){
      staged();
      await gate;
    }
  };
  try{
    await f.message('owned registry cancellation fixture');
    await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Registry staging missing')),3500).unref())]);
    await f.message('/stop');
  }finally{
    fs.writeFile=write;
    release();
  }
  await f.bot.stop();
  assert.ok(f.edits.includes('Моя остановочка ✋🏽⛔️'));
  assert.equal((await loadState()).state.managedMcp,undefined);
  assert.deepEqual(await fs.readdir(path.join(botRoot(),'mcp-config')),[]);
});

test('ADD_MCP: a pre-existing native Codex alias cannot produce a false registration success',async t=>{
  const {f,native}=await prepare(t,'codex');
  await fs.writeFile(native.collision,codexManagedMcpName('fixture_mcp'));
  const reply=await ask(f,native,block(http));
  assert.match(reply,/Не получилось подключить сервер/);
  assert.doesNotMatch(reply,/Подключил MCP|ADD_MCP|fixture-private/);
  assert.equal((await loadState()).state.managedMcp,undefined);
});

test('ADD_MCP: a Claude replacement stays active, and Delete hides its inherited name for this bot',async t=>{
  const {f,native}=await prepare(t,'claude');
  const original=await fs.readFile(f.config);
  assert.ok((await ask(f,native,block({...http,name:'zulu'}))).includes(success('zulu')));
  await f.callback('mcp:folder:workspace');
  assert.match(f.edits.at(-1),/\[\+\] <b>zulu<\/b> \(http\)/);
  assert.equal(JSON.parse((await launch(native)).projection).mcpServers.zulu.type,'http');
  await remove(f,'zulu');
  assert.ok(!buttons(f).some(button=>button.text==='zulu'));
  const after=await launch(native);
  assert.ok(after.argv.includes(JSON.stringify({deniedMcpServers:[{serverName:'zulu'}]})));
  const prior=process.env.MSB_BOT_ID;
  process.env.MSB_BOT_ID='other';
  try{
    await saveState({engine:'cc'});
    await f.callback('mcp:folder:workspace');
    assert.ok(buttons(f).some(button=>button.text==='zulu'));
    assert.ok(!(await launch(native)).argv.includes('--settings'));
  }finally{process.env.MSB_BOT_ID=prior;}
  assert.deepEqual(await fs.readFile(f.config),original);
});

test('ADD_MCP: closing-tag text inside a JSON string stays inside the private payload',async t=>{
  const {f,native}=await prepare(t,'claude');
  const custom={...http,headers:{Authorization:'Bearer [/ADD_MCP] fixture-secret-after-quoted-tag'}};
  const reply=await ask(f,native,block(custom));
  assert.ok(reply.includes(success('fixture_mcp')));
  assert.doesNotMatch(reply,/ADD_MCP|fixture-secret-after-quoted-tag/);
  const next=await launch(native);
  assert.equal(JSON.parse(next.projection).mcpServers.fixture_mcp.headers.Authorization,custom.headers.Authorization);
});

test('ADD_MCP: an unfinished JSON payload cannot reach Telegram or the diary',async t=>{
  const {f,native}=await prepare(t,'codex');
  const reply=await ask(f,native,'[ADD_MCP]{"name":"fixture_mcp","headers":{"Authorization":"fixture-secret-incomplete');
  assert.match(reply,/Не понял настройки сервера/);
  assert.doesNotMatch(reply,/ADD_MCP|fixture-secret-incomplete/);
  await f.bot.stop();
  const diary=await fs.readFile(path.join(botRoot(),'chat-diary.jsonl'),'utf8');
  assert.doesNotMatch(diary,/ADD_MCP|fixture-secret-incomplete/);
  assert.equal((await loadState()).state.managedMcp,undefined);
});

test('ADD_MCP: an ordinary Codex user name is replaced and removed for this bot while its sibling retains it',async t=>{
  const {f,native}=await prepare(t,'codex');
  await fs.writeFile(native.collision,'fixture_mcp');
  const original=await fs.readFile(f.native);
  const mask='mcp_servers={"fixture_mcp"={enabled=false}}';
  assert.ok((await ask(f,native,block(http))).includes(success('fixture_mcp')));
  await f.callback('mcp:folder:workspace');
  assert.deepEqual(buttons(f).filter(row=>row.text.startsWith('fixture_mcp')).map(row=>row.text),['fixture_mcp']);
  const replaced=await launch(native);
  assert.ok(replaced.argv.includes(mask));
  assert.ok(replaced.profile.includes(http.headers.Authorization));
  await remove(f,'fixture_mcp');
  assert.ok(!buttons(f).some(row=>row.text.startsWith('fixture_mcp')));
  const after=await launch(native);
  assert.ok(after.argv.includes(mask));
  assert.equal(after.profile,null);
  const prior=process.env.MSB_BOT_ID;
  process.env.MSB_BOT_ID='other';
  try{
    await saveState({engine:'cc',extAuthBypass:'codex'});
    await f.callback('mcp:folder:workspace');
    assert.ok(buttons(f).some(row=>row.text==='fixture_mcp'));
    assert.ok(!(await launch(native)).argv.includes(mask));
  }finally{process.env.MSB_BOT_ID=prior;}
  assert.deepEqual(await fs.readFile(f.native),original);
});

for(const provider of ['claude','codex']){
  test('ADD_MCP: '+provider+' cannot change a native profile retargeted after the turn',async t=>{
    let link,second;
    const {f,native}=await prepare(t,provider,async options=>{
      const result=await runAgentTurn(options);
      await fs.unlink(link);
      await fs.symlink(second,link);
      return result;
    });
    link=provider==='claude'?f.config:f.native;
    const first=link+'.first';
    second=link+'.second';
    const original=await fs.readFile(link);
    await fs.rename(link,first);
    await fs.writeFile(second,original);
    await fs.symlink(first,link);
    if(provider==='codex')await fs.writeFile(native.collision,'fixture_mcp');
    const reply=await ask(f,native,block({...http,name:provider==='claude'?'zulu':'fixture_mcp'}));
    assert.match(reply,/Не получилось подключить сервер/);
    assert.doesNotMatch(reply,/Подключил MCP|fixture-private|ADD_MCP/);
    const {state}=await loadState();
    assert.equal(state.managedMcp,undefined);
    assert.equal(state.removedNativeMcp,undefined);
    assert.deepEqual(await fs.readFile(first),original);
    assert.deepEqual(await fs.readFile(second),original);
  });
}

test('ADD_MCP: profile retargeted while staging the private file leaves no registration',async t=>{
  const {f,native}=await prepare(t,'claude');
  const first=f.config+'.first',second=f.config+'.second';
  const original=await fs.readFile(f.config);
  await fs.rename(f.config,first);
  await fs.writeFile(second,original);
  await fs.symlink(first,f.config);
  const directory=path.join(botRoot(),'mcp-config');
  const write=fs.writeFile;
  let changed=false;
  fs.writeFile=async (file,body,opts)=>{
    await write(file,body,opts);
    if(!changed && typeof file==='string' && path.dirname(file)===directory){
      changed=true;
      await fs.unlink(f.config);
      await fs.symlink(second,f.config);
    }
  };
  let reply;
  try{reply=await ask(f,native,block({...http,name:'zulu'}));}
  finally{fs.writeFile=write;}
  assert.ok(changed);
  assert.match(reply,/Не получилось подключить сервер/);
  const {state}=await loadState();
  assert.equal(state.managedMcp,undefined);
  assert.equal(state.removedNativeMcp,undefined);
  assert.deepEqual(await fs.readdir(directory),[]);
  assert.deepEqual(await fs.readFile(first),original);
  assert.deepEqual(await fs.readFile(second),original);
});
