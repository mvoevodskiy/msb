/**
 * Агент, авторизация, модель, effort и поздний setup fallback.
 * Навигация: [Telegram](../README.md).
 */
import { loadState, updateState } from '../../state.mjs';
import { agentScreen, connScreen, effortScreen, modelScreen, permModeScreen, placeholder, setupScreen } from '../screens.mjs';
import { applyEffort, applyModelFamily, applyPermMode } from '../actions.mjs';
import { UNHANDLED } from './shared.mjs';

export async function handleAgentRoute({ data, state, show, pending, chatId, bot }) {
  // —— agent / model ——
  if (data === 'settings:model') return show(modelScreen());
  if (data === 'settings:effort') return show(effortScreen());
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
  if (data.startsWith('settings:model:set:')) {
    const family = data.split(':').pop();
    const model = await applyModelFamily(family);
    if (model) await bot.api.sendMessage(chatId, `Модель: <code>${model}</code>`, { parse_mode: 'HTML' });
    return show(await agentScreen((await loadState()).state));
  }
  if (data === 'settings:model:fable:ask' || data.startsWith('settings:model:fable')) {
    await applyModelFamily('fable');
    await bot.api.sendMessage(
      chatId,
      'Fable включена. На Pro она может тратить usage credits сверх подписки.',
    );
    return show(await agentScreen((await loadState()).state));
  }
  if (data === 'settings:model:ver') {
    return show(placeholder('📌 Версии', 'settings:model'));
  }
  if (data.startsWith('settings:effort:set:')) {
    await applyEffort(data.split(':').pop());
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
