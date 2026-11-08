/**
 * Ввод локального IP и ключей: только в исходном чате, просроченный ввод
 * поглощается до модели. State — auth/local-ssh; [проверки](../tests/input-scope.test.mjs).
 * Навигация: [Обвязка](../README.md).
 */
import profile from '../../shared/profile.cjs';
import { AUTH_INPUT_EXPIRED } from '../../shared/input-notices.mjs';
import { setActive } from '../store.mjs';
import { saveProviderSecret } from '../env.mjs';
import { buildConnMenu, savedKeyText } from '../menu.mjs';
import { getPendingAuth, clearPendingAuth } from '../auth.mjs';
import { ensureProviderCli, enrichPath } from '../ensure-cli.mjs';
import { wireProviderAuth } from '../auth-wire.mjs';
import { syncExtAuthGate } from '../setup-bypass.mjs';
import { setLocalSshHost, getPendingLocalIp, clearPendingLocalIp, isValidLocalSshHost } from '../local-ssh.mjs';
import { buildLocalSshMenu } from '../menu.mjs';
import { EXT_MARKER } from './shared.mjs';

export async function handleLocalSshIpMessage(bot, msg) {
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (!userId || !chatId) return false;
  const pending = getPendingLocalIp(userId, { chatId, includeExpired: true });
  if (!pending) return false;
  if (pending.expired) {
    clearPendingLocalIp(userId);
    await bot.api.sendMessage(chatId, '⏳ Время на ввод IP истекло (10 мин) — режим ввода сброшен. Начни заново: /settings → 🔌 Подключение.');
    return true;
  }

  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) {
    clearPendingLocalIp(userId);
    return false;
  }

  clearPendingLocalIp(userId);
  if (!isValidLocalSshHost(text)) {
    await bot.api.sendMessage(
      chatId,
      `Не похоже на IPv4/hostname. Пример: <code>${profile.resolveProfile().lanExample}</code>`,
      { parse_mode: 'HTML' },
    );
    return true;
  }

  try {
    await setLocalSshHost(text);
    await bot.api.deleteMessage(chatId, msg.message_id).catch(() => {});
    const menu = await buildLocalSshMenu();
    await bot.api.sendMessage(
      chatId,
      `✔ Локальный SSH IP: <code>${text}</code>\n\n${menu.text}`,
      { parse_mode: 'HTML', reply_markup: menu.keyboard },
    );
    console.error(`${EXT_MARKER} MSB_LOCAL_SSH_HOST → ${text}`);
  } catch (err) {
    await bot.api.sendMessage(chatId, `❌ ${String(err.message || err).slice(0, 200)}`);
  }
  return true;
}

export async function handleAuthMessage(bot, msg) {
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (!userId || !chatId) return false;

  if (await handleLocalSshIpMessage(bot, msg)) return true;

  const pending = getPendingAuth(userId, { chatId, includeExpired: true });
  if (!pending) return false;

  // Codex не принимает секрет из Telegram — сбрасываем pending, если вдруг остался.
  if (pending.providerId === 'codex') {
    clearPendingAuth(userId);
    await bot.api
      .sendMessage(
        chatId,
        'Для Codex секрет в чат не нужен. Открой «🔌 Подключение» → Codex → «Войти» (ChatGPT device code).',
      )
      .catch(() => {});
    return true;
  }

  if (pending.expired) {
    clearPendingAuth(userId);
    await bot.api.sendMessage(chatId, AUTH_INPUT_EXPIRED);
    return true;
  }

  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) {
    clearPendingAuth(userId);
    return false;
  }

  try {
    await saveProviderSecret(pending.providerId, text);
    clearPendingAuth(userId);
    await bot.api.deleteMessage(chatId, msg.message_id).catch(() => {});

    await bot.api.sendMessage(chatId, '⏳ Сохранил ключ. Ставлю/проверяю CLI и авторизацию…').catch(() => {});
    process.env.PATH = enrichPath(process.env);
    const cli = await ensureProviderCli(pending.providerId, { env: process.env });
    if (!cli.ok) {
      await bot.api.sendMessage(
        chatId,
        `✔ Ключ сохранён, но CLI не готов:\n${cli.error}\n\nПоставь CLI и снова выбери провайдера в «🔌 Подключение».`,
      );
      return true;
    }

    const wired = await wireProviderAuth(pending.providerId, text, process.env);
    if (!wired?.ok) {
      await bot.api.sendMessage(
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
    await bot.api.sendMessage(
      chatId,
      `${savedKeyText(pending.providerId)}${extra}\n\n${menu.text}`,
      { parse_mode: 'HTML', reply_markup: menu.keyboard },
    );
    console.error(`${EXT_MARKER} saved+wired ${pending.providerId}`);
  } catch (err) {
    clearPendingAuth(userId);
    await bot.api.sendMessage(chatId, `❌ Не сохранил ключ: ${String(err.message || err).slice(0, 200)}`);
  }
  return true;
}
