/** Verify the real callback and scheduled delivery with a bounded fake Bot API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot, InputFile } from 'grammy';
import { defaultConfig, saveMonitorConfig } from '../src/monitor/config.mjs';
import { buildDigestText, maybeSendDigest } from '../src/monitor/digest.mjs';
import { appendItems, loadMeta } from '../src/monitor/store.mjs';
import { saveState } from '../src/state.mjs';
import { createBot } from '../src/telegram/bot.mjs';
import { handleMonitorRoute } from '../src/telegram/routes/monitor.mjs';

const now = '2026-11-24T09:15:00.000Z';
const maxText = 4096;
const chat = 42;

function visibleText(html) {
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>' };
  return html.replace(/<\/?b>/g, '').replace(/&(?:amp|lt|gt);/g, entity => entities[entity]);
}

async function fixture(t, titles, urls = titles.map((_, i) => `https://fixture.invalid/${i}?x=1&y=2`)) {
  const root = await mkdtemp(join(tmpdir(), 'msb-digest-delivery-'));
  const previous = { MSB_RUNTIME_ROOT: process.env.MSB_RUNTIME_ROOT, MSB_BOT_ID: process.env.MSB_BOT_ID };
  process.env.MSB_RUNTIME_ROOT = root;
  process.env.MSB_BOT_ID = 'default';
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const config = defaultConfig();
  config.digest = { ...config.digest, hour: 9, topN: 25 };
  await saveMonitorConfig(config);
  await saveState({ timezone: 'UTC' });
  await appendItems(titles.map((title, i) => ({
    id: String(i), title, sourceType: 'rss', sourceName: 'News & updates',
    url: urls[i], publishedAt: new Date(Date.now() - i * 60_000).toISOString(),
  })));

  const messages = [], files = [], fileOptions = [], views = [];
  const api = {
    async sendMessage(chatId, text, options) {
      assert.equal(chatId, chat);
      if (visibleText(text).length > maxText) throw new Error('Bot API: message is too long');
      messages.push({ text, options });
    },
    async sendDocument(chatId, file, options) {
      assert.equal(chatId, chat);
      assert.ok(file instanceof InputFile);
      assert.match(file.filename, /\.html$/);
      const bytes = await file.toRaw();
      files.push(Buffer.from(bytes).toString('utf8'));
      fileOptions.push(options);
    },
  };
  return {
    api, messages, files, fileOptions, views, urls,
    manual: threadId => handleMonitorRoute({ data: 'digest:now', chatId: chat, bot: { api },
      ctx: { callbackQuery: { message: { message_thread_id: threadId } } }, show: view => views.push(view) }),
    scheduled: () => maybeSendDigest({ api, adminId: chat, log() {} }),
  };
}

function assertDocument(document, digest, expectedUrls) {
  assert.match(document, /<!doctype html>/i);
  assert.ok(document.includes('<meta charset="utf-8">'));
  const anchors = /<a href="([^"]*)">([^<]*)<\/a>/g;
  const targets = Array.from(document.matchAll(anchors), match => match[1].replaceAll('&amp;', '&'));
  assert.deepEqual(targets, expectedUrls, 'links follow exactly the selected materials in order');
  assert.ok(document.replace(anchors, '$2').includes(digest.text), 'all visible fields retain their formatting');
}

test('25 articles remain in order in one document for both manual and scheduled delivery', async t => {
  const titles = Array.from({ length: 25 }, (_, i) => `Article ${i} ` + 'a'.repeat(180));
  const f = await fixture(t, titles);
  const digest = await buildDigestText();
  assert.ok(visibleText(digest.text).length > maxText);

  await f.manual(55);
  assert.equal(f.views.length, 1);
  assert.equal((await loadMeta()).lastDigestAt, null);
  assert.deepEqual(await f.scheduled(), { sent: true, count: 25 });
  assert.equal((await loadMeta()).lastDigestAt, now);
  assert.deepEqual(await f.scheduled(), { sent: false, reason: 'already' });

  assert.deepEqual(f.messages, []);
  assert.equal(f.files.length, 2);
  assert.deepEqual(f.fileOptions, [{ message_thread_id: 55 }, undefined]);
  for (const doc of f.files) assertDocument(doc, digest, f.urls);
});

test('document anchors use only the article HTTP(S) URL, including its query and fragment', async t => {
  const title = 'References https://other.invalid/title <А> & Б. '.repeat(95);
  const f = await fixture(t, [title, 'HTTP article', 'Archived URL', 'Missing URL', 'Relative URL'], [
    'https://fixture.invalid/отчёт?q="часть"&page=2#итог', 'http://fixture.invalid/item?x=1&y=2',
    'mailto:desk@fixture.invalid', undefined, '../archive',
  ]);
  const digest = await buildDigestText();
  await f.manual();
  assert.equal(f.files.length, 1);
  assertDocument(f.files[0], digest, [
    new URL('https://fixture.invalid/отчёт?q="часть"&page=2#итог').href, f.urls[1],
  ]);
  assert.ok(f.files[0].includes('>https://fixture.invalid/отчёт?q="часть"&amp;page=2#итог</a>'));
});

test('a digest at the after-entities limit stays one HTML chat message', async t => {
  // 4096 UTF-16 units of visible text for the fixed single-item fixture layout.
  const scaffolding = '📨 Дайджест · 1 материалов\n\n• News & updates · 2026-11-24 09:15\n  \n  https://fixture.invalid/0?x=1&y=2\n';
  const f = await fixture(t, ['<&'.repeat((maxText - scaffolding.length) / 2)
    + 'x'.repeat((maxText - scaffolding.length) % 2)]);
  const digest = await buildDigestText();
  assert.equal(visibleText(digest.text).length, maxText);
  assert.ok(digest.text.length > maxText);

  await f.manual();
  assert.deepEqual(await f.scheduled(), { sent: true, count: 1 });
  assert.deepEqual(f.messages, [
    { text: digest.text, options: { parse_mode: 'HTML' } },
    { text: digest.text, options: { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } },
  ]);
  assert.deepEqual(f.files, []);
  assert.ok(!f.messages[0].text.includes('<a '));
});

test('a single giant article is retried as one document and marked only after success', async t => {
  const f = await fixture(t, ['<script>alert("escaped")</script> ' + '🐘 & '.repeat(1400)]);
  const digest = await buildDigestText();
  const sendDocument = f.api.sendDocument;
  f.api.sendDocument = async () => { throw new Error('upload unavailable'); };

  await assert.rejects(f.scheduled(), /upload unavailable/);
  assert.equal((await loadMeta()).lastDigestAt, null);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.files, []);

  f.api.sendDocument = sendDocument;
  assert.deepEqual(await f.scheduled(), { sent: true, count: 1 });
  assert.equal((await loadMeta()).lastDigestAt, now);
  assert.equal(f.files.length, 1);
  assertDocument(f.files[0], digest, f.urls);
  assert.ok(!f.files[0].includes('<script>'));
  await f.manual();
  assert.equal(f.files.length, 2);
  assertDocument(f.files[1], digest, f.urls);
});

test('/digest delivers a long digest to the invoking topic as one document', async t => {
  const f = await fixture(t, ['Long title '.repeat(450)]);
  const digest = await buildDigestText();
  const bot = new Bot('unused', { botInfo: { id: 123, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' } });
  const deliveries = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === 'setMyCommands') return { ok: true, result: true };
    deliveries.push({ method, payload });
    if (method === 'sendMessage') await f.api.sendMessage(payload.chat_id, payload.text);
    if (method === 'sendDocument') await f.api.sendDocument(payload.chat_id, payload.document);
    return { ok: true, result: {} };
  });
  createBot({ botToken: 'unused', adminId: chat }, { bot });
  t.after(() => bot.stop());

  await bot.handleUpdate({ update_id: 1, message: {
    message_id: 10, date: Date.now() / 1000, text: '/digest',
    entities: [{ type: 'bot_command', offset: 0, length: 7 }],
    from: { id: chat, is_bot: false, first_name: 'Fixture' },
    chat: { id: chat, type: 'supergroup', title: 'Fixture', is_forum: true },
    is_topic_message: true, message_thread_id: 9,
  } });
  assert.deepEqual(deliveries.map(({ method, payload }) => [method, payload.chat_id, payload.message_thread_id]),
    [['sendDocument', chat, 9]]);
  assert.equal((await loadMeta()).lastDigestAt, null);
  assert.equal(f.files.length, 1);
  assertDocument(f.files[0], digest, f.urls);
});
