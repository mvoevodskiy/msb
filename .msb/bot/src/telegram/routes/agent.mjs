/**
 * Авторизация, effort/права и поздний setup fallback.
 * Модели/версии → [отдельный route](./models.mjs), те же state и router.
 * Первый запуск → [setup availability](../auth.mjs), [screen](../screens/agent.mjs),
 * [checks](../../../tests/onboarding-guides.test.mjs). Навигация: [Telegram](../README.md).
 */
import { readClaudeVersion } from '../../agent/claude-version.mjs';
import { loadState, updateState } from '../../state.mjs';
import { agentScreen, connScreen, effortScreen, permModeScreen, setupScreen } from '../screens.mjs';
import { applyEffort, applyPermMode } from '../actions.mjs';
import { hasCodexSetup } from '../auth.mjs';
import { UNHANDLED } from './shared.mjs';
import { InlineKeyboard } from 'grammy';
import { connectionNavigation } from '../../../shared/connection-navigation.mjs';

export async function handleAgentRoute({ data, state, show, pending, chatId, ctx }) {
  // —— agent / model ——
  if (data === 'settings:effort') return show(effortScreen(state, await readClaudeVersion()));
  if (data === 'settings:permmode') return show(permModeScreen(state));
  if (data === 'settings:conn' || data === 'settings:auth') {
    return show(await connScreen(state, process.env, connectionNavigation(data).back));
  }
  if (data === 'settings:conn:noop') return;
  if (data === 'settings:conn:set:cc' || data === 'settings:engine:set:cc') {
    await updateState((s) => {
      s.engine = 'cc';
      return s;
    });
    return show(await agentScreen((await loadState()).state));
  }
  if (data === 'settings:auth:switch-sub' || data === 'setup:subscription') {
    pending.set(chatId, 'auth-token');
    const navigation = connectionNavigation(data, ctx?.callbackQuery?.message);
    const back = navigation?.back ?? (data === 'setup:subscription' ? 'setup:back' : 'menu:agent');
    return show({
      text: 'Пришли следующим сообщением токен Claude (<code>claude setup-token</code>) или ключ <code>sk-ant-…</code>.\nОтмена: /start',
      keyboard: new InlineKeyboard().text('« Назад', back),
    });
  }
  if (data.startsWith('settings:effort:set:')) {
    if (!await applyEffort(data.slice('settings:effort:set:'.length))) return;
    return show(await agentScreen((await loadState()).state));
  }
  if (data.startsWith('settings:permmode:set:')) {
    await applyPermMode(data.slice('settings:permmode:set:'.length));
    return show(await agentScreen((await loadState()).state));
  }

  return UNHANDLED;
}

export async function handleSetupRoute({ data, show, bot, pending, chatId, ctx }) {
  const codexAvailable = hasCodexSetup(bot);
  const back = connectionNavigation(data, ctx?.callbackQuery?.message)?.entry ?? 'setup:back';
  // A guide does not accept a Claude token; don't consume the next ordinary text as one.
  if (['setup:help', 'setup:help:codex', 'setup:back'].includes(data) && pending.get(chatId) === 'auth-token') pending.delete(chatId);
  // —— setup ——
  if (data === 'setup:help') {
    return show({
      text: '<b>Claude Code · инструкция</b>\n\n1. На машине, где работает бот, выполни <code>claude setup-token</code> и скопируй токен. Можно использовать и API-ключ Anthropic.\n2. Нажми «🔑 Новый токен Claude» и пришли токен или ключ боту.',
      keyboard: new InlineKeyboard().text('🔑 Новый токен Claude', 'setup:subscription').row().text('« Назад', back),
    });
  }
  if (data === 'setup:help:codex' && codexAvailable) {
    return show({
      text: '<b>Codex · инструкция</b>\n\n1. Открой /settings → «🔌 Подключения».\n2. Рядом с Codex нажми «🔐 Вход». При необходимости бот установит Codex CLI.\n3. Открой полученную ссылку, войди в ChatGPT и введи код из сообщения.\n4. Дождись подтверждения бота: после успешного входа он выберет Codex.\n\nПароль и токены не отправляй в чат.',
      keyboard: new InlineKeyboard().text('« Назад', back),
    });
  }
  if (data.startsWith('setup:')) return show(setupScreen({ codexAvailable }));

  return UNHANDLED;
}
