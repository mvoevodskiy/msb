/**
 * Проверка CLI и прежний native login Codex; вход — callback меню, выход — статус и инструкция.
 * Вызывает [auth-wire](../auth-wire.mjs); проверка: [device login](../tests/codex-device-login.test.mjs).
 * Навигация: [Обвязка](../README.md).
 */
import { getProvider } from '../providers.mjs';
import fs from 'node:fs/promises';
import { buildConnMenu, switchedText, codexLoginGuide } from '../menu.mjs';
import { ensureProviderCli, enrichPath } from '../ensure-cli.mjs';
import { captureCodexLogin, startCodexDeviceLogin, waitCodexNativeAuth, codexLoginStatus } from '../auth-wire.mjs';
import { syncExtAuthGate } from '../setup-bypass.mjs';
import { codexHome, hasNativeCodexAuth } from '../codex-native.mjs';
import { ensureCodexStableTransport } from '../codex-transport.mjs';
import { editOrReply } from './shared.mjs';
import { EXT_MARKER } from './shared.mjs';

async function prepareCodexRuntime(profile) {
  if (profile.profileDir !== codexHome(profile.home)) return;
  try {
    const tr = await ensureCodexStableTransport(profile.home, profile.env);
    if (tr.changed) {
      console.error(`${EXT_MARKER} codex transport → ${tr.providerId}`);
    }
  } catch (err) {
    console.error(`${EXT_MARKER} codex transport ensure failed:`, err?.message || err);
  }
}

async function activateCodex(profile, activateCli = false) {
  const outcome = await syncExtAuthGate(process.env, undefined, {
    activateCli, verifiedCodexProfile: profile.profileDir,
  });
  if (!outcome.selected) return false;
  await prepareCodexRuntime(profile);
  return true;
}

function rejectCodexSelection(bot, chatId, messageId) {
  return editOrReply(bot, chatId, messageId, 'Codex CLI не подтвердил вход. Выбранный движок и сессия сохранены.',
    { inline_keyboard: [[{ text: '🔐 Вход', callback_data: 'ext:auth:codex' }], [{ text: '« Назад', callback_data: 'settings:conn' }]] });
}

async function showCodexSelection(bot, chatId, messageId) {
  const menu = await buildConnMenu();
  await editOrReply(bot, chatId, messageId, switchedText('codex') + '\n\n' + menu.text, menu.keyboard);
}

export async function selectCodexNative(bot, chatId, messageId) {
  if (!await ensureAndReport(bot, chatId, messageId, 'codex')) return false;
  const profile = await captureCodexLogin().catch(() => null);
  if (!profile || !(await codexLoginStatus(profile.env, profile.home)).ok || !await activateCodex(profile, true)) {
    await rejectCodexSelection(bot, chatId, messageId);
    return false;
  }
  await showCodexSelection(bot, chatId, messageId);
  return true;
}

export async function ensureAndReport(bot, chatId, messageId, providerId) {
  const p = getProvider(providerId);
  await editOrReply(
    bot,
    chatId,
    messageId,
    `⏳ Проверяю CLI для ${p?.title || providerId}…`,
    undefined,
  );
  process.env.PATH = enrichPath(process.env);
  const res = await ensureProviderCli(providerId, { env: process.env });
  if (!res.ok) {
    await editOrReply(
      bot,
      chatId,
      messageId,
      `❌ CLI для ${p?.title || providerId} не готов.\n\n${res.error || 'неизвестная ошибка'}\n\nМожно поставить вручную и снова выбрать провайдера в «🔌 Подключение».`,
      undefined,
    );
    return false;
  }
  if (res.installed) {
    await bot.api
      .sendMessage(chatId, `✔ CLI установлен: <code>${res.bin}</code>`, { parse_mode: 'HTML' })
      .catch(() => {});
  }
  return true;
}

export async function connectCodexNative(bot, chatId, messageId) {
  const okCli = await ensureAndReport(bot, chatId, messageId, 'codex');
  if (!okCli) return false;

  const profile = await captureCodexLogin().catch(() => null);
  if (!profile) {
    await rejectCodexSelection(bot, chatId, messageId);
    return false;
  }
  if (await hasNativeCodexAuth(profile.home, profile.profileDir)) {
    const status = await codexLoginStatus(profile.env, profile.home);
    if (status.ok) {
      if (!await activateCodex(profile)) {
        await rejectCodexSelection(bot, chatId, messageId);
        return false;
      }
      await showCodexSelection(bot, chatId, messageId);
      console.error(`${EXT_MARKER} active provider → codex (native auth)`);
      return true;
    }
  }

  await editOrReply(bot, chatId, messageId, '⏳ Запускаю штатный вход Codex (device code)…', undefined);

  let started;
  try {
    if (profile.env.CODEX_HOME) await fs.mkdir(profile.profileDir, { recursive: true, mode: 0o700 });
    started = startCodexDeviceLogin(profile.env, profile.home);
  } catch (error) {
    started = { ok: false, error: error.message };
  }
  if (!started.ok) {
    await editOrReply(
      bot,
      chatId,
      null,
      `❌ Не удалось начать вход Codex.\n${started.error}\n\nДвижок не переключаю.`,
      undefined,
    );
    return false;
  }

  // Дать CLI напечатать URL/код. Проверять вход только в исходном профиле.
  let guideSent = false;
  let guideSending = false;
  const sendCompleteGuide = async () => {
    if (guideSent || guideSending) return;
    const info = started.extract?.() || {};
    if (!info.url || !info.code) return;
    guideSending = true;
    try {
      await bot.api.sendMessage(chatId, codexLoginGuide(info), { parse_mode: 'HTML' });
      guideSent = true;
    } catch {
      // Leave it eligible for retry while the same device login is pending.
    } finally {
      guideSending = false;
    }
  };
  const guideTimer = setInterval(() => { void sendCompleteGuide(); }, 1000);
  await new Promise((r) => setTimeout(r, 1500));
  await sendCompleteGuide();
  if (!guideSent && !guideSending) {
    const info = started.extract?.() || {};
    if (!info.url && !info.code) {
      await bot.api
        .sendMessage(chatId, codexLoginGuide(), { parse_mode: 'HTML' })
        .catch(() => {});
    }
  }

  const waited = await waitCodexNativeAuth({ env: profile.env, home: profile.home, timeoutMs: 300_000 });
  clearInterval(guideTimer);
  try {
    started.child?.kill('SIGTERM');
  } catch {
    /* ignore */
  }

  if (!waited.ok || !(await hasNativeCodexAuth(profile.home, profile.profileDir))) {
    await bot.api
      .sendMessage(
        chatId,
        `❌ Вход Codex не подтверждён.\n${waited.error || 'нет auth.json выбранного профиля'}\n\nДвижок не переключаю.`,
      )
      .catch(() => {});
    return false;
  }

  if (!await activateCodex(profile)) {
    await rejectCodexSelection(bot, chatId, messageId);
    return false;
  }
  const menu = await buildConnMenu();
  await bot.api
    .sendMessage(chatId, `${switchedText('codex')}\n\n${menu.text}`, {
      parse_mode: 'HTML',
      reply_markup: menu.keyboard,
    })
    .catch(() => {});
  console.error(`${EXT_MARKER} active provider → codex (device login ok)`);
  return true;
}
