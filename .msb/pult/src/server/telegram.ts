// Отправка тревог и сводки в Telegram (sendMessage, parse_mode HTML).
// Токен бота живёт только в URL запроса: ни в журнал, ни в тексты ошибок он не попадает —
// все ошибки собираются здесь из своих формулировок и дополнительно чистятся от токена.
// Последняя ошибка и время последней отправки — в kv (видны в /api/snapshot и в admin check).

import type { Config } from './config.ts';
import { kvGet, kvSet, type Db } from './db.ts';
import type { Log } from './log.ts';

export interface SendResult {
  ok: boolean;
  /** Не настроен Telegram — ничего не отправляли. */
  skipped: boolean;
  error: string | null;
}

export interface NotifyStatus { configured: boolean; lastError: string | null; lastSentAt: string | null }

export interface Notifier {
  readonly configured: boolean;
  /** kind — для журнала отправок: alert, recovery, summary, login, test… */
  send(text: string, kind: string): Promise<SendResult>;
  /**
   * Кнопка меню бота → сайт как Telegram Mini App — только в чате владельца.
   * Для остальных личных чатов меню сбрасывается на команды (без Mini App).
   */
  setWebAppMenu(url: string): Promise<SendResult>;
  getMe(): Promise<{ ok: true; username: string } | { ok: false; error: string }>;
  status(): NotifyStatus;
}

export interface TelegramOptions {
  tg: Config['tg'];
  db: Db;
  log: Log;
  fetchFn?: typeof fetch;
  /** Паузы между попытками; попыток = паузы + 1. */
  retryDelaysMs?: number[];
  timeoutMs?: number;
  now?: () => number;
  /**
   * HTTPS-адрес панели: к каждому сообщению — кнопка Mini App «Открыть Пульт».
   * http:// (локальные проверки) — кнопку не ставим: Telegram её отклонит.
   */
  webAppUrl?: string | null;
}

/** Кнопка InlineKeyboard, открывающая сайт как Mini App. null — URL не подходит. */
export function webAppOpenButton(url: string, ticket?: string): { text: string; web_app: { url: string } } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const base = u.href.replace(/\/+$/, '') || u.origin;
  // ?tg=билет — вход на сервере без initData (подпись WebView часто ломается при разборе hash).
  const href = ticket ? `${base}/?tg=${encodeURIComponent(ticket)}` : base;
  // Текст «Пульт сразу» — чтобы в чате была видна свежая кнопка после смены входа.
  return { text: 'Пульт сразу', web_app: { url: href } };
}

const KEY_ERROR = 'notify_last_error';
const KEY_SENT = 'notify_last_sent_at';

interface TgReply { ok?: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number }; result?: { username?: string } }

class TgFailure extends Error {
  retry: boolean;
  waitMs: number;
  constructor(message: string, retry: boolean, waitMs = 0) {
    super(message);
    this.retry = retry;
    this.waitMs = waitMs;
  }
}

/** Понятный текст по ответу Telegram. Описание от Telegram — английское, оставляем как есть в конце. */
export function explainTelegramError(status: number, description: string): { text: string; retry: boolean } {
  const d = description.toLowerCase();
  if (status === 401 || status === 404) return { text: 'Telegram: неверный токен бота уведомлений (PULT_TG_TOKEN)', retry: false };
  if (status === 403 && (d.includes("can't initiate conversation") || d.includes('blocked by the user') || d.includes('user is deactivated'))) {
    return { text: 'Открой бота уведомлений и нажми «Старт»', retry: false };
  }
  if (status === 403) return { text: `Telegram запретил отправку: ${description}`, retry: false };
  if (status === 400 && d.includes('chat not found')) return { text: 'Telegram: чат не найден — проверь PULT_TG_CHAT_ID и нажми «Старт» у бота уведомлений', retry: false };
  if (status === 400 && d.includes("can't parse entities")) return { text: `Telegram отклонил разметку сообщения: ${description}`, retry: false };
  if (status === 400) return { text: `Telegram отклонил сообщение: ${description}`, retry: false };
  if (status === 429) return { text: 'Telegram: слишком много сообщений, попросил подождать', retry: true };
  if (status >= 500) return { text: `Telegram временно недоступен (ответ ${status})`, retry: true };
  return { text: `Telegram ответил ${status}: ${description}`, retry: false };
}

function networkError(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `Telegram недоступен: нет ответа за ${Math.round(timeoutMs / 1000)} с`;
  const code = err?.cause?.code;
  return code ? `Telegram недоступен: сеть (${code})` : 'Telegram недоступен: сетевая ошибка';
}

export function createTelegram(o: TelegramOptions): Notifier {
  const fetchFn = o.fetchFn ?? fetch;
  const delays = o.retryDelaysMs ?? [2000, 5000];
  const timeoutMs = o.timeoutMs ?? 15_000;
  const now = o.now ?? Date.now;
  const tg = o.tg;
  // Mini App без ?tg=: вход через initData (HMAC токена бота). Билет — только для одноразовых веб-ссылок.
  const openBtn = (): { text: string; web_app: { url: string } } | null => {
    if (!o.webAppUrl) return null;
    return webAppOpenButton(o.webAppUrl);
  };
  // На всякий случай вычищаем токен из любого текста, который уходит наружу.
  const clean = (s: string): string => (tg ? s.split(tg.token).join('***') : s);

  /** Обновить кнопку меню владельца тем же URL, что у свежей кнопки в сообщении. */
  function refreshMenu(btn: { web_app: { url: string } }): void {
    if (!tg) return;
    void withRetry('menu', 0, () => call('setChatMenuButton', {
      chat_id: tg.chatId,
      menu_button: { type: 'web_app', text: 'Пульт сразу', web_app: { url: btn.web_app.url } },
    }).then(() => undefined));
  }

  async function call(method: string, body: unknown): Promise<TgReply> {
    if (!tg) throw new TgFailure('Telegram не настроен', false);
    let res: Response;
    try {
      res = await fetchFn(`${tg.apiBase}/bot${tg.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TgFailure(networkError(e, timeoutMs), true);
    }
    let reply: TgReply = {};
    try {
      reply = (await res.json()) as TgReply;
    } catch { /* тело не JSON — разберёмся по статусу */ }
    if (res.ok && reply.ok) return reply;
    const { text, retry } = explainTelegramError(res.status, clean(String(reply.description ?? res.statusText ?? '')));
    const waitMs = res.status === 429 ? Math.min(30, Number(reply.parameters?.retry_after ?? 5)) * 1000 : 0;
    throw new TgFailure(text, retry, waitMs);
  }

  function record(kind: string, ok: boolean, error: string | null, chars: number): void {
    try {
      o.db.prepare('INSERT INTO tg_log (t, kind, ok, error, chars) VALUES (?, ?, ?, ?, ?)').run(now(), kind, ok ? 1 : 0, error, chars);
      if (ok) {
        kvSet(o.db, KEY_SENT, new Date(now()).toISOString());
        kvSet(o.db, KEY_ERROR, null);
      } else {
        kvSet(o.db, KEY_ERROR, error);
      }
    } catch (e) {
      o.log(`журнал отправок Telegram не записан: ${(e as Error).message}`);
    }
  }

  async function withRetry(kind: string, chars: number, run: () => Promise<void>): Promise<SendResult> {
    if (!tg) return { ok: false, skipped: true, error: null };
    let lastError = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await run();
        record(kind, true, null, chars);
        return { ok: true, skipped: false, error: null };
      } catch (e) {
        const f = e instanceof TgFailure ? e : new TgFailure('Telegram: непредвиденная ошибка', false);
        lastError = clean(f.message);
        if (!f.retry || attempt === delays.length) break;
        await new Promise(r => setTimeout(r, Math.max(delays[attempt], f.waitMs)));
      }
    }
    record(kind, false, lastError, chars);
    o.log(`ошибка Telegram (${kind}): ${lastError}`);
    return { ok: false, skipped: false, error: lastError };
  }

  return {
    configured: tg !== null,

    async send(text, kind) {
      if (!tg) return { ok: false, skipped: true, error: null };
      const body: Record<string, unknown> = {
        chat_id: tg.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };
      const btn = openBtn();
      if (btn) body.reply_markup = { inline_keyboard: [[btn]] };
      const result = await withRetry(kind, text.length, () => call('sendMessage', body).then(() => undefined));
      // Сводка и тревоги обновляют и меню — через сутки не нужна отдельная просьба «пришли кнопку».
      if (result.ok && btn) refreshMenu(btn);
      return result;
    },

    async setWebAppMenu(url) {
      if (!tg) return { ok: false, skipped: true, error: null };
      const btn = webAppOpenButton(url);
      if (!btn) return { ok: false, skipped: true, error: null };
      // Сначала общий default без Mini App, потом меню владельца (вход — initData).
      return withRetry('menu', 0, async () => {
        await call('setChatMenuButton', { menu_button: { type: 'commands' } });
        await call('setChatMenuButton', {
          chat_id: tg.chatId,
          menu_button: { type: 'web_app', text: 'Пульт сразу', web_app: { url: btn.web_app.url } },
        });
      });
    },

    async getMe() {
      if (!tg) return { ok: false, error: 'Telegram не настроен: нет PULT_TG_TOKEN' };
      try {
        const r = await call('getMe', {});
        return { ok: true, username: String(r.result?.username ?? '') };
      } catch (e) {
        return { ok: false, error: clean(e instanceof TgFailure ? e.message : 'Telegram: непредвиденная ошибка') };
      }
    },

    status() {
      return { configured: tg !== null, lastError: kvGet(o.db, KEY_ERROR), lastSentAt: kvGet(o.db, KEY_SENT) };
    },
  };
}

/** Экранирование для parse_mode HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
