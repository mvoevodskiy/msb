// Утренняя сводка в Telegram: раз в день в PULT_SUMMARY_HOUR по PULT_TZ.
// Пропустили час (сервис был выключен) — догоняем при старте, если ещё нет 12:00 и сегодня не отправляли.
// Текст — HTML для Telegram, не длиннее 3500 символов: длинные списки ужимаются, лишнее — «…и ещё N».

import type { Level, Snapshot } from '../shared/types.ts';
import type { Config } from './config.ts';
import { kvGet, kvSet, type Db } from './db.ts';
import type { Log } from './log.ts';
import { loadSnapshot } from './snapshot.ts';
import { esc, type Notifier } from './telegram.ts';
import { ago, ddmm, localDate, localParts, parseIso, plural, whenShort } from './time.ts';

export const MAX_CHARS = 3500;
const KEY_DATE = 'summary_last_date';
const KEY_TRY = 'summary_last_try';
const RETRY_MS = 10 * 60_000;

const LEVEL_MARK: Record<Level, string> = { crit: '🔴', serious: '🟠', warn: '🟡' };
const LEVEL_ORDER: Record<Level, number> = { crit: 0, serious: 1, warn: 2 };

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pct = (used: number, total: number): string => (total > 0 && Number.isFinite(used) ? `${Math.round((used / total) * 100)} %` : 'нет данных');

function list<T>(items: T[], cap: number, line: (x: T) => string): string[] {
  const out = items.slice(0, cap).map(line);
  if (items.length > cap) out.push(`…и ещё ${items.length - cap}`);
  return out;
}

export interface SummaryInput {
  snap: { snapshot: Snapshot; receivedAt: number } | null;
  now: number;
  tz: string;
  staleSec: number;
  publicUrl: string;
}

function build(o: SummaryInput, cap: number): string {
  const { now, tz } = o;
  const title = `<b>Сводка Пульта, ${ddmm(now, tz)}</b>`;
  const link = esc(o.publicUrl);
  if (!o.snap) return ['🔴 Нужно от тебя: посмотреть — сборщик ещё не прислал данных', '', title, '', link].join('\n');

  const s = o.snap.snapshot;
  const stale = now - o.snap.receivedAt > o.staleSec * 1000;
  const crit = s.attention.filter(a => a.level === 'crit').length;

  let first: string;
  if (stale) first = `🔴 Нужно от тебя: посмотреть — сборщик молчит с ${whenShort(o.snap.receivedAt, now, tz)}`;
  else if (s.asks.length || crit) {
    const parts: string[] = [];
    if (s.asks.length) parts.push(`${s.asks.length} ${plural(s.asks.length, ['решение', 'решения', 'решений'])}`);
    if (crit) parts.push('посмотреть тревоги');
    first = `🔴 Нужно от тебя: ${parts.join(', ')}`;
  } else first = '🟢 От тебя ничего не нужно';

  const out: string[] = [first, '', title];
  if (stale) out.push(`Данные на ${whenShort(o.snap.receivedAt, now, tz)} — новее нет.`);

  if (s.asks.length) {
    const asks = [...s.asks].sort((a, b) => a.since.localeCompare(b.since));
    out.push('', '<b>Нужно от тебя</b>', ...list(asks, cap, a => {
      const since = parseIso(a.since);
      const proj = a.project ? `${esc(a.project)}: ` : '';
      return `• ${proj}${esc(cut(a.text, 160))}${since !== null ? ` · ждёт ${ago(since, now)}` : ''}`;
    }));
  }

  if (s.attention.length) {
    const att = [...s.attention].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
    out.push('', '<b>Требует внимания</b>', ...list(att, cap, a => {
      const proj = a.project ? `${esc(a.project)} · ` : '';
      return `${LEVEL_MARK[a.level] ?? '•'} ${proj}${esc(cut(a.text, 160))}`;
    }));
  }

  if (s.bots.length) {
    out.push('', '<b>Боты</b>', ...s.bots.map(b => {
      const st = b.service?.state;
      const state = st === 'active' ? 'работает' : st === 'activating' ? 'запускается' : `не работает (${esc(st ?? 'нет данных')})`;
      const chat = b.chat24h?.requests ?? 0;
      const bg = b.bg24h?.runs ?? 0;
      return `• ${esc(b.name)} — ${state} · за сутки ${chat} ${plural(chat, ['запрос', 'запроса', 'запросов'])} в чате, ${bg} ${plural(bg, ['фоновый ход', 'фоновых хода', 'фоновых ходов'])}`;
    }));
  }

  const bad = s.tasks.filter(t => (t.stats24h?.error ?? 0) > 0 || (t.stats24h?.missed ?? 0) > 0);
  out.push('', '<b>Фон за сутки</b>');
  if (!s.tasks.length) out.push('фоновых задач нет');
  else if (!bad.length) out.push('все задачи отработали штатно');
  else out.push(...list(bad, cap, t => {
    const p: string[] = [];
    if (t.stats24h.error) p.push(`${t.stats24h.error} ${plural(t.stats24h.error, ['ошибка', 'ошибки', 'ошибок'])}`);
    if (t.stats24h.missed) p.push(`${t.stats24h.missed} ${plural(t.stats24h.missed, ['пропуск', 'пропуска', 'пропусков'])}`);
    return `• ${esc(cut(t.name, 80))} (${esc(t.botName)}): ${p.join(', ')}`;
  }));

  const v = s.server;
  const cpu = typeof v.cpuPct === 'number' && Number.isFinite(v.cpuPct) ? `${Math.round(v.cpuPct)} %` : 'нет данных';
  out.push('', '<b>Сервер</b>', `Процессор ${cpu} · память ${pct(v.memUsedMb, v.memTotalMb)} · диск ${pct(v.diskUsedGb, v.diskTotalGb)}`);

  if (s.balances.length) {
    out.push('', '<b>Остатки</b>', ...list(s.balances, cap, b =>
      `• ${esc(b.name)}: ${esc(b.value)}${b.ok === false ? ' — мало' : ''}${b.stale ? ' (давно не обновлялся)' : ''}`));
  }

  out.push('', link);
  return out.join('\n');
}

export function summaryText(o: SummaryInput): string {
  for (let cap = 10; cap >= 1; cap--) {
    const t = build(o, cap);
    if (t.length <= MAX_CHARS) return t;
  }
  // Крайний случай: режем по строкам, ссылку на панель оставляем.
  const lines = build(o, 1).split('\n');
  const link = lines.pop() ?? '';
  let text = '';
  for (const l of lines) {
    if (text.length + l.length + link.length + 4 > MAX_CHARS) break;
    text += `${l}\n`;
  }
  return `${text}…\n${link}`;
}

/** Пора ли отправлять: наступил час сводки, ещё нет крайнего срока (12:00) и сегодня не отправляли. */
export function summaryDue(now: number, tz: string, hour: number, lastDate: string | null): boolean {
  const p = localParts(now, tz);
  const cutoff = hour < 12 ? 12 : 24;
  return p.hour >= hour && p.hour < cutoff && lastDate !== localDate(now, tz);
}

export interface Summary {
  /** Проверка раз в минуту (и при старте): отправит, если пора. */
  tick(): Promise<void>;
  text(): string;
}

export function createSummary(o: { db: Db; cfg: Config; notifier: Notifier; log: Log; now: () => number }): Summary {
  let busy = false;
  const text = (): string => summaryText({ snap: loadSnapshot(o.db), now: o.now(), tz: o.cfg.tz, staleSec: o.cfg.staleSec, publicUrl: o.cfg.publicUrl });
  return {
    text,
    async tick() {
      if (busy || !o.notifier.configured) return;
      const now = o.now();
      if (!summaryDue(now, o.cfg.tz, o.cfg.summaryHour, kvGet(o.db, KEY_DATE))) return;
      const lastTry = Number(kvGet(o.db, KEY_TRY) ?? 0);
      if (now - lastTry < RETRY_MS) return;
      busy = true;
      try {
        kvSet(o.db, KEY_TRY, String(now));
        const r = await o.notifier.send(text(), 'summary');
        if (r.ok) {
          kvSet(o.db, KEY_DATE, localDate(now, o.cfg.tz));
          o.log('сводка отправлена');
        }
      } catch (e) {
        o.log(`ошибка сводки: ${(e as Error).message}`);
      } finally {
        busy = false;
      }
    },
  };
}
