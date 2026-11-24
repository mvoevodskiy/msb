/** Public channel collection must keep text and metadata with their own post. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSourceFromInput } from '../src/monitor/config.mjs';
import { pollAllSources } from '../src/monitor/poll.mjs';
import { itemId, listRecentItems } from '../src/monitor/store.mjs';

test('Telegram collection keeps text, permalink and time within each outer post', async t => {
  const root = await mkdtemp(join(tmpdir(), 'msb-telegram-posts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { MSB_RUNTIME_ROOT: root };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T13:00:00Z') });
  await addSourceFromInput('https://t.me/fixturechannel', env);

  const url = id => 'https://t.me/fixturechannel/' + id;
  const date = id => '2026-11-24T12:0' + (id % 100) + ':00.000Z';
  const footer = id => '<div class="tgme_widget_message_footer">'
    + '<a class="tgme_widget_message_date" href="' + url(id) + '"><time datetime="' + date(id)
    + '"></time></a></div>';
  const body = text => '<div class="tgme_widget_message_text js-message_text">' + text + '</div>';
  const widget = (id, content) =>
    '<div data-post="fixturechannel/' + id + '" class="tgme_widget_message js-widget_message">' + content + '</div>';
  const wrap = widget => '<div class="tgme_widget_message_wrap js-widget_message_wrap">' + widget + '</div>';
  const forwarded = '<div class="tgme_widget_message_forwarded_from">'
    + '<a class="tgme_widget_message_forwarded_from_name" href="https://t.me/other/1">Other</a></div>';
  const replyPreview = '<a class="tgme_widget_message_reply" href="' + url(105) + '">'
    + '<div class="tgme_widget_message_reply_text">Reply preview</div></a>';
  const embedded = widget(105, body('Embedded post (not a separate feed item)') + footer(105));
  const html = wrap(widget(101, '<div class="tgme_widget_message_bubble">'
    + forwarded + replyPreview + embedded + body('Own <b>first</b><div>nested &amp; text</div> tail')
    + footer(101) + '</div>'))
    + wrap(widget(102, '<a class="tgme_widget_message_photo_wrap" href="' + url(102) + '"></a>' + footer(102)))
    + wrap(widget(103, body('Third &lt;text&gt;') + footer(103)))
    + wrap(widget(104, body('Incomplete post') + footer(105)))
    + wrap(widget(106, body('Final entry') + footer(106)));
  t.mock.method(globalThis, 'fetch', async target => {
    assert.equal(String(target), 'https://t.me/s/fixturechannel');
    return new Response(html);
  });

  const collected = await pollAllSources(env, { log() {} });
  assert.deepEqual(collected.errors, []);
  const items = await listRecentItems({}, env);
  assert.deepEqual(items.map(({ id, externalId, title, url, publishedAt, summary }) => ({
    id, externalId, title, url, publishedAt, summary,
  })), [
    [106, 'Final entry'], [103, 'Third <text>'], [102, ''], [101, 'Own first nested & text tail'],
  ].map(([id, summary]) => ({
    id: itemId('telegram', 'fixturechannel', url(id), url(id)),
    externalId: url(id), title: summary || url(id), url: url(id), publishedAt: date(id), summary,
  })));
  assert.equal(collected.added, items.length);
  assert.equal((await pollAllSources(env, { log() {} })).added, 0);
});
