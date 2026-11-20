/**
 * Агент, глубина, права и подключение Claude.
 * Модель/версии → [pure renderer](./models.mjs), совместимые re-exports ниже.
 * [Routes](../routes/agent.mjs) supplies state; depth → [policy](../../agent/effort.mjs),
 * [production checks](../../../tests/claude-effort.test.mjs); first-run presentation →
 * [setup route](../routes/agent.mjs), [checks](../../../tests/onboarding-guides.test.mjs).
 * No setting writes here.
 * Навигация: [Telegram](../README.md).
 */
import { VISIBLE_PERMISSION_MODES } from '../../../shared/permission-modes.mjs';
import { InlineKeyboard } from 'grammy';
import { CLAUDE_EFFORTS, isClaudeEffort, supportsClaudeEffort, claudeEffortFlag, effectiveClaudeEffort } from '../../agent/effort.mjs';
import { hasClaudeAuth, resolveModel } from '../../state.mjs';
import { defaultModelEffort, modelShortLabel } from '../../agent/models.mjs';
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
  const modelLabel = display.label || display.model.replace(/^claude-/, '');
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

export { modelScreen, modelVersionsScreen } from './models.mjs';

export function effortScreen(state = {}, version) {
  const model = resolveModel(state);
  const keyboard = new InlineKeyboard();
  if (!supportsClaudeEffort(model,version)) return {
    text: '<b>💭 Глубина мыслей</b>\n\nУ этой модели глубина не настраивается.',
    keyboard: keyboard.text('« Назад', 'menu:agent'),
  };
  const saved = state.ccEffort || state.effort;
  const defaultLevel = saved && !isClaudeEffort(saved) ? effectiveClaudeEffort(model,saved,version) : defaultModelEffort(model,version).level;
  const level = isClaudeEffort(saved) ? saved : defaultLevel;
  const descriptions = ['быстро, минимум раздумий', 'обычная глубина', 'углублённо', 'глубже, для кода и сложных задач', 'максимум'];
  CLAUDE_EFFORTS.forEach((value, index) => {
    if (index > 0 && index % 3 === 0) keyboard.row();
    keyboard.text(`${value}${level === value ? ' ✓' : ''}`, `settings:effort:set:${value}`);
  });
  keyboard.row().text('« Назад', 'menu:agent');
  const normalized = ['xhigh', 'max'].filter(value => claudeEffortFlag(model, value, version) !== value);
  const label = escapeHtml(modelShortLabel(model,version));
  const note = normalized.length ? `\n\n<i>На ${label} ${normalized.join(' и ')} ${normalized.length === 1 ? 'работает' : 'работают'} как high.</i>` : '';
  const choices = CLAUDE_EFFORTS.map((value, index) => `<b>${value}</b>: ${descriptions[index]}${value === defaultLevel ? ' (по умолчанию)' : ''}`).join('\n');
  return {
    text: `<b>💭 Глубина мыслей</b>\n\nНасколько глубоко агент обдумывает ответ.\n\n${choices}\n\n<b>Сейчас:</b> ${level}${isClaudeEffort(saved) ? '' : ' (по умолчанию)'}${note}`,
    keyboard,
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

export function setupScreen({ codexAvailable = false } = {}) {
  const keyboard = new InlineKeyboard()
    .text('🔑 Новый токен Claude', 'setup:subscription')
    .row()
    .text('❔ Инструкция Claude', 'setup:help');
  if (codexAvailable) keyboard.row().text('❔ Инструкция Codex', 'setup:help:codex');
  return {
    text: `<b>Сначала подключи AI</b>

<b>Claude Code</b> — нажми «🔑 Новый токен Claude» и пришли токен подписки или API-ключ Anthropic.${codexAvailable ? `

<b>Codex</b> — вход через ChatGPT: /settings → «🔌 Подключения» → «🔐 Вход» рядом с Codex. Токен в чат отправлять не нужно.

Другие подключения доступны в /settings → «🔌 Подключения».` : ''}
${BLANK}`,
    keyboard,
  };
}
