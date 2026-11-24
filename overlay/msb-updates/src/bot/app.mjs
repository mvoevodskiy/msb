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
      .text('Миграция IIA → MSB', 'inst:migrate')
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
      'Установщик MSB: новый сервер, первичная настройка или миграция с IIA.',
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
    await askSetupUser(ctx);
  });

  bot.callbackQuery('inst:migrate', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await askSetupUser(ctx, 'iia');
  });

  bot.callbackQuery('inst:user:root', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    if (sessions.get(ctx.from.id)?.step !== 'await_setup_user') return;
    await acceptSetupUser(ctx, 'root');
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

  bot.callbackQuery(/^inst:nobackup:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const intent = await intents.get(ctx.match[1]);
    if (!intent || intent.migrate_from !== 'iia' || intent.status !== 'awaiting_backup_confirm') return;
    intent.skip_iia_backup = true;
    intent.error = null;
    await intents.save(intent);
    await worker.enqueue(intent.id);
    await ctx.reply('Продолжаю миграцию без резервной копии.');
    watchSetup(ctx, intent.id);
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
        if (cur.status === 'awaiting_backup_confirm') {
          const need = formatBytes(cur.result?.backup_need);
          const free = formatBytes(cur.result?.backup_free);
          const kb = new InlineKeyboard().text('Продолжить без копии', `inst:nobackup:${intentId}`);
          await ctx.reply(
            `Для резервной копии IIA не хватает места: нужно ${need}, свободно ${free}.\nПродолжить миграцию без копии? Откат к состоянию до миграции тогда будет недоступен.`,
            { reply_markup: kb },
          );
          return;
        }
        if (cur.status !== 'done' && cur.status !== 'failed') continue;
        if (cur.status === 'done') {
          const backup = installation?.iia_backup
            ? `\nРезервная копия: ${installation.iia_backup}`
            : installation?.backup_skipped
              ? '\nРезервная копия не создана.'
              : '';
          await ctx.reply(`Готово: ${who}, ${cur.host}. Ключ msb-admin оставлен.${backup}`);
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

  function askSetupUser(ctx, migrateFrom) {
    sessions.set(ctx.from.id, { step: 'await_setup_user', migrateFrom: migrateFrom || null });
    const text = migrateFrom === 'iia'
      ? 'Миграция IIA → MSB. Имя пользователя для первого входа. Каталог .iia останется на сервере.'
      : 'Имя пользователя для первого входа. По умолчанию root.';
    return ctx.reply(text, { reply_markup: new InlineKeyboard().text('root', 'inst:user:root') });
  }

  function codeBlock(text) {
    const escaped = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre>${escaped}</pre>`;
  }

  function formatBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value ?? '');
    if (n < 1024) return `${n} Б`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
  }

  async function acceptSetupUser(ctx, raw) {
    const current = sessions.get(ctx.from.id);
    const lowered = raw.trim().toLowerCase();
    const username = raw.trim() === '-' || lowered === 'root' || lowered === 'по умолчанию' ? 'root' : raw.trim();
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) {
      await ctx.reply('Имя пользователя: латиница, цифры, _ и -. По умолчанию root.');
      return;
    }
    sessions.set(ctx.from.id, { step: 'await_setup_host', username, migrateFrom: current?.migrateFrom || null });
    const script = buildAccessScript({ publicKey: worker.getPublicKey(), username });
    const lead = current?.migrateFrom === 'iia'
      ? `Вставь это на сервере под ${username}, затем пришли хост. Данные .iia будут скопированы в .msb, исходный каталог не удаляется.`
      : `Вставь это на сервере под ${username}, затем пришли хост.`;
    await ctx.reply(lead);
    await ctx.reply(codeBlock(script), { parse_mode: 'HTML' });
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
      origin: session.migrateFrom === 'iia' ? 'iia_migration' : 'setup',
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
      migrate_from: session.migrateFrom === 'iia' ? 'iia' : null,
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
    handleUpdate: async (update) => {
      try {
        await bot.handleUpdate(update);
      } catch (err) {
        console.error('[bot]', String(err?.message || err).slice(0, 300));
      }
    },
    async start() {
      if (!config.adminIds.length) {
        console.log('[bot] INSTALLER_ADMIN_TG_IDS пуст — бот не запущен');
        return;
      }
      if (config.botMode === 'webhook') {
        await bot.init();
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
