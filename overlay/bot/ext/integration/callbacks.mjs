/**
 * Callback-ветви расширения в прежнем порядке.
 * Навигация: [Обвязка](../README.md).
 */
import os from 'node:os';
import { normalizePermissionMode } from '../../shared/permission-modes.mjs';
import { isProviderId, getProvider } from '../providers.mjs';
import { setActive } from '../store.mjs';
import { providerConfigured } from '../env.mjs';
import { buildConnMenu, buildModelMenu, buildAgentMenu, buildEffortMenu, buildPermModeMenu, authPrompt, switchedText, modelSwitchedText } from '../menu.mjs';
import { setPendingAuth } from '../auth.mjs';
import { codexLoginStatus } from '../auth-wire.mjs';
import { updateBotState } from '../state-update.mjs';
import { syncExtAuthGate } from '../setup-bypass.mjs';
import { applyProviderModel, applyProviderEffort } from '../apply-model.mjs';
import { loadStore } from '../store.mjs';
import { setLocalSshHost, setPendingLocalIp, clearPendingLocalIp } from '../local-ssh.mjs';
import { buildLocalSshMenu, localSshPrompt } from '../menu.mjs';
import { ccOnly, readEngine, editOrReply } from './shared.mjs';
import { prepareCodexRuntime, ensureAndReport, connectCodexNative } from './native-login.mjs';
import { showLocalAwareSshHome } from './ssh-screen.mjs';
import { writeBotPermissionMode } from './actions.mjs';
import { EXT_MARKER } from './shared.mjs';

export async function handleCallback(bot, cq, closedCore = false) {
  const data = String(cq.data || '');
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const userId = cq.from?.id;
  if (!chatId || !userId) return false;

  if (data.startsWith('settings:ssh:')) {
    if (closedCore) return false;
    await bot.api.answerCallbackQuery(cq.id).catch(() => {});
    await editOrReply(bot, chatId, messageId, 'Управление SSH-ключами и firewall через это меню пока не подключено. Существующий доступ к серверу не меняется.', { inline_keyboard: [[{ text: '« Назад', callback_data: 'settings:ssh' }]] });
    return true;
  }

  // SSH-экран: показываем статус + кнопку локального IP (иначе на LAN всё красное).
  if (data === 'settings:ssh') {
    await bot.api.answerCallbackQuery(cq.id).catch(() => {});
    await showLocalAwareSshHome(bot, chatId, messageId);
    return true;
  }

  if (data === 'ext:ssh:local') {
    await bot.api.answerCallbackQuery(cq.id).catch(() => {});
    clearPendingLocalIp(userId, { chatId });
    const menu = await buildLocalSshMenu();
    await editOrReply(bot, chatId, messageId, menu.text, menu.keyboard);
    return true;
  }

  if (data === 'ext:ssh:local:edit') {
    await bot.api.answerCallbackQuery(cq.id).catch(() => {});
    setPendingLocalIp(userId, { chatId, messageId });
    const prompt = localSshPrompt();
    await editOrReply(bot, chatId, messageId, prompt.text, prompt.keyboard);
    return true;
  }

  if (data === 'ext:ssh:local:clear') {
    await bot.api.answerCallbackQuery(cq.id).catch(() => {});
    await setLocalSshHost('');
    const menu = await buildLocalSshMenu();
    await editOrReply(
      bot,
      chatId,
      messageId,
      `✔ Локальный SSH IP сброшен.\n\n${menu.text}`,
      menu.keyboard,
    );
    return true;
  }

  // Разделители в совмещённом меню.
  if (data === 'ext:conn:noop') {
    await bot.api.answerCallbackQuery(cq.id).catch(() => {});
    return true;
  }

  if (closedCore && ['settings:auth:openrouter', 'settings:conn:set:openrouter', 'settings:engine:set:oc', 'settings:engine:set:cc', 'settings:conn:set:cc', 'settings:auth:switch-sub', 'settings:auth:help'].includes(data)) {
    if (data !== 'settings:auth:help' && data !== 'settings:auth:switch-sub') {
      await setActive('claude');
      await syncExtAuthGate();
    }
    return false;
  }

  if (['settings:auth:openrouter', 'settings:conn:set:openrouter', 'settings:engine:set:oc'].includes(data)) {
    await bot.api.answerCallbackQuery(cq.id).catch(() => {});
    await editOrReply(bot, chatId, messageId,
      'Это подключение в текущем ядре не реализовано. Выбранный движок и сессия сохранены.',
      { inline_keyboard: [[{ text: '« Назад', callback_data: 'settings:conn' }]] });
    return true;
  }
  if (['settings:engine:set:cc', 'settings:conn:set:cc'].includes(data)) {
    if (await providerConfigured(getProvider('claude'))) {
      await updateBotState((state) => {
        if (state.engine !== 'oc') return null;
        state.engine = 'cc';
        return state;
      });
    }
    cq.data = 'ext:conn:set:claude';
    return handleCallback(bot, cq, closedCore);
  }
  if (data === 'settings:auth:help') {
    cq.data = 'setup:help';
    return false;
  }

  // Совмещённый экран: штатные Claude/OpenRouter/OpenClaw + CLI обвязки.
  // На движке OpenClaw штатные «Подключения» не подменяем.
  if (data === 'settings:auth' || data === 'settings:conn' || data === 'ext:conn') {
    if (ccOnly()) return false;
    if ((await readEngine()) === 'oc') return false;
    const menu = await buildConnMenu();
    await bot.api.answerCallbackQuery(cq.id).catch(() => {});
    await editOrReply(bot, chatId, messageId, menu.text, menu.keyboard);
    return true;
  }

  if (data.startsWith('ext:conn:set:')) {
    const id = data.slice('ext:conn:set:'.length);
    if (!isProviderId(id)) return false;
    if (ccOnly() && id !== 'claude') {
      await bot.api.answerCallbackQuery(cq.id).catch(() => {});
      await editOrReply(bot, chatId, messageId, 'Этот бот зафиксирован на Claude Code (JARVIS_CC_ONLY).', undefined);
      return true;
    }
    const p = getProvider(id);
    await bot.api.answerCallbackQuery(cq.id).catch(() => {});

    if (id === 'codex') {
      const ok = await ensureAndReport(bot, chatId, messageId, id);
      if (!ok) return true;
      const status = await codexLoginStatus();
      if (!status.ok) {
        await editOrReply(bot, chatId, messageId, 'Codex CLI не подтвердил вход. Выбранный движок и сессия сохранены.',
          { inline_keyboard: [[{ text: '🔐 Вход', callback_data: 'ext:auth:codex' }], [{ text: '« Назад', callback_data: 'settings:conn' }]] });
        return true;
      }
      await prepareCodexRuntime();
      await setActive(id);
      await syncExtAuthGate(process.env, os.homedir(), { activateCli: true });
      const menu = await buildConnMenu();
      await editOrReply(bot, chatId, messageId, `${switchedText(id)}\n\n${menu.text}`, menu.keyboard);
      return true;
    }

    if (!(await providerConfigured(p))) {
      if (p.authViaStock) {
        cq.data = 'settings:auth:switch-sub';
        return false;
      }
      const prompt = authPrompt(id);
      setPendingAuth(userId, id, chatId);
      await editOrReply(bot, chatId, messageId, prompt.text, prompt.keyboard);
      return true;
    }
    if (id !== 'claude') {
      const ok = await ensureAndReport(bot, chatId, messageId, id);
      if (!ok) return true;
    }
    await setActive(id);
    await syncExtAuthGate();
    const menu = await buildConnMenu();
    await editOrReply(bot, chatId, messageId, `${switchedText(id)}\n\n${menu.text}`, menu.keyboard);
    console.error(`${EXT_MARKER} active provider → ${id}`);
    return true;
  }

  if (data.startsWith('ext:auth:')) {
    const id = data.slice('ext:auth:'.length);
    if (!isProviderId(id) || getProvider(id)?.authViaStock) return false;
    await bot.api.answerCallbackQuery(cq.id).catch(() => {});

    if (id === 'codex') {
      // Перелогин / первый вход — без запроса секрета в чат.
      await connectCodexNative(bot, chatId, messageId);
      return true;
    }

    const prompt = authPrompt(id);
    setPendingAuth(userId, id, chatId);
    await editOrReply(bot, chatId, messageId, prompt.text, prompt.keyboard);
    return true;
  }

  // «🧠 Агент» / глубина / режим — не показывать Claude, если активен другой провайдер.
  if (
    data === 'menu:agent' ||
    data === 'settings:effort' ||
    data.startsWith('settings:effort:') ||
    data.startsWith('ext:effort:') ||
    data === 'settings:permmode' ||
    data.startsWith('settings:permmode:') ||
    data.startsWith('ext:permmode:')
  ) {
    if (ccOnly()) return false;
    if ((await readEngine()) === 'oc') return false;
    const store = await loadStore();
    if (!store.active || store.active === 'claude') return false;

    await bot.api.answerCallbackQuery(cq.id).catch(() => {});

    if (data === 'menu:agent') {
      const menu = await buildAgentMenu();
      if (!menu) return false;
      await editOrReply(bot, chatId, messageId, menu.text, menu.keyboard);
      return true;
    }

    if (data === 'settings:effort' || (data.startsWith('settings:effort:') && !data.startsWith('settings:effort:set:'))) {
      const menu = await buildEffortMenu();
      await editOrReply(bot, chatId, messageId, menu.text, menu.keyboard);
      return true;
    }

    if (data.startsWith('ext:effort:set:') || data.startsWith('settings:effort:set:')) {
      const effort = data.startsWith('ext:effort:set:')
        ? data.slice('ext:effort:set:'.length)
        : data.slice('settings:effort:set:'.length);
      const applied = await applyProviderEffort(store.active, effort);
      const agent = await buildAgentMenu(
        process.env,
        undefined,
        applied.ok ? `✔ Глубина: <b>${effort}</b>.` : `❌ ${applied.error}`,
      );
      await editOrReply(bot, chatId, messageId, agent.text, agent.keyboard);
      return true;
    }

    if (data === 'settings:permmode') {
      const menu = await buildPermModeMenu();
      if (!menu) return false;
      await editOrReply(bot, chatId, messageId, menu.text, menu.keyboard);
      return true;
    }

    if (data.startsWith('ext:permmode:set:') || data.startsWith('settings:permmode:set:')) {
      const mode = data.startsWith('ext:permmode:set:')
        ? data.slice('ext:permmode:set:'.length)
        : data.slice('settings:permmode:set:'.length);
      const next = normalizePermissionMode(mode);
      await writeBotPermissionMode(next);
      const notice = store.active === 'codex' ? `✔ Настройка режима сохранена: <b>${next}</b>. Права Codex не менялись.` : `✔ Режим: <b>${next}</b>.`;
      const agent = await buildAgentMenu(process.env, undefined, notice);
      await editOrReply(bot, chatId, messageId, agent.text, agent.keyboard);
      return true;
    }

    return false;
  }

  // «🧠 Модель»: для Cursor/Codex/Qwen — свой список, не Claude Opus/Sonnet.
  if (data === 'settings:model' || data.startsWith('settings:model:') || data.startsWith('ext:model:')) {
    if (ccOnly()) return false;
    if ((await readEngine()) === 'oc') return false;
    const store = await loadStore();
    if (!store.active || store.active === 'claude') return false;

    await bot.api.answerCallbackQuery(cq.id).catch(() => {});

    const isSet = data.startsWith('ext:model:set:') || data.startsWith('settings:model:set:');
    if (!isSet) {
      // Любой экран версий/каталога Claude → наш список моделей провайдера.
      const menu = await buildModelMenu();
      if (!menu) return false;
      await editOrReply(bot, chatId, messageId, menu.text, menu.keyboard);
      return true;
    }

    const modelId = data.startsWith('ext:model:set:')
      ? data.slice('ext:model:set:'.length)
      : data.slice('settings:model:set:'.length);
    // Не даём штатным алиасам Claude (opus/sonnet/…) записаться как модель Codex/Cursor.
    if (/^(opus|sonnet|haiku|fable)\b/i.test(modelId)) {
      const menu = await buildModelMenu();
      await editOrReply(
        bot,
        chatId,
        messageId,
        `Это модель Claude, а сейчас активен другой провайдер.\n\n${menu.text}`,
        menu.keyboard,
      );
      return true;
    }

    const applied = await applyProviderModel(store.active, modelId);
    const menu = await buildModelMenu();
    if (!applied.ok) {
      await editOrReply(
        bot,
        chatId,
        messageId,
        `❌ Не сменил модель: ${applied.error}\n\n${menu?.text || ''}`,
        menu?.keyboard,
      );
      return true;
    }
    await editOrReply(
      bot,
      chatId,
      messageId,
      `${modelSwitchedText(store.active, modelId)}\n\n${menu.text}`,
      menu.keyboard,
    );
    console.error(`${EXT_MARKER} model → ${store.active}:${modelId}`);
    return true;
  }

  return false;
}
