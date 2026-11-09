/**
 * Former Telegram list and card for stored timers.
 * [Route](../routes/autonomy.mjs), [timer records](../../autonomy/legacy-timers.mjs),
 * [old UI regression](../../../tests/autonomy-timers.test.mjs).
 */
import { InlineKeyboard } from 'grammy';
import { formatLegacyTimer } from '../../autonomy/legacy-timers.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK } from './shared.mjs';

const empty = 'Ни одного. Это старая механика повторов: она просто присылает текст в назначенный срок.\n\nЕсли нужна работа по расписанию, лучше завести задачу: скажи мне словами, что делать и когда.';
const note = 'Это старая механика повторов, она работает и никуда не денется. У задач есть права, отчёт и история: захочешь такую же работу задачей, скажи мне словами, и я заведу. Таймеры при этом останутся на месте.';
const mark = timer => timer.enabled ? '✔' : '⏸';

export function autonomyTimersScreen(timers = [], { afterChange = false } = {}) {
  const keyboard = new InlineKeyboard();
  const heading = '⏳ <b>Таймеры</b>';
  if (!timers.length) {
    const content = afterChange ? 'Ни одного не осталось.' : empty;
    return { text: [heading, '', content, BLANK].join('\n'), keyboard: keyboard.text('« Назад', 'auto:home') };
  }

  const lines = timers.map(timer => mark(timer) + ' ' + escapeHtml(formatLegacyTimer(timer)));
  for (const timer of timers) {
    keyboard.text((mark(timer) + ' ' + timer.name).slice(0, 30), 'auto:timer:' + timer.id).row();
  }
  if (!afterChange) lines.push('', note);
  const text = [heading + ' (' + timers.length + ')', '', ...lines, '', BLANK].join('\n');
  return { text, keyboard: keyboard.text('« Назад', 'auto:home') };
}

export function autonomyTimerScreen(timer) {
  const keyboard = new InlineKeyboard();
  if (!timer) return { text: '⚠️ Таймер не найден.', keyboard: keyboard.text('« Назад', 'auto:timers') };

  const kind = timer.type === 'daily' ? 'ежедневно' : timer.type === 'weekly' ? 'еженедельно' : 'одноразовый';
  const status = timer.enabled ? '✔ активен' : '⏸ выключен';
  const prompt = escapeHtml(String(timer.prompt ?? '').slice(0, 200));
  const text = ['⏳ <b>' + escapeHtml(timer.name) + '</b>', '', 'Тип: ' + kind, 'Статус: ' + status,
    'Текст: <i>' + prompt + '</i>', BLANK].join('\n');
  keyboard.text(timer.enabled ? '⏸ Выключить' : '▶️ Включить', 'auto:timer-toggle:' + timer.id).row()
    .text('🗑 Удалить', 'auto:timer-delete:' + timer.id).row()
    .text('« Назад', 'auto:timers');
  return { text, keyboard };
}
