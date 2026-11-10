/**
 * Ворота владельца: только ADMIN_ID.
 * Чужие апдейты — тишина (как в закрытом ядре), без reply.
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
