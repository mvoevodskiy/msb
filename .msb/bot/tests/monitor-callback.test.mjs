import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addSourceFromInput, loadMonitorConfig, saveMonitorConfig } from '../src/monitor/config.mjs';
import { handleMonitorRoute } from '../src/telegram/routes/monitor.mjs';
import { monitorSourcesScreen } from '../src/telegram/screens/monitor.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-callback-'));
  const previous = { profile: process.env.MSB_RUNTIME_PROFILE, root: process.env.MSB_RUNTIME_ROOT };
  process.env.MSB_RUNTIME_PROFILE = 'jar1';
  process.env.MSB_RUNTIME_ROOT = root;
  t.after(async () => {
    if (previous.profile === undefined) delete process.env.MSB_RUNTIME_PROFILE;
    else process.env.MSB_RUNTIME_PROFILE = previous.profile;
    if (previous.root === undefined) delete process.env.MSB_RUNTIME_ROOT;
    else process.env.MSB_RUNTIME_ROOT = previous.root;
    await fs.rm(root, { recursive: true, force: true });
  });
  const click = (data) => handleMonitorRoute({ data, show: async () => {}, pending: new Map(), chatId: 42, bot: {} });
  const buttons = async () => (await monitorSourcesScreen()).keyboard.inline_keyboard.flat()
    .filter((button) => button.text?.startsWith('🗑'));
  return { click, buttons };
}

test('long Unicode sources use bounded stable callbacks and a stale button cannot remove a neighbor', async (t) => {
  const f = await fixture(t);
  const a = `https://example.invalid/${'новости'.repeat(8)}/first.xml`;
  const b = `https://example.invalid/${'новости'.repeat(8)}/second.xml`;
  await addSourceFromInput(a);
  await addSourceFromInput(b);
  const buttons = await f.buttons();
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((button) => Buffer.byteLength(button.callback_data) <= 64));
  assert.notEqual(buttons[0].callback_data, buttons[1].callback_data);
  const cfg = await loadMonitorConfig();
  cfg.rss.feeds.reverse();
  await saveMonitorConfig(cfg);
  await f.click(buttons[0].callback_data);
  assert.deepEqual((await loadMonitorConfig()).rss.feeds.map((feed) => feed.url), [b]);
  await f.click(buttons[0].callback_data);
  assert.deepEqual((await loadMonitorConfig()).rss.feeds.map((feed) => feed.url), [b]);
});

test('old short callback format still removes its source', async (t) => {
  const f = await fixture(t);
  const url = 'https://a.co/feed';
  await addSourceFromInput(url);
  const [button] = await f.buttons();
  assert.equal(button.callback_data, `mon:src-del:rss:${encodeURIComponent(url)}`);
  await f.click(button.callback_data);
  assert.equal((await loadMonitorConfig()).rss.feeds.length, 0);
});

test('a token made from a YouTube handle still works after channel resolution', async (t) => {
  const f = await fixture(t);
  const handle = `long${'name'.repeat(20)}`;
  await addSourceFromInput(`https://youtube.com/@${handle}`);
  const [button] = await f.buttons();
  assert.match(button.callback_data, /^mon:src-key:/);
  const cfg = await loadMonitorConfig();
  cfg.youtube.channels[0].channelId = 'UCabcdefghijabcdefghijab';
  await saveMonitorConfig(cfg);
  await f.click(button.callback_data);
  assert.equal((await loadMonitorConfig()).youtube.channels.length, 0);
});

test('an ambiguous token does not remove any source', async (t) => {
  const f = await fixture(t);
  const url = `https://example.invalid/${'long'.repeat(20)}/feed.xml`;
  await addSourceFromInput(url);
  const [button] = await f.buttons();
  const cfg = await loadMonitorConfig();
  cfg.rss.feeds.push({ ...cfg.rss.feeds[0] });
  await saveMonitorConfig(cfg);
  await f.click(button.callback_data);
  assert.equal((await loadMonitorConfig()).rss.feeds.length, 2);
});
