/** Old MG/vHA configuration metadata through real prompt paths; synthetic data only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './helpers/menu-fixture.mjs';
import {agentOptionsReport} from './helpers/agent-options.mjs';
import {envCapabilityPrompt} from '../src/env/prompt.mjs';
import {buildSystemPrompt} from '../src/agent/system-prompt.mjs';
import {envFilePath,setEnvKey} from '../src/env/store.mjs';
// Independent old MG fixture: blob73aa9e7 lines9156–9245, not the production catalog.
const SERVICES=[
 ['DEEPGRAM_API_KEY','Голосовые сообщения (Deepgram)',true],
 ['VOYAGE_API_KEY','Семантический поиск (Voyage AI)',true],
 ['OPENROUTER_API_KEY','OpenRouter (мультимодель)',true],
 ['GITHUB_TOKEN','GitHub',true],
 ['SERPER_API_KEY','Веб-поиск Serper',true],
 ['BRAVE_API_KEY','Веб-поиск Brave',true],
 ['SUPABASE_URL','Supabase (БД)',true],
 ['SUPABASE_ACCESS_TOKEN','Supabase CLI',false],
 ['VERCEL_TOKEN','Vercel (деплой)',true],
 ['RAILWAY_TOKEN','Railway (деплой)',true],
 ['GOOGLE_API_KEY','Google AI (Gemini)',false],
 ['GEMINI_API_KEY','Google Gemini',false],
 ['OPENAI_API_KEY','OpenAI (GPT)',false],
 ['REPLICATE_API_TOKEN','Replicate',false],
 ['CLOUDFLARE_API_TOKEN','Cloudflare',false],
 ['NANOBANANA_API_KEY','NanoBanana',false],
 ['FAL_KEY','fal.ai (генеративное медиа)',true],
 ['SUPADATA_API_KEY','Supadata (видео и веб)',true],
 ['APIFY_API_KEY','Apify (соцсети и данные)',true],
];
const SECRET='fixture-metadata-secret-not-for-output-7ab9';
const CUSTOM='fixture-custom-metadata-value-08a3';
const bare=f=>({HOME:f.home,MSB_BOT_ID:'default'});
const active=(key,label)=>`${key}: ${label} — ключ задан в ${key==='DEEPGRAM_API_KEY'?'настройках STT':'окружении процесса'}.`;
const inactive=(key,label)=>`${key}: ${label} — в ${key==='DEEPGRAM_API_KEY'?'настройках STT':'окружении процесса'} ключ не задан (добавь через /settings → 🔑).`;
const unknown='DEEPGRAM_API_KEY: Голосовые сообщения (Deepgram) — состояние ключа в настройках STT неизвестно.';
for(const[key,label,hint]of SERVICES)test(`env services: old ${key} is independent of file registration and keeps inactive hint rules`,async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=bare(f);
 assert.ok((await envCapabilityPrompt({...env,[key]:SECRET})).includes(active(key,label)));
 for(const value of [undefined,'']){
  const prompt=await envCapabilityPrompt(value===undefined?env:{...env,[key]:value});
  if(hint)assert.ok(prompt.includes(inactive(key,label)));
  else assert.equal(prompt.includes(key+':'),false);
  assert.equal(prompt.includes(active(key,label)),false);
 }
 const p=await buildSystemPrompt({env:{...env,[key]:SECRET},workspace:f.home});
 assert.ok(p.includes(active(key,label)));assert.equal(p.includes(SECRET),false);
 assert.equal(await fs.stat(envFilePath(env)).then(()=>true,()=>false),false);
});

test('env services: generic file-only key is not reported as process configured',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=bare(f);
 await setEnvKey('OPENROUTER_API_KEY',SECRET,{...env},{comment:'file is not runtime auth'});
 const file=envFilePath(env),before=await fs.readFile(file,'utf8'),p=await envCapabilityPrompt(env);
 assert.ok(p.includes(inactive('OPENROUTER_API_KEY','OpenRouter (мультимодель)')));
 assert.equal(p.includes(active('OPENROUTER_API_KEY','OpenRouter (мультимодель)')),false);
 assert.equal(p.includes(SECRET),false);assert.equal(await fs.readFile(file,'utf8'),before);
 assert.equal(env.OPENROUTER_API_KEY,undefined);
});

test('env services: configuration is re-read without a sticky active flag or credential values',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env={...bare(f),OPENROUTER_API_KEY:SECRET};
 assert.ok((await envCapabilityPrompt(env)).includes(active('OPENROUTER_API_KEY','OpenRouter (мультимодель)')));
 env.OPENROUTER_API_KEY='';assert.ok((await envCapabilityPrompt(env)).includes(inactive('OPENROUTER_API_KEY','OpenRouter (мультимодель)')));
 assert.equal(await fs.stat(envFilePath(env)).then(()=>true,()=>false),false);
});

test('env services control: registered custom metadata stays, unregistered and internal keys do not become services',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=bare(f);
 await setEnvKey('CUSTOM_API',CUSTOM,env,{comment:'fixture custom description'});
 await setEnvKey('PULT_PASSWORD','fixture-pult-only-value',env);
 env.UNRELATED_RUNTIME_ONLY=SECRET;env.CLAUDE_CODE_OAUTH_TOKEN=SECRET;
 const p=await envCapabilityPrompt(env);
 assert.ok(p.includes('CUSTOM_API: fixture custom description'));
 for(const text of ['UNRELATED_RUNTIME_ONLY','PULT_PASSWORD','CLAUDE_CODE_OAUTH_TOKEN',SECRET,CUSTOM,'fixture-pult-only-value'])assert.equal(p.includes(text),false);
});

for(const key of ['GITHUB_TOKEN_FINE','GITHUB_TOKEN_CLASSIC','X_BEARER_TOKEN','PROXYAPI_KEY'])test(`env services: quick ${key} retains the old ordinary custom metadata route`,async t=>{
 const f=await fixture(t,undefined,{overlay:false});
 await f.callback('settings:env:quick:'+key);await f.message(CUSTOM);await f.message('fixture service description');
 const env={...bare(f),[key]:CUSTOM},p=await buildSystemPrompt({env,workspace:f.home});
 assert.ok(p.includes(key+': fixture service description'));assert.equal(p.includes(CUSTOM),false);
 assert.deepEqual(f.restartRequests,[]);
});

test('env services: supported digit-leading key does not produce a universal $NAME shell promise',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=bare(f);await setEnvKey('1A',CUSTOM,env,{comment:'fixture digit key'});
 const local=spawnSync('/bin/bash',['-c','printf "%s" "$1A"'],{env:{'1A':CUSTOM},encoding:'utf8'});
 assert.equal(local.status,0);assert.equal(local.stdout,'A');
 const p=await envCapabilityPrompt(env);assert.ok(p.includes('1A: fixture digit key'));
 assert.equal(p.includes('Все ключи доступны в Bash через $ИМЯ.'),false);
 for(const text of ['интернет-поиск (Anthropic)','check_capabilities','cleanEnv','скоринг контента, дайджесты'])assert.equal(p.includes(text),false);
});

const sttCases=[
 ['shared-only',{},null,`DEEPGRAM_API_KEY=${SECRET}\n`,true],
 ['per-bot over shared empty',{},`DEEPGRAM_API_KEY=${SECRET}\n`,'DEEPGRAM_API_KEY=\n',true],
 ['per-bot empty blocks shared',{},'DEEPGRAM_API_KEY=\n',`DEEPGRAM_API_KEY=${SECRET}\n`,false],
 ['process over per-bot empty',{DEEPGRAM_API_KEY:SECRET},'DEEPGRAM_API_KEY=\n',null,true],
 ['process empty blocks per-bot',{DEEPGRAM_API_KEY:''},`DEEPGRAM_API_KEY=${SECRET}\n`,null,false],
 ['whitespace process override',{DEEPGRAM_API_KEY:'  '},`DEEPGRAM_API_KEY=${SECRET}\n`,null,false],
 ['command only',{STT_COMMAND:'/fixture/no-command-is-executed'},null,null,false],
 ['command and key',{STT_COMMAND:'/fixture/no-command-is-executed',DEEPGRAM_API_KEY:SECRET},null,null,true],
 ['missing all',{},null,null,false],
];
for(const[label,vars,botText,sharedText,configured]of sttCases)test('env services: Deepgram follows existing STT resolver '+label,async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env={...bare(f),...vars};
 const bot=envFilePath(env),shared=path.join(f.home,'.msb/.env');
 for(const[file,text]of [[bot,botText],[shared,sharedText]])if(text!==null)await fs.writeFile(file,text,{mode:0o600});
 const before={...env},snap=await Promise.all([bot,shared].map(p=>fs.readFile(p,'utf8').catch(e=>e.code)));
 const p=await envCapabilityPrompt(env);
 assert.ok(p.includes((configured?active:inactive)('DEEPGRAM_API_KEY','Голосовые сообщения (Deepgram)')));
 for(const value of [SECRET,'/fixture/no-command-is-executed'])assert.equal(p.includes(value),false);
 assert.equal(p.includes('Deepgram выбран'),false);
 assert.deepEqual(env,before);assert.deepEqual(await Promise.all([bot,shared].map(p=>fs.readFile(p,'utf8').catch(e=>e.code))),snap);
});

test('env services: STT read error becomes safe unknown, never missing or an exception in the text prompt',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=bare(f),read=fs.readFile.bind(fs),privatePath=path.join(f.home,'.msb/.env');
 t.mock.method(fs,'readFile',async(file,...args)=>{if(String(file)===privatePath)throw Object.assign(Error('fixture-private-marker-'+SECRET+' '+privatePath),{code:'EACCES',path:privatePath});return read(file,...args);});
 const p=await buildSystemPrompt({env,workspace:f.home});assert.ok(p.includes(unknown));
 assert.equal(p.includes(inactive('DEEPGRAM_API_KEY','Голосовые сообщения (Deepgram)')),false);
 for(const s of [SECRET,'fixture-private-marker','EACCES',privatePath])assert.equal(p.includes(s),false);
});

for(const provider of ['claude','codex'])for(const mode of ['inline','file'])test(`env services: production ${provider} ${mode} prompt route retains metadata without credentials`,async()=>{
 const out=agentOptionsReport(provider,'auto','opus','high','2.1.316',false,'','env-services-'+mode),call=out.calls[0],p=call.nativePrompt;
 assert.equal(call.provider,provider);assert.equal(call.systemPromptViaFile,mode==='file');
 assert.ok(p.includes(active('DEEPGRAM_API_KEY','Голосовые сообщения (Deepgram)')));
 assert.ok(p.includes(active('OPENROUTER_API_KEY','OpenRouter (мультимодель)')));
 assert.ok(p.includes('FIXTURE_CUSTOM_API: fixture custom description'));
 assert.equal(p.includes('GEMINI_API_KEY:'),false);
 for(const value of ['fixture-service-stt-value','fixture-service-router-value','fixture-service-custom-value','fixture-service-file-only-value'])assert.equal(p.includes(value),false);
 assert.deepEqual(call.inheritedServiceEnvNonempty,{deepgram:true,openrouter:true});
 if(provider==='codex')assert.ok(p.includes('Runtime override'));
});

for (const source of ['shared','bot']) test('env services: unknown '+source+' STT status permits an ordinary production text turn',async()=>{
 const scenario=source==='bot'?'env-services-unknown-bot':'env-services-unknown';
 const out=agentOptionsReport('codex','auto','opus','high','2.1.316',false,'',scenario),p=out.calls[0].nativePrompt;
 assert.equal(out.ok,true);assert.ok(p.includes(unknown));assert.equal(p.includes('fixture-private-marker'),false);
});

for (const target of ['metadata','system']) test('env services: unreadable per-bot metadata preserves known rows in '+target,async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env={...bare(f),GITHUB_TOKEN:SECRET},read=fs.readFile.bind(fs),privatePath=envFilePath(bare(f));
 t.mock.method(fs,'readFile',async(file,...args)=>{
  if(String(file)===envFilePath(env))throw Object.assign(Error('fixture-private-marker-'+SECRET+' '+privatePath),{code:'EACCES',path:privatePath});
  return read(file,...args);
 });
 const p=target==='metadata'?await envCapabilityPrompt(env):await buildSystemPrompt({env,workspace:f.home});
 assert.ok(p.includes(active('GITHUB_TOKEN','GitHub')));assert.ok(p.includes(unknown));
 assert.ok(p.includes('Дополнительные имена и описания ключей сейчас недоступны.'));
 for(const value of [SECRET,'fixture-private-marker','EACCES',privatePath])assert.equal(p.includes(value),false);
 assert.equal(env.GITHUB_TOKEN,SECRET);assert.deepEqual(f.restartRequests,[]);
});
