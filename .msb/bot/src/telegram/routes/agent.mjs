/**
 * Авторизация, effort/права и поздний setup fallback.
 * Модели/версии → [отдельный route](./models.mjs), те же state и router.
 * Навигация: [Telegram](../README.md).
 */
import { readClaudeVersion } from '../../agent/claude-version.mjs';
import { loadState, updateState } from '../../state.mjs';
import { agentScreen, connScreen, effortScreen, permModeScreen, setupScreen } from '../screens.mjs';
import { applyEffort, applyPermMode } from '../actions.mjs';
import { UNHANDLED } from './shared.mjs';

export async function handleAgentRoute({ data, state, show, pending, chatId, bot }) {
  // —— agent / model ——
  if (data === 'settings:effort') return show(effortScreen(state, await readClaudeVersion()));
  if (data === 'settings:permmode') return show(permModeScreen(state));
  if (data === 'settings:conn' || data === 'settings:auth') return show(await connScreen(state));
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
    return show({
      text: 'Пришли следующим сообщением токен Claude (<code>claude setup-token</code>) или ключ <code>sk-ant-…</code>.\nОтмена: /start',
      keyboard: (await connScreen(state)).keyboard,
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

export async function handleSetupRoute({ data, show }) {
  // —— setup ——
  if (data === 'setup:help') {
    return show({
      text: 'На машине выполни <code>claude setup-token</code>, скопируй токен и пришли его боту.',
      keyboard: setupScreen().keyboard,
    });
  }
  if (data.startsWith('setup:')) return show(setupScreen());

  return UNHANDLED;
}
