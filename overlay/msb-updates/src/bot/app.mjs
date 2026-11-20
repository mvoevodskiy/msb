import { Bot, InlineKeyboard } from 'grammy';
import { loadSshInstruction } from './copy.mjs';

export function createInstallerBot(ctx) {
  const { config, auth, intents, worker } = ctx;
  if (!config.botToken) return null;

  const bot = new Bot(config.botToken);
  const sessions = new Map(); // tg_user_id -> { step, type, intentId }

  function isAdmin(userId) {
    if (!config.adminIds.length) return true; // если список пуст — любой (dev)
    return config.adminIds.includes(Number(userId));
  }

  async function userToken(tgUserId) {
    // выдаём/переиспользуем installer_session на лету
    const issued = await auth.issueToken({
      tgUserId,
      kind: 'installer_session',
      scopes: ['core:read', 'ext:read', 'install:ext', 'install:empty', 'web:open'],
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    return issued.token;
  }

  function mainKeyboard() {
    return new InlineKeyboard()
      .text('Подключить обвязку', 'inst:ext')
      .row()
      .text('Новый сервер', 'inst:empty')
      .row()
      .text('Мои установки', 'inst:list')
      .row()
      .text('Открыть веб', 'inst:web');
  }

  async function sendInstruction(ctx, type) {
    const text = loadSshInstruction({
      publicKey: worker.getPublicKey(),
      egressIps: config.egressIps,
    });
    sessions.set(ctx.from.id, { step: 'await_host', type });
    const kb = new InlineKeyboard()
      .text('Я открыл доступ — указать хост', 'inst:host')
      .row()
      .text('Открыть веб', 'inst:web')
      .row()
      .text('« Назад', 'inst:home');
    await ctx.reply(text, { reply_markup: kb });
  }

  bot.command('start', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('Нет доступа к установщику.');
      return;
    }
    await ctx.reply(
      'Установщик MSB: обвязка на существующий бот или новый сервер.\nВладелец скрипты не запускает — только SSH в настройках бота.',
      { reply_markup: mainKeyboard() },
    );
  });

  bot.callbackQuery('inst:home', async (ctx) => {
    await ctx.answerCallbackQuery();
    sessions.delete(ctx.from.id);
    await ctx.reply('Выбери действие:', { reply_markup: mainKeyboard() });
  });

  bot.callbackQuery('inst:ext', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAdmin(ctx.from.id)) return ctx.reply('Нет доступа');
    await sendInstruction(ctx, 'ext_overlay');
  });

  bot.callbackQuery('inst:empty', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAdmin(ctx.from.id)) return ctx.reply('Нет доступа');
    await sendInstruction(ctx, 'empty_bot');
  });

  bot.callbackQuery('inst:host', async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = sessions.get(ctx.from.id);
    if (!s?.type) {
      await ctx.reply('Сначала выбери сценарий.', { reply_markup: mainKeyboard() });
      return;
    }
    s.step = 'await_host';
    await ctx.reply('Пришли хост сервера одной строкой (IP или DNS). Опционально: host:port');
  });

  bot.callbackQuery('inst:web', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAdmin(ctx.from.id)) return;
    const link = await auth.createWebLink({ tgUserId: ctx.from.id });
    const url = `${config.baseUrl}/?t=${encodeURIComponent(link.token)}`;
    await ctx.reply(`Одноразовая ссылка (до ${link.expires_at}):\n${url}`);
  });

  bot.callbackQuery('inst:list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const list = await intents.listByUser(ctx.from.id, 10);
    if (!list.length) {
      await ctx.reply('Установок пока нет.', { reply_markup: mainKeyboard() });
      return;
    }
    const lines = list.map((i) => `• ${i.id} — ${i.type} — ${i.status}${i.host ? ` @ ${i.host}` : ''}${i.ext_version ? ` ext=${i.ext_version}` : ''}`);
    await ctx.reply(lines.join('\n'), { reply_markup: mainKeyboard() });
  });

  bot.callbackQuery(/^inst:retry:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const intentId = ctx.match[1];
    await worker.enqueue(intentId);
    await ctx.reply(`Повторная проверка запущена для ${intentId}`);
  });

  bot.on('message:text', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const s = sessions.get(ctx.from.id);
    if (!s || s.step !== 'await_host') return;
    const raw = ctx.message.text.trim();
    if (raw.startsWith('/')) return;

    let host = raw;
    let port = 22;
    if (raw.includes(':') && !raw.includes('://')) {
      const [h, p] = raw.split(':');
      host = h;
      port = Number(p) || 22;
    }

    const rec = await intents.create({
      type: s.type,
      tg_user_id: ctx.from.id,
      host,
      port,
      ssh_user: config.defaultSshUser,
    });
    s.intentId = rec.id;
    s.step = 'running';
    await worker.enqueue(rec.id);
    await ctx.reply(
      `Задача ${rec.id} поставлена в очередь.\nХост: ${host}:${port}\nСтатус можно смотреть в «Мои установки» или на вебе.`,
      {
        reply_markup: new InlineKeyboard()
          .text('Повторить проверку', `inst:retry:${rec.id}`)
          .row()
          .text('« Меню', 'inst:home'),
      },
    );

    // poll briefly and notify
    setTimeout(async () => {
      const cur = await intents.get(rec.id);
      if (!cur) return;
      if (cur.status === 'done') {
        await ctx.reply(`Готово: обвязка ${cur.ext_version || '?'} на ${cur.host}`);
      } else if (cur.status === 'failed' || cur.status === 'awaiting_ssh') {
        await ctx.reply(
          `Пока не вышло (${cur.status}${cur.error ? `: ${cur.error}` : ''}).\nПроверь ключ и IP в настройках бота, затем «Повторить проверку».\n\n` +
            loadSshInstruction({ publicKey: worker.getPublicKey(), egressIps: config.egressIps }),
          { reply_markup: new InlineKeyboard().text('Повторить проверку', `inst:retry:${rec.id}`) },
        );
      }
    }, 20000);
  });

  return {
    bot,
    handleUpdate: (update) => bot.handleUpdate(update),
    async start() {
      if (config.botMode === 'webhook') {
        const whUrl = `${config.baseUrl}/telegram/webhook`;
        const opts = {};
        if (config.webhookSecret) opts.secret_token = config.webhookSecret;
        await bot.api.setWebhook(whUrl, opts);
        console.log(`[bot] webhook → ${whUrl}`);
      } else {
        await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
        bot.start({
          onStart: (info) => console.log(`[bot] polling @${info.username}`),
        });
      }
    },
  };
}
