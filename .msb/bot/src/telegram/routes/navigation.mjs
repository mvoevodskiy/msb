/**
 * Главное меню, навигация и поздние plan/misc callbacks.
 * plan:* → [actions](../plan-actions.mjs) → существующий inbox; [handoff checks](../../../tests/plan-handoff.test.mjs).
 * Навигация: [Telegram](../README.md).
 */
import { agentScreen, autonomyHomeScreen, hubScreen, settingsScreen } from '../screens.mjs';
import { UNHANDLED } from './shared.mjs';

export async function handleNavigationRoute({ data, state, show, pending, chatId, bot }) {
  if (data === 'whisper:skip') return show({ text: 'Когда захочешь — отправь голосовое снова.\nИли подключи Deepgram в /settings → 🔑' });

  // —— menu ——
  if (data === 'menu:back' || data === 'menu:close') return show(hubScreen());
  if (data === 'menu:settings' || data === 'settings:back') return show(settingsScreen(state));
  if (data === 'menu:agent') return show(await agentScreen(state));
  if (data === 'menu:autonomy' || data === 'auto:home') return show(await autonomyHomeScreen());

  return UNHANDLED;
}

export async function handleMiscRoute({ data, ctx, plan }) {
  if (data.startsWith('plan:')) return plan.callback(ctx);
  return UNHANDLED;
}
