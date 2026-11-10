// Сторож сборщика: если веб-сервис Пульта долго не принимает снимки (лежит, завис, отвечает ошибкой),
// тревогу шлёт сам сборщик — веб-сервис в этот момент сам ничего не пришлёт. Одна тревога на случай,
// после неё — «снова принимает». Короткие сбои (перезапуск при выкладке) молча.

import { fmtTime } from '../shared/format.ts';
import { escHtml } from '../shared/tg.ts';

export const WATCH_AFTER_MS = 10 * 60_000;

export interface WatchMessage { kind: 'alert' | 'recovery'; text: string }

export class IngestWatch {
  private since: number | null = null;
  private alerted = false;
  private readonly afterMs: number;
  private readonly publicUrl: string | undefined;

  constructor(opts: { afterMs?: number; publicUrl?: string } = {}) {
    this.afterMs = opts.afterMs ?? WATCH_AFTER_MS;
    this.publicUrl = opts.publicUrl;
  }

  /** Итог очередной отправки. Возвращает сообщение, если пора его отправить. */
  update(sendError: string | null, nowMs: number): WatchMessage | null {
    if (sendError === null) {
      const from = this.since;
      const was = this.alerted;
      this.since = null;
      this.alerted = false;
      if (!was || from === null) return null;
      return {
        kind: 'recovery',
        text: ['🟢 От тебя ничего не нужно', '', `Веб-сервис Пульта снова принимает данные (не принимал с ${fmtTime(from)} до ${fmtTime(nowMs)}).`].join('\n'),
      };
    }
    this.since ??= nowMs;
    if (this.alerted || nowMs - this.since < this.afterMs) return null;
    this.alerted = true;
    return {
      kind: 'alert',
      text: [
        '🔴 Нужно от тебя: посмотреть — Пульт не принимает данные',
        '',
        `<b>Пульт</b>: с ${fmtTime(this.since)} сборщик не может передать снимок веб-сервису: ${escHtml(sendError)}.`,
        'Панель показывает устаревшее, тревоги и сводка из неё не уходят.',
        'Поручи личному боту разобраться: он видит журналы служб.',
        ...(this.publicUrl ? ['', this.publicUrl] : []),
      ].join('\n'),
    };
  }

  /** Тревога не ушла (Telegram недоступен) — попробовать снова на следующем тике. */
  retry(): void {
    this.alerted = false;
  }
}
