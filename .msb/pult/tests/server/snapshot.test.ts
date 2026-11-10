import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SnapshotResponse } from '../../src/shared/types.ts';
import { cleanup, openDb } from '../../src/server/db.ts';
import { history, IngestError, loadSnapshot, metricTime, metricsOf, snapshotResponseJson, storeSnapshot, validateSnapshot } from '../../src/server/snapshot.ts';
import { fixture, tmpDir } from './helpers.ts';

const T0 = Date.UTC(2026, 9, 30, 5, 0, 0);
const notify = { configured: true, lastError: null, lastSentAt: null };

test('проверка снимка: пример проходит, поломки — понятные ошибки', () => {
  assert.doesNotThrow(() => validateSnapshot(fixture()));
  const bad = (mut: (s: Record<string, unknown>) => void, re: RegExp) => {
    const s = fixture() as unknown as Record<string, unknown>;
    mut(s);
    assert.throws(() => validateSnapshot(s), (e: Error) => e instanceof IngestError && re.test(e.message));
  };
  assert.throws(() => validateSnapshot([]), IngestError);
  assert.throws(() => validateSnapshot(null), IngestError);
  bad(s => { s.schema = 2; }, /schema должна быть 1/);
  bad(s => { delete s.schema; }, /schema/);
  bad(s => { s.collectedAt = 'вчера'; }, /collectedAt/);
  bad(s => { s.collectedAt = 1700000000; }, /collectedAt/);
  bad(s => { s.server = null; }, /server/);
  for (const k of ['bots', 'tasks', 'services', 'projects', 'asks', 'attention', 'balances', 'upcoming', 'sourceErrors']) {
    bad(s => { s[k] = {}; }, new RegExp(`${k} должен быть массивом`));
  }
  bad(s => { (s.attention as unknown[]).push({ key: 'x', level: 'panic', text: 'y' }); }, /attention\[3\]/);
  bad(s => { (s.attention as unknown[]).push({ level: 'crit', text: 'y' }); }, /attention\[3\]/);
});

test('метрики: проценты из снимка; без данных точка не пишется', () => {
  const s = fixture();
  const m = metricsOf(s)!;
  assert.equal(m.cpu, 12.4);
  assert.equal(m.mem, 45);
  assert.equal(m.disk, 61);
  assert.equal(m.swap, 12.5);
  s.server.swapTotalMb = 0;
  s.server.swapUsedMb = 0;
  assert.equal(metricsOf(s)!.swap, 0, 'нет подкачки — 0 %');
  s.server.memTotalMb = 0;
  assert.equal(metricsOf(s), null);
  const s2 = fixture();
  (s2.server as unknown as Record<string, unknown>).cpuPct = null;
  assert.equal(metricsOf(s2), null);
});

test('хранение: последний снимок заменяет прошлый, ответ API собран без повторной сериализации', t => {
  const db = openDb(tmpDir(t));
  t.after(() => db.close());
  const empty = JSON.parse(snapshotResponseJson(db, T0, 300, notify)) as SnapshotResponse;
  assert.deepEqual(empty, { snapshot: null, receivedAt: null, ageSec: null, stale: true, notify });

  const s = fixture();
  storeSnapshot(db, s, T0);
  s.host = 'Второй снимок';
  storeSnapshot(db, s, T0 + 60_000);
  assert.equal(loadSnapshot(db)?.snapshot.host, 'Второй снимок');
  assert.equal((db.prepare('SELECT count(*) AS n FROM metrics').get() as { n: number }).n, 2);

  const r = JSON.parse(snapshotResponseJson(db, T0 + 60_000 + 299_000, 300, { configured: false, lastError: 'Открой бота', lastSentAt: null })) as SnapshotResponse;
  assert.equal(r.snapshot?.host, 'Второй снимок');
  assert.equal(r.receivedAt, new Date(T0 + 60_000).toISOString());
  assert.equal(r.ageSec, 299);
  assert.equal(r.stale, false);
  assert.deepEqual(r.notify, { configured: false, lastError: 'Открой бота', lastSentAt: null });
  const old = JSON.parse(snapshotResponseJson(db, T0 + 60_000 + 301_000, 300, notify)) as SnapshotResponse;
  assert.equal(old.stale, true);
  assert.equal(old.ageSec, 301);
});

test('история: усреднение по корзинам 5 мин / 30 мин / 2 ч, старое за пределами не попадает', t => {
  const db = openDb(tmpDir(t));
  t.after(() => db.close());
  const ins = db.prepare('INSERT INTO metrics (t, cpu, mem, disk, swap) VALUES (?, ?, ?, ?, ?)');
  const now = Date.UTC(2026, 9, 30, 12, 0, 0); // ровно на границе всех корзин
  // Две точки в одной 5-минутной корзине 11:50–11:55 и одна в 11:55–12:00.
  ins.run(now - 10 * 60_000, 10, 40, 60, 0);
  ins.run(now - 7 * 60_000, 20, 50, 60, 10);
  ins.run(now - 3 * 60_000, 90, 60, 61, 0);
  // Точка 3 дня назад и 20 дней назад, 40 дней назад.
  ins.run(now - 3 * 86_400_000, 50, 50, 50, 50);
  ins.run(now - 20 * 86_400_000 + 1000, 30, 30, 30, 30);
  ins.run(now - 40 * 86_400_000, 99, 99, 99, 99);

  const d = history(db, '24h', now);
  assert.equal(d.range, '24h');
  assert.deepEqual(d.points, [
    { t: new Date(now - 10 * 60_000).toISOString(), cpu: 15, mem: 45, disk: 60, swap: 5 },
    { t: new Date(now - 5 * 60_000).toISOString(), cpu: 90, mem: 60, disk: 61, swap: 0 },
  ]);

  const w = history(db, '7d', now);
  assert.equal(w.points.length, 2, 'три свежие точки попали в одну 30-минутную корзину, плюс точка 3 дня назад');
  assert.equal(w.points[1].t, new Date(now - 30 * 60_000).toISOString());
  assert.equal(w.points[1].cpu, 40);
  assert.equal(w.points[1].mem, 50);
  assert.equal(w.points[0].cpu, 50);

  const m = history(db, '30d', now);
  assert.equal(m.points.length, 3, '40 дней назад — за пределами');
  assert.equal(m.points[2].t, new Date(now - 2 * 3_600_000).toISOString());
  assert.equal(m.points[2].cpu, 40);
  assert.equal(m.points[0].cpu, 30);

  cleanup(db, now);
  assert.equal((db.prepare('SELECT count(*) AS n FROM metrics').get() as { n: number }).n, 5, 'чистка: старше 35 дней удалено');
});

test('точка истории — на момент сбора; часы сборщика «в будущем» или слишком старые — на момент получения', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  assert.equal(metricTime('2026-10-29T11:58:00Z', now), Date.parse('2026-10-29T11:58:00Z'), 'задержка доставки — время сбора');
  assert.equal(metricTime('2026-10-29T12:03:00Z', now), Date.parse('2026-10-29T12:03:00Z'), 'расхождение часов до 5 мин допустимо');
  assert.equal(metricTime('2026-10-29T12:10:00Z', now), now, 'часы сборщика убежали вперёд');
  assert.equal(metricTime('2026-09-01T00:00:00Z', now), now, 'старше срока хранения');
  assert.equal(metricTime('не дата', now), now);
});
