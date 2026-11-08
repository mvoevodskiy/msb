/**
 * Callback вход из [createBot](./bot.mjs): тот же callback_data и один context.
 * ROUTES ниже задаёт прежний порядок; только UNHANDLED передаёт управление дальше.
 * Настройки/формы → [settings](./routes/settings.mjs), модель/права → [agent](./routes/agent.mjs),
 * выбор движка → [engines](./routes/engines.mjs), проекты/MCP → [workspace](./routes/workspace.mjs),
 * задачи → [autonomy](./routes/autonomy.mjs), источники → [monitor](./routes/monitor.mjs).
 * Остальные семейства видны в прямых imports ниже; rendering → [screens](./screens.mjs).
 * Состояние → [state](../state.mjs), shared pending принадлежит createBot.
 * Проверка переходов/отмены/owner: [menu handlers](../../tests/menu-handlers.test.mjs).
 */
import { loadState } from '../state.mjs';
import { editOrReply } from './edit.mjs';
import { enginesScreen } from './screens.mjs';
import { handleNavigationRoute, handleMiscRoute } from './routes/navigation.mjs';
import { handleAgentRoute, handleSetupRoute } from './routes/agent.mjs';
import { handleSystemRoute } from './routes/system.mjs';
import { handleBotsRoute } from './routes/bots.mjs';
import { handleSettingsRoute } from './routes/settings.mjs';
import { handleEnginesRoute } from './routes/engines.mjs';
import { handleAutonomyRoute } from './routes/autonomy.mjs';
import { handleMonitorRoute } from './routes/monitor.mjs';
import { handleWorkspaceRoute } from './routes/workspace.mjs';
import { UNHANDLED } from './routes/shared.mjs';

const ROUTES = [
  handleNavigationRoute,
  handleAgentRoute,
  handleSystemRoute,
  handleBotsRoute,
  handleSettingsRoute,
  handleEnginesRoute,
  handleAutonomyRoute,
  handleMonitorRoute,
  handleWorkspaceRoute,
  handleSetupRoute,
  handleMiscRoute,
];

/**
 * @param {object} opts
 * @param {import('grammy').Bot} opts.bot
 * @param {object} opts.cfg
 * @param {Map<number, string>} opts.pending
 */
export async function handleCallback({ bot, cfg, pending, ctx }) {
  const data = ctx.callbackQuery.data || '';
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery.message?.message_id;
  await ctx.answerCallbackQuery().catch(() => {});
  if (!chatId) return;
  if (['menu:back', 'menu:close', 'menu:agent', 'menu:settings', 'settings:back', 'mon:back', 'settings:bots:cancel'].includes(data)) pending.delete(chatId);

  const show = async (view) => editOrReply(bot.api, chatId, msgId, view.text, view.keyboard);
  const { state } = await loadState();
  const engineMenu = async (snapshot) => enginesScreen(state, snapshot,
    await bot[Symbol.for('msb.engineProviderView')]?.(state));

  const context = { bot, cfg, pending, ctx, data, chatId, msgId, show, state, engineMenu };
  for (const route of ROUTES) {
    const result = await route(context);
    if (result !== UNHANDLED) return result;
  }

  // неизвестный callback — не молчим в лог
  console.error(`[msb/bot] unhandled callback: ${data}`);
}
