// Тревоги в Telegram. Источник — attention уровня crit из снимка (их посчитал сборщик) и своя проверка
// «сборщик молчит». Состояние в таблице alerts переживает перезапуск, поэтому повторов после рестарта нет.
//
// Правила:
// - из снимка — тревожим, только если проблема есть в двух снимках подряд и держится ≥ 3 мин;
// - «сборщик молчит» — сразу, как только снимка нет дольше PULT_STALE_SEC;
// - одна проблема — одна тревога на весь случай; новые за один проход — одним сообщением;
// - ушла проблема, о которой тревожили, — «снова в норме»; о которой не тревожили — молчим;
// - активная тревога напоминается раз в 12 ч.

import type { Attention } from '../shared/types.ts';
import type { Config } from './config.ts';
import { tx, type Db } from './db.ts';
import type { Log } from './log.ts';
import { loadSnapshot } from './snapshot.ts';
import { esc, type Notifier } from './telegram.ts';
import { parseIso, whenShort } from './time.ts';

export const HOLD_MS = 3 * 60_000;
export const REMIND_MS = 12 * 3_600_000;
/** После неудачной отправки не долбим Telegram каждые 30 с. */
export const RETRY_MS = 5 * 60_000;
export const STALE_KEY = 'pult:collector-silent';
const MAX_CHARS = 3500;

export interface AlertRow {
  key: string;
  source: 'snapshot' | 'stale';
  level: string;
  text: string;
  /** С какого момента проблема: раньшее из «впервые увидели» и since от сборщика. */
  since: number;
  firstSeen: number;
  seenCount: number;
  lastSeen: number;
  notified: boolean;
  notifiedAt: number | null;
  resolvedAt: number | null;
}

type Raw = { key: string; source: 'snapshot' | 'stale'; level: string; text: string; since: number; first_seen: number; seen_count: number; last_seen: number; notified: number; notified_at: number | null; resolved_at: number | null };

const toRow = (r: Raw): AlertRow => ({
  key: r.key, source: r.source, level: r.level, text: r.text,
  since: Number(r.since), firstSeen: Number(r.first_seen), seenCount: Number(r.seen_count), lastSeen: Number(r.last_seen),
  notified: Number(r.notified) === 1, notifiedAt: r.notified_at === null ? null : Number(r.notified_at),
  resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
});

export function allAlerts(db: Db): AlertRow[] {
  return (db.prepare('SELECT * FROM alerts ORDER BY since, key').all() as Raw[]).map(toRow);
}

function getAlert(db: Db, key: string): AlertRow | null {
  const r = db.prepare('SELECT * FROM alerts WHERE key = ?').get(key) as Raw | undefined;
  return r ? toRow(r) : null;
}

/** Текст тревоги в Telegram: проект впереди, если есть. */
export function alertItemText(a: Pick<Attention, 'text' | 'project'>): string {
  return a.project ? `${a.project} · ${a.text}` : a.text;
}

/** Новый снимок: обновить счётчики «подряд» для crit-проблем и отметить ушедшие. */
export function observeSnapshot(db: Db, attention: Attention[], receivedAt: number): void {
  const crit = new Map<string, Attention>();
  for (const a of attention) if (a.level === 'crit' && !crit.has(a.key)) crit.set(a.key, a);
  tx(db, () => {
    for (const a of crit.values()) {
      const given = parseIso(a.since);
      const since = given !== null && given <= receivedAt ? Math.min(given, receivedAt) : receivedAt;
      const text = alertItemText(a);
      const row = getAlert(db, a.key);
      if (row && row.source === 'snapshot') {
        // Вернулась до отправки «снова в норме» — это тот же случай, продолжаем его.
        db.prepare('UPDATE alerts SET level = ?, text = ?, seen_count = seen_count + 1, last_seen = ?, since = min(since, ?), resolved_at = NULL WHERE key = ?')
          .run(a.level, text, receivedAt, since, a.key);
      } else if (!row) {
        db.prepare("INSERT INTO alerts (key, source, level, text, since, first_seen, seen_count, last_seen) VALUES (?, 'snapshot', ?, ?, ?, ?, 1, ?)")
          .run(a.key, a.level, text, since, receivedAt, receivedAt);
      }
    }
    for (const row of allAlerts(db)) {
      if (row.source !== 'snapshot' || row.resolvedAt !== null || crit.has(row.key)) continue;
      if (row.notified) db.prepare('UPDATE alerts SET resolved_at = ? WHERE key = ?').run(receivedAt, row.key);
      else db.prepare('DELETE FROM alerts WHERE key = ?').run(row.key);
    }
  });
}

/**
 * «Сборщик молчит». Отсчёт — от последнего снимка, но не раньше старта сервиса:
 * после долгого простоя самого Пульта сборщику даём PULT_STALE_SEC, чтобы прислать свежий снимок.
 */
export function observeStale(db: Db, o: { now: number; lastReceivedAt: number | null; startedAt: number; staleSec: number }): void {
  const lastHeard = Math.max(o.lastReceivedAt ?? 0, o.startedAt);
  const silent = o.now - lastHeard > o.staleSec * 1000;
  const row = getAlert(db, STALE_KEY);
  if (silent) {
    if (!row) {
      const text = o.lastReceivedAt === null ? 'Сборщик не прислал ни одного снимка' : 'Сборщик не присылает данные';
      const since = o.lastReceivedAt ?? o.startedAt;
      db.prepare("INSERT INTO alerts (key, source, level, text, since, first_seen, seen_count, last_seen) VALUES (?, 'stale', 'crit', ?, ?, ?, 1, ?)")
        .run(STALE_KEY, text, since, o.now, o.now);
    } else {
      db.prepare('UPDATE alerts SET last_seen = ?, resolved_at = NULL WHERE key = ?').run(o.now, STALE_KEY);
    }
  } else if (row && row.resolvedAt === null) {
    if (row.notified) db.prepare('UPDATE alerts SET resolved_at = ? WHERE key = ?').run(o.now, STALE_KEY);
    else db.prepare('DELETE FROM alerts WHERE key = ?').run(STALE_KEY);
  }
}

export interface AlertPlan { fresh: AlertRow[]; remind: AlertRow[]; recovered: AlertRow[] }

export function planAlerts(db: Db, now: number): AlertPlan {
  const rows = allAlerts(db);
  return {
    fresh: rows.filter(r => r.resolvedAt === null && !r.notified && (r.source === 'stale' || (r.seenCount >= 2 && now - r.since >= HOLD_MS))),
    remind: rows.filter(r => r.resolvedAt === null && r.notified && r.notifiedAt !== null && now - r.notifiedAt >= REMIND_MS),
    recovered: rows.filter(r => r.resolvedAt !== null),
  };
}

/** Пункты списка с ограничением по длине: лишнее — «…и ещё N». */
function bullets(rows: AlertRow[], now: number, tz: string, budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    const line = `• ${esc(rows[i].text)} (с ${whenShort(rows[i].since, now, tz)})`;
    if (used + line.length > budget && out.length > 0) {
      out.push(`…и ещё ${rows.length - i}`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

export function alertMessage(o: { fresh: AlertRow[]; remind: AlertRow[]; host: string | null; publicUrl: string; tz: string; now: number }): string {
  const head = ['🔴 Нужно от тебя: посмотреть', '', `<b>${esc(o.host ? `Пульт · ${o.host}` : 'Пульт')}</b>`];
  const tail = ['', esc(o.publicUrl)];
  const budget = MAX_CHARS - head.join('\n').length - tail.join('\n').length - 40;
  const body: string[] = [];
  if (o.fresh.length) body.push(...bullets(o.fresh, o.now, o.tz, o.remind.length ? budget / 2 : budget));
  if (o.remind.length) {
    if (body.length) body.push('');
    body.push('Всё ещё не в норме:', ...bullets(o.remind, o.now, o.tz, o.fresh.length ? budget / 2 : budget));
  }
  return [...head, ...body, ...tail].join('\n');
}

export function recoveryMessage(rows: AlertRow[], tz: string, now: number): string {
  const lines = rows.slice(0, 30).map(r =>
    `Снова в норме: ${esc(r.text)} (было с ${whenShort(r.since, now, tz)} до ${whenShort(r.resolvedAt ?? now, now, tz)})`);
  if (rows.length > 30) lines.push(`…и ещё ${rows.length - 30}`);
  return ['🟢 От тебя ничего не нужно', '', ...lines].join('\n');
}

export interface Alerter {
  /** Проверить и отправить, что положено. Повторный вызов во время отправки — догонит после неё. */
  check(): Promise<void>;
  /** Принят новый снимок. */
  onSnapshot(attention: Attention[], receivedAt: number): void;
}

export function createAlerter(o: { db: Db; cfg: Config; notifier: Notifier; log: Log; now: () => number; startedAt: number }): Alerter {
  let running: Promise<void> | null = null;
  let again = false;
  let nextTryAt = 0;

  async function once(): Promise<void> {
    const now = o.now();
    const last = loadSnapshot(o.db);
    observeStale(o.db, { now, lastReceivedAt: last?.receivedAt ?? null, startedAt: o.startedAt, staleSec: o.cfg.staleSec });
    if (!o.notifier.configured || now < nextTryAt) return;
    const plan = planAlerts(o.db, now);

    if (plan.fresh.length || plan.remind.length) {
      const text = alertMessage({ fresh: plan.fresh, remind: plan.remind, host: last?.snapshot.host ?? null, publicUrl: o.cfg.publicUrl, tz: o.cfg.tz, now });
      const r = await o.notifier.send(text, 'alert');
      if (!r.ok) {
        nextTryAt = o.now() + RETRY_MS;
        return;
      }
      const at = o.now();
      tx(o.db, () => {
        for (const row of [...plan.fresh, ...plan.remind]) {
          const ch = o.db.prepare('UPDATE alerts SET notified = 1, notified_at = ? WHERE key = ?').run(at, row.key);
          // Проблема ушла, пока летело сообщение (строку уже удалили как «не тревожили») — вернём её,
          // чтобы следующим проходом ушло «снова в норме».
          if (Number(ch.changes) === 0) {
            o.db.prepare('INSERT INTO alerts (key, source, level, text, since, first_seen, seen_count, last_seen, notified, notified_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
              .run(row.key, row.source, row.level, row.text, row.since, row.firstSeen, row.seenCount, row.lastSeen, at, at);
          }
        }
      });
      o.log(`тревога отправлена: новых ${plan.fresh.length}, напоминаний ${plan.remind.length}`);
    }

    if (plan.recovered.length) {
      const r = await o.notifier.send(recoveryMessage(plan.recovered, o.cfg.tz, now), 'recovery');
      if (!r.ok) {
        nextTryAt = o.now() + RETRY_MS;
        return;
      }
      tx(o.db, () => {
        for (const row of plan.recovered) o.db.prepare('DELETE FROM alerts WHERE key = ? AND resolved_at IS NOT NULL').run(row.key);
      });
      o.log(`тревога снята: ${plan.recovered.length}`);
    }
  }

  async function check(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await once();
        } while (again);
      } catch (e) {
        o.log(`ошибка проверки тревог: ${(e as Error).message}`);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    check,
    onSnapshot(attention, receivedAt) {
      observeSnapshot(o.db, attention, receivedAt);
      void check();
    },
  };
}
