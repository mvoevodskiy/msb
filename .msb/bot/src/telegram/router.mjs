/**
 * Callback вход из [createBot](./bot.mjs): тот же callback_data и один context.
 * ROUTES ниже задаёт прежний порядок; только UNHANDLED передаёт управление дальше.
 * Настройки/формы → [settings](./routes/settings.mjs), модели → [models](./routes/models.mjs), auth/права → [agent](./routes/agent.mjs),
 * выбор движка → [engines](./routes/engines.mjs), проекты → [projects](./routes/projects.mjs),
 * навыки → [skills](./routes/skills.mjs), MCP → [workspace](./routes/workspace.mjs), сессии → [sessions](./routes/sessions.mjs),
 * задачи → [autonomy](./routes/autonomy.mjs), источники → [monitor](./routes/monitor.mjs).
 * Старая кнопка паузы таймеров → [pause confirmation](./pause-confirmation.mjs).
 * Остальные семейства видны в прямых imports ниже; rendering → [screens](./screens.mjs).
 * Состояние → [state](../state.mjs), shared pending принадлежит createBot.
 * Prepared views → [view delivery](./view-delivery.mjs); short views stay unchanged.
 * Presentation/read lifecycle → [shared scopes](../../shared/callback-renders.mjs),
 * [async status checks](../../tests/callback-refresh.test.mjs).
 * Проверка переходов/отмены/owner: [menu handlers](../../tests/menu-handlers.test.mjs).
 */
import { beginCallbackRender, runCallbackScope, trackCallbackTask, callbackTransportSignal } from '../../shared/callback-renders.mjs';
import { cancelPultInput } from './forms/pult.mjs';
import { loadState } from '../state.mjs';
import { editOrReply } from './edit.mjs';
import { deliverView } from './view-delivery.mjs';
import { enginesScreen } from './screens.mjs';
import { handleNavigationRoute, handleMiscRoute } from './routes/navigation.mjs';
import { handleModelRoute, isModelSelectionCallback } from './routes/models.mjs';
import { handleAgentRoute, handleSetupRoute } from './routes/agent.mjs';
import { handleSystemRoute } from './routes/system.mjs';
import { handleBotsRoute } from './routes/bots.mjs';
import { handleSettingsRoute } from './routes/settings.mjs';
import { handleEnginesRoute } from './routes/engines.mjs';
import { handlePauseConfirmation, isPauseConfirmation } from './pause-confirmation.mjs';
import { handleAutonomyRoute } from './routes/autonomy.mjs';
import { handleMonitorRoute } from './routes/monitor.mjs';
import {handleWorkspaceRoute,isMcpReadCallback} from './routes/workspace.mjs';
import { handleProjectRoute } from './routes/projects.mjs';
import {handleSessionRoute} from './routes/sessions.mjs';
import {handleSkillRoute,isSkillReadCallback} from './routes/skills.mjs';
import { UNHANDLED } from './routes/shared.mjs';

const ROUTES = [
  handleSessionRoute,
  handleSkillRoute,
  handleProjectRoute,
  handleNavigationRoute,
  handleModelRoute,
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
  // Read-only status/catalog views are detached. Authorized mutations retain their
  // existing execution order; navigation invalidates their rendering, not writes.
  const deferred = ['eng:status','settings:pult:refresh','menu:agent','settings:model','settings:model:ver','settings:effort'].includes(data) || isSkillReadCallback(data) || isMcpReadCallback(data);
  if (data === 'settings:pult:refresh') cancelPultInput(pending, chatId);
  let answered = false;
  const answer = async options => {
    if (answered) return;
    answered = true;
    await ctx.answerCallbackQuery(options).catch(() => {});
  };
  if (!isModelSelectionCallback(data) && !isPauseConfirmation(data)) await answer();
  if (!chatId) return;
  if (['menu:back', 'menu:close', 'menu:agent', 'menu:settings', 'settings:back', 'mon:back', 'settings:bots:cancel'].includes(data)) pending.delete(chatId);
  const show = async view => {
    if (!scope.isCurrent()) return;
    const extra=view.disablePreview?{link_preview_options:{is_disabled:true}}:{};
    return deliverView(view,{scope,
      edit:part=>editOrReply(bot.api,chatId,msgId,part.text,part.keyboard,'HTML',scope,extra),
      reply:part=>scope.render(()=>ctx.reply(part.text,{...extra,parse_mode:'HTML',reply_markup:part.keyboard},callbackTransportSignal(scope))),
    });
  };
  const dispatch = async () => {
    if (deferred && !scope.isCurrent()) return;
    const { state } = await loadState();
    if (deferred && !scope.isCurrent()) return;
    const engineMenu = async snapshot => enginesScreen(state, snapshot,
      await bot[Symbol.for('msb.engineProviderView')]?.(state));
    const context = { bot, cfg, pending, ctx, plan, answer, data, chatId, msgId, show, state, engineMenu, signal: scope.signal };
    if (isPauseConfirmation(data)) return handlePauseConfirmation(context);
    for (const route of ROUTES) {
      const result = await route(context);
      if (result !== UNHANDLED) return result;
    }
    console.error(`[msb/bot] unhandled callback: ${data}`);
  };
  if (deferred) {
    const task = runCallbackScope(scope, dispatch).catch(() => { if (!scope.signal.aborted) console.error('[msb/bot] read callback failed'); });
    trackCallbackTask(bot, task);
    return;
  }
  try { return await runCallbackScope(scope, dispatch); }
  finally { await answer(); }
}
