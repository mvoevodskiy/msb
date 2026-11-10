/**
 * Канал обновлений владельца open-core (не vendor creator).
 *
 * Позже: свой сервис манифеста.
 * Сейчас: безопасная заглушка — проверяет MSB_OWN_UPDATES_URL, ничего не качает
 * без явного MSB_OWN_UPDATES_APPLY=1.
 *
 * Vendor puller/sync создателя уже отключены при наличии OPEN-CORE.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function checkOwnUpdates(env = process.env) {
  const url = (env.MSB_OWN_UPDATES_URL || '').replace(/\/$/, '');
  if (!url) {
    return {
      ok: true,
      status: 'unconfigured',
      message:
        'Свой канал обновлений ещё не задан (MSB_OWN_UPDATES_URL). Vendor-обновления создателя закрытого ядра отключены.',
    };
  }
  try {
    const res = await fetch(`${url}/manifest.json`, {
      headers: env.MSB_OWN_UPDATES_TOKEN
        ? { Authorization: `Bearer ${env.MSB_OWN_UPDATES_TOKEN}` }
        : {},
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) {
      return { ok: true, status: 'empty', message: 'Сервис отвечает, манифеста пока нет.' };
    }
    if (!res.ok) {
      return { ok: false, status: 'http', message: `HTTP ${res.status}` };
    }
    const man = await res.json();
    const local = await localVersion();
    return {
      ok: true,
      status: 'ok',
      local,
      remote: man.version || man.tag || null,
      message: man.version
        ? `Удалённо: ${man.version}, локально: ${local}`
        : 'Манифест получен (поля version нет).',
      manifest: man,
    };
  } catch (err) {
    return { ok: false, status: 'error', message: err.message };
  }
}

export async function applyOwnUpdates(_env = process.env) {
  return {
    ok: false,
    message:
      'Apply своего канала ещё не реализован. Когда сервис будет готов — включится здесь. Vendor apply намеренно недоступен.',
  };
}

async function localVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '../../package.json'), 'utf8'));
    return pkg.version || 'open';
  } catch {
    return 'open';
  }
}
