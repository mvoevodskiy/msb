/**
 * Old plan clicks/comment state, owned by [createBot](./bot.mjs), behind owner guard.
 * [router](./router.mjs) → callback; text ingress → consumeComment after secret forms.
 * Output is an ordinary input to the same [inbox](./inbox.mjs), never a second runner.
 * State is per user + originating chat, in memory, untimed as old S$; no saved grant.
 * [Final keyboard](./plan.mjs), [regressions](../../tests/plan-handoff.test.mjs).
 */
const prompts = {
  approve: '✔ Продолжай выполнение.',
  always: '☑ Разрешаю это действие всегда. Продолжай.',
  skip: '✖ Пропусти это изменение, продолжай дальше.',
};
const topicOptions = ctx => {
  const thread = (ctx.message || ctx.callbackQuery?.message)?.message_thread_id;
  return thread && thread !== 1 ? { message_thread_id: thread } : {};
};
async function removeKeyboard(ctx, messageId) {
  if (messageId) await ctx.api.editMessageReplyMarkup(ctx.chat.id, messageId, { reply_markup: undefined }).catch(() => {});
}

export function createPlanActions({ enqueue }) {
  const comments = new Map();
  return {
    async callback(ctx) {
      const action = ctx.callbackQuery.data.slice('plan:'.length);
      const messageId = ctx.callbackQuery.message?.message_id;
      await removeKeyboard(ctx, messageId);
      if (Object.hasOwn(prompts, action)) enqueue(ctx, prompts[action]);
      else if (action === 'reject') await ctx.reply('✖️ Задача отменена. Напиши что изменить.', topicOptions(ctx));
      else if (action === 'comment') {
        if (messageId) comments.set(ctx.from.id, { chatId: ctx.chat.id, messageId });
        await ctx.reply('Напиши комментарий — агент учтёт его:', topicOptions(ctx));
      }
    },
    async consumeComment(ctx, text) {
      const entry = comments.get(ctx.from?.id);
      if (!entry || entry.chatId !== ctx.chat.id) return false;
      comments.delete(ctx.from.id);
      await removeKeyboard(ctx, entry.messageId);
      enqueue(ctx, `✖ Не согласен. Комментарий: ${text}`);
      return true;
    },
  };
}
