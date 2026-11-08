/**
 * Переменные окружения, timezone, лимиты и сведения.
 * Callback вход → [router](../router.mjs), renderer → [settings screens](../screens/settings.mjs).
 * Env CRUD → [store](../../env/store.mjs); pending принадлежит createBot.
 * [Old form contract](../../../tests/reference/parity-forms-contract.txt),
 * [handler tests](../../../tests/menu-handlers.test.mjs).
 */
import { loadState, updateState } from '../../state.mjs';
import { envScreen, envDeleteScreen, limitScreen, notificationsScreen, serverStatusScreen, sttScreen, tzScreen } from '../screens.mjs';
import { deleteEnvKey } from '../../env/store.mjs';
import { UNHANDLED } from './shared.mjs';
import { protectedEnvNotice } from '../env-protection.mjs';
import { escapeHtml } from '../edit.mjs';

export async function handleSettingsRoute({ data, state, show, pending, chatId, bot, cfg }) {
  if (data === 'settings:env' || data === 'settings:env:cancel') {
    pending.delete(chatId);
    return show(await envScreen());
  }
  if (data === 'settings:env:add') {
    pending.set(chatId, 'env-key-name');
    return show({
      text: 'Пришли имя ключа (например <code>MY_API_KEY</code>).',
      keyboard: (await envScreen()).keyboard,
    });
  }
  if (data.startsWith('settings:env:quick:')) {
    const key = data.slice('settings:env:quick:'.length);
    const refusal = protectedEnvNotice(key);
    if (refusal) { pending.delete(chatId); return show(refusal); }
    pending.set(chatId, `env:${key}`);
    return show({
      text: `Пришли значение для <code>${escapeHtml(key)}</code>.`,
      keyboard: (await envScreen()).keyboard,
    });
  }
  if (data.startsWith('settings:env:delete:')) {
    return show(envDeleteScreen(data.slice('settings:env:delete:'.length)));
  }
  if (data.startsWith('settings:env:confirm-delete:')) {
    const key = data.slice('settings:env:confirm-delete:'.length);
    try { await deleteEnvKey(key); }
    catch (err) { await bot.api.sendMessage(chatId, err.message); }
    return show(await envScreen());
  }
  if (data === 'settings:tz') {
    pending.set(chatId, 'timezone');
    return show(tzScreen(state));
  }
  if (data === 'settings:limit') return show(limitScreen(state));
  if (data.startsWith('settings:limit:set:')) {
    const n = Number(data.split(':').pop());
    await updateState((s) => {
      s.dailySpendLimit = Number.isFinite(n) ? n : 0;
      if (n === 0) s.costPaused = false;
      return s;
    });
    return show(limitScreen((await loadState()).state));
  }
  if (data === 'settings:server-status') return show(serverStatusScreen(cfg));
  if (data === 'settings:stt') return show(sttScreen());
  if (data === 'nm:list') return show(notificationsScreen());
  return UNHANDLED;
}
