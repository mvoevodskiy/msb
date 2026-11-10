/** Old lK value semantics through real form/store; no credentials or external API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixture} from './helpers/menu-fixture.mjs';
import {setEnvKey,readEnvMap,envFilePath} from '../src/env/store.mjs';
import {loadState} from '../src/state.mjs';
import {handleEnvValueInput} from '../src/telegram/forms/env.mjs';
const LINE='Значение должно быть одной строкой, без переносов и служебных символов. Пришли только сам ключ/токен.';
const JSON_NOTE='Похоже, это целый JSON (например ключ сервисного аккаунта), а не одно значение. Переменная окружения должна быть ОДНОЙ строкой — так вставлять нельзя. Напиши в поддержку, если нужно подключить именно такой ключ.';
const TELEGRAM='Не похоже на токен Telegram-бота. Формат: <цифры>:<буквы/цифры> (как выдаёт @BotFather).';
const lengthError=n=>`Значение слишком длинное (${n} символов, максимум 4000). Похоже на вставку целого файла — пришли только сам ключ.`;
const mismatch=(actual,expected)=>`Это похоже на ключ ${actual}, а не ${expected}. Проверь, тот ли ключ вставляешь.`;
const shapedTelegram='12345:'+'F'.repeat(30); // inert, format-only fixture; never sent to Telegram API
const skip=async f=>f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});

const invalid=[
 ['empty','CUSTOM_API','','Значение пустое.'],
 ['whitespace','CUSTOM_API',' \t ','Значение пустое.'],
 ['leading newline','CUSTOM_API','\nfixture',LINE],
 ['trailing CR','CUSTOM_API','fixture\r',LINE],
 ['internal C0','CUSTOM_API','fix\x01ture',LINE],
 ['DEL','CUSTOM_API','fixture\x7f',LINE],
 ['NUL','CUSTOM_API','fixture\0',LINE],
 ['multiline JSON','CUSTOM_API','{"one":"fixture",\n"two":"fixture"}',JSON_NOTE],
 ['single JSON key uses generic warning','CUSTOM_API','{"one":\n"fixture"}',LINE],
 ['4001 ASCII','CUSTOM_API','x'.repeat(4001),lengthError(4001)],
 ['UTF16 bound','CUSTOM_API','😀'.repeat(2001),lengthError(4002)],
 ['Anthropic in OpenRouter','OPENROUTER_API_KEY','sk-ant-fixture',mismatch('Anthropic','OpenRouter')],
 ['OpenRouter in OpenAI','OPENAI_API_KEY','sk-or-fixture',mismatch('OpenRouter','OpenAI')],
 ['Google in custom Anthropic name','PARITY_ANTHROPIC_KEY','AIzaFixture',mismatch('Google','Anthropic')],
 ['xAI in OpenRouter','OPENROUTER_API_KEY','xai-fixture',mismatch('xAI','OpenRouter')],
 ['case-insensitive prefix','OPENAI_API_KEY','SK-ANT-fixture',mismatch('Anthropic','OpenAI')],
 ['first declared name wins','ANTHROPIC_OPENROUTER_KEY','sk-or-fixture',mismatch('OpenRouter','Anthropic')],
 ['Telegram fallback shape','TELEGRAM_BOT_2','fixture-is-not-a-token',TELEGRAM],
];
for(const [label,key,value,reason] of invalid.filter(([, , value])=>value!==''))test('env value: '+label+' rejects before description and allows retry',async t=>{
 let turns=0;const f=await fixture(t,async()=>{turns++;return{ok:true,text:'unexpected'};});
 await setEnvKey('KEEP','fixture-keep');const file=envFilePath(),before=await fs.readFile(file,'utf8'),state=(await loadState()).state;
 const providers=await fs.readFile(f.storeFile,'utf8');await f.callback('settings:env:quick:'+key);await f.message(value);
 assert.equal(f.messages.at(-1),'Не сохранил: '+reason);
 assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(process.env[key],undefined);
 assert.equal(f.messageOptions.at(-1)?.reply_markup,undefined,'invalid value must not expose description/skip');
 const valid=key.includes('TELEGRAM')?shapedTelegram:'fixture-valid-retry';await f.message(valid);await skip(f);
 assert.equal((await readEnvMap()).map.get(key),valid);assert.equal((await readEnvMap()).map.get('KEEP'),'fixture-keep');
 assert.equal(turns,0);assert.deepEqual(f.restartRequests,[]);assert.ok(!f.deleted.includes(99));
 assert.deepEqual((await loadState()).state,state);assert.equal(await fs.readFile(f.storeFile,'utf8'),providers);
});

// Telegram cannot deliver an empty text message. Exercise the public production
// form directly here; the ingress fixture correctly classifies textless media.
test('env value: direct form rejects empty raw text before any draft or save',async t=>{
 const f=await fixture(t,undefined,{overlay:false});
 const replies=[],pending={advance(){assert.fail('empty value entered description');},delete(){assert.fail('ordinary key cleared input');}};
 await handleEnvValueInput({kind:'env:CUSTOM_API',ctx:{reply:async text=>replies.push(text)},text:'',pending,chatId:42});
 assert.deepEqual(replies,['Не сохранил: Значение пустое.']);
 assert.equal(await fs.stat(envFilePath()).then(()=>true,()=>false),false);
 assert.equal(process.env.CUSTOM_API,undefined);assert.deepEqual(f.restartRequests,[]);
});

const valid=[
 ['trimmed spaces','CUSTOM_API','  fixture value  ','fixture value'],
 ['horizontal tab','CUSTOM_API','fixture\tvalue','fixture\tvalue'],
 ['4000 ASCII','CUSTOM_API','x'.repeat(4000),'x'.repeat(4000)],
 ['length after trim','CUSTOM_API','  '+'x'.repeat(4000)+'  ','x'.repeat(4000)],
 ['4000 UTF16 units','CUSTOM_API','😀'.repeat(2000),'😀'.repeat(2000)],
 ['single-line JSON','CUSTOM_API','{"one":"a","two":"b"}','{"one":"a","two":"b"}'],
 ['unknown prefix','OPENROUTER_API_KEY','fixture-compatible-provider','fixture-compatible-provider'],
 ['OpenRouter own prefix','OPENROUTER_API_KEY','sk-or-fixture','sk-or-fixture'],
 ['Google lower-case stays unknown','OPENAI_API_KEY','aizaFixture','aizaFixture'],
 ['unclassified custom key','CUSTOM_API','sk-ant-fixture','sk-ant-fixture'],
 ['Pult key is not Telegram-name rule','PULT_TG_TOKEN','fixture-pult-value','fixture-pult-value'],
 ['Telegram-shaped input','TELEGRAM_BOT_2',shapedTelegram,shapedTelegram],
];
for(const [label,key,value,expected] of valid)test('env value: '+label+' keeps supported old input',async t=>{
 const f=await fixture(t,undefined,{overlay:false});await f.callback('settings:env:quick:'+key);await f.message(value);
 assert.equal(f.messages.at(-1),`Описание для <code>${key}</code> (необязательно, видно тебе и агенту):`);
 await skip(f);assert.equal((await readEnvMap()).map.get(key),expected);assert.equal(process.env[key],expected);
});

test('env value: store repeats all guards before any file or env mutation',async t=>{
 const f=await fixture(t,undefined,{overlay:false});
 const env={HOME:f.home,MSB_BOT_ID:'direct'},file=envFilePath(env);
 for(const [,key,value,reason] of invalid){
  const before={...env};await assert.rejects(setEnvKey(key,value,env),error=>error.message===reason);
  assert.deepEqual(env,before);assert.equal(await fs.stat(file).then(()=>true,()=>false),false);
 }
 await setEnvKey('CUSTOM_API','  fixture-trimmed  ',env);assert.equal(env.CUSTOM_API,'fixture-trimmed');
 assert.equal((await readEnvMap(env)).map.get('CUSTOM_API'),'fixture-trimmed');
});

test('env value: protected-name rejection wins and internal does not bypass value rules',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env={HOME:f.home,MSB_BOT_ID:'internal'};
 for(const value of ['', '\n', 'x'.repeat(4001)])await assert.rejects(setEnvKey('BOT_TOKEN',value,env),/защищённый системный ключ/);
 await assert.rejects(setEnvKey('BOT_TOKEN','fixture-wrong-shape',env,{internal:true}),error=>error.message===TELEGRAM);
 await assert.rejects(setEnvKey('ANTHROPIC_API_KEY','sk-or-fixture',env,{internal:true}),error=>error.message===mismatch('OpenRouter','Anthropic'));
 await setEnvKey('BOT_TOKEN',shapedTelegram,env,{internal:true});assert.equal(env.BOT_TOKEN,shapedTelegram);
});

test('env value: invalid retry keeps the original deadline and an exiting command is not a value',async t=>{
 let clock=1_000_000;const f=await fixture(t,undefined,{overlay:false,now:()=>clock});
 await f.callback('settings:env:quick:CUSTOM_API');clock+=590_000;await f.message(' ');
 assert.equal(f.messages.at(-1),'Не сохранил: Значение пустое.');clock+=10_001;await f.message('fixture-too-late');
 assert.ok(f.messages.at(-1).startsWith('⏳ Время на ввод переменной истекло'));assert.equal((await readEnvMap()).map.size,0);
 await f.callback('settings:env:quick:CUSTOM_API');await f.message(' ');await f.message('/not_a_saved_command');
 assert.equal((await readEnvMap()).map.size,0);assert.ok(f.messages.at(-1).startsWith('Вышел из режима ввода переменной'));
});

test('env value: failed internal auth write retains previous credentials and permits the old retry',async t=>{
 const f=await fixture(t,undefined,{overlay:false});
 await setEnvKey('CLAUDE_CODE_OAUTH_TOKEN','fixture-existing-oauth',process.env,{internal:true});
 const before=await fs.readFile(envFilePath(),'utf8'),state=(await loadState()).state;
 await f.callback('settings:auth:switch-sub');await f.message('fixture-opaque-'+'x'.repeat(4000));
 assert.ok(f.messages.at(-1).startsWith('Токен не сохранён: Значение слишком длинное'));
 assert.equal(await fs.readFile(envFilePath(),'utf8'),before);assert.deepEqual((await loadState()).state,state);assert.deepEqual(f.restartRequests,[]);
 await f.message('sk-ant-oat01-fixture-'+'x'.repeat(40));assert.deepEqual(f.restartRequests,[0]);
});
