// Проверка initData Telegram Mini App (HMAC-SHA256, ключ WebAppData + токен бота).
// Без проверки подписи данные из WebView доверять нельзя.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Сколько секунд живёт initData: старше — отказ (повторное открытие Mini App даёт свежие). */
export const TG_INIT_MAX_AGE_SEC = 24 * 60 * 60;

export interface TgWebAppUser {
  id: number;
  firstName?: string;
  username?: string;
}

export interface TgWebAppData {
  authDate: number;
  user: TgWebAppUser;
  queryId?: string;
}

export type TgWebAppVerifyOk = { ok: true; data: TgWebAppData };
export type TgWebAppVerifyFail = { ok: false; error: string };
export type TgWebAppVerifyResult = TgWebAppVerifyOk | TgWebAppVerifyFail;

/** Разобрать initData вручную (первое «=» в паре; «+» → пробел как в form-urlencoded). */
export function parseInitDataFields(initData: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of initData.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawK = eq < 0 ? part : part.slice(0, eq);
    const rawV = eq < 0 ? '' : part.slice(eq + 1);
    let k: string;
    let v: string;
    try {
      k = decodeURIComponent(rawK.replace(/\+/g, '%20'));
      v = decodeURIComponent(rawV.replace(/\+/g, '%20'));
    } catch {
      k = rawK;
      v = rawV;
    }
    if (k) out.set(k, v);
  }
  return out;
}

/** Подпись initData верна? Сравнение хеша за постоянное время. */
export function initDataSignatureOk(initData: string, botToken: string): boolean {
  const params = parseInitDataFields(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  params.delete('hash');
  // HMAC authenticates every received field except hash, including signature.
  // Only the separate third-party Ed25519 algorithm excludes signature as well.
  // https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secret).update(checkString).digest();
  const given = Buffer.from(hash, 'hex');
  return given.length === computed.length && timingSafeEqual(given, computed);
}

/**
 * Разобрать и проверить initData. Ожидается владелец панели (числовой chat id).
 * botToken и ownerChatId — из настроек Telegram Пульта.
 */
export function verifyTgWebAppInitData(
  initData: string,
  botToken: string,
  ownerChatId: string,
  nowSec: number,
  maxAgeSec = TG_INIT_MAX_AGE_SEC,
): TgWebAppVerifyResult {
  // Клиент иногда присылает ещё раз URL-кодированную строку — пробуем как есть и после decode.
  const candidates = [initData.trim()];
  try {
    const once = decodeURIComponent(initData.trim().replace(/\+/g, '%20'));
    if (once && once !== candidates[0]) candidates.push(once);
  } catch { /* ignore */ }

  let raw = '';
  for (const c of candidates) {
    if (c && c.length <= 8192 && initDataSignatureOk(c, botToken)) {
      raw = c;
      break;
    }
  }
  if (!raw) {
    const sample = candidates[0] ?? '';
    const keys = [...parseInitDataFields(sample).keys()].join(',');
    return { ok: false, error: `подпись Mini App неверна${keys ? ` (${keys})` : ''}` };
  }

  const params = parseInitDataFields(raw);
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, error: 'в данных Mini App нет даты' };
  if (authDate > nowSec + 60) return { ok: false, error: 'часы Mini App в будущем' };
  if (nowSec - authDate > maxAgeSec) return { ok: false, error: 'данные Mini App устарели — открой панель снова' };

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, error: 'в данных Mini App нет пользователя' };
  let userJson: { id?: unknown; first_name?: unknown; username?: unknown };
  try {
    userJson = JSON.parse(userRaw) as typeof userJson;
  } catch {
    return { ok: false, error: 'пользователь Mini App — не JSON' };
  }
  const id = Number(userJson.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'id пользователя Mini App неверен' };
  if (String(id) !== String(ownerChatId).trim()) {
    return { ok: false, error: 'это не чат владельца Пульта' };
  }

  return {
    ok: true,
    data: {
      authDate,
      user: {
        id,
        firstName: typeof userJson.first_name === 'string' ? userJson.first_name : undefined,
        username: typeof userJson.username === 'string' ? userJson.username : undefined,
      },
      queryId: params.get('query_id') ?? undefined,
    },
  };
}
