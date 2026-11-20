/**
 * Ворота владельца: только ADMIN_ID.
 * Чужие апдейты — тишина (как в закрытом ядре), без reply.
 * Первый запуск: [bot](./bot.mjs) и [setup route](./routes/agent.mjs);
 * наличие Codex определяется той же регистрацией overlay, что и сохранённые ходы.
 * Проверка: [onboarding guides](../../tests/onboarding-guides.test.mjs).
 */
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
      return; // silent drop
    }
    return next();
  };
}

/** Setup Mode: нет authMode и нет ключей в env. */
export function isSetupMode(state, env = process.env) {
  if (state?.engine === 'oc') return false;
  if (state?.authMode) return false;
  if (state?.extAuthBypass) return false;
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return false;
  if (env.MSB_ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim()) return false;
  return true;
}

/** Не предлагать инструкцию для маршрута, отсутствующего в plain core или отключённого флагом. */
export function hasCodexSetup(bot, env = process.env) {
  return env.JARVIS_CC_ONLY !== '1' && typeof bot?.[Symbol.for('msb.savedCodexPrompt')] === 'function';
}
