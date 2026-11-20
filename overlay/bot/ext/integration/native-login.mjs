/**
 * Проверка CLI и native login Codex/Cursor/Grok; вход — callback меню, выход — статус и инструкция.
 * Codex: [auth-wire](../auth-wire.mjs); Cursor: [cursor-auth](../cursor-auth.mjs);
 * Grok: [grok-auth](../grok-auth.mjs). Проверки: [device login](../tests/codex-device-login.test.mjs),
 * [native-auth](../tests/native-auth-login.test.mjs).
 * Навигация: [Обвязка](../README.md).
 */
import { getProvider } from '../providers.mjs';
import fs from 'node:fs/promises';
import { buildConnMenu, switchedText, codexLoginGuide, cursorLoginGuide, grokLoginGuide } from '../menu.mjs';
import { ensureProviderCli, enrichPath } from '../ensure-cli.mjs';
import { captureCodexLogin, startCodexDeviceLogin, waitCodexNativeAuth, codexLoginStatus } from '../auth-wire.mjs';
import {
  hasNativeCursorAuth, cursorLoginStatus, startCursorBrowserLogin, waitCursorNativeAuth,
} from '../cursor-auth.mjs';
import {
  hasNativeGrokAuth, grokLoginStatus, startGrokDeviceLogin, waitGrokNativeAuth,
} from '../grok-auth.mjs';
import { syncExtAuthGate } from '../setup-bypass.mjs';
import { setActive } from '../store.mjs';
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

async function activateExtProvider(providerId, activateCli = false) {
  await setActive(providerId);
  const outcome = await syncExtAuthGate(process.env, undefined, { activateCli });
  if (outcome.reason?.startsWith('bypass:')) return true;
  if (outcome.reason === 'select-cli-engine' || outcome.reason === 'noop') return true;
  return false;
}

function rejectNativeSelection(bot, chatId, messageId, providerId, title) {
  return editOrReply(
    bot,
    chatId,
    messageId,
    `${title} не подтвердил вход. Выбранный движок и сессия сохранены.`,
    {
      inline_keyboard: [
        [{ text: '🔐 Вход', callback_data: `ext:auth:${providerId}` }],
        [{ text: '« Назад', callback_data: 'settings:conn' }],
      ],
    },
  );
}

async function showProviderSelection(bot, chatId, messageId, providerId) {
  const menu = await buildConnMenu();
  await editOrReply(bot, chatId, messageId, `${switchedText(providerId)}\n\n${menu.text}`, menu.keyboard);
}

async function finishNativeLogin(bot, chatId, providerId) {
  const menu = await buildConnMenu();
  await bot.api
    .sendMessage(chatId, `${switchedText(providerId)}\n\n${menu.text}`, {
      parse_mode: 'HTML',
      reply_markup: menu.keyboard,
    })
    .catch(() => {});
}

/**
 * Общий цикл: CLI печатает URL(/код) → гид в Telegram → poll native auth.
 * @param {{ requireCode?: boolean }} opts — Cursor browser login может дать только URL.
 */
async function runNativeLoginFlow(bot, chatId, messageId, {
  providerId, title, startLabel, startLogin, waitAuth, hasAuth, guide, requireCode = true,
}) {
  if (!await ensureAndReport(bot, chatId, messageId, providerId)) return false;

  if (await hasAuth()) {
    const activated = await activateExtProvider(providerId, true);
    if (!activated) {
      await rejectNativeSelection(bot, chatId, messageId, providerId, title);
      return false;
    }
    await showProviderSelection(bot, chatId, messageId, providerId);
    console.error(`${EXT_MARKER} active provider → ${providerId} (native auth)`);
    return true;
  }

  await editOrReply(bot, chatId, messageId, startLabel, undefined);
  let started;
  try {
    started = startLogin();
  } catch (error) {
    started = { ok: false, error: error.message };
  }
  if (!started.ok) {
    await editOrReply(
      bot,
      chatId,
      null,
      `❌ Не удалось начать вход ${title}.\n${started.error}\n\nДвижок не переключаю.`,
      undefined,
    );
    return false;
  }

  let guideSent = false;
  let guideSending = false;
  const sendCompleteGuide = async () => {
    if (guideSent || guideSending) return;
    const info = started.extract?.() || {};
    if (!info.url) return;
    if (requireCode && !info.code) return;
    guideSending = true;
    try {
      await bot.api.sendMessage(chatId, guide(info), { parse_mode: 'HTML' });
      guideSent = true;
    } catch {
      /* retry while pending */
    } finally {
      guideSending = false;
    }
  };
  const guideTimer = setInterval(() => { void sendCompleteGuide(); }, 1000);
  await new Promise((r) => setTimeout(r, 1500));
  await sendCompleteGuide();
  if (!guideSent && !guideSending) {
    const info = started.extract?.() || {};
    if (!info.url && !(requireCode && info.code)) {
      await bot.api.sendMessage(chatId, guide(), { parse_mode: 'HTML' }).catch(() => {});
    }
  }

  const waited = await waitAuth();
  clearInterval(guideTimer);
  try {
    started.child?.kill('SIGTERM');
  } catch {
    /* ignore */
  }

  if (!waited.ok || !(await hasAuth())) {
    await bot.api
      .sendMessage(
        chatId,
        `❌ Вход ${title} не подтверждён.\n${waited.error || 'нет native credentials'}\n\nДвижок не переключаю.`,
      )
      .catch(() => {});
    return false;
  }

  if (!await activateExtProvider(providerId)) {
    await rejectNativeSelection(bot, chatId, messageId, providerId, title);
    return false;
  }
  await finishNativeLogin(bot, chatId, providerId);
  console.error(`${EXT_MARKER} active provider → ${providerId} (native login ok)`);
  return true;
}

export async function selectCursorNative(bot, chatId, messageId) {
  if (!await ensureAndReport(bot, chatId, messageId, 'cursor')) return false;
  const status = await cursorLoginStatus();
  if (!status.ok || !await activateExtProvider('cursor', true)) {
    await rejectNativeSelection(bot, chatId, messageId, 'cursor', 'Cursor');
    return false;
  }
  await showProviderSelection(bot, chatId, messageId, 'cursor');
  return true;
}

export async function connectCursorNative(bot, chatId, messageId) {
  return runNativeLoginFlow(bot, chatId, messageId, {
    providerId: 'cursor',
    title: 'Cursor',
    startLabel: '⏳ Запускаю штатный вход Cursor (ссылка в браузере)…',
    startLogin: () => startCursorBrowserLogin(),
    waitAuth: () => waitCursorNativeAuth({ timeoutMs: 300_000 }),
    hasAuth: () => hasNativeCursorAuth(),
    guide: cursorLoginGuide,
    requireCode: false,
  });
}

export async function selectGrokNative(bot, chatId, messageId) {
  if (!await ensureAndReport(bot, chatId, messageId, 'grok')) return false;
  const status = await grokLoginStatus();
  if (!status.ok || !await activateExtProvider('grok', true)) {
    await rejectNativeSelection(bot, chatId, messageId, 'grok', 'Grok Build');
    return false;
  }
  await showProviderSelection(bot, chatId, messageId, 'grok');
  return true;
}

export async function connectGrokNative(bot, chatId, messageId) {
  return runNativeLoginFlow(bot, chatId, messageId, {
    providerId: 'grok',
    title: 'Grok Build',
    startLabel: '⏳ Запускаю штатный вход Grok Build (device code)…',
    startLogin: () => startGrokDeviceLogin(),
    waitAuth: () => waitGrokNativeAuth({ timeoutMs: 300_000 }),
    hasAuth: () => hasNativeGrokAuth(),
    guide: grokLoginGuide,
    requireCode: true,
  });
}
