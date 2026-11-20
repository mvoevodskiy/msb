/**
 * Клиент Пульта для MSB-бота: чтение секретов, выдача билетов, разметка /pult.
 * Helper-state adapter → [status](./status.mjs); settings/Refresh →
 * [system route](../telegram/routes/system.mjs), [checks](../../tests/pult-status.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InlineKeyboard } from 'grammy';

const SECRETS_DIR = () => path.join(process.env.HOME || os.homedir(), 'pult-secrets');

/** Разобрать EnvironmentFile-подобный .env (кавычки systemd). */
export function parseEnvFile(raw) {
  const map = new Map();
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    let v = t.slice(i + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    map.set(t.slice(0, i), v);
  }
  return map;
}

export async function readPultSecrets() {
  const dir = SECRETS_DIR();
  const out = { dir, web: new Map(), collector: new Map() };
  try {
    out.web = parseEnvFile(await fs.readFile(path.join(dir, 'web.env'), 'utf8'));
  } catch {
    /* нет */
  }
  try {
    out.collector = parseEnvFile(await fs.readFile(path.join(dir, 'collector.env'), 'utf8'));
  } catch {
    /* нет */
  }
  return out;
}

export function pultPublicUrl(secrets, env = process.env) {
  return (
    env.PULT_PUBLIC_URL ||
    secrets.web.get('PULT_PUBLIC_URL') ||
    secrets.collector.get('PULT_PUBLIC_URL') ||
    'http://127.0.0.1:8791'
  ).replace(/\/+$/, '');
}

export function pultIngestToken(secrets, env = process.env) {
  return env.PULT_INGEST_TOKEN || secrets.web.get('PULT_INGEST_TOKEN') || secrets.collector.get('PULT_INGEST_TOKEN') || '';
}

export function pultListenHost(secrets, env = process.env) {
  return env.PULT_HOST || secrets.web.get('PULT_HOST') || '127.0.0.1';
}

/** Локальный URL API (сборщик всегда ходит на loopback). */
export function pultApiBase(secrets) {
  const port = secrets.web.get('PULT_PORT') || secrets.collector.get('PULT_URL')?.match(/:(\d+)/)?.[1] || '8791';
  const fromCollector = secrets.collector.get('PULT_URL');
  if (fromCollector) return fromCollector.replace(/\/+$/, '');
  return `http://127.0.0.1:${port}`;
}

/**
 * @param {'webapp'|'once'} kind
 * @returns {Promise<{ url: string, expiresAt: string, once: boolean, ttlSec: number }>}
 */
export async function issuePultTicket(kind = 'webapp') {
  const secrets = await readPultSecrets();
  const token = pultIngestToken(secrets);
  if (!token) throw new Error('Пульт не настроен: нет PULT_INGEST_TOKEN (включи Пульт в настройках)');
  const base = pultApiBase(secrets);
  const res = await fetch(`${base}/api/bot/ticket`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ kind }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Пульт ответил не JSON (${res.status}): ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(data.error || `Пульт: HTTP ${res.status}`);
  if (!data.url) throw new Error('Пульт не вернул url билета');
  return data;
}

/** Три кнопки в одном ряду: Mini App (initData) · обновить · одноразовая веб-ссылка. */
export async function buildPultCommandKeyboard() {
  const secrets = await readPultSecrets();
  const base = pultPublicUrl(secrets);
  const once = await issuePultTicket('once');
  let httpsOk = false;
  try {
    httpsOk = new URL(base).protocol === 'https:';
  } catch {
    httpsOk = false;
  }
  const kb = new InlineKeyboard();
  // Mini App: без ?tg= — вход через подпись initData текущего бота.
  // На http Telegram web_app недоступен: левая кнопка тогда тоже ведёт на одноразовую ссылку.
  if (httpsOk) kb.webApp('🖥 Пульт', base);
  else kb.url('🖥 Пульт', once.url);
  kb.text('🔄', 'pult:refresh');
  kb.url('🔗 Ссылка', once.url);
  return {
    keyboard: kb,
    text: `<b>🖥 Пульт</b>

Левая — Mini App${httpsOk ? ' (вход по подписи Telegram)' : ' недоступен без https — открывает одноразовую ссылку'}.
Средняя — обновить правую кнопку.
Правая — одноразовая веб-ссылка (~1 ч): билет сгорает при любом переходе; без сессии — вход, с сессией — просто открытие панели.`,
  };
}

export function maskSecret(v) {
  const s = String(v || '');
  if (!s) return 'не задан';
  if (s.length <= 4) return 'задан (•••)';
  return `задан (…${s.slice(-4)})`;
}

export function listenHostLabel(host) {
  if (!host || host === '127.0.0.1' || host === '::1') return 'только localhost (127.0.0.1)';
  if (host === '0.0.0.0' || host === '::') return 'все интерфейсы (0.0.0.0)';
  return `адрес ${host}`;
}
