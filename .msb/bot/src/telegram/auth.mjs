/**
 * Ворота владельца: только ADMIN_ID.
 * Чужие апдейты пропускаются молча. У кнопок nm:* есть прежнее предупреждение владельца.
 * Первый запуск: [bot](./bot.mjs) и [setup route](./routes/agent.mjs);
 * наличие Codex определяется той же регистрацией overlay, что и сохранённые ходы.
 * Claude keys: readonly inherit от default — [provider-env-inherit](../../shared/provider-env-inherit.mjs).
 * Проверка: [onboarding guides](../../tests/onboarding-guides.test.mjs).
 */
import { resolveClaudeCreds } from '../../shared/provider-env-inherit.mjs';

export function isAdmin(ctx, adminId) {
  const uid = ctx.from?.id;
  if (!adminId) return false;
  return Number(uid) === Number(adminId);
}

export function adminGuard(adminId) {
  return async (ctx, next) => {
    if (!adminId) {
      // без ADMIN_ID нельзя открывать бота всем
      if (ctx.message || ctx.callbackQuery) {
        try {
          await ctx.reply('ADMIN_ID не задан в окружении бота. Добавь его в .env и перезапусти.');
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (!isAdmin(ctx, adminId)) {
      if (ctx.callbackQuery?.data === 'pause-off') {
        await ctx.answerCallbackQuery({ text: 'Снимает паузу только владелец бота', show_alert: true }).catch(() => {});
      } else if (/^nm:.+$/.test(ctx.callbackQuery?.data ?? '')) {
        await ctx.answerCallbackQuery({ text: 'Настраивает только владелец бота', show_alert: true }).catch(() => {});
      }
      return;
    }
    return next();
  };
}

/** Setup Mode: нет authMode и нет ключей в env (включая readonly inherit от default). */
export function isSetupMode(state, env = process.env) {
  if (state?.engine === 'oc') return false;
  if (state?.authMode) return false;
  if (state?.extAuthBypass) return false;
  if (resolveClaudeCreds(env).ok) return false;
  return true;
}

/** Не предлагать инструкцию для маршрута, отсутствующего в plain core или отключённого флагом. */
export function hasCodexSetup(bot, env = process.env) {
  return env.JARVIS_CC_ONLY !== '1' && typeof bot?.[Symbol.for('msb.savedCodexPrompt')] === 'function';
}
