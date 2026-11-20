/** Manual collection and digest share the production JSONL store. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { addSourceFromInput, monitorDir } from '../src/monitor/config.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const feedUrl = 'https://fixture.invalid/feed.xml';
const publishedAt = '2026-11-20T06:30:00.000Z';
const previousItem = JSON.stringify({ id: 'previous', sourceType: 'rss', title: 'Previous fixture item', publishedAt });
const feed = `<rss><channel><item><guid>fixture</guid><title>New fixture item</title>
  <link>https://fixture.invalid/item</link><pubDate>${publishedAt}</pubDate></item></channel></rss>`;

for (const [description, history, separator] of [
  ['an interrupted final record', `${previousItem}\n{"id":"interrupted","title":"partial`, '\n'],
  ['a valid final record without a newline', previousItem, '\n'],
  ['a normal newline-terminated file', `${previousItem}\n`, ''],
  ['an empty file', '', ''],
]) {
  test(`manual collection and digest preserve JSONL boundaries after ${description}`, async t => {
    const f = await fixture(t, undefined, { overlay: false });
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T07:00:00Z') });
    await addSourceFromInput(feedUrl);
    const file = path.join(monitorDir(), 'items.jsonl');
    await fs.writeFile(file, history);
    t.mock.method(globalThis, 'fetch', async target => {
      assert.equal(String(target), feedUrl);
      return { ok: true, text: async () => feed };
    });

    await f.callback('mon:poll:all');
    assert.match(f.messages.at(-1), /новых 1, ошибок 0/);
    await f.callback('digest:now');
    const digest = f.messages.at(-1);
    if (history) assert.match(digest, /Previous fixture item/);
    assert.match(digest, /New fixture item/);

    const after = await fs.readFile(file, 'utf8');
    const prefix = history + separator;
    assert.ok(after.startsWith(prefix + '{'));
    assert.ok(after.endsWith('\n'));
    assert.equal(JSON.parse(after.slice(prefix.length)).title, 'New fixture item');
    await f.callback('mon:poll:all');
    assert.match(f.messages.at(-1), /новых 0, ошибок 0/);
    assert.equal(await fs.readFile(file, 'utf8'), after);
  });
}
