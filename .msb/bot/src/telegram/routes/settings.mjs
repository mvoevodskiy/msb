/**
 * Переменные окружения, timezone, лимиты и сведения.
 * Callback вход → [router](../router.mjs), renderer → [settings screens](../screens/settings.mjs).
 * Env CRUD → [store](../../env/store.mjs); pending принадлежит createBot.
 * [Old form contract](../../../tests/reference/parity-forms-contract.txt),
 * [handler tests](../../../tests/menu-handlers.test.mjs).
 */
import { SPEND_LIMIT_CHOICES } from '../../billing/owner-spend.mjs';
import { updateState } from '../../state.mjs';
import { envScreen, envDeleteScreen, limitScreen, settingsScreen, notificationsScreen, serverStatusScreen, sttScreen, tzScreen } from '../screens.mjs';
import { skipEnvComment } from '../forms/env.mjs';
import { deleteEnvKey, listEnvEntries } from '../../env/store.mjs';
import { resolveEnvKeyReference } from '../../env/callback-key.mjs';
import { UNHANDLED } from './shared.mjs';
import { protectedEnvNotice } from '../env-protection.mjs';
import { escapeHtml } from '../edit.mjs';

export async function handleSettingsRoute({ data, state, show, pending, chatId, bot, cfg, ctx, now = Date.now }) {
  if (data === 'settings:env' || data === 'settings:env:cancel') {
    pending.delete(chatId);
    return show(await envScreen());
  }
  if (data === 'settings:env:skip-comment') return skipEnvComment({ctx,pending,chatId});
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
    const entries = await listEnvEntries();
    const key = resolveEnvKeyReference(data.slice('settings:env:delete:'.length),entries.map(row=>row.key));
    if (key === null) return;
    const entry = entries.find(row => row.key === key);
    return show(envDeleteScreen(key,entry?.comment));
  }
  if (data.startsWith('settings:env:confirm-delete:')) {
    const entries = await listEnvEntries();
    const key = resolveEnvKeyReference(data.slice('settings:env:confirm-delete:'.length),entries.map(row=>row.key));
    if (key === null) return;
    try { await deleteEnvKey(key); }
    catch (err) { await bot.api.sendMessage(chatId, err.message); }
    return show(await envScreen());
  }
  if (data === 'settings:tz') {
    pending.set(chatId, 'timezone');
    return show(tzScreen(state));
  }
  if (data === 'settings:limit') return show(limitScreen(state, now()));
  if (data === 'settings:cost:resume' || data.startsWith('settings:limit:set:')) {
    const raw = data.slice('settings:limit:set:'.length);
    const limit = SPEND_LIMIT_CHOICES.find(choice => String(choice) === raw);
    if (data !== 'settings:cost:resume' && limit === undefined) return;
    const saved = await updateState(current => {
      if (limit !== undefined) current.dailySpendLimit = limit;
      current.costPaused = false;
      return current;
    });
    return show(settingsScreen(saved));
  }
  if (data === 'settings:server-status') return show(serverStatusScreen(cfg));
  if (data === 'settings:stt') return show(sttScreen());
  if (data === 'nm:list') return show(notificationsScreen());
  return UNHANDLED;
}
