/**
 * Re-adding a disabled Twitter source follows old GHA/OQA:
 * git show 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11 | nl -ba
 * lines 5727–5754, 43261–43264. Uses only synthetic Telegram and profile files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/menu-fixture.mjs';
import { addSourceFromInput, loadMonitorConfig, saveMonitorConfig } from '../src/monitor/config.mjs';

async function prepared(t) {
  const f = await fixture(t, undefined, {overlay:false});
  const cfg = await loadMonitorConfig();
  cfg.twitter.enabled = true;
  cfg.twitter.accounts = [
    { username: 'Existing', name: '@Existing', enabled: false, addedAt: '2020-01-01T00:00:00Z', marker: 'preserve' },
    { username: 'Other', name: '@Other', enabled: false, marker: 'other' },
  ];
  cfg.telegram.enabled = true;
  cfg.telegram.channels = [{username:'Existing',name:'@Existing',enabled:false,marker:'different-provider'}];
  await saveMonitorConfig(cfg);
  return { f, cfg };
}

test('selecting Twitter for an existing disabled account re-enables only that record and reports it', async t => {
  const {f,cfg:before} = await prepared(t);
  await f.callback('mon:add-hint'); await f.message('@existing');
  const id = f.messages.length;
  await f.callback('mon:add:as:twitter',42,{messageId:id});
  const after = await loadMonitorConfig();
  assert.deepEqual(after.twitter.accounts[0], {...before.twitter.accounts[0], enabled:true});
  assert.deepEqual(after.twitter.accounts[1], before.twitter.accounts[1]);
  assert.deepEqual(after.telegram, before.telegram);
  assert.match(f.messages.at(-1), /✅ Twitter: @existing \(re-enabled\)/);
});

test('direct URL re-enables once, repeated concurrent additions preserve one record and other settings', async t => {
  const {cfg:before} = await prepared(t);
  const results = await Promise.all([
    addSourceFromInput('https://x.com/EXISTING'),
    addSourceFromInput('https://twitter.com/existing'),
  ]);
  assert.equal(results.filter(x => x.reason === 're-enabled').length, 1);
  assert.equal(results.filter(x => x.added === false).length, 1);
  const after = await loadMonitorConfig();
  assert.equal(after.twitter.accounts.length, 2);
  assert.deepEqual(after.twitter.accounts[0], {...before.twitter.accounts[0], enabled:true});
  assert.deepEqual(after.twitter.accounts[1], before.twitter.accounts[1]);
  assert.deepEqual(after.digest, before.digest);
});

test('an existing account with no enabled field is already active and is not rewritten', async t => {
  const {cfg} = await prepared(t);
  delete cfg.twitter.accounts[0].enabled;
  await saveMonitorConfig(cfg);
  const result = await addSourceFromInput('https://x.com/EXISTING');
  assert.equal(result.added, false);
  assert.equal(Object.hasOwn((await loadMonitorConfig()).twitter.accounts[0], 'enabled'), false);
});

test('re-enabling one account leaves an independently disabled X service disabled', async t => {
  const {cfg} = await prepared(t);
  cfg.twitter.enabled = false;
  await saveMonitorConfig(cfg);
  const result = await addSourceFromInput('https://x.com/existing');
  assert.equal(result.reason, 're-enabled');
  const after = await loadMonitorConfig();
  assert.equal(after.twitter.accounts[0].enabled, true);
  assert.equal(after.twitter.enabled, false);
});

test('an explicit X URL reports the old re-enabled result through the Telegram form', async t => {
  const {f} = await prepared(t);
  await f.callback('mon:add-hint');
  await f.message('https://x.com/Existing');
  assert.equal(f.messages.at(-1), '✅ Twitter: @Existing (re-enabled)');
  assert.equal((await loadMonitorConfig()).twitter.accounts[0].enabled, true);
});
