import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { openDb } from '../../src/server/db.ts';
import { classifyTgUpdate, runTgInbox } from '../../src/server/tg-inbox.ts';
import { config, tmpDir } from './helpers.ts';

test('classifyTgUpdate: владелец, чужой, не-личное', () => {
  const owner = classifyTgUpdate({
    update_id: 10,
    message: { chat: { id: 1857089, type: 'private' }, text: 'кнопка' },
  }, '1857089');
  assert.equal(owner.kind, 'owner');
  assert.equal(owner.msg?.text, 'кнопка');

  const stranger = classifyTgUpdate({
    update_id: 11,
    message: { chat: { id: 999, type: 'private' }, text: 'привет' },
  }, '1857089');
  assert.equal(stranger.kind, 'stranger');

  const group = classifyTgUpdate({
    update_id: 12,
    message: { chat: { id: -100, type: 'group' }, text: 'x' },
  }, '1857089');
  assert.equal(group.kind, 'ignore');

  const photo = classifyTgUpdate({
    update_id: 13,
    message: { chat: { id: 1857089, type: 'private' }, caption: 'фото' },
  }, '1857089');
  assert.equal(photo.kind, 'owner');
  assert.equal(photo.msg?.text, 'фото');
});

test('runTgInbox: владельцу — onOwnerMessage, чужому — нет; offset растёт', async t => {
  const dir = tmpDir(t);
  const cfg = config(dir);
  const db = openDb(dir);
  t.after(() => db.close());
  const { kvGet, kvSet } = await import('../../src/server/db.ts');
  // Смещение уже есть — без сброса «хвоста», иначе тестовые updates съест bootstrap.
  kvSet(db, 'tg_updates_offset', '100');

  const ownerHits: string[] = [];
  const logs: string[] = [];
  let round = 0;
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    const method = (req.url ?? '').split('/').pop();
    if (method === 'deleteWebhook') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (method === 'getUpdates') {
      round++;
      const result = round === 1
        ? [
            { update_id: 100, message: { chat: { id: 999, type: 'private' }, text: 'хак' } },
            { update_id: 101, message: { chat: { id: Number(cfg.tg!.chatId), type: 'private' }, text: 'дай' } },
          ]
        : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    res.writeHead(404);
    res.end();
    void body;
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ac = new AbortController();
  const done = runTgInbox({
    tg: { token: cfg.tg!.token, chatId: cfg.tg!.chatId, apiBase: base },
    db,
    log: s => logs.push(s),
    fetchFn: fetch,
    now: () => 1_700_000_000_000,
    pollSec: 1,
    signal: ac.signal,
    onOwnerMessage: async msg => {
      ownerHits.push(msg.text);
      ac.abort();
    },
  });

  await done;
  assert.deepEqual(ownerHits, ['дай']);
  assert.ok(logs.some(l => l.includes('чужой чат 999')));
  assert.equal(kvGet(db, 'tg_updates_offset'), '102');
});
