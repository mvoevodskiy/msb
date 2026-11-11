/**
 * Ввод локального IP и ключей: только в исходном чате, просроченный ввод
 * поглощается до модели. State — auth/local-ssh; [scope](../tests/input-scope.test.mjs),
 * [transport failures](../tests/input-boundary.test.mjs).
 * Навигация: [Обвязка](../README.md).
 */
import profile from '../../shared/profile.cjs';
import { AUTH_INPUT_EXPIRED } from '../../shared/input-notices.mjs';
import { setActive, setSelectedModel } from '../store.mjs';
import { saveProviderSecret } from '../env.mjs';
import { buildConnMenu, buildModelMenu, openaiCompatPrompt, savedKeyText } from '../menu.mjs';
import { getPendingAuth, clearPendingAuth, setPendingAuth } from '../auth.mjs';
import { ensureProviderCli, enrichPath } from '../ensure-cli.mjs';
import { wireProviderAuth } from '../auth-wire.mjs';
import { syncExtAuthGate } from '../setup-bypass.mjs';
import { saveOpenaiCompatConfig, normalizeOpenaiBaseUrl } from '../openai-compat.mjs';
import { setLocalSshHost, getPendingLocalIp, clearPendingLocalIp, isValidLocalSshHost } from '../local-ssh.mjs';
import { buildLocalSshMenu } from '../menu.mjs';
import { EXT_MARKER } from './shared.mjs';

export async function handleLocalSshIpMessage(bot, msg) {
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (!userId || !chatId) return false;
  const pending = getPendingLocalIp(userId, { chatId, includeExpired: true });
  if (!pending) return false;
  try {
    if (pending.expired) {
      clearPendingLocalIp(userId, { chatId });
      await sendInputNotice(bot, chatId, '⏳ Время на ввод IP истекло (10 мин) — режим ввода сброшен. Начни заново: /settings → 🔌 Подключение.');
      return true;
    }

    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/')) {
      clearPendingLocalIp(userId, { chatId });
      return false;
    }

    clearPendingLocalIp(userId, { chatId });
    if (!isValidLocalSshHost(text)) {
      await sendInputNotice(bot,
        chatId,
        `Не похоже на IPv4/hostname. Пример: <code>${profile.resolveProfile().lanExample}</code>`,
        { parse_mode: 'HTML' },
      );
      return true;
    }

    await setLocalSshHost(text);
    await bot.api.deleteMessage(chatId, msg.message_id).catch(() => {});
    const menu = await buildLocalSshMenu();
    await sendInputNotice(bot,
      chatId,
      `✔ Локальный SSH IP: <code>${text}</code>\n\n${menu.text}`,
      { parse_mode: 'HTML', reply_markup: menu.keyboard },
    );
    console.error(`${EXT_MARKER} MSB_LOCAL_SSH_HOST → ${text}`);
  } catch (err) {
    clearPendingLocalIp(userId, { chatId });
    await sendInputNotice(bot, chatId, `❌ ${String(err.message || err).slice(0, 200)}`);
  }
  return true;
}

export async function handleAuthMessage(bot, msg) {
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (!userId || !chatId) return false;

  // Slash commands cancel only this chat's forms and reach the core even when
  // an expired form still owns late ordinary text.
  if (msg.text?.startsWith('/')) {
    clearPendingAuth(userId, { chatId });
    clearPendingLocalIp(userId, { chatId });
    return false;
  }

  if (await handleLocalSshIpMessage(bot, msg)) return true;

  const pending = getPendingAuth(userId, { chatId, includeExpired: true });
  if (!pending) return false;

  // Codex не принимает секрет из Telegram — сбрасываем pending, если вдруг остался.
  if (pending.providerId === 'codex') {
    clearPendingAuth(userId, { chatId });
    await sendInputNotice(bot,
      chatId,
      'Для Codex секрет в чат не нужен. Открой «🔌 Подключение» → Codex → «Войти» (ChatGPT device code).',
    );
    return true;
  }

  if (pending.expired) {
    clearPendingAuth(userId, { chatId });
    await sendInputNotice(bot, chatId, AUTH_INPUT_EXPIRED);
    return true;
  }

  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) {
    clearPendingAuth(userId, { chatId });
    return false;
  }

  if (pending.providerId === 'openai') {
    return handleOpenaiWizard(bot, msg, pending);
  }

  try {
    await saveProviderSecret(pending.providerId, text);
    clearPendingAuth(userId, { chatId });
    await bot.api.deleteMessage(chatId, msg.message_id).catch(() => {});

    await sendInputNotice(bot, chatId, '⏳ Сохранил ключ. Ставлю/проверяю CLI и авторизацию…');
    process.env.PATH = enrichPath(process.env);
    const cli = await ensureProviderCli(pending.providerId, { env: process.env });
    if (!cli.ok) {
      await sendInputNotice(bot,
        chatId,
        `✔ Ключ сохранён, но CLI не готов:\n${cli.error}\n\nПоставь CLI и снова выбери провайдера в «🔌 Подключение».`,
      );
      return true;
    }

    const wired = await wireProviderAuth(pending.providerId, text, process.env);
    if (!wired?.ok) {
      await sendInputNotice(bot,
        chatId,
        `❌ Авторизация ${pending.providerId} не удалась.\n${wired?.error || 'unknown'}\n\nДвижок не переключаю.`,
      );
      console.error(`${EXT_MARKER} auth wire failed:`, wired?.error);
      return true;
    }
    if (wired?.warn) {
      console.error(`${EXT_MARKER} auth wire warn:`, wired.warn);
    }

    await setActive(pending.providerId);
    await syncExtAuthGate();
    const menu = await buildConnMenu();
    const extra = cli.installed ? `\nCLI: <code>${cli.bin}</code>` : '';
    await sendInputNotice(bot,
      chatId,
      `${savedKeyText(pending.providerId)}${extra}\n\n${menu.text}`,
      { parse_mode: 'HTML', reply_markup: menu.keyboard },
    );
    console.error(`${EXT_MARKER} saved+wired ${pending.providerId}`);
  } catch (err) {
    clearPendingAuth(userId, { chatId });
    await sendInputNotice(bot, chatId, `❌ Не сохранил ключ: ${String(err.message || err).slice(0, 200)}`);
  }
  return true;
}

async function handleOpenaiWizard(bot, msg, pending) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const step = pending.step || 'key';
  const draft = { ...(pending.draft || {}) };

  if (step === 'model-only') {
    try {
      await setSelectedModel('openai', text);
      clearPendingAuth(userId, { chatId });
      await bot.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      const menu = await buildModelMenu();
      await sendInputNotice(bot, chatId, `✔ Модель: <code>${text}</code>\n\n${menu?.text || ''}`, {
        parse_mode: 'HTML',
        reply_markup: menu?.keyboard,
      });
    } catch (err) {
      clearPendingAuth(userId, { chatId });
      await sendInputNotice(bot, chatId, `❌ ${String(err.message || err).slice(0, 200)}`);
    }
    return true;
  }

  if (step === 'key') {
    if (text.length < 8 || /\s/.test(text)) {
      await sendInputNotice(bot, chatId, 'Ключ слишком короткий или содержит пробелы. Пришли ещё раз.');
      return true;
    }
    draft.apiKey = text;
    setPendingAuth(userId, 'openai', chatId, { step: 'url', draft });
    await bot.api.deleteMessage(chatId, msg.message_id).catch(() => {});
    const prompt = openaiCompatPrompt('url', draft);
    await sendInputNotice(bot, chatId, prompt.text, { parse_mode: 'HTML', reply_markup: prompt.keyboard });
    return true;
  }

  if (step === 'url') {
    try {
      draft.baseUrl = normalizeOpenaiBaseUrl(text);
    } catch (err) {
      await sendInputNotice(bot, chatId, `❌ ${String(err.message || err).slice(0, 200)}\nПришли URL ещё раз.`);
      return true;
    }
    setPendingAuth(userId, 'openai', chatId, { step: 'model', draft });
    await bot.api.deleteMessage(chatId, msg.message_id).catch(() => {});
    const prompt = openaiCompatPrompt('model', draft);
    await sendInputNotice(bot, chatId, prompt.text, { parse_mode: 'HTML', reply_markup: prompt.keyboard });
    return true;
  }

  if (step === 'model') {
    try {
      const saved = await saveOpenaiCompatConfig({
        apiKey: draft.apiKey,
        baseUrl: draft.baseUrl,
        model: text,
      });
      clearPendingAuth(userId, { chatId });
      await bot.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      await setActive('openai');
      await syncExtAuthGate();
      const menu = await buildConnMenu();
      await sendInputNotice(
        bot,
        chatId,
        `✔ OpenAI-совместимый подключён.\n` +
          `URL: <code>${saved.baseUrl}</code>\n` +
          `Модель: <code>${saved.model}</code>\n\n${menu.text}`,
        { parse_mode: 'HTML', reply_markup: menu.keyboard },
      );
      console.error(`${EXT_MARKER} openai-compat ready model=${saved.model}`);
    } catch (err) {
      clearPendingAuth(userId, { chatId });
      await sendInputNotice(bot, chatId, `❌ Не сохранил: ${String(err.message || err).slice(0, 200)}`);
    }
    return true;
  }

  clearPendingAuth(userId, { chatId });
  return false;
}

/** Notification failure never changes the admission decision for owned input. */
async function sendInputNotice(bot, ...args) {
  try { return await bot.api.sendMessage(...args); } catch { /* transport only */ }
}
