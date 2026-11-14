/** Native msb-engine UI; opt-in platform path, not JAR1's legacy OS integration. */
import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../telegram/edit.mjs';
const BLANK = '⠀';

export function nativeEnginesScreen(state, engineSnap = null, providerView = null) {
  const eng = providerView?.activeTitle || (state.engine === 'oc' ? 'OpenClaw' : 'Claude Code');
  const j = (engineSnap?.msb || engineSnap?.jarvis);
  const o = engineSnap?.openclaw;
  const helper = engineSnap?.helper ? String(engineSnap.helper) : '—';
  const jLine = j
    ? `MSB-бот: <b>${escapeHtml(j.state)}</b>${j.bots?.length ? ` (${j.bots.length})` : ''}`
    : 'MSB-бот: нет данных helper';
  const oStatus = o?.enabled ? o.gateway || 'on'
    : ['active', 'activating', 'deactivating'].includes(o?.gateway) ? 'выключение не завершено'
      : ['inactive', 'failed'].includes(o?.gateway) ? 'off' : 'состояние неизвестно';
  const oLine = o && typeof o.installed === 'boolean' && (o.installed === false || typeof o.enabled === 'boolean')
    ? `OpenClaw: <b>${o.installed ? oStatus : 'не установлен'}</b>`
    : 'OpenClaw: нет данных';
  const err = engineSnap?.error === 'NO_STATE'
    ? '\n\n⚠️ Нет /run/msb-engine/state.json — проверь msb-engine.path'
    : '';
  const keyboard = new InlineKeyboard().text('👾 Claude Code', 'settings:engine:set:cc').row();
  for (const choice of providerView?.choices || []) keyboard.text(choice.text, choice.callback_data).row();
  return {
    text: `<b>⚙️ Движки</b>

Сейчас отвечает: <b>${escapeHtml(eng)}</b>
Helper: <code>${escapeHtml(helper)}</code>

${jLine}
${oLine}${err}

Установка OpenClaw из меню — в v1.1. Сейчас: статус / вкл-выкл, если OC уже на боксе.
${BLANK}`,
    keyboard: keyboard
      .text('🔄 Статус helper', 'eng:status')
      .row()
      .text('▶️ OC', 'eng:oc:on')
      .text('⏸ OC', 'eng:oc:off')
      .row()
      .text('« Назад', 'menu:settings'),
  };
}
