/**
 * Old named ACP turns through the real core. The owned acpx fixture emits
 * documented JSON frames without starting a Gateway or using a real account.
 * [Old windows](reference/parity-openclaw-turn-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {mcpFixture} from './helpers/mcp-fixture.mjs';
import {until} from './helpers/reminder-registration-fixture.mjs';
import {runAgentTurn} from '../src/agent/turn.mjs';
import {loadState,saveState} from '../src/state.mjs';
import {resetCliConversation} from '../src/sessions/selection.mjs';
import {actionRoot,botRoot} from '../src/paths.mjs';
import {reminderRunPath} from '../src/autonomy/reminder-runs.mjs';

const ccSessionId='untouched-claude-session';
const seen=(kind,rows)=>rows.find(row=>row.kind===kind);
const fixtureSessionId='fixture-acp-session';

async function prepare(t,{state={},behavior='ok',reply='OpenClaw fixture reply',runTurn}={}){
  const f=await mcpFixture(t,'oc',{runTurn});
  await saveState({engine:'oc',ccSessionId,...state});
  for(const key of ['CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','IIA_ANTHROPIC_API_KEY','MSB_ANTHROPIC_API_KEY'])delete process.env[key];
  process.env.BOT_TOKEN='fixture-telegram-secret';
  const script=path.join(f.home,'.local/bin/acpx'),log=path.join(f.home,'acpx.jsonl'),release=path.join(f.home,'release-acpx');
  const config=JSON.stringify({behavior,reply,log,release,fixtureSessionId});
  const lines=[
    "import fs from 'node:fs';",
    'const c='+config+';',
    'const argv=process.argv.slice(2);',
    'const command=argv.slice(argv.includes("--agent")?argv.indexOf("--agent")+2:argv.indexOf("openclaw")+1);',
    'const kind=command[0];',
    'const file=argv.includes("--file")?argv[argv.indexOf("--file")+1]:null;',
    'const record={kind,argv,cwd:process.cwd(),prompt:file?fs.readFileSync(file,"utf8"):null,promptMode:file?fs.statSync(file).mode&0o777:null,',
    '  hasTelegramSecret:Boolean(process.env.BOT_TOKEN)};',
    'fs.appendFileSync(c.log,JSON.stringify(record)+"\\n");',
    'const emit=value=>console.log(JSON.stringify(value));',
    'if(kind==="sessions" && (command[1]==="new" || command[1]==="ensure")){emit({action:"new",acpxSessionId:c.fixtureSessionId});process.exit(0);}',
    'if(kind==="cancel"){emit({action:"cancel"});process.exit(0);}',
    'if(kind!=="prompt")process.exit(8);',
    'const emitUpdate=update=>emit({method:"session/update",params:{sessionId:"fixture-gateway-frame",update}});',
    'if(c.behavior==="stale" && command[2]==="fixture-stale"){emit({id:2,error:{message:"fixture missing session",data:{acpxCode:"NO_SESSION"}}});process.exit(4);}',
    'if(c.behavior==="hold")while(!fs.existsSync(c.release))await new Promise(resolve=>setTimeout(resolve,15));',
    'emitUpdate({sessionUpdate:"agent_thought_chunk",content:{type:"text",text:"hidden reasoning"}});',
    'emitUpdate({sessionUpdate:"tool_call",kind:"mcp__supadata__probe",toolCallId:"fixture-tool"});',
    'emitUpdate({sessionUpdate:"agent_message_chunk",content:{type:"text",text:c.reply}});',
    'emitUpdate({sessionUpdate:"usage_update",used:150,size:200});',
    'if(c.behavior==="partial"){emit({id:2,error:{message:"private diagnostic",data:{acpxCode:"RUNTIME"}}});process.exit(1);}',
    'emit({id:2,result:{stopReason:"end_turn"}});',
  ].join('\n');
  await fs.writeFile(script,'#!'+process.execPath+'\n'+lines,{mode:0o700});
  async function calls(){
    try{return(await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
    catch(error){if(error.code==='ENOENT')return [];throw error;}
  }
  async function waitForPrompt(){
    const until=Date.now()+2400;
    while(Date.now()<until){
      const row=seen('prompt',await calls());
      if(row)return row;
      await delay(10);
    }
    throw Error('The real turn must start acpx');
  }
  return {...f,calls,waitForPrompt,release:()=>fs.writeFile(release,'released')};
}

test('OpenClaw ordinary turn uses old named ACP without Claude credentials and keeps the other engine session',async t=>{
  const f=await prepare(t);
  await fs.writeFile(path.join(f.workspace,'AGENTS.md'),'untouched fixture instructions');
  const events=[];
  const result=await runAgentTurn({prompt:'Owned OC user input',onStatus:event=>events.push(event)});
  assert.equal(result.ok,true,result.text);
  assert.equal(result.text,'OpenClaw fixture reply');
  const calls=await f.calls(),create=seen('sessions',calls),prompt=seen('prompt',calls);
  assert.ok(create && prompt);
  const name=create.argv[create.argv.indexOf('--name')+1];
  assert.ok(name.startsWith('oc-'));
  assert.deepEqual(prompt.argv.slice(0,6),['--format','json','--json-strict','--cwd',f.workspace,'openclaw']);
  assert.equal(await fs.realpath(prompt.cwd),await fs.realpath(f.workspace));
  assert.equal(prompt.argv[prompt.argv.indexOf('-s')+1],name);
  assert.ok(prompt.prompt.includes('Owned OC user input'));
  assert.ok(prompt.prompt.includes('[INSTALL_SKILL]'));
  assert.doesNotMatch(prompt.prompt,/\[ADD_MCP\]/);
  assert.equal(prompt.promptMode,0o600);
  assert.ok(!calls.some(row=>row.hasTelegramSecret));
  assert.equal(await fs.readFile(path.join(f.workspace,'AGENTS.md'),'utf8'),'untouched fixture instructions');
  await assert.rejects(fs.access(prompt.argv.at(-1)),{code:'ENOENT'});
  assert.ok(events.some(event=>event.kind==='tool' && event.name==='mcp__supadata__probe'));
  assert.ok(events.some(event=>event.kind==='thinking'));
  const {state}=await loadState();
  assert.equal(state.ocSessionName,name);
  assert.equal(state.ocSessionId,fixtureSessionId);
  assert.equal(state.ccSessionId,ccSessionId);
});

test('OpenClaw migrates a pre-existing legacy ID through the old named-session resume flag',async t=>{
  const f=await prepare(t,{state:{ocSessionId:'fixture-legacy'}});
  const result=await runAgentTurn({prompt:'Owned migration fixture'});
  assert.equal(result.ok,true,result.text);
  const create=seen('sessions',await f.calls());
  assert.equal(create.argv[create.argv.indexOf('--resume-session')+1],'fixture-legacy');
});

test('OpenClaw recreates a missing named session once before any work from the old prompt',async t=>{
  const f=await prepare(t,{state:{ocSessionId:'fixture-old-id',ocSessionName:'fixture-stale'},behavior:'stale'});
  const result=await runAgentTurn({prompt:'Owned stale fixture'});
  assert.equal(result.ok,true,result.text);
  const calls=await f.calls(),prompts=calls.filter(row=>row.kind==='prompt');
  assert.equal(prompts.length,2);
  assert.equal(prompts[0].argv[prompts[0].argv.indexOf('-s')+1],'fixture-stale');
  assert.notEqual((await loadState()).state.ocSessionName,'fixture-stale');
});

test('OpenClaw nonterminal partial output remains an error and does not publish a new active session',async t=>{
  const f=await prepare(t,{behavior:'partial'});
  const result=await runAgentTurn({prompt:'Owned partial fixture'});
  assert.equal(result.ok,false);
  assert.match(result.text,/OpenClaw fixture reply/);
  assert.doesNotMatch(result.text,/private diagnostic/);
  assert.equal((await loadState()).state.ocSessionName,undefined);
  assert.equal((await f.calls()).filter(row=>row.kind==='prompt').length,1);
});

test('OpenClaw reset clears only its active session and rejects a late reply from the preceding turn',async t=>{
  const f=await prepare(t,{state:{ocSessionId:fixtureSessionId,ocSessionName:'fixture-existing'},behavior:'hold'});
  const run=runAgentTurn({prompt:'Owned late reply'});
  try{await f.waitForPrompt();await resetCliConversation();}finally{await f.release();}
  const result=await run;
  assert.equal(result.ok,true,result.text);
  const {state}=await loadState();
  assert.equal(state.ocSessionId,undefined);
  assert.equal(state.ocSessionName,undefined);
  assert.deepEqual(state.ocPrevSessionIds,[fixtureSessionId]);
  assert.equal(state.ccSessionId,ccSessionId);
});

test('OpenClaw cancellation targets exactly the current named session',async t=>{
  const f=await prepare(t,{state:{ocSessionId:fixtureSessionId,ocSessionName:'fixture-cancel-me'},behavior:'hold'});
  const controller=new AbortController();
  const run=runAgentTurn({prompt:'Owned cancellation fixture',signal:controller.signal});
  try{await f.waitForPrompt();}finally{controller.abort();}
  const result=await run;
  assert.equal(result.error,'aborted');
  const cancel=seen('cancel',await f.calls());
  assert.ok(cancel);
  assert.deepEqual(cancel.argv.slice(-3),['cancel','-s','fixture-cancel-me']);
  assert.equal((await loadState()).state.ocSessionName,'fixture-cancel-me');
});

async function nativePath(directory){
  const file=path.join(directory,'openclaw.json');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  await fs.writeFile(file,'{"gateway":{"mode":"local"}}',{mode:0o600});
  process.env.OPENCLAW_STATE_DIR=directory;
  process.env.OPENCLAW_CONFIG_PATH=file;
  return file;
}

test('OpenClaw rejects an explicit foreign profile instead of using the legacy agent fallback',async t=>{
  const f=await prepare(t);
  await nativePath(path.join(f.home,'neighbor-openclaw'));
  const result=await runAgentTurn({prompt:'This fixture must never reach another Gateway.'});
  assert.equal(result.ok,false);
  assert.deepEqual(await f.calls(),[]);
});

test('OpenClaw changes both the acpx scope and active named session after switching owned profiles',async t=>{
  const f=await prepare(t);
  await nativePath(path.join(botRoot(),'native one'));
  assert.equal((await runAgentTurn({prompt:'First Gateway.'})).ok,true);
  const first=(await loadState()).state;
  await nativePath(path.join(botRoot(),'native two'));
  assert.equal((await runAgentTurn({prompt:'Second Gateway.'})).ok,true);
  const calls=await f.calls(),prompts=calls.filter(row=>row.kind==='prompt');
  const [a,b]=prompts.map(row=>row.argv[row.argv.indexOf('--agent')+1]);
  assert.notEqual(a,b,'The acpx queue key must include the selected native profile');
  const state=(await loadState()).state;
  assert.notEqual(state.ocSessionName,first.ocSessionName);
  assert.ok(state.ocPrevSessionIds.includes(first.ocSessionId));
  assert.ok(!calls.some(row=>row.argv.includes('--resume-session')));
});

test('OpenClaw retains the explicit conventional native profile under its own HOME',async t=>{
  const f=await prepare(t);
  process.env.OPENCLAW_PROFILE='native';
  await nativePath(path.join(f.home,'.openclaw-native'));
  const result=await runAgentTurn({prompt:'Conventional legacy profile fixture.'});
  assert.equal(result.ok,true,result.text);
  assert.ok(seen('prompt',await f.calls()).argv.includes('openclaw'));
});

test('legacy automatic turn still uses the named native OpenClaw session', async t => {
  const f = await prepare(t);
  const result = await runAgentTurn({ prompt: 'Owned scheduled OC input', isAutoTurn: true });
  assert.equal(result.ok, true, result.text);
  const prompt = seen('prompt', await f.calls());
  assert.ok(prompt.prompt.includes('Owned scheduled OC input'));
  assert.equal((await loadState()).state.ocSessionId, fixtureSessionId);
});

test('Telegram queues ordinary OpenClaw text without a Claude login',async t=>{
  const f=await prepare(t,{runTurn:runAgentTurn});
  await f.message('Проверь обычный ход');
  assert.doesNotMatch(f.messages.join('\n'),/Сначала подключи AI/);
  assert.match((await f.waitForPrompt()).prompt,/Проверь обычный ход/);
  await until(()=>f.edits.some(text=>text.includes('OpenClaw fixture reply') && text.includes('⏱')),
    'OpenClaw reply did not reach Telegram');
  assert.equal((await loadState()).state.ccSessionId,ccSessionId);
});

test('Telegram retains the local text setup gate for unauthenticated Claude',async t=>{
  const f=await prepare(t,{runTurn:runAgentTurn,state:{engine:'cc',authMode:'subscription'}});
  await f.message('Проверь обычный ход');
  assert.match(f.messages.at(-1),/Сначала подключи AI/);
  assert.deepEqual(await f.calls(),[]);
});

test('OpenClaw owner Telegram turn exposes the old journal read without local scheduling authority',async t=>{
  const f=await prepare(t,{runTurn:runAgentTurn,reply:'[TASK_RUNS]\n[SET_LIMIT max_actions 7]'});
  process.env.AUTONOMY_ENABLED='1';
  delete process.env.AUTONOMY_MAX_ACTIONS;
  const journal=reminderRunPath();
  await fs.mkdir(path.dirname(journal),{recursive:true});
  const line=JSON.stringify({ts:new Date(Date.now()-60_000).toISOString(),actionId:'oc-journal',name:'Прогон этого бота',status:'ok'})+'\n';
  await fs.writeFile(journal,line);
  await f.message('Покажи историю прогонов');
  await until(()=>f.edits.some(text=>text.includes('⏱')),'OpenClaw fixture did not finish',10_000);
  const prompt=seen('prompt',await f.calls()).prompt;
  assert.match(prompt,/\[TASK_RUNS\].*\[TASK_RUNS:/s);
  assert.doesNotMatch(prompt,/\[SCHEDULE_TASK\]|\[SET_LIMIT/);
  assert.ok(f.edits.some(text=>text.includes('Прогон этого бота — 1 прогон')));
  assert.equal(process.env.AUTONOMY_MAX_ACTIONS,undefined);
  assert.equal(await fs.readFile(journal,'utf8'),line);
});

test('OpenClaw can clean requested historical local rows while retaining its native jobs',async t=>{
  const f=await prepare(t,{runTurn:runAgentTurn,reply:'[CANCEL_SPENT]'});
  process.env.AUTONOMY_ENABLED='1';
  const ts='2026-11-07T09:00:00.000Z';
  const local={id:'local',name:'Старый локальный',enabled:true,trigger:{kind:'once',at:ts},
    task:{kind:'reminder',text:'local fixture'},lastRunAt:ts,runner:'cc'};
  const native={...local,id:'mapped',name:'Нативный OpenClaw',runner:'oc'};
  const auto={...local,id:'auto',name:'Неизвестный старый маршрут',runner:'auto'};
  const file=path.join(actionRoot(),'actions.json');
  const mapFile=path.join(actionRoot(),'autonomy','cron-jobs.json');
  const map='{"mapped":{"jobId":"not-owned-proof","enabled":true}}';
  await fs.mkdir(path.dirname(mapFile),{recursive:true});
  await fs.writeFile(file,JSON.stringify([local,native,auto]));
  await fs.writeFile(mapFile,map);
  await f.message('Убери завершённые разовые задачи');
  await until(()=>f.edits.some(text=>text.includes('⏱')),'OpenClaw fixture did not finish',10_000);
  const prompt=seen('prompt',await f.calls()).prompt;
  assert.match(prompt,/\[CANCEL_SPENT\] отдельной строкой/);
  assert.doesNotMatch(prompt,/\[SCHEDULE_TASK\]|\[SET_LIMIT/);
  assert.match(f.edits.at(-1),/Снёс 1[\s\S]*Не удалось снять: Нативный OpenClaw, Неизвестный старый маршрут/);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),[native,auto]);
  assert.equal(await fs.readFile(mapFile,'utf8'),map);
  assert.deepEqual((await f.calls()).map(row=>row.kind),['sessions','prompt']);
});
