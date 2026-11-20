// Production runAgentTurn → runClaudeTurn argv/prompt, fake child and isolated HOME.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import {parseClaudeArgv,buildPrompt} from '../../../../overlay/bot/ext/adapters/parse-args.mjs';
const [provider, mode, model = 'opus', effort = 'high', cliVersion = '2.1.154', envDescription, envName, envScenario] = process.argv.slice(2);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-agent-options-'));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: home, MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: home,
  MSB_SESSION_DIR: path.join(home, 'sessions'), PATH: path.dirname(process.execPath), CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only' });
const { fixtureClaudeVersion } = await import('../helpers/claude-version-fixture.mjs');
await fixtureClaudeVersion(home, cliVersion);
const calls = [];
let project = null, stateBefore = null;
cp.spawn = (command, args, options) => {
  if (command !== 'claude' || options.env.HOME !== home) throw Error('Unexpected CLI');
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => true;
  const call = { args, provider: options.env.MSB_TURN_PROVIDER, cwd: options.cwd, prompt: '' };
  if (envName) call.namedEnv = {name:envName,valuePresent:options.env[envName] === 'fixture-env-name-value'};
  calls.push(call);
  child.stdin.on('data', value => { call.prompt += value; });
  child.stdin.on('finish', () => queueMicrotask(async () => {
    if (envScenario) {
      const parsed=parseClaudeArgv(args);
      call.systemPromptViaFile=Boolean(parsed.appendSystemPromptFile);
      call.nativePrompt=provider==='claude'
        ? parsed.appendSystemPrompt || await fs.readFile(parsed.appendSystemPromptFile,'utf8')
        : await buildPrompt(parsed,call.prompt,{providerId:provider});
      call.inheritedServiceEnvNonempty={deepgram:Boolean(options.env.DEEPGRAM_API_KEY),openrouter:Boolean(options.env.OPENROUTER_API_KEY)};
    }
    if(envScenario==='skills-race') {
      const {loadState,saveState}=await import('../../src/state.mjs');
      await saveState({...((await loadState()).state),extAuthBypass:provider==='codex'?'claude':'codex'});
    }
    const id = provider === 'claude' ? 'claude-options-fixture' : 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
    child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model, provider_id: provider }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: id, result: 'fixture options answer', is_error: false }) + '\n');
    child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
  }));
  return child;
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw Error('External network forbidden'); };
try {
  const { saveState, loadState } = await import('../../src/state.mjs');
  const { runAgentTurn } = await import('../../src/agent/turn.mjs');
  await saveState({ engine: 'cc', ccModel: model, ccEffort: effort, permissionMode: mode,
    authMode: 'subscription', hasSubscriptionAuth: true, ...(provider === 'claude' ? {} : { extAuthBypass: provider }) });
  if (envDescription === 'env-description') {
    const { setEnvKey } = await import('../../src/env/store.mjs');
    await setEnvKey('FIXTURE_CUSTOM_API', 'fixture-env-description-value-79f1', process.env, {comment:'fixture custom description'});
  }
  if (envName) {
    const {setEnvKey} = await import('../../src/env/store.mjs');
    await setEnvKey(envName,'fixture-env-name-value');
  }
  if (envScenario?.startsWith('env-services-')) {
    const {setEnvKey}=await import('../../src/env/store.mjs');
    process.env.DEEPGRAM_API_KEY='fixture-service-stt-value';
    process.env.OPENROUTER_API_KEY='fixture-service-router-value';
    await setEnvKey('FIXTURE_CUSTOM_API','fixture-service-custom-value',process.env,{comment:'fixture custom description'});
    await setEnvKey('GEMINI_API_KEY','fixture-service-file-only-value',{HOME:home,MSB_BOT_ID:'default'});
    if (envScenario==='env-services-file')await fs.writeFile(path.join(home,'SOUL.md'),'fixture large system context '.repeat(2500));
    if (envScenario==='env-services-unknown' || envScenario==='env-services-unknown-bot') {
      delete process.env.DEEPGRAM_API_KEY;
      const read=fs.readFile.bind(fs);
      fs.readFile=async(file,...args)=>{
        if(String(file)===path.join(home,envScenario==='env-services-unknown-bot'?'.msb/bots/default/.env':'.msb/.env'))throw Object.assign(Error('fixture-private-marker'),{code:'EACCES'});
        return read(file,...args);
      };
    }
  }
  if (envScenario?.startsWith('project-')) {
    const workspace=path.join(home,'tenant','workspace');
    process.env.MSB_WORKSPACE_DIR=workspace;
    project=path.join(home,'tenant','projects','alpha');
    await fs.mkdir(workspace,{recursive:true});
    for(const [name,text]of Object.entries({'SOUL.md':'fixture-global-soul','USER.md':'fixture-global-user','MEMORY.md':'fixture-global-memory','CLAUDE.md':'fixture-global-rules'}))await fs.writeFile(path.join(workspace,name),text);
    if(envScenario!=='project-missing') {
      await fs.mkdir(path.join(project,'memory'),{recursive:true});
      await fs.mkdir(path.join(project,'knowledge'),{recursive:true});
      await fs.writeFile(path.join(project,'SOUL.md'),'fixture-local-soul-must-not-replace-owner');
      await fs.writeFile(path.join(project,'.current-task.md'),'fixture-project-task');
      await fs.writeFile(path.join(project,'knowledge/_index.md'),'fixture-project-index');
      await fs.writeFile(path.join(project,'memory',new Date().toISOString().slice(0,10)+'.md'),'fixture-project-daily');
    }
    const before=(await loadState()).state;
    await saveState({...before,...(envScenario==='project-default'?{}:{activeProject:'alpha'}),
      ccSessionId:provider==='claude'?'fixture-existing-project-session':'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a51',timezone:'UTC'});
    stateBefore=(await loadState()).state;
  }
  if(['skills-cc-only','skills-oc-present','skills-oc-observed'].includes(envScenario))process.env.JARVIS_CC_ONLY='1';
  if(envScenario==='skills-msb-cc-only')process.env.MSB_CC_ONLY='1';
  if(envScenario==='skills-oc-present' || envScenario==='skills-oc-observed') {
    const saved=(await loadState()).state;await saveState({...saved,ocModel:'fixture-legacy-oc'});
    if(envScenario==='skills-oc-observed'){await loadState();await saveState(saved);}
  }
  let out;
  try { out=await runAgentTurn({ prompt: 'synthetic options task' }); }
  catch(error) { out={ok:false,error:error.code || 'exception',text:String(error.message)}; }
  console.log('AGENT_OPTIONS=' + JSON.stringify({ ok: out.ok, error:out.error, calls,
    workspace:process.env.MSB_WORKSPACE_DIR, project, stateBefore, skillInstall:out.skillInstall, state: (await loadState()).state }));
} finally { await fs.rm(home, { recursive: true, force: true }); }
