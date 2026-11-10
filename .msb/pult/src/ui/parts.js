// Общие кусочки экранов: заголовки секций, переключатели, легенды, полоска ходов, пустые состояния.

import { h, dot } from './dom.js';

export const LEVEL_WORD = { crit: 'нужно действие', serious: 'серьёзно', warn: 'внимание', good: 'в норме', off: 'нет данных', pause: 'пауза' };

/** Заголовок экрана; на него переводится фокус при смене экрана. */
export const pageTitle = (text, extra) => h('h1', { class: 'page-title', tabindex: '-1', 'data-focus': 'title' }, text, extra);

/** Заголовок секции (серые прописные). */
export const secTitle = (text, id) => h('h2', { class: 'lbl', id }, text);

/** Пустое состояние списка. */
export const empty = (text, sub) => h('p', { class: 'empty' }, text, sub ? h('span', { class: 'empty-sub' }, sub) : null);

/** Точка уровня со словом для чтеца. */
export const levelDot = (level) => dot(level, LEVEL_WORD[level] ?? null);

/**
 * Сегментный переключатель из ссылок (фильтры, периоды). items: [{ key, label, href }].
 * Текущая — aria-current="true".
 */
export function seg(label, items, current, fkeyPrefix) {
  return h('nav', { class: 'seg', 'aria-label': label },
    items.map((it) => h('a', {
      href: it.href, class: it.key === current ? 'on' : null, 'aria-current': it.key === current ? 'true' : null,
      'data-fkey': `${fkeyPrefix}:${it.key}`,
    }, it.label)));
}

/** Легенда: [{ sw: 'класс образца' | null, text }]. */
export function legend(items, label = 'Условные обозначения') {
  return h('ul', { class: 'legend', 'aria-label': label },
    items.map((it) => h('li', null, it.sw ? h('i', { class: `sw ${it.sw}`, 'aria-hidden': 'true' }) : null, it.text)));
}

/** Полоска ходов: клетки ok | silent | error | missed | none. */
export function runStrip(cells, label) {
  const el = h('span', { class: `strip${cells.length > 40 ? ' dense' : ''}`, role: 'img', 'aria-label': label });
  for (const c of cells) el.append(h('i', { class: `c-${c}` }));
  return el;
}

/** Полоска-доля (диск, память службы). */
export function meter(pct, cls = '', label) {
  const p = Math.max(0, Math.min(100, pct));
  return h('span', { class: `meter ${cls}`, role: label ? 'img' : null, 'aria-label': label ?? null, 'aria-hidden': label ? null : 'true' },
    h('i', { style: `width:${p.toFixed(1)}%` }));
}

/** Строка «ключ — значение» для списков справа. */
export const kv = (k, v, cls) => h('li', { class: cls }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));

/**
 * Свёртка (progressive disclosure). Без JS: нативный details/summary, CSP не ломается.
 * summaryNodes — то, что видно в закрытом виде; bodyNodes — содержимое.
 */
export function fold(summaryNodes, bodyNodes, { open = false, class: cls = 'fold', label } = {}) {
  return h('details', { class: cls, open: open || null },
    h('summary', { class: 'fold-sum', 'aria-label': label || null }, summaryNodes),
    h('div', { class: 'fold-body' }, bodyNodes));
}
