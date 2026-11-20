/** The Monitoring screen displays the latest persisted successful source time. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addSourceFromInput } from '../src/monitor/config.mjs';
import { sourceCallbackData } from '../src/monitor/source-ref.mjs';
import { loadMeta, saveMeta } from '../src/monitor/store.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const feedUrl = 'https://fixture.invalid/feed.xml';
const sourceKey = `rss:${feedUrl}`;
const early = '2026-11-20T07:00:00.000Z';
const latest = '2026-11-20T07:01:00.000Z';
const emptyRss = { ok: true, text: async () => '<rss><channel></channel></rss>' };

test('an older overlapping collection cannot roll back the last successful source time on the Monitoring screen', { timeout: 5_000 }, async t => {
  const f = await fixture(t, undefined, { overlay: false });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(early) });
  const slowUrl = 'https://fixture.invalid/slow.xml';
  await addSourceFromInput(feedUrl);
  await addSourceFromInput(slowUrl);
  const reachedSlow = Promise.withResolvers();
  const finishSlow = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async target => {
    if (String(target) === feedUrl) return emptyRss;
    assert.equal(String(target), slowUrl);
    reachedSlow.resolve();
    await finishSlow.promise;
    return { ok: false, status: 503 };
  });

  const older = f.callback('mon:poll:all');
  try {
    await Promise.race([reachedSlow.promise, older.then(() => assert.fail('The older collection did not reach the slow source'))]);
    await f.callback(sourceCallbackData('rss', slowUrl));
    t.mock.timers.setTime(Date.parse(latest));
    await f.callback('mon:poll:all');
    assert.match(f.edits.at(-1), /Последний сбор: 2026-11-20 07:01:00/);
  } finally {
    finishSlow.resolve();
    await older;
  }

  await f.callback('mon:back');
  assert.deepEqual({
    saved: (await loadMeta()).lastPollAt[sourceKey],
    displayed: f.edits.at(-1).match(/Последний сбор: .*$/m)?.[0],
  }, {
    saved: latest,
    displayed: 'Последний сбор: 2026-11-20 07:01:00',
  });
});

test('a successful collection advances an earlier mark or replaces a malformed one', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(latest) });
  const otherKey = 'rss:https://fixture.invalid/other.xml';
  await addSourceFromInput(feedUrl);
  await addSourceFromInput('https://fixture.invalid/other.xml');
  await saveMeta({ lastPollAt: { [sourceKey]: early, [otherKey]: { toString: 'malformed' } }, lastDigestAt: early });
  t.mock.method(globalThis, 'fetch', async () => emptyRss);

  await f.callback('mon:poll:all');

  assert.deepEqual(await loadMeta(), { lastPollAt: { [sourceKey]: latest, [otherKey]: latest }, lastDigestAt: early });
});
