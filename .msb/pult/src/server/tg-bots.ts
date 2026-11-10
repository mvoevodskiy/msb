// Кандидаты для проверки initData Mini App: отдельный бот тревог Пульта и все MSB-боты на машине.
// Mini App открывается из любого бота — подпись initData идёт его BOT_TOKEN, не обязательно PULT_TG_TOKEN.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TgAuthCandidate {
  token: string;
  chatId: string;
  /** Откуда взяли — для журнала, без секретов. */
  source: string;
}

function parseEnv(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    let v = t.slice(i + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    map.set(t.slice(0, i), v);
  }
  return map;
}

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

/**
 * Список (token, ownerChatId) для verifyTgWebAppInitData.
 * cfgTg — из PULT_TG_* (если задан); плюс <PULT_BOTS_DIR>/<id>/.env.
 * PULT_BOTS_ROOT — совместимый alias; по умолчанию ~/.msb/bots.
 */
export function listTgAuthCandidates(
  cfgTg: { token: string; chatId: string } | null,
  home = process.env.HOME || homedir(),
  env: NodeJS.ProcessEnv = process.env,
): TgAuthCandidate[] {
  const out: TgAuthCandidate[] = [];
  const seen = new Set<string>();

  const add = (token: string, chatId: string, source: string) => {
    if (!TOKEN_RE.test(token) || !chatId) return;
    const key = `${token}\0${chatId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ token, chatId, source });
  };

  if (cfgTg) add(cfgTg.token, cfgTg.chatId, 'pult-tg');

  const botsRoot = env.PULT_BOTS_DIR || env.PULT_BOTS_ROOT || join(home, '.msb', 'bots');
  let ids: string[] = [];
  try {
    ids = readdirSync(botsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
  } catch {
    return out;
  }
  for (const id of ids) {
    try {
      const env = parseEnv(readFileSync(join(botsRoot, id, '.env'), 'utf8'));
      const token = env.get('BOT_TOKEN') || '';
      const chatId = env.get('ADMIN_ID') || env.get('OWNER_USER_ID') || '';
      add(token, chatId, `msb-bot@${id}`);
    } catch {
      /* нет .env */
    }
  }
  return out;
}
