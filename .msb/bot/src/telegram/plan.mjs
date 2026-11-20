/**
 * Old final assistant marker → clean text and original approval keyboard; no I/O.
 * [response](./response.mjs) parses only at final delivery; [actions](./plan-actions.mjs)
 * sends clicked instructions through the existing inbox. No native permission grant.
 * Checks: [handoff](../../tests/plan-handoff.test.mjs); old rkA/akA in reference contract.
 */
import { InlineKeyboard } from 'grammy';

export function parsePlanResponse(value) {
  const text = String(value ?? '');
  for (const pattern of ['control', 'plan', 'approve']) {
    const marker = `[КНОПКИ: ${pattern}]`;
    if (text.includes(marker)) return { pattern, cleanText: text.split(marker).join('').trimEnd() };
  }
  if (text.includes('✔ вносить / ✖ пропустить?')) return { pattern: 'control', cleanText: text };
  if (text.includes('Делаем? ✔ или ✖')) return { pattern: 'plan', cleanText: text };
  return null;
}

export function planKeyboard(pattern) {
  const kb = new InlineKeyboard();
  if (pattern === 'control') kb.text('✔ Вносить', 'plan:approve').text('✖ Пропустить', 'plan:skip').row();
  else if (pattern === 'approve') return kb.text('✓ Один раз', 'plan:approve').text('☑ Всегда', 'plan:always').text('✕ Нет', 'plan:reject');
  else kb.text('✔ Продолжай', 'plan:approve').text('✖ Стоп', 'plan:reject').row();
  return kb.text('💬 Комментарий', 'plan:comment');
}
