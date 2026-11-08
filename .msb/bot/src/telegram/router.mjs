/**
 * Callback вход из [createBot](./bot.mjs): тот же callback_data и один context.
 * ROUTES ниже задаёт прежний порядок; только UNHANDLED передаёт управление дальше.
 * Настройки/формы → [settings](./routes/settings.mjs), модель/права → [agent](./routes/agent.mjs),
 * выбор движка → [engines](./routes/engines.mjs), проекты/MCP → [workspace](./routes/workspace.mjs),
 * задачи → [autonomy](./routes/autonomy.mjs), источники → [monitor](./routes/monitor.mjs).
 * Остальные семейства видны в прямых imports ниже; rendering → [screens](./screens.mjs).
 * Состояние → [state](../state.mjs), shared pending принадлежит createBot.
 * Presentation/read lifecycle → [shared scopes](../../shared/callback-renders.mjs),
 * [async status checks](../../tests/callback-refresh.test.mjs).
 * Проверка переходов/отмены/owner: [menu handlers](../../tests/menu-handlers.test.mjs).
 */
import { beginCallbackRender, runCallbackScope, trackCallbackTask } from '../../shared/callback-renders.mjs';
import { cancelPultInput } from './forms/pult.mjs';
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
export async function handleCallback({ bot, cfg, pending, ctx, plan }) {
  const data = ctx.callbackQuery.data || '';
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery.message?.message_id;
  const scope = beginCallbackRender(bot, ctx.callbackQuery);
  // Only read-only status is detached. Authorized mutation routes retain their
  // existing execution order; navigation invalidates their rendering, not writes.
  const deferred = data === 'eng:status' || data === 'settings:pult:refresh';
  if (data === 'settings:pult:refresh') cancelPultInput(pending, chatId);
  await ctx.answerCallbackQuery().catch(() => {});
  if (!chatId) return;
  if (['menu:back', 'menu:close', 'menu:agent', 'menu:settings', 'settings:back', 'mon:back', 'settings:bots:cancel'].includes(data)) pending.delete(chatId);
  const show = async view => {
    if (!scope.isCurrent()) return;
    return editOrReply(bot.api, chatId, msgId, view.text, view.keyboard, 'HTML', scope);
  };
  const dispatch = async () => {
    if (deferred && !scope.isCurrent()) return;
    const { state } = await loadState();
    if (deferred && !scope.isCurrent()) return;
    const engineMenu = async snapshot => enginesScreen(state, snapshot,
      await bot[Symbol.for('msb.engineProviderView')]?.(state));
    const context = { bot, cfg, pending, ctx, plan, data, chatId, msgId, show, state, engineMenu, signal: scope.signal };
    for (const route of ROUTES) {
      const result = await route(context);
      if (result !== UNHANDLED) return result;
    }
    console.error(`[msb/bot] unhandled callback: ${data}`);
  };
  if (deferred) {
    const task = runCallbackScope(scope, dispatch).catch(() => { if (!scope.signal.aborted) console.error('[msb/bot] status callback failed'); });
    trackCallbackTask(bot, task);
    return;
  }
  return await runCallbackScope(scope, dispatch);
}
