/**
 * Task-mode picker for project routing. Data → [routing](../../projects/routing.mjs).
 */
import { InlineKeyboard } from 'grammy';
import { ROUTING_MODES, ROUTING_MODE_LABELS } from '../../projects/routing-modes.mjs';
import { escapeHtml } from '../edit.mjs';

export function routingModeScreen({ mode = null, path = null, apply = 'sticky' } = {}) {
  const keyboard = new InlineKeyboard();
  ROUTING_MODES.forEach((id, index) => {
    if (index && index % 3 === 0) keyboard.row();
    const mark = id === mode ? '✓ ' : '';
    keyboard.text(mark + ROUTING_MODE_LABELS[id], `routing:mode:${id}`);
  });
  keyboard.row().text('« Назад', 'menu:back');
  const current = mode ? ROUTING_MODE_LABELS[mode] || mode : 'не закреплён';
  const file = path ? `\nФайл: <code>${escapeHtml(path)}</code>` : '';
  return {
    text: `🎛 <b>Режим задачи</b>\nСейчас: <b>${escapeHtml(current)}</b> (${escapeHtml(apply)})${file}\n\nВыбери режим или пиши <code>#make …</code> / <code>#анализ …</code>.`,
    keyboard,
  };
}
