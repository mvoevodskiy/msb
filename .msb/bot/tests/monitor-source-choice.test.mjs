/**
 * Telegram source input restores the old ambiguous @name choice.
 * Old blob 73aa9e7e: classifier 102248–102303, choice 118820–118880,
 * callback 117271–117299. Production routes: forms/monitor -> routes/monitor.
 * All Telegram, profiles and source records below are synthetic and local.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { addSourceFromInput, classifySourceInput, loadMonitorConfig } from '../src/monitor/config.mjs';

const buttons = options => options.reply_markup.inline_keyboard.flat().map(b => [b.text, b.callback_data]);
async function startChoice(f, value) {
  await f.callback('mon:add-hint');
  await f.message(value);
  const id = f.messages.length;
  assert.equal(f.messages.at(-1), 'Не понял, что это: у Telegram и Twitter ник выглядит одинаково.\n' + value);
  assert.deepEqual(buttons(f.messageOptions.at(-1)), [
    ['Telegram', 'mon:add:as:telegram'], ['Twitter', 'mon:add:as:twitter'], ['Отмена', 'mon:add:cancel'],
  ]);
  return id;
}

test('adding a source replaces the list keyboard and Cancel exits only that input', async t => {
  const turns = [];
  const f = await fixture(t, async ({ prompt }) => {
    turns.push(prompt);
    return { ok: true, text: 'fixture' };
  }, { overlay: false });
  await addSourceFromInput('https://t.me/kept');
  await f.callback('mon:sources', 42, { messageId: 17 });
  await f.callback('mon:add-hint', 42, { messageId: 17 });
  assert.deepEqual(buttons(f.editOptions.at(-1)), [['Отмена', 'mon:add:cancel']]);

  await f.callback('mon:add:cancel', 42, { messageId: 17 });
  assert.match(f.edits.at(-1), /Источники/);
  await f.message('ordinary task after cancellation');
  for (let i = 0; turns.length === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(turns, ['ordinary task after cancellation']);
  assert.deepEqual((await loadMonitorConfig()).telegram.channels.map(row => row.username), ['kept']);
});

for (const type of ['telegram', 'twitter']) {
  test(`ambiguous @name asks before adding, then adds only selected ${type}`, async t => {
    const f = await fixture(t, undefined, {overlay:false});
    const id = await startChoice(f, '@examplechannel');
    let cfg = await loadMonitorConfig();
    assert.equal(cfg.telegram.channels.length + cfg.twitter.accounts.length, 0);
    await f.callback('mon:add:as:' + type, 42, {messageId:id});
    cfg = await loadMonitorConfig();
    assert.equal(cfg[type][type === 'telegram' ? 'channels' : 'accounts'].length, 1);
    assert.equal(cfg[type === 'telegram' ? 'twitter' : 'telegram'][type === 'telegram' ? 'accounts' : 'channels'].length, 0);
    assert.match(f.messages.at(-1), new RegExp('✅ ' + (type === 'telegram' ? 'Telegram' : 'Twitter') + ': @examplechannel'));
    await f.callback('mon:add:as:' + type, 42, {messageId:id});
    cfg = await loadMonitorConfig();
    assert.equal(cfg[type][type === 'telegram' ? 'channels' : 'accounts'].length, 1, 'Repeated clicks must not add twice.');
  });
}

test('source choice is scoped to the originating prompt; stale and unauthorised callbacks cannot add or cancel the new draft', async t => {
  const f = await fixture(t, undefined, {overlay:false});
  const oldId = await startChoice(f, '@first');
  const newId = await startChoice(f, '@second');
  await f.callback('mon:add:as:twitter', 43, {messageId:newId});
  await f.callback('mon:add:as:twitter', 42, {messageId:oldId});
  assert.equal((await loadMonitorConfig()).twitter.accounts.length, 0);
  await f.callback('mon:add:as:telegram', 42, {messageId:newId});
  assert.deepEqual((await loadMonitorConfig()).telegram.channels.map(x => x.username), ['second']);
});

for (const cancel of ['mon:add:cancel', '/start']) {
  test(`source choice: ${cancel} cancels the pending choice without adding`, async t => {
    const f = await fixture(t, undefined, {overlay:false});
    const id = await startChoice(f, '@examplechannel');
    if (cancel.startsWith('/')) await f.message(cancel); else await f.callback(cancel, 42, {messageId:id});
    await f.callback('mon:add:as:telegram', 42, {messageId:id});
    const cfg = await loadMonitorConfig();
    assert.equal(cfg.telegram.channels.length + cfg.twitter.accounts.length, 0);
  });
}

test('stale sources navigation cannot clear a newer pending choice', async t => {
  const f = await fixture(t, undefined, {overlay:false});
  await f.callback('mon:add-hint'); await f.message('@first');
  const first = f.messages.length;
  await f.callback('mon:add-hint'); await f.message('@second');
  const second = f.messages.length;
  await f.callback('mon:sources', 42, {messageId:first});
  await f.callback('mon:add:as:telegram', 42, {messageId:second});
  assert.deepEqual((await loadMonitorConfig()).telegram.channels.map(x => x.username), ['second']);
});

test('a stale cancel cannot cancel a newer choice or a new source input', async t => {
  const f = await fixture(t, undefined, {overlay:false});
  const first = await startChoice(f, '@first');
  const second = await startChoice(f, '@second');
  await f.callback('mon:add:cancel', 42, {messageId:first});
  await f.callback('mon:add:as:telegram', 42, {messageId:second});
  assert.deepEqual((await loadMonitorConfig()).telegram.channels.map(x => x.username), ['second']);
  const third = await startChoice(f, '@third');
  await f.callback('mon:add-hint');
  await f.callback('mon:add:cancel', 42, {messageId:third});
  await f.message('@fourth');
  assert.match(f.messages.at(-1), /у Telegram и Twitter ник выглядит одинаково/);
  const fourth = f.messages.length;
  await f.callback('mon:add:as:twitter', 42, {messageId:fourth});
  assert.deepEqual((await loadMonitorConfig()).twitter.accounts.map(x => x.username), ['fourth']);
});

test('direct source API refuses ambiguous handles until the caller identifies the service', async t => {
  const f = await fixture(t, undefined, {overlay:false});
  const name = '@ExampleChannel';
  assert.equal(classifySourceInput(name).type, 'ambiguous');
  const unknown = await addSourceFromInput(name);
  assert.equal(unknown.needsChoice, true);
  await assert.rejects(fs.stat(path.join(f.home,'.msb/monitor/config.json')), {code:'ENOENT'});
  assert.equal((await addSourceFromInput(name, process.env, {type:'telegram'})).type, 'telegram');
  assert.equal((await addSourceFromInput(name, process.env, {type:'twitter'})).type, 'twitter');
  const cfg = await loadMonitorConfig();
  assert.equal(cfg.telegram.channels.length, 1);
  assert.equal(cfg.twitter.accounts.length, 1);
});

test('explicit X and Telegram URLs continue to add directly; longer Telegram handles still ask', async t => {
  const f = await fixture(t, undefined, {overlay:false});
  await f.callback('mon:add-hint');
  await f.message('https://x.com/first');
  await f.callback('mon:add-hint');
  await f.message('https://t.me/second');
  let cfg = await loadMonitorConfig();
  assert.deepEqual(cfg.twitter.accounts.map(x => x.username), ['first']);
  assert.deepEqual(cfg.telegram.channels.map(x => x.username), ['second']);
  const id = await startChoice(f, '@channel_name_longer_than_fifteen');
  await f.callback('mon:add:as:telegram',42,{messageId:id});
  cfg = await loadMonitorConfig();
  assert.equal(cfg.telegram.channels.length, 2);
});

test('selecting a source preserves existing accounts, feeds and digest settings', async t => {
  const f = await fixture(t, undefined, {overlay:false});
  for (const url of ['https://x.com/existing', 'https://t.me/otherchannel', 'https://example.invalid/feed.xml']) {
    assert.equal((await addSourceFromInput(url)).ok, true);
  }
  const before = await loadMonitorConfig();
  const id = await startChoice(f, '@newchannel');
  await f.callback('mon:add:as:telegram', 42, {messageId:id});
  const after = await loadMonitorConfig();
  assert.deepEqual(after.twitter, before.twitter);
  assert.deepEqual(after.rss, before.rss);
  assert.deepEqual(after.digest, before.digest);
  assert.deepEqual(after.telegram.channels.slice(0,1), before.telegram.channels);
  assert.equal(classifySourceInput('@a').type, 'twitter', 'Preserve the existing one-character X input.');
});

test('a delayed old prompt cannot overwrite the newer source choice', async t => {
  const f = await fixture(t, undefined, {overlay:false});
  const originalSend = f.bot.api.sendMessage;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.bot.api.sendMessage = async (...args) => {
    if (args[1]?.endsWith('\n@first')) { entered(); await gate; }
    return originalSend(...args);
  };
  await f.callback('mon:add-hint');
  const first = f.message('@first');
  await started;
  const secondId = await startChoice(f, '@second');
  release(); await first;
  await f.callback('mon:add:as:telegram',42,{messageId:secondId});
  assert.deepEqual((await loadMonitorConfig()).telegram.channels.map(x => x.username), ['second']);
});
