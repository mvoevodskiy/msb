import { Bot, InlineKeyboard } from 'grammy';
import { isInstallerAdmin } from '../config.mjs';
import { isTelegramBotToken, ownerLabel } from '../store/clients.mjs';
import { buildAccessScript } from './access-script.mjs';

export function createInstallerBot(ctx) {
  const { config, auth, intents, worker, clients, secretBox } = ctx;
  if (!config.botToken) return null;

  const bot = new Bot(config.botToken);
  const sessions = new Map(); // tg_user_id -> { step, type, intentId }

  function isAdmin(userId) {
    return isInstallerAdmin(config.adminIds, userId);
  }

  async function guard(ctx) {
    if (isAdmin(ctx.from?.id)) return true;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply('Нет доступа к установщику.').catch(() => {});
    return false;
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
      .text('Создать сервер', 'inst:hoster')
      .row()
      .text('Настроить систему', 'inst:setup')
      .row()
      .text('Клиенты', 'inst:clients')
      .row()
      .text('Мои установки', 'inst:list')
      .row()
      .text('Открыть веб', 'inst:web');
  }

  bot.command('start', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.reply(
      'Установщик MSB: новый сервер или первичная настройка.',
      { reply_markup: mainKeyboard() },
    );
  });

  bot.callbackQuery('inst:home', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    sessions.delete(ctx.from.id);
    await ctx.reply('Выбери действие:', { reply_markup: mainKeyboard() });
  });

  bot.callbackQuery('inst:hoster', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    sessions.set(ctx.from.id, { step: 'await_hoster_token' });
    await ctx.reply('Пришли токен Hetzner Cloud. Токен бота на этом шаге не нужен.');
  });

  bot.callbackQuery('inst:setup', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    sessions.set(ctx.from.id, { step: 'await_setup_user' });
    await ctx.reply('Имя пользователя для первого входа. По умолчанию root — пришли root или «-».');
  });

  bot.callbackQuery('inst:clients', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await sendClients(ctx);
  });

  bot.callbackQuery('inst:web', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const link = await auth.createWebLink({ tgUserId: ctx.from.id });
    const url = `${config.baseUrl}/?t=${encodeURIComponent(link.token)}`;
    await ctx.reply(`Одноразовая ссылка (до ${link.expires_at}):\n${url}`);
  });

  bot.callbackQuery('inst:list', async (ctx) => {
    if (!(await guard(ctx))) return;
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
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const intentId = ctx.match[1];
    await worker.enqueue(intentId);
    await ctx.reply(`Повторная проверка запущена для ${intentId}`);
  });

  bot.command('drop_admin_key', async (ctx) => {
    if (!(await guard(ctx))) return;
    const installationId = String(ctx.match || '').trim();
    if (!installationId) {
      await ctx.reply('Команда: /drop_admin_key <id сервера из «Клиенты».');
      return;
    }
    const kb = new InlineKeyboard().text('Удалить ключ msb-admin', `inst:dropkey:${installationId}`);
    await ctx.reply(`Удалить ключ хаба у msb-admin на ${installationId}?`, { reply_markup: kb });
  });

  bot.callbackQuery(/^inst:dropkey:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const result = await worker.dropAdminKey(ctx.match[1]);
    if (!result.ok) {
      await ctx.reply(`Ключ не снят: ${result.error}`);
      return;
    }
    await ctx.reply(`Ключ msb-admin снят на ${ctx.match[1]}.`);
  });

  bot.on('message:text', async (ctx) => {
    if (!(await guard(ctx))) return;
    const s = sessions.get(ctx.from.id);
    const raw = ctx.message.text.trim();
    if (raw.startsWith('/')) return;
    if (s?.step === 'await_hoster_token') {
      await acceptHosterToken(ctx, raw);
      return;
    }
    if (s?.step === 'await_bot_token') {
      await acceptBotToken(ctx, s, raw);
      return;
    }
    if (s?.step === 'await_setup_user') {
      await acceptSetupUser(ctx, raw);
      return;
    }
    if (s?.step === 'await_setup_host') {
      await acceptSetupHost(ctx, s, raw);
    }
  });

  function splitHost(raw) {
    let host = raw.trim();
    let port = 22;
    if (host.includes(':') && !host.includes('://')) {
      const [h, p] = host.split(':');
      host = h;
      port = Number(p) || 22;
    }
    if (!host || /\s/.test(host)) return { host: '', port };
    return { host, port };
  }

  async function sendClients(ctx) {
    const list = await clients.listInstallations();
    if (!list.length) {
      await ctx.reply('Клиентов пока нет.', { reply_markup: mainKeyboard() });
      return;
    }
    const lines = list.slice(0, 20).map((item) => {
      const where = [item.name, item.host].filter(Boolean).join(' ');
      return `• ${ownerLabel(item)} — ${where || 'без адреса'} — ${item.status}\n  ${item.id}`;
    });
    await ctx.reply(lines.join('\n'), { reply_markup: mainKeyboard() });
  }

  function watchSetup(ctx, intentId) {
    (async () => {
      for (let i = 0; i < 18; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        const cur = await intents.get(intentId);
        if (!cur) return;
        const installation = cur.installation_id ? await clients.getInstallation(cur.installation_id) : null;
        const who = installation ? ownerLabel(installation) : String(cur.tg_user_id);
        if (cur.status !== 'done' && cur.status !== 'failed') continue;
        if (cur.status === 'done') {
          await ctx.reply(`Готово: ${who}, ${cur.host}. Ключ msb-admin оставлен.`);
        } else {
          await ctx.reply(`Не вышло (${cur.error || cur.status}). ${who}. Запись ${cur.installation_id || intentId}.`);
        }
        return;
      }
    })().catch(() => {});
  }

  async function acceptHosterToken(ctx, raw) {
    if (isTelegramBotToken(raw)) {
      await ctx.reply('Это токен бота. Пришли токен Hetzner Cloud.');
      return;
    }
    try {
      const client = await clients.upsertFromTelegram(ctx.from);
      const account = await clients.savePlatformToken(client.tg_user_id, {
        provider: config.hoster.provider,
        token: raw,
      });
      sessions.set(ctx.from.id, { step: 'await_bot_token', platformAccountId: account.id });
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply('Токен площадки сохранён. Пришли токен Telegram-бота — на хабе он не останется.');
    } catch {
      await ctx.reply('Токен площадки не принят. Пришли его ещё раз.');
    }
  }

  async function acceptBotToken(ctx, session, raw) {
    if (!isTelegramBotToken(raw)) {
      await ctx.reply('Нужен токен Telegram-бота, вида 123456:AA....');
      return;
    }
    const client = await clients.upsertFromTelegram(ctx.from);
    const installation = await clients.createInstallation({
      owner_tg_user_id: client.tg_user_id,
      owner_username: client.username,
      owner_name: client.name,
      origin: 'hoster',
      provider: config.hoster.provider,
      platform_account_id: session.platformAccountId,
      ssh_user: 'root',
      status: 'creating',
    });
    secretBox.put(installation.id, raw);
    await ctx.deleteMessage().catch(() => {});
    const intent = await intents.create({
      type: 'system_setup',
      tg_user_id: ctx.from.id,
      ssh_user: 'root',
      installation_id: installation.id,
      platform_account_id: session.platformAccountId,
    });
    sessions.delete(ctx.from.id);
    await worker.enqueue(intent.id);
    await ctx.reply(
      `Сервер создаётся для ${ownerLabel(installation)}.\nЗапись ${installation.id}. Токен бота на хабе не сохраняю.`,
      { reply_markup: mainKeyboard() },
    );
    watchSetup(ctx, intent.id);
  }

  async function acceptSetupUser(ctx, raw) {
    const lowered = raw.trim().toLowerCase();
    const username = raw.trim() === '-' || lowered === 'root' || lowered === 'по умолчанию' ? 'root' : raw.trim();
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) {
      await ctx.reply('Имя пользователя: латиница, цифры, _ и -. По умолчанию root.');
      return;
    }
    sessions.set(ctx.from.id, { step: 'await_setup_host', username });
    const script = buildAccessScript({ publicKey: worker.getPublicKey(), username });
    await ctx.reply(`Вставь это на сервере под ${username}, затем пришли хост.`);
    await ctx.reply(script);
  }

  async function acceptSetupHost(ctx, session, raw) {
    const { host, port } = splitHost(raw);
    if (!host) {
      await ctx.reply('Пришли хост одной строкой.');
      return;
    }
    const client = await clients.upsertFromTelegram(ctx.from);
    const installation = await clients.createInstallation({
      owner_tg_user_id: client.tg_user_id,
      owner_username: client.username,
      owner_name: client.name,
      origin: 'setup',
      host,
      port,
      ssh_user: session.username || 'root',
      status: 'creating',
    });
    const intent = await intents.create({
      type: 'system_setup',
      tg_user_id: ctx.from.id,
      host,
      port,
      ssh_user: session.username || 'root',
      installation_id: installation.id,
    });
    sessions.delete(ctx.from.id);
    await worker.enqueue(intent.id);
    await ctx.reply(
      `Настройка ${installation.id} для ${ownerLabel(installation)} @ ${host}.`,
      { reply_markup: mainKeyboard() },
    );
    watchSetup(ctx, intent.id);
  }

  return {
    bot,
    handleUpdate: (update) => bot.handleUpdate(update),
    async start() {
      if (!config.adminIds.length) {
        console.log('[bot] INSTALLER_ADMIN_TG_IDS пуст — бот не запущен');
        return;
      }
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
