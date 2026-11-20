/**
 * Closed task-mode vocabulary for project routing.
 * Load/resolve → [routing-load](./routing-load.mjs), [routing-resolve](./routing-resolve.mjs).
 * Contract: [project-routing tests](../../tests/project-routing.test.mjs),
 * [TDR](../../../../docs/tdr/project-task-routing.md).
 */
export const ROUTING_MODES = Object.freeze(['ask', 'make', 'study', 'check', 'run']);

export const ROUTING_MODE_LABELS = Object.freeze({
  ask: 'Спросить',
  make: 'Сделать',
  study: 'Разобрать',
  check: 'Проверить',
  run: 'Запустить',
});

export const DEFAULT_ROUTING_ALIASES = Object.freeze({
  вопрос: 'ask',
  справка: 'ask',
  сделай: 'make',
  код: 'make',
  дизайн: 'make',
  монтаж: 'make',
  графика: 'make',
  черновик: 'make',
  анализ: 'study',
  аналитика: 'study',
  данные: 'study',
  исследование: 'study',
  юрист: 'study',
  бухучёт: 'study',
  бухучет: 'study',
  ревью: 'check',
  проверка: 'check',
  аудит: 'check',
  сверка: 'check',
  запуск: 'run',
  выкладка: 'run',
  операция: 'run',
  подача: 'run',
});

export function isRoutingMode(value) {
  return ROUTING_MODES.includes(value);
}
