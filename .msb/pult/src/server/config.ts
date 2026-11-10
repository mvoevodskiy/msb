// Настройки веб-сервиса Пульта — только из переменных окружения, проверяются при старте.
// Любая ошибка — ConfigError с понятным текстом по-русски; main.ts и admin.ts печатают её и выходят с кодом 1.
// Секреты (пароль, токены) в текст ошибок и в журнал не попадают никогда.

import { isAbsolute, resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  /** Каталог данных: pult.db, backups/, pult.pid. */
  dataDir: string;
  password: string;
  ingestToken: string;
  /** Внешний адрес панели без завершающего «/» — для ссылок в Telegram и проверки Origin. */
  publicUrl: string;
  /** null — Telegram не настроен: панель работает, тревоги и сводка не отправляются. */
  tg: { token: string; chatId: string; apiBase: string } | null;
  cookieSecure: boolean;
  /** Брать IP клиента из X-Real-IP/X-Forwarded-For, если соединение пришло с локального адреса (nginx). */
  trustProxy: boolean;
  staleSec: number;
  summaryHour: number;
  tz: string;
  /** Срок полной сессии браузера (мс). По умолчанию 4 часа. */
  sessionTtlMs: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

const val = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

function int(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = val(env, name);
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name}: ожидается целое число от ${min} до ${max}, сейчас «${raw}»`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name}: ожидается целое число от ${min} до ${max}, сейчас ${n}`);
  return n;
}

function flag(env: Env, name: string, def: boolean): boolean {
  const raw = val(env, name);
  if (raw === undefined) return def;
  if (raw === '1') return true;
  if (raw === '0') return false;
  throw new ConfigError(`${name}: ожидается 1 или 0, сейчас «${raw}»`);
}

function required(env: Env, name: string, what: string): string {
  const v = val(env, name);
  if (v === undefined) throw new ConfigError(`${name} не задан: ${what}`);
  return v;
}

export function loadConfig(env: Env = process.env): Config {
  // 0 — любой свободный порт (для тестов и живых проверок), фактический пишется в журнал при старте.
  const port = int(env, 'PULT_PORT', 8791, 0, 65535);
  const host = val(env, 'PULT_HOST') ?? '127.0.0.1';

  const dataDirRaw = required(env, 'PULT_DATA_DIR', 'нужен каталог данных Пульта (база, копии)');
  if (!isAbsolute(dataDirRaw)) throw new ConfigError(`PULT_DATA_DIR: нужен абсолютный путь, сейчас «${dataDirRaw}»`);
  const dataDir = resolve(dataDirRaw);

  const password = required(env, 'PULT_PASSWORD', 'нужен пароль входа в панель (не короче 12 символов)');
  if ([...password].length < 12) throw new ConfigError('PULT_PASSWORD: пароль короче 12 символов');

  const ingestToken = required(env, 'PULT_INGEST_TOKEN', 'нужен токен сборщика (не короче 32 символов), тот же, что у сборщика');
  if (ingestToken.length < 32) throw new ConfigError('PULT_INGEST_TOKEN: токен короче 32 символов');
  if (/\s/.test(ingestToken)) throw new ConfigError('PULT_INGEST_TOKEN: в токене не должно быть пробелов');

  const publicRaw = required(env, 'PULT_PUBLIC_URL', 'нужен внешний адрес панели, например https://panel.mp.aaa0.ru');
  let publicUrl: URL;
  try {
    publicUrl = new URL(publicRaw);
  } catch {
    throw new ConfigError(`PULT_PUBLIC_URL: это не адрес — «${publicRaw}»`);
  }
  if (publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') throw new ConfigError('PULT_PUBLIC_URL: адрес должен начинаться с https:// (или http:// для проверки)');

  const tgToken = val(env, 'PULT_TG_TOKEN');
  const tgChatId = val(env, 'PULT_TG_CHAT_ID') ?? val(env, 'OWNER_USER_ID');
  let tg: Config['tg'] = null;
  if (tgToken) {
    // Токен в текст ошибки не выводим — только описание формата.
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(tgToken)) throw new ConfigError('PULT_TG_TOKEN: не похож на токен бота Telegram (ожидается «123456:ABC…» от @BotFather)');
    if (!tgChatId) throw new ConfigError('PULT_TG_TOKEN задан, а PULT_TG_CHAT_ID (или OWNER_USER_ID) — нет: некуда слать тревоги и сводку');
    if (!/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(tgChatId)) throw new ConfigError(`PULT_TG_CHAT_ID: ожидается числовой id чата или @имя канала, сейчас «${tgChatId}»`);
    const apiBase = (val(env, 'PULT_TG_API_BASE') ?? 'https://api.telegram.org').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(apiBase)) throw new ConfigError('PULT_TG_API_BASE: ожидается адрес http(s)://…');
    tg = { token: tgToken, chatId: tgChatId, apiBase };
  }

  const tz = val(env, 'PULT_TZ') ?? 'Europe/Moscow';
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: tz });
  } catch {
    throw new ConfigError(`PULT_TZ: неизвестный часовой пояс «${tz}» (пример: Europe/Moscow)`);
  }

  // 1…720 ч (месяц); по умолчанию 4 часа.
  const sessionHours = int(env, 'PULT_SESSION_HOURS', 4, 1, 720);

  return {
    port,
    host,
    dataDir,
    password,
    ingestToken,
    publicUrl: publicUrl.href.replace(/\/+$/, ''),
    tg,
    cookieSecure: flag(env, 'PULT_COOKIE_SECURE', true),
    trustProxy: flag(env, 'PULT_TRUST_PROXY', false),
    staleSec: int(env, 'PULT_STALE_SEC', 300, 30, 86_400),
    summaryHour: int(env, 'PULT_SUMMARY_HOUR', 8, 0, 23),
    tz,
    sessionTtlMs: sessionHours * 60 * 60 * 1000,
  };
}
