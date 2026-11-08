/**
 * Old protected-name/store boundary through real ingress; synthetic HOME only.
 * [Contract](./reference/parity-env-protected-contract.txt), [store](../src/env/store.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { envFilePath, setEnvKey, deleteEnvKey, readEnvMap } from '../src/env/store.mjs';
import { loadState } from '../src/state.mjs';
import { handleFormInput } from '../src/telegram/forms.mjs';

const SYSTEM = [
  'JARVIS_CC_ONLY', 'BOT_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'SYNC_KEY', 'SYNC_URL', 'NODE_ENV', 'VPS_CLIENT_ID', 'ADMIN_ID', 'OWNER_USER_ID',
  ...['ANTHROPIC_API_KEY', 'WORKSPACE_DIR', 'SESSION_DIR', 'BOT_ID', 'TRANSCRIPT_DIR',
    'HOOKS_DIR', 'TRACES_DIR', 'RUNTIME_PROFILE', 'RUNTIME_ROOT', 'OS_ENGINE']
    .flatMap(name => [`MSB_${name}`, `IIA_${name}`]),
];
const BOT_REFUSAL = '⛔ <code>BOT_TOKEN</code> — токен Джарвиса. Изменение убьёт бота.\n\nДля нового бота добавь ключ с другим именем:';
const expectedRefusal = key => key === 'BOT_TOKEN' ? BOT_REFUSAL
  : ['ANTHROPIC_API_KEY', 'MSB_ANTHROPIC_API_KEY', 'IIA_ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key)
    ? `⛔ <code>${key}</code> — системный ключ.\n\nДля смены ключа Claude: /settings → 🔌 Подключение.`
    : `⛔ <code>${key}</code> — системный ключ, управляется автоматически.`;
const until = async check => {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('synthetic turn not observed');
};
async function seed() {
  const file = envFilePath();
  await fs.writeFile(file, '# fixture, never a real token\nBOT_TOKEN=fixture-original-token\n', {mode:0o600});
  process.env.BOT_TOKEN = 'fixture-original-token';
  return file;
}

for (const overlay of [false, true]) for (const entry of ['custom', 'quick']) {
  test(`protected env: ${entry} BOT_TOKEN refusal closes form, overlay=${overlay}`, async t => {
    const turns = [], f = await fixture(t, async request => { turns.push(request); return {ok:true,text:'ordinary task accepted'}; }, {overlay});
    const file = await seed(), before = await fs.readFile(file, 'utf8');
    const state = (await loadState()).state, providers = await fs.readFile(f.storeFile, 'utf8');
    if (entry === 'custom') { await f.callback('settings:env:add'); await f.message(' bot_token '); }
    else await f.callback('settings:env:quick:BOT_TOKEN');
    assert.equal(entry === 'custom' ? f.messages.at(-1) : f.edits.at(-1), BOT_REFUSAL);
    const options = entry === 'custom' ? f.messageOptions.at(-1) : f.editOptions.at(-1);
    assert.equal(options.parse_mode, 'HTML');
    assert.deepEqual(options.reply_markup.inline_keyboard, [[{text:'➕ Добавить TELEGRAM_BOT_2',callback_data:'settings:env:quick:TELEGRAM_BOT_2'}]]);
    await f.message('ordinary task after refusal');
    await until(() => turns.length === 1);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(process.env.BOT_TOKEN, 'fixture-original-token');
    assert.deepEqual((await loadState()).state, state);
    assert.equal(await fs.readFile(f.storeFile, 'utf8'), providers);
    assert.deepEqual(f.restartRequests, []);
    assert.deepEqual(f.deleted, []);
  });
}

for (const key of ['ADMIN_ID', 'MSB_RUNTIME_ROOT', 'IIA_SESSION_DIR', 'ANTHROPIC_API_KEY', 'IIA_ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  test(`protected env: name ${key} refuses with the old reason, without a value prompt`, async t => {
    const f = await fixture(t, undefined, {overlay:false}), file = await seed();
    const before = await fs.readFile(file, 'utf8');
    await f.callback('settings:env:add');
    await f.message(key);
    assert.equal(f.messages.at(-1), expectedRefusal(key));
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.deepEqual(f.restartRequests, []);
  });
}

test('protected env: direct store denies old and bootstrap aliases before any mutation', async t => {
  const f = await fixture(t, undefined, {overlay:false});
  for (let i = 0; i < SYSTEM.length; i++) {
    const key = SYSTEM[i], env = {HOME:f.home, MSB_BOT_ID:`guard${i}`};
    const file = envFilePath(env);
    await fs.mkdir(path.dirname(file), {recursive:true});
    await fs.writeFile(file, `# fixture\n${key}=fixture-original\n`, {mode:0o600});
    const before = await fs.readFile(file, 'utf8'), metadata = await fs.stat(file, {bigint:true});
    const envBefore = {...env};
    await assert.rejects(setEnvKey(key, 'fixture-replacement', env), /защищённый системный ключ/);
    await assert.rejects(deleteEnvKey(key, env), /защищён/);
    assert.equal(await fs.readFile(file, 'utf8'), before, key);
    const after = await fs.stat(file, {bigint:true});
    for (const field of ['ino','mode','mtimeNs','ctimeNs']) assert.equal(after[field], metadata[field], `${key}.${field}`);
    assert.deepEqual(env, envBefore, key);
    assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['.env']);
  }
  const absentEnv = {HOME:f.home, MSB_BOT_ID:'absentguard'};
  await assert.rejects(setEnvKey('BOT_TOKEN','fixture-replacement',absentEnv), /защищённый системный ключ/);
  assert.equal(await fs.stat(path.dirname(envFilePath(absentEnv))).then(()=>true,()=>false), false);
});

test('protected env: stale value-stage input is consumed, never written or retried as a credential', async t => {
  await fixture(t, undefined, {overlay:false});
  const file = await seed(), before = await fs.readFile(file,'utf8'), replies = [];
  const pending = new Map([[42, 'env:BOT_TOKEN']]);
  const consumed = await handleFormInput({kind:'env:BOT_TOKEN',text:'fixture-replacement',pending,
    ctx:{chat:{id:42},reply:async(...args)=>replies.push(args)}});
  assert.equal(consumed,true);
  assert.equal(pending.has(42),false);
  assert.equal(replies.at(-1)[0],BOT_REFUSAL);
  assert.equal(await fs.readFile(file,'utf8'),before);
});

test('protected env: explicit internal auth write still validates values and changes only its key', async t => {
  const f=await fixture(t,undefined,{overlay:false}), env={HOME:f.home,MSB_BOT_ID:'trustedauth'};
  await setEnvKey('DEEPGRAM_API_KEY','fixture-deepgram',env);
  const before=await fs.readFile(envFilePath(env),'utf8');
  for(const value of ['bad\nINJECTED=x','bad\0value']) {
    await assert.rejects(setEnvKey('CLAUDE_CODE_OAUTH_TOKEN',value,env,{internal:true}));
    assert.equal(await fs.readFile(envFilePath(env),'utf8'),before);
  }
  await setEnvKey('CLAUDE_CODE_OAUTH_TOKEN','fixture-oauth',env,{internal:true});
  const {map}=await readEnvMap(env);
  assert.equal(map.get('DEEPGRAM_API_KEY'),'fixture-deepgram');
  assert.equal(map.get('CLAUDE_CODE_OAUTH_TOKEN'),'fixture-oauth');
});

test('protected env: old TELEGRAM_BOT_2 fallback and Deepgram service remain ordinary supported keys', async t => {
  const f=await fixture(t,undefined,{overlay:false});
  await f.callback('settings:env:quick:TELEGRAM_BOT_2');
  await f.message('12345:'+'F'.repeat(30));
  await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});
  await f.callback('settings:env:quick:DEEPGRAM_API_KEY');
  await f.message('fixture-deepgram');
  await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});
  const {map}=await readEnvMap();
  assert.equal(map.get('TELEGRAM_BOT_2'),'12345:'+'F'.repeat(30));
  assert.equal(map.get('DEEPGRAM_API_KEY'),'fixture-deepgram');
  assert.deepEqual(f.restartRequests,[]);
});
