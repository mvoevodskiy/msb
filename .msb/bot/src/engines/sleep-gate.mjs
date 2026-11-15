/**
 * Provider-independent admission for a sleeping bot: [policy](./sleep.mjs),
 * [Telegram ingress/queue](../telegram/bot.mjs), [checks](../../tests/sleep-gate.test.mjs).
 * The caller owns marker/wake decisions, notices and provider-scoped stop access.
 */
const KEY_PATTERNS = [
  /(?<!\d)\d{5,12}:[A-Za-z0-9_-]{30,}/,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{6,}/,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/,
  /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{20,}/,
];

export function createSleepGate({ pending, sleeping, notify, allowStop = async () => false }) {
  async function middleware(ctx, next) {
    if (!await sleeping()) return next();
    const data = ctx.callbackQuery?.data;
    const text = ctx.message?.text || '';
    const stopping = /^\/stop(?:@\w+)?(?:\s|$)/.test(text) ||
      (text.toLowerCase() === 'стоп' && Boolean(ctx.message?.reply_to_message));
    if (stopping && await allowStop()) return next();
    if (typeof data === 'string' && (data.startsWith('eng:') || data.startsWith('settings:'))) return next();
    if (/^\/settings(?:@\w+)?(?:\s|$)/.test(text)) return next();
    if (pending.has(ctx.chat?.id) && text.trim() && !text.trim().startsWith('/')) return next();
    if (!ctx.message && !ctx.callbackQuery) return;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    if (!ctx.chat?.id) return;
    let suffix = '';
    if (text && KEY_PATTERNS.some(pattern => pattern.test(text))) {
      const deleted = await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).then(() => true, () => false);
      suffix = deleted ? '\nСообщение с ключом удалил.' : '\nУдали сообщение с ключом из чата сам: у меня не получилось.';
    }
    await notify(ctx, suffix);
  }

  async function queued(entry) {
    if (!await sleeping()) return false;
    await entry.presentation?.catch(() => {});
    if (!entry.recovered && entry.status?.message_id) {
      await entry.ctx.api.deleteMessage(entry.ctx.chat.id, entry.status.message_id).catch(() => {});
    }
    if (!entry.recovered && !entry.isAutoTurn) await notify(entry.ctx);
    return true;
  }

  return { middleware, queued };
}
