/**
 * Old X accounts use handle: blob 73aa9e7e, GHA 5727–5754,
 * zL 5909–5927, config path 6070–6074 (git show <blob> | nl -ba).
 * Fake Telegram, fake network, and temporary profile. No real credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/menu-fixture.mjs';
import { addSourceFromInput, loadMonitorConfig, removeSource, saveMonitorConfig } from '../src/monitor/config.mjs';
import { monitorScreen, monitorSourcesScreen } from '../src/telegram/screens/monitor.mjs';
import { pollAllSources } from '../src/monitor/poll.mjs';

async function prepared(t, accounts) {
  const f=await fixture(t,undefined,{overlay:false});
  const cfg=await loadMonitorConfig();
  cfg.twitter.enabled=true;
  cfg.twitter.accounts=accounts;
  cfg.github.repos=[{owner:'other',repo:'fixture',enabled:false}];
  await saveMonitorConfig(cfg);
  const buttons=async () => (await monitorSourcesScreen()).keyboard.inline_keyboard.flat().filter(b=>b.text?.startsWith('🗑 twitter:'));
  return {f,cfg,buttons};
}

test('legacy account can be re-enabled and a different source added without changing neighbors', async t => {
  const {cfg}=await prepared(t,[{handle:'legacy',enabled:false,marker:'legacy'}, {username:'newer',enabled:true,marker:'new'}]);
  const repeat=await addSourceFromInput('https://x.com/LEGACY');
  assert.equal(repeat.reason,'re-enabled');
  assert.deepEqual((await loadMonitorConfig()).twitter.accounts,[{...cfg.twitter.accounts[0],enabled:true},cfg.twitter.accounts[1]]);
  const added=await addSourceFromInput('https://x.com/another');
  assert.equal(added.added,true);
  const after=await loadMonitorConfig();
  assert.equal(after.twitter.accounts.length,3);
  assert.deepEqual(after.github,cfg.github);
});

test('legacy source has the right name and deletion target; stale undefined cannot delete a real account', async t => {
  const {f,buttons}=await prepared(t,[{handle:'legacy',enabled:true},{username:'undefined',enabled:true}]);
  const screen=await monitorSourcesScreen();
  assert.match(screen.text,/@legacy/);
  assert.doesNotMatch(screen.text,/@undefined[^<]*undefined/);
  const before=await loadMonitorConfig();
  await f.callback('mon:src-del:twitter:undefined');
  assert.deepEqual((await loadMonitorConfig()).twitter,before.twitter);
  const initial=await buttons();
  const legacy=initial.find(b=>b.text.includes('@legacy'));
  const actual=initial.find(b=>b.text.includes('@undefined'));
  assert.ok(legacy && actual);
  assert.match(actual.callback_data,/^mon:src-key:twitter:/);
  await f.callback(legacy.callback_data);
  assert.deepEqual((await loadMonitorConfig()).twitter.accounts,[before.twitter.accounts[1]]);
  await f.callback('mon:src-del:twitter:undefined');
  assert.deepEqual((await loadMonitorConfig()).twitter.accounts,[before.twitter.accounts[1]]);
  await f.callback(actual.callback_data);
  assert.equal((await loadMonitorConfig()).twitter.accounts.length,0);
});

test('poll fetches old and new identities and records results on their own rows', async t => {
  const {cfg}=await prepared(t,[{handle:'legacy',enabled:true,addedAt:'old'}, {username:'newer',enabled:true,addedAt:'new'}]);
  const original=globalThis.fetch, urls=[];
  globalThis.fetch=async url => {
    urls.push(String(url));
    const match=String(url).match(/users\/by\/username\/([^/?]+)/);
    if (match) return {ok:true,json:async()=>({data:{id:match[1]}})};
    if (/\/users\/(legacy|newer)\/tweets/.test(String(url))) return {ok:true,json:async()=>({data:[]})};
    throw Error('unexpected fake URL');
  };
  t.after(()=>{globalThis.fetch=original;});
  const res=await pollAllSources({...process.env,X_BEARER_TOKEN:'fake'}, {log(){}});
  assert.equal(res.errors.length,0);
  assert.ok(urls.some(x=>x.endsWith('/users/by/username/legacy')));
  assert.ok(urls.some(x=>x.endsWith('/users/by/username/newer')));
  const after=await loadMonitorConfig();
  assert.deepEqual(after.twitter.accounts,cfg.twitter.accounts.map(a=>({...a,lastError:null})));
  assert.deepEqual(after.github,cfg.github);
});

test('conflicting fields are not selected, deleted or fetched', async t => {
  const {f,buttons,cfg}=await prepared(t,[{username:'other',handle:'legacy',enabled:true,marker:'conflict'}]);
  const a=await addSourceFromInput('https://x.com/legacy');
  const b=await addSourceFromInput('https://x.com/other');
  assert.equal(a.ok,false); assert.equal(b.ok,false);
  const screen=await monitorSourcesScreen();
  assert.match(screen.text,/⚠/);
  assert.equal((await buttons()).length,1);
  await f.callback('mon:src-del:twitter:legacy');
  const original=globalThis.fetch; let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('unexpected network');};
  t.after(()=>{globalThis.fetch=original;});
  const result=await pollAllSources({...process.env,X_BEARER_TOKEN:'fake'},{log(){}});
  assert.equal(calls,0); assert.equal(result.errors.length,1);
  assert.deepEqual((await loadMonitorConfig()).twitter,cfg.twitter);
});

test('duplicate legacy and current identities do not cause arbitrary reactivation or deletion', async t => {
  const {f,cfg}=await prepared(t,[{handle:'same',enabled:false,marker:'old'}, {username:'SAME',enabled:true,marker:'new'}]);
  const result=await addSourceFromInput('https://x.com/same');
  assert.equal(result.ok,false);
  await f.callback('mon:src-del:twitter:same');
  assert.deepEqual((await loadMonitorConfig()).twitter,cfg.twitter);
});

test('a long legacy callback remains bounded and deletes its own row', async t => {
  const handle=`legacy${'a'.repeat(55)}`;
  const {f,buttons}=await prepared(t,[{handle,enabled:true}]);
  const [button]=await buttons();
  assert.match(button.callback_data,/^mon:src-key:twitter:/);
  assert.ok(Buffer.byteLength(button.callback_data)<=64);
  await f.callback(button.callback_data);
  assert.equal((await loadMonitorConfig()).twitter.accounts.length,0);
});

test('a delayed poll cannot write an old error into a replaced legacy record', async t => {
  await prepared(t,[{handle:'legacy',enabled:true,marker:'before'}]);
  const original=globalThis.fetch; let release, entered;
  const enteredPromise=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  globalThis.fetch=async()=>{entered();await gate;throw Error('synthetic failure');};
  t.after(()=>{globalThis.fetch=original;});
  const running=pollAllSources({...process.env,X_BEARER_TOKEN:'fake'},{log(){}});
  await enteredPromise;
  const cfg=await loadMonitorConfig();
  cfg.twitter.accounts[0]={handle:'legacy',enabled:true,marker:'replacement',lastError:'keep'};
  await saveMonitorConfig(cfg);
  release(); await running;
  assert.deepEqual((await loadMonitorConfig()).twitter.accounts[0],cfg.twitter.accounts[0]);
});


test('a token for a long account cannot delete one of two case-variant identities', async t => {
  const handle=`legacy${'a'.repeat(55)}`;
  const {f,buttons,cfg}=await prepared(t,[{handle,enabled:true},{username:handle.toUpperCase(),enabled:false}]);
  const [button]=await buttons();
  assert.match(button.callback_data,/^mon:src-key:twitter:/);
  await f.callback(button.callback_data);
  assert.deepEqual((await loadMonitorConfig()).twitter,cfg.twitter);
});

test('an undefined API argument cannot delete the real account named undefined', async t => {
  const {cfg}=await prepared(t,[{username:'undefined',enabled:true}]);
  assert.equal(await removeSource('twitter',undefined),false);
  assert.deepEqual((await loadMonitorConfig()).twitter,cfg.twitter);
});

test('matching username and old handle are one source without rewriting metadata', async t => {
  const {cfg}=await prepared(t,[{username:'Legacy',handle:'legacy',enabled:false,marker:'keep'}]);
  const result=await addSourceFromInput('https://x.com/LEGACY');
  assert.equal(result.reason,'re-enabled');
  assert.deepEqual((await loadMonitorConfig()).twitter.accounts[0],{...cfg.twitter.accounts[0],enabled:true});
});


test('a malformed row keeps a safe delete button that does not touch its neighbor', async t => {
  const {f,buttons,cfg}=await prepared(t,[{username:'other',handle:'legacy',enabled:true,marker:'conflict'}, {username:'neighbor',enabled:true}]);
  const candidates=await buttons();
  const invalid=candidates.find(button=>button.text.includes('⚠'));
  assert.ok(invalid);
  assert.match(invalid.callback_data,/^mon:src-key:twitter:/);
  await f.callback(invalid.callback_data);
  assert.deepEqual((await loadMonitorConfig()).twitter.accounts,[cfg.twitter.accounts[1]]);
  await f.callback(invalid.callback_data);
  assert.deepEqual((await loadMonitorConfig()).twitter.accounts,[cfg.twitter.accounts[1]]);
});

test('stale malformed-row token and identical duplicates cannot delete a source', async t => {
  const invalid={username:'other',handle:'legacy',enabled:true,marker:'before'};
  const {f,buttons}=await prepared(t,[invalid]);
  const [button]=await buttons();
  const cfg=await loadMonitorConfig();
  cfg.twitter.accounts[0].marker='after';
  await saveMonitorConfig(cfg);
  await f.callback(button.callback_data);
  assert.deepEqual((await loadMonitorConfig()).twitter,cfg.twitter);
  cfg.twitter.accounts.push({...cfg.twitter.accounts[0]});
  await saveMonitorConfig(cfg);
  const [current]=await buttons();
  await f.callback(current.callback_data);
  assert.deepEqual((await loadMonitorConfig()).twitter,cfg.twitter);
});

test('different malformed rows show their conflicting identifiers and remain distinguishable', async t => {
  const first={username:'alice',handle:'bob',enabled:true,marker:'not-for-display-1'};
  const second={username:'carol',handle:'dan',enabled:true,marker:'not-for-display-2'};
  const {f,buttons}=await prepared(t,[first,second]);
  const screen=await monitorSourcesScreen();
  for (const value of ['@alice','@bob','@carol','@dan']) assert.ok(screen.text.includes(value));
  assert.doesNotMatch(screen.text,/not-for-display/);
  const both=await buttons();
  assert.equal(both.length,2);
  assert.notEqual(both[0].text,both[1].text);
  await f.callback(both[0].callback_data);
  assert.deepEqual((await loadMonitorConfig()).twitter.accounts,[second]);
});

test('same conflicting identifiers with different hidden metadata are not arbitrarily removed', async t => {
  const first={username:'alice',handle:'bob',enabled:true,marker:'one'};
  const second={username:'alice',handle:'bob',enabled:true,marker:'two'};
  const {f,buttons,cfg}=await prepared(t,[first,second]);
  const [button]=await buttons();
  await f.callback(button.callback_data);
  assert.deepEqual((await loadMonitorConfig()).twitter,cfg.twitter);
});

test('a null X record is shown as invalid and never fetched or mistaken for its neighbor', async t => {
  const {f,buttons}=await prepared(t,[null,{username:'neighbor',enabled:true}]);
  const screen=await monitorSourcesScreen();
  assert.match(screen.text,/Некорректный источник X/);
  const rows=await buttons();
  const invalid=rows.find(button=>button.text.includes('Некорректный'));
  assert.ok(invalid);
  const original=globalThis.fetch, urls=[];
  globalThis.fetch=async url => {
    urls.push(String(url));
    if (String(url).endsWith('/users/by/username/neighbor')) return {ok:true,json:async()=>({data:{id:'neighbor'}})};
    if (String(url).includes('/users/neighbor/tweets')) return {ok:true,json:async()=>({data:[]})};
    throw Error('unexpected fake URL');
  };
  t.after(()=>{globalThis.fetch=original;});
  const result=await pollAllSources({...process.env,X_BEARER_TOKEN:'fake'},{log(){}});
  assert.equal(result.errors.length,1);
  assert.equal(urls.length,2);
  assert.ok(urls.every(url=>url.includes('neighbor')));
  await f.callback(invalid.callback_data);
  assert.deepEqual((await loadMonitorConfig()).twitter.accounts,[{username:'neighbor',enabled:true,lastError:null}]);
});


test('missing enabled on a legacy record remains active without a rewrite on re-add', async t => {
  const {cfg}=await prepared(t,[{handle:'legacy',marker:'unchanged'}]);
  const result=await addSourceFromInput('https://x.com/LEGACY');
  assert.equal(result.added,false);
  assert.deepEqual((await loadMonitorConfig()).twitter,cfg.twitter);
});

test('missing bearer records the error against the matching legacy row without a request', async t => {
  const {cfg}=await prepared(t,[{handle:'legacy',enabled:true}]);
  const original=globalThis.fetch; let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('unexpected network');};
  t.after(()=>{globalThis.fetch=original;});
  const env={...process.env}; delete env.X_BEARER_TOKEN; delete env.TWITTER_BEARER_TOKEN;
  const result=await pollAllSources(env,{log(){}});
  assert.equal(calls,0);
  assert.equal(result.errors[0].id,'legacy');
  assert.match((await loadMonitorConfig()).twitter.accounts[0].lastError,/X_BEARER_TOKEN/);
  assert.deepEqual((await loadMonitorConfig()).github,cfg.github);
});

test('Telegram re-add reports an old handle re-enabled while retaining the service setting', async t => {
  const {f,cfg}=await prepared(t,[{handle:'legacy',enabled:false,marker:'keep'}]);
  cfg.twitter.enabled=false;
  await saveMonitorConfig(cfg);
  await f.callback('mon:add-hint');
  await f.message('https://x.com/LEGACY');
  assert.equal(f.messages.at(-1),'✅ Twitter: @LEGACY (re-enabled)');
  const after=await loadMonitorConfig();
  assert.equal(after.twitter.enabled,false);
  assert.deepEqual(after.twitter.accounts[0],{...cfg.twitter.accounts[0],enabled:true});
});


test('monitor overview remains available with a malformed X row before or after a valid one', async t => {
  const {cfg}=await prepared(t,[null,{username:'neighbor',enabled:true}]);
  assert.match((await monitorScreen()).text,/источник\(а\) с ошибками/);
  assert.deepEqual((await loadMonitorConfig()).twitter,cfg.twitter);
  cfg.twitter.accounts.reverse();
  await saveMonitorConfig(cfg);
  assert.match((await monitorScreen()).text,/источник\(а\) с ошибками/);
  assert.deepEqual((await loadMonitorConfig()).twitter,cfg.twitter);
});
