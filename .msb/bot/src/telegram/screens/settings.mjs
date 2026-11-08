/**
 * Настройки, переменные окружения и сведения о сервере.
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { QUICK_KEYS, listEnvEntries, PROTECTED_KEYS } from '../../env/store.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK, describeSpendLimit } from './shared.mjs';

export function settingsScreen(state, { showEngines = true } = {}) {
  const limit = `💰 Лимит API: ${describeSpendLimit(state.dailySpendLimit)}`;
  const kb = new InlineKeyboard();
  kb.text('🔑 Переменные окружения', 'settings:env').row();
  kb.text('🔌 Подключения', 'settings:auth').row();
  if (showEngines) kb.text('⚙️ Движки', 'eng:home').row();
  kb.text('🤖 Мои боты', 'settings:bots').row();
  kb.text('🕐 Часовой пояс', 'settings:tz').row();
  kb.text('🔕 Отключённые уведомления', 'nm:list').row();
  kb.text(limit, 'settings:limit').row();
  kb.text('🖥️ Состояние сервера', 'settings:server-status').row();
  kb.text('🔧 Системные', 'settings:extras').row();
  kb.text('« Назад', 'menu:back');
  return {
    text: `<b>⚙️ Настройки</b>\n\nПодключения, лимиты, сервер и системные опции.\n${BLANK}`,
    keyboard: kb,
  };
}

export async function envScreen() {
  const entries = await listEnvEntries();
  const lines = [
    '<b>🔑 Переменные окружения</b>',
    '',
    `Записей в <code>.env</code> бота: ${entries.length}`,
    'Это параметры, включая служебные; вход Codex хранится отдельно.',
    '',
  ];
  for (const e of entries.slice(0, 25)) {
    lines.push(`• <code>${escapeHtml(e.key)}</code> — ${escapeHtml(e.masked)}${e.protected ? ' 🔒' : ''}`);
    if (e.comment) lines.push(`   └ <i>${escapeHtml(e.comment.length > 300 ? e.comment.slice(0,300)+'…' : e.comment)}</i>`);
  }
  if (entries.length > 25) lines.push(`… и ещё ${entries.length - 25}`);
  lines.push(BLANK);
  const kb = new InlineKeyboard();
  for (const q of QUICK_KEYS.slice(0, 6)) {
    kb.text(`➕ ${q.label}`, `settings:env:quick:${q.key}`).row();
  }
  kb.text('➕ Свой ключ', 'settings:env:add').row();
  for (const e of entries.filter((x) => !x.protected).slice(0, 8)) {
    kb.text(`🗑 ${e.key}`, `settings:env:delete:${e.key}`).row();
  }
  kb.text('« Назад', 'settings:back');
  return { text: lines.join('\n'), keyboard: kb };
}

/** Legacy two-step deletion. Opening this view never changes the env file. */
export function envDeleteScreen(key,comment) {
  const safeKey = escapeHtml(key);
  if (PROTECTED_KEYS.has(key)) return {
    text: `❌ ${safeKey} — защищённый ключ, удаление запрещено.`,
    keyboard: new InlineKeyboard().text('« Назад', 'settings:env'),
  };
  return {
    text: `Удалить <code>${safeKey}</code>?${comment ? `\n📝 <i>${escapeHtml(comment)}</i>\n` : ''}`,
    keyboard: new InlineKeyboard()
      .text('🗑 Да, удалить', `settings:env:confirm-delete:${key}`)
      .text('« Нет', 'settings:env'),
  };
}

export function tzScreen(state) {
  const tz = state.timezone || process.env.MSB_TIMEZONE || 'Europe/Moscow';
  return {
    text: `<b>🕐 Часовой пояс</b>\n\nСейчас: <code>${escapeHtml(tz)}</code>\n\nПришли новое имя зоны (например <code>Europe/Moscow</code> или <code>Asia/Yekaterinburg</code>).\n${BLANK}`,
    keyboard: new InlineKeyboard().text('« Назад', 'settings:back'),
  };
}

export function limitScreen(state) {
  const lim = describeSpendLimit(state.dailySpendLimit);
  return {
    text: `<b>💰 Лимит API</b>\n\nСохранённый лимит: ${lim}.\nВыбери значение кнопкой. Проверка и применение лимита в open-core пока не подключены.\n${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('$10', 'settings:limit:set:10')
      .text('$25', 'settings:limit:set:25')
      .text('$50', 'settings:limit:set:50')
      .row()
      .text('Без лимита', 'settings:limit:set:0')
      .row()
      .text('« Назад', 'settings:back'),
  };
}

export function serverStatusScreen(cfg) {
  return {
    text: `<b>🖥️ Состояние сервера</b>

Бот: <code>${escapeHtml(cfg.botId)}</code>
Ядро: open-core <code>${escapeHtml(cfg.version)}</code>
Workspace: <code>${escapeHtml(cfg.workspace)}</code>
${BLANK}`,
    keyboard: new InlineKeyboard().text('« Назад', 'settings:back'),
  };
}

export function notificationsScreen() {
  return {
    text: `<b>🔕 Отключённые уведомления</b>

Этот экран пока не читает список отключённых уведомлений.
${BLANK}`,
    keyboard: new InlineKeyboard().text('« Назад', 'settings:back'),
  };
}
