/** A fresh Telegram page can repair an existing shifted item in the JSONL digest. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSourceFromInput, monitorDir } from '../src/monitor/config.mjs';
import { buildDigestText } from '../src/monitor/digest.mjs';
import { pollAllSources } from '../src/monitor/poll.mjs';
import { appendItems, itemId, listRecentItems } from '../src/monitor/store.mjs';

const channel = 'fixturechannel';
const articleUrl = `https://t.me/${channel}/101`;
const publishedAt = '2026-11-24T11:00:00.000Z';
const savedAt = '2026-11-24T11:15:00.000Z';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'msb-telegram-repair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { MSB_RUNTIME_ROOT: root };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T13:00:00Z') });
  await addSourceFromInput(`https://t.me/${channel}`, env);

  const legacy = {
    id: itemId('telegram', channel, articleUrl, articleUrl),
    sourceType: 'telegram', sourceId: channel, sourceName: 'Original source name',
    title: 'Shifted text from the next post', summary: 'Shifted text from the next post',
    url: articleUrl, externalId: articleUrl, publishedAt: '2026-11-24T11:01:00.000Z',
    savedAt, custom: { keep: true },
  };
  const unmatchedUrl = `https://t.me/${channel}/99`;
  const unmatched = Buffer.from('  ' + JSON.stringify({
    ...legacy, id: itemId('telegram', channel, unmatchedUrl, unmatchedUrl),
    title: 'Unobserved post', url: unmatchedUrl, externalId: unmatchedUrl,
  }) + '\r\n');
  const rss = Buffer.from('  {"id":"rss-previous","title":"Unrelated RSS","savedAt":"' + savedAt + '"}  \r\n');
  const partial = Buffer.concat([Buffer.from('{"unclosed":"'), Buffer.from([0xff])]);
  const original = Buffer.concat([rss, unmatched, Buffer.from(JSON.stringify(legacy) + '\n'), partial]);
  const file = join(monitorDir(env), 'items.jsonl');
  await fs.writeFile(file, original, { mode: 0o640 });
  await fs.chmod(file, 0o640);

  const post = (id, title) => '<div class="tgme_widget_message js-widget_message" data-post="' + channel + '/' + id + '">'
    + '<div class="tgme_widget_message_text js-message_text">' + title + '</div>'
    + '<a class="tgme_widget_message_date" href="https://t.me/' + channel + '/' + id + '">'
    + '<time datetime="' + publishedAt + '"></time></a></div>';
  let firstTitle = 'Correct public caption';
  t.mock.method(globalThis, 'fetch', async target => {
    assert.equal(String(target), `https://t.me/s/${channel}`);
    return new Response(post(101, firstTitle) + post(102, 'New public post'));
  });
  return {
    env, file, legacy, original, rss, unmatched, partial, edit: () => { firstTitle = 'Later Telegram edit'; },
    poll: () => pollAllSources(env, { log() {} }),
  };
}

test('concurrent re-poll repairs persisted legacy Telegram content without counting it as new', async t => {
  const f = await fixture(t);
  assert.match((await buildDigestText(f.env)).text, /Shifted text from the next post/);

  const results = await Promise.all([f.poll(), f.poll()]);
  assert.deepEqual(results.map(result => result.errors), [[], []]);
  assert.equal(results.reduce((sum, result) => sum + result.added, 0), 1);
  const digest = await buildDigestText(f.env);
  assert.match(digest.text, /Correct public caption/);
  assert.match(digest.text, /New public post/);
  assert.doesNotMatch(digest.text, /Shifted text from the next post/);
  assert.equal(digest.count, 4);
  const items = await listRecentItems({}, f.env);
  const repaired = items.find(item => item.url === articleUrl);
  assert.equal(items.filter(item => item.url === articleUrl).length, 1);
  assert.deepEqual(repaired, {
    ...f.legacy,
    title: 'Correct public caption', summary: 'Correct public caption', publishedAt,
    telegramPostVerified: true,
  });

  const repairedBytes = await fs.readFile(f.file);
  assert.deepEqual(repairedBytes.subarray(0, f.rss.length + f.unmatched.length), Buffer.concat([f.rss, f.unmatched]));
  assert.notEqual(repairedBytes.indexOf(Buffer.concat([f.partial, Buffer.from('\n')])), -1);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o640);
  assert.equal((await f.poll()).added, 0);
  f.edit();
  assert.equal((await f.poll()).added, 0);
  assert.deepEqual(await fs.readFile(f.file), repairedBytes);
});

test('a failed replacement leaves the previous JSONL bytes intact and the collection can retry', async t => {
  const f = await fixture(t);
  const target = await fs.realpath(f.file);
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === target) throw new Error('simulated items commit failure');
    return rename(from, to);
  });
  await assert.rejects(f.poll(), /simulated items commit failure/);
  assert.deepEqual(await fs.readFile(f.file), f.original);
  mock.mock.restore();
  assert.equal((await f.poll()).added, 1);
  assert.match((await buildDigestText(f.env)).text, /Correct public caption/);
});

test('an older duplicate outside the old append window cannot reappear in the repaired digest', async t => {
  const f = await fixture(t);
  const stale = { ...f.legacy, title: 'Earlier duplicate with wrong text' };
  const expired = '{"id":"filler","publishedAt":"2000-01-01T00:00:00Z"}\n';
  await fs.writeFile(f.file, Buffer.concat([Buffer.from(JSON.stringify(stale) + '\n' + expired.repeat(5001)), f.original]));
  await f.poll();
  const digest = await buildDigestText(f.env);
  assert.doesNotMatch(digest.text, /Earlier duplicate|Shifted text/);
  assert.equal((digest.text.match(/Correct public caption/g) || []).length, 1);
  assert.ok((await fs.readFile(f.file)).includes(Buffer.from(JSON.stringify(stale))));
});

test('an unreadable items file aborts the Telegram repair without appending', async t => {
  const f = await fixture(t);
  const target = await fs.realpath(f.file);
  const readFile = fs.readFile;
  const unreadable = Object.assign(new Error('simulated items read failure'), { code: 'EACCES' });
  const mock = t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === target) throw unreadable;
    return readFile(file, ...args);
  });
  await assert.rejects(f.poll(), unreadable);
  mock.mock.restore();
  assert.deepEqual(await fs.readFile(f.file), f.original);
});

test('repair through a journal symlink and append through its target share the same file', async t => {
  const f = await fixture(t);
  const targetEnv = { MSB_RUNTIME_ROOT: join(f.env.MSB_RUNTIME_ROOT, 'target') };
  await fs.mkdir(monitorDir(targetEnv), { recursive: true });
  const target = join(monitorDir(targetEnv), 'items.jsonl');
  await fs.rename(f.file, target);
  await fs.symlink(target, f.file);

  const [polled, added] = await Promise.all([
    f.poll(),
    appendItems([{ id: 'second-writer', title: 'Second writer item', publishedAt }], targetEnv),
  ]);
  assert.equal(polled.added, 1);
  assert.equal(added, 1);
  assert.equal(await fs.readlink(f.file), target);
  assert.ok((await fs.stat(target + '.lock.sqlite')).isFile());
  await assert.rejects(fs.lstat(f.file + '.lock.sqlite'), { code: 'ENOENT' });
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  const digest = await buildDigestText(f.env);
  assert.match(digest.text, /Correct public caption/);
  assert.match(digest.text, /Second writer item/);
  assert.equal(digest.count, 5);
});
