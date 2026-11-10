/**
 * Выбор движка и опциональное представление CLI-провайдера.
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { agentDisplay } from '../../agent/display.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK } from './shared.mjs';

export async function enginesScreen(state, env = process.env, providerView = null) {
  const eng = providerView?.activeTitle || (await agentDisplay(state, env)).engine;
  const keyboard = new InlineKeyboard().text('👾 Claude Code', 'settings:engine:set:cc').row();
  for (const choice of providerView?.choices || []) keyboard.text(choice.text, choice.callback_data).row();
  return {
    text: `<b>⚙️ Движки</b>

Сейчас отвечает: <b>${escapeHtml(eng)}</b>

OpenClaw в open-core ещё переносится. Текущее подключение можно сохранить.
${BLANK}`,
    keyboard: keyboard
      .text('➕ OpenClaw', 'eng:add')
      .row()
      .text('« Назад', 'menu:settings'),
  };
}
