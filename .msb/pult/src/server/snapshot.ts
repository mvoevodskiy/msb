// Приём снимка от сборщика, метрики сервера для графиков и ответы /api/snapshot и /api/history.
// Снимок хранится одной строкой JSON (последний), метрики — строкой на каждый снимок (35 дней).

import { SNAPSHOT_SCHEMA, type HistoryResponse, type Snapshot } from '../shared/types.ts';
import { getSnapshot, type Db } from './db.ts';
import type { NotifyStatus } from './telegram.ts';

const ARRAYS = ['bots', 'tasks', 'services', 'projects', 'asks', 'attention', 'balances', 'upcoming', 'sourceErrors'] as const;
const LEVELS = ['crit', 'serious', 'warn'];

export class IngestError extends Error {}

/** Проверка формы снимка: только то, на что опирается сервис. Остальное рисует интерфейс как есть. */
export function validateSnapshot(data: unknown): Snapshot {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new IngestError('снимок должен быть JSON-объектом');
  const s = data as Record<string, unknown>;
  if (s.schema !== SNAPSHOT_SCHEMA) throw new IngestError(`schema должна быть ${SNAPSHOT_SCHEMA}, пришло ${JSON.stringify(s.schema) ?? 'ничего'}`);
  if (typeof s.collectedAt !== 'string' || Number.isNaN(Date.parse(s.collectedAt))) throw new IngestError('collectedAt должен быть датой ISO');
  if (typeof s.host !== 'string') throw new IngestError('host должен быть строкой');
  if (typeof s.server !== 'object' || s.server === null || Array.isArray(s.server)) throw new IngestError('server должен быть объектом');
  for (const k of ARRAYS) if (!Array.isArray(s[k])) throw new IngestError(`${k} должен быть массивом`);
  (s.attention as unknown[]).forEach((a, i) => {
    const x = a as Record<string, unknown> | null;
    if (!x || typeof x.key !== 'string' || !x.key || typeof x.text !== 'string' || !LEVELS.includes(x.level as string)) {
      throw new IngestError(`attention[${i}]: нужны key, text и level (crit | serious | warn)`);
    }
  });
  return data as Snapshot;
}

const pct = (used: unknown, total: unknown): number | null =>
  typeof used === 'number' && typeof total === 'number' && Number.isFinite(used) && Number.isFinite(total) && total > 0
    ? Math.min(100, Math.max(0, (used / total) * 100))
    : null;

export interface Metrics { cpu: number; mem: number; disk: number; swap: number }

/** Проценты для графиков; null — сборщик не смог прочитать что-то из основного (точку не пишем, а не выдумываем). */
export function metricsOf(s: Snapshot): Metrics | null {
  const v = s.server;
  const cpu = typeof v.cpuPct === 'number' && Number.isFinite(v.cpuPct) ? Math.min(100, Math.max(0, v.cpuPct)) : null;
  const mem = pct(v.memUsedMb, v.memTotalMb);
  const disk = pct(v.diskUsedGb, v.diskTotalGb);
  const swap = v.swapTotalMb === 0 ? 0 : pct(v.swapUsedMb, v.swapTotalMb);
  if (cpu === null || mem === null || disk === null || swap === null) return null;
  return { cpu, mem, disk, swap };
}

/** Точка истории — на момент сбора (снимок мог прийти с задержкой, например с другого сервера после обрыва связи).
 *  Часы сборщика не верим, если они «в будущем» больше чем на 5 мин или время старше срока хранения истории. */
export function metricTime(collectedAt: string, receivedAt: number): number {
  const t = Date.parse(collectedAt);
  if (Number.isNaN(t) || t > receivedAt + 5 * 60_000 || t < receivedAt - 35 * 86_400_000) return receivedAt;
  return t;
}

export function storeSnapshot(db: Db, s: Snapshot, receivedAt: number): number {
  const json = JSON.stringify(s);
  db.prepare(`INSERT INTO snapshot (id, json, received_at, collected_at, size) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET json = excluded.json, received_at = excluded.received_at, collected_at = excluded.collected_at, size = excluded.size`)
    .run(json, receivedAt, s.collectedAt, Buffer.byteLength(json));
  const m = metricsOf(s);
  if (m) db.prepare('INSERT INTO metrics (t, cpu, mem, disk, swap) VALUES (?, ?, ?, ?, ?)').run(metricTime(s.collectedAt, receivedAt), m.cpu, m.mem, m.disk, m.swap);
  return Buffer.byteLength(json);
}

/** Последний снимок как объект (для тревог и сводки). */
export function loadSnapshot(db: Db): { snapshot: Snapshot; receivedAt: number } | null {
  const row = getSnapshot(db);
  return row ? { snapshot: JSON.parse(row.json) as Snapshot, receivedAt: row.receivedAt } : null;
}

/**
 * Тело /api/snapshot. Снимок вставляется в ответ готовой строкой из БД — без разбора и повторной
 * сериализации (он уже проверен при приёме и записан через JSON.stringify).
 */
export function snapshotResponseJson(db: Db, now: number, staleSec: number, notify: NotifyStatus): string {
  const row = getSnapshot(db);
  const ageSec = row ? Math.max(0, Math.floor((now - row.receivedAt) / 1000)) : null;
  const rest = {
    receivedAt: row ? new Date(row.receivedAt).toISOString() : null,
    ageSec,
    stale: ageSec === null || ageSec > staleSec,
    notify,
  };
  return `{"snapshot":${row ? row.json : 'null'},${JSON.stringify(rest).slice(1)}`;
}

export const RANGES: Record<HistoryResponse['range'], { spanMs: number; bucketMs: number }> = {
  '24h': { spanMs: 24 * 3_600_000, bucketMs: 5 * 60_000 },
  '7d': { spanMs: 7 * 86_400_000, bucketMs: 30 * 60_000 },
  '30d': { spanMs: 30 * 86_400_000, bucketMs: 2 * 3_600_000 },
};

export function isRange(v: unknown): v is HistoryResponse['range'] {
  return typeof v === 'string' && Object.hasOwn(RANGES, v);
}

const r1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Средние по корзинам; t — начало корзины (корзины выровнены по эпохе UTC). Пустые корзины не выдаём.
 * CAST обязателен: node:sqlite передаёт числа как REAL, и деление было бы не целочисленным.
 */
export function history(db: Db, range: HistoryResponse['range'], now: number): HistoryResponse {
  const { spanMs, bucketMs } = RANGES[range];
  const rows = db.prepare(`SELECT (CAST(t AS INTEGER) / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS b, avg(cpu) AS cpu, avg(mem) AS mem, avg(disk) AS disk, avg(swap) AS swap
    FROM metrics WHERE t >= ? AND t <= ? GROUP BY b ORDER BY b`).all(bucketMs, bucketMs, now - spanMs, now) as
    { b: number; cpu: number; mem: number; disk: number; swap: number }[];
  return {
    range,
    points: rows.map(r => ({ t: new Date(Number(r.b)).toISOString(), cpu: r1(r.cpu), mem: r1(r.mem), disk: r1(r.disk), swap: r1(r.swap) })),
  };
}
