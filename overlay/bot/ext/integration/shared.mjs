/**
 * Общие операции интеграции: состояние маршрута и edit/send.
 * Scope/ordered delivery → [shared lifecycle](../../shared/callback-renders.mjs);
 * [continuation checks](../../../../.msb/bot/tests/callback-scope.test.mjs).
 * Навигация: [Обвязка](../README.md).
 */
import fs from 'node:fs/promises';
import { currentCallbackRender, callbackTransportSignal } from '../../shared/callback-renders.mjs';
import os from 'node:os';
import { botStatePath } from '../paths.mjs';

export const EXT_MARKER = '[msb/ext]';

export function ccOnly() {
  return process.env.JARVIS_CC_ONLY === '1';
}

export async function readEngine(home = os.homedir()) {
  try {
    const raw = await fs.readFile(botStatePath(process.env, home), 'utf8');
    const st = JSON.parse(raw);
    return st?.engine === 'oc' ? 'oc' : 'cc';
  } catch {
    return 'cc';
  }
}

export async function editOrReply(bot, chatId, messageId, text, keyboard) {
  const scope = currentCallbackRender(bot, chatId);
  const deliver = async () => {
    if (scope && !scope.isCurrent()) return;
    const opts = { parse_mode: 'HTML', reply_markup: keyboard };
    if (messageId) {
      try {
        await bot.api.editMessageText(chatId, messageId, text, opts, scope ? callbackTransportSignal(scope) : undefined);
        return;
      } catch { if (scope && !scope.isCurrent()) return; }
    }
    if (!scope || scope.isCurrent()) await bot.api.sendMessage(chatId, text, opts, scope ? callbackTransportSignal(scope) : undefined);
  };
  return scope ? scope.render(deliver) : deliver();
}
