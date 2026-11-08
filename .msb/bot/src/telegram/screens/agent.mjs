/**
 * Агент, модель, глубина, права и подключение Claude.
 * Навигация: [Telegram](../README.md).
 */
import { VISIBLE_PERMISSION_MODES } from '../../../shared/permission-modes.mjs';
import { InlineKeyboard } from 'grammy';
import { hasClaudeAuth } from '../../state.mjs';
import { agentDisplay } from '../../agent/display.mjs';
import { CC_ONLY_OC_BLOCK } from '../commands.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK } from './shared.mjs';

export async function agentScreen(state) {
  const permLabels = {
    auto: 'без спроса',
    smart: 'auto',
    control: 'с подтверждением',
    plan: 'сначала план',
    bypassPermissions: 'bypass',
    acceptEdits: 'acceptEdits',
  };
  const effortLabels = {
    off: 'выкл',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  };
  const display = await agentDisplay(state);
  const modelLabel = display.model.replace(/^claude-/, '');
  const effort = display.effort;
  const effortLabel = effort ? effortLabels[effort] || effort : null;
  const perm = display.engine === 'Codex' ? 'полный доступ, без подтверждений' : permLabels[state.permissionMode || state.permMode || 'auto'] || 'без спроса';
  const engine = display.engine;

  const lines = [
    `Модель: <b>${escapeHtml(modelLabel)}</b>`,
    ...(effortLabel !== null ? [`Глубина: <b>${escapeHtml(effortLabel)}</b>`] : []),
    `Режим: <b>${escapeHtml(perm)}</b>`,
    `Подключение: <b>${escapeHtml(engine)}</b>`,
  ];

  const kb = new InlineKeyboard();
  if (effortLabel !== null) {
    kb.text('🧠 Модель', 'settings:model').text('💭 Глубина', 'settings:effort').row();
    kb.text('🔐 Режим', 'settings:permmode').text('🔌 Подключение', 'settings:conn').row();
  } else {
    kb.text('🧠 Модель', 'settings:model').text('🔐 Режим', 'settings:permmode').row();
    kb.text('🔌 Подключение', 'settings:conn').row();
  }
  kb.text('« Назад', 'menu:back');

  return {
    text: `<b>🧠 Агент</b>\n\n${lines.join('\n')}\n${BLANK}`,
    keyboard: kb,
  };
}

export function modelScreen() {
  return {
    text: `<b>🧠 Модель</b>\n\nВыбери семейство. Конкретные версии — в «📌 Версии».\n${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('🧠 Opus', 'settings:model:set:opus')
      .text('🚀 Sonnet', 'settings:model:set:sonnet')
      .row()
      .text('⚡ Haiku', 'settings:model:set:haiku')
      .text('🔮 Fable', 'settings:model:fable:ask')
      .row()
      .text('📌 Версии', 'settings:model:ver')
      .row()
      .text('« Назад', 'menu:agent'),
  };
}

export function effortScreen() {
  return {
    text: `<b>💭 Глубина мыслей</b>\n\nПередаётся в Claude Code как <code>--effort</code>.\n${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('off', 'settings:effort:set:off')
      .text('low', 'settings:effort:set:low')
      .text('medium', 'settings:effort:set:medium')
      .row()
      .text('high', 'settings:effort:set:high')
      .text('xhigh', 'settings:effort:set:xhigh')
      .text('max', 'settings:effort:set:max')
      .row()
      .text('« Назад', 'menu:agent'),
  };
}

export function permModeScreen(state = {}) {
  const current = state.permissionMode || state.permMode || 'auto';
  const modes = VISIBLE_PERMISSION_MODES;
  const keyboard = new InlineKeyboard();
  for (const mode of modes) keyboard.text(`${mode.label}${mode.id === current ? ' ✓' : ''}`, `settings:permmode:set:${mode.id}`).row();
  keyboard.text('« Назад', 'menu:agent');
  const selected = current === 'smart' ? 'Auto' : modes.find(mode => mode.id === current)?.label || modes[0].label;
  return {
    text: `<b>🧠 Режим работы</b>\n\nСпрашивает ли агент разрешение перед изменениями.\n\n${modes.map(mode => `<b>${mode.label}</b> — ${mode.desc}`).join('\n')}\n\n<b>Сейчас:</b> ${selected}\n\n<i>Смена режима начнёт новую беседу.</i>`,
    keyboard,
  };
}

export async function connScreen(state, env = process.env) {
  const connected = hasClaudeAuth(env, state);
  const display = await agentDisplay(state, env);
  const ccOnly = env.JARVIS_CC_ONLY === '1';
  if (ccOnly && state.engine === 'oc') {
    return {
      text: CC_ONLY_OC_BLOCK,
      keyboard: new InlineKeyboard()
        .text('👾 Claude Code', 'settings:conn:set:cc')
        .row()
        .text('« Назад', 'menu:agent'),
    };
  }

  const text = display.engine !== 'Claude Code'
    ? `<b>🔌 Авторизация Claude</b>\n\nСейчас отвечает ${escapeHtml(display.engine)}. Здесь можно обновить токен Claude: «🔑 Новый токен».\n${BLANK}`
    : connected
    ? `<b>🔌 Подключение</b>\n\nClaude Code работает, подписка подключена ✔\n\nЕсли токен перестал работать, пришли новый: «🔑 Новый токен».\n${BLANK}`
    : `<b>🔌 Подключение</b>\n\nClaude Code ждёт подписку Anthropic.\n\nПришли токен подписки: «🔑 Новый токен». Как его получить — в инструкции.\n${BLANK}`;

  const kb = new InlineKeyboard();
  if (connected) {
    kb.text(display.engine === 'Claude Code' ? '👾 Claude Code ✓ включен' : '👾 Claude · настройка токена', 'settings:conn:noop').row();
    kb.text('🔑 Новый токен', 'settings:auth:switch-sub').row();
  } else {
    kb.text('🔑 Новый токен', 'settings:auth:switch-sub').row();
  }
  if (!ccOnly) {
    kb.text('⚙️ Движки', 'eng:home').row();
  }
  kb.text('« Назад', 'menu:agent');
  return { text, keyboard: kb };
}

export function setupScreen() {
  return {
    text: `Сначала подключи AI.

Для Claude нужен его токен. Codex и другие CLI подключаются через /settings → «Подключения».
Нажми «🔑 Новый токен» и пришли вывод <code>claude setup-token</code> или ключ <code>sk-ant-…</code>.
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('🔑 Новый токен', 'setup:subscription')
      .row()
      .text('❔ Инструкция', 'setup:help'),
  };
}
