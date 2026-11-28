// Бот поддержки. Отдельный токен, тот же процесс, что Установщик.
// Вход: текст человека. Выход: ответ в Telegram и запись через support-ingress.
// Админов Установщика не требует. Проверка приёма: tests/tickets.test.mjs.

import { Bot } from 'grammy';
import { receiveSupportText } from '../portal/support-ingress.mjs';

const REPLIES = {
  support_unavailable: 'Поддержка сейчас не принимает обращения.',
  capability_denied: 'Доступ к поддержке закрыт.',
  empty_text: 'Напишите текст обращения.',
  text_too_long: 'Сообщение длиннее 4000 символов.',
};

export function createSupportBot(deps) {
  if (!deps.config.supportBotToken) return null;
  const bot = new Bot(deps.config.supportBotToken);

  async function answer(ctx, code, created) {
    if (code === 'accepted') {
      await ctx.reply(created ? 'Обращение принято.' : 'Сообщение добавлено в открытое обращение.');
      return;
    }
    await ctx.reply(REPLIES[code] || 'Сообщение не принято.');
  }

  bot.command('start', async (ctx) => {
    await ctx.reply('Напишите сообщение. Пока обращение открыто, следующие сообщения попадут в него.');
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    try {
      const result = await receiveSupportText({
        tickets: deps.tickets,
        access: deps.access,
        clients: deps.clients,
        from: ctx.from,
        text,
        source: 'bot',
      });
      await answer(ctx, result.code, result.created);
    } catch {
      await ctx.reply('Сообщение не принято.');
    }
  });

  return {
    bot,
    handleUpdate: (update) => bot.handleUpdate(update),
    async send(row) {
      try {
        await bot.api.sendMessage(Number(row.tg_user_id), row.payload.text);
        return { ok: true };
      } catch (err) {
        const code = Number(err?.error_code || err?.error?.error_code || 0);
        if (!code || code >= 500) {
          throw Object.assign(new Error('outcome unknown'), { code: 'OUTCOME_UNKNOWN' });
        }
        throw err;
      }
    },
    async start() {
      if (deps.config.botMode === 'webhook') {
        const whUrl = `${deps.config.baseUrl}/telegram/support`;
        const opts = {};
        if (deps.config.supportWebhookSecret) opts.secret_token = deps.config.supportWebhookSecret;
        await bot.api.setWebhook(whUrl, opts);
        console.log(`[support] webhook → ${whUrl}`);
      } else {
        await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
        bot.start({
          onStart: (info) => console.log(`[support] polling @${info.username}`),
        });
      }
    },
  };
}
