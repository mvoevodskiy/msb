/**
 * Автономка: задачи, история и сохранённые права. [Таймеры](./legacy-timers.mjs).
 * Сохранённые [напоминания](./reminders.mjs) рядом с отдельными задачами tasks.json.
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { listTasks } from '../../autonomy/store.mjs';
import { historyPages } from '../../autonomy/history.mjs';
import { loadState } from '../../state.mjs';
import { escapeHtml } from '../edit.mjs';
import { savedActionIsActive, savedActionRows, savedActionViews } from './reminders.mjs';
import { BLANK } from './shared.mjs';

export async function autonomyHomeScreen(codexAvailable, cursorAvailable = false) {
  const [tasks, reminders] = await Promise.all([listTasks(), savedActionViews(undefined, codexAvailable, cursorAvailable)]);
  const active = tasks.filter(t => t.enabled !== false).length + reminders.actions.filter(action => savedActionIsActive(action, reminders)).length;
  const kb = new InlineKeyboard()
    .text('📋 Задачи', 'auto:tasks')
    .text('📡 Мониторинг', 'auto:monitor')
    .row()
    .text('🕓 История', 'auto:history')
    .text('⏳ Таймеры', 'auto:timers')
    .row()
    .text('❔ Что это', 'auto:what')
    .row()
    .text('🔓 Права', 'auto:rights')
    .row()
    .text('« Назад', 'menu:back');
  return {
    text: `<b>🥷 Автономка</b>\n\nАктивных задач: ${active}\nПоддерживаются интервалы: «каждые 6 часов проверяй диск».\n${BLANK}`,
    keyboard: kb,
  };
}

export function autonomyWhatScreen() {
  return {
    text: `🥷 <b>Что такое автономка</b>

Обычно я жду твоего сообщения и отвечаю. Автономка это когда я работаю сам, без твоей команды: в нужное время беру задачу, делаю её и присылаю результат.

<b>Как завести</b>
Скажи словами, что делать и когда. Например: <i>«каждое утро в 9 смотри, что нового у конкурентов»</i> или <i>«раз в час проверяй сервер и пиши, только если сломалось»</i>. Штатный парсер сейчас поддерживает интервалы вида «каждые 6 часов …».

<b>Что можно</b>
Список задач и просмотр истории работают. Напоминание можно открыть, поставить на паузу или удалить.

<b>Про права</b>
Сохранённые задания Claude используют отдельную сессию и заданные для задачи инструменты. Упрощённые интервальные задачи работают в общем сеансе.

<b>Чем это отличается от таймеров</b>
Интервальные задачи выполняются планировщиком. Сохранённые таймеры можно посмотреть и изменить в меню «Таймеры».
${BLANK}`,
    keyboard: new InlineKeyboard().text('« Назад', 'auto:home'),
  };
}

export async function autonomyTasksScreen(state, codexAvailable, cursorAvailable = false) {
  const [tasks, reminders] = await Promise.all([listTasks(), savedActionViews(state, codexAvailable, cursorAvailable)]);
  const kb = new InlineKeyboard();
  const lines = tasks.map((task, index) => {
    const mark = task.enabled === false ? '⏸' : '▶️';
    kb.text(mark + ' ' + (task.title || task.id).slice(0, 28), 'auto:task:' + task.id).row();
    return mark + ' <b>' + (index + 1) + '.</b> ' + escapeHtml(task.title || task.prompt?.slice(0, 60) || task.id);
  });
  const rows = savedActionRows(reminders, kb);
  if ((tasks.length || rows.length) && reminders.stopped) {
    lines.unshift('⏸ Всё на паузе: ни одна из них сейчас не сработает.', '');
  }
  lines.push(...rows);
  if (reminders.error) lines.push(reminders.error);
  const count = tasks.length + rows.length;
  const heading = '📋 <b>Задачи</b>' + (count ? ' (' + count + ')' : '');
  if (!lines.length) {
    lines.push('Пока пусто. Скажи словами расписание, например:',
      '<i>«каждые 6 часов проверяй диск и пиши итог»</i>');
  }
  kb.text('« Назад', 'auto:home');
  return { text: [heading, '', ...lines, BLANK].join('\n'), keyboard: kb };
}

export async function autonomyHistoryScreen({ limit = 10, menu = true } = {}) {
  const pages = await historyPages({ limit, menu });
  return {
    text: pages[0],
    pages,
    keyboard: new InlineKeyboard().text('« Назад', 'auto:home'),
  };
}

export async function autonomyRightsScreen() {
  const { state } = await loadState();
  const on = state.autonomyRights === true;
  return {
    text: `<b>🔓 Права фоновых задач</b>

Сохранённая настройка: <b>${on ? 'включены' : 'выключены'}</b>

Сохранённые задания Claude используют отдельную сессию и инструменты задачи. Расширенные права пока ожидают отдельного подключения.
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text(on ? '🔒 Выключить права' : '🔓 Включить права', 'auto:rights-toggle')
      .row()
      .text('« Назад', 'auto:home'),
  };
}
