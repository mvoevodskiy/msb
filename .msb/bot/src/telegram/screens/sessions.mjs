import {projectPath} from '../../projects/paths.mjs';
import {cliSessionEntries} from '../../sessions/scope.mjs';
import {sessionListScreen} from './session-list.mjs';
/**
 * CLI history → [list](./session-list.mjs) / [provider scope](../../sessions/scope.mjs);
 * status остаётся отдельным view native-контекста. OC backend ещё не подключён.
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { agentDisplay } from '../../agent/display.mjs';
import { readSessionContext, formatContextUsage } from '../../agent/context.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK } from './shared.mjs';

export async function sessionsScreen(state = {}, env = process.env, page = 0, options = {}) {
  if(state.engine!=='oc')return sessionListScreen(cliSessionEntries(state,env),state.ccSessionId,page,options);
  // Keep the existing unconnected OC view; native OC history/reattach is a separate transfer.
  const context = formatContextUsage(await readSessionContext(state.ccSessionId, env));
  return {
    text: `<b>💬 Сессии</b>

Текущая сессия: ${escapeHtml((await agentDisplay(state, env)).engine)}. Новая сессия — кнопка ниже или /newtask.
${context || 'Контекст: нет данных текущей сессии.'}
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('🆕 Новая сессия', 'menu:newtask')
      .row()
      .text('« Назад', 'menu:back'),
  };
}

export async function statusScreen(state, cfg, env = process.env) {
  const agent = await agentDisplay(state, env);
  const context = formatContextUsage(await readSessionContext(state.ccSessionId, env));
  return {
    text: [
      '<b>Статус</b>',
      `Бот: <code>${escapeHtml(cfg.botId)}</code>`,
      `Движок: ${escapeHtml(agent.engine)}`,
      `Модель: <code>${escapeHtml(agent.model)}</code>`,
      ...(agent.effort ? [`Глубина: <code>${escapeHtml(agent.effort)}</code>`] : []),
      context || 'Контекст: нет данных текущей сессии.',
      `Workspace: <code>${escapeHtml(state.activeProject ? projectPath(state.activeProject,env) : cfg.workspace)}</code>`,
      `Сессия: <code>${escapeHtml((state.ccSessionId || '—').slice(0, 24))}</code>`,
    ].join('\n'),
  };
}
