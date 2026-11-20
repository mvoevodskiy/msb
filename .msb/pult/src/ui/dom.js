// Мелкие помощники DOM. Всё из снимка вставляется ТОЛЬКО как текст (append строки = текстовый узел),
// innerHTML не используется нигде — тексты задач и вопросов свободные. Обработчики — addEventListener (CSP).

const SVG_NS = 'http://www.w3.org/2000/svg';

function put(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

function setProps(el, props, svg) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') svg ? el.setAttribute('class', v) : (el.className = v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

/** HTML-элемент: h('a', { href: '#/', class: 'x' }, 'текст', child). */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  setProps(el, props, false);
  put(el, children);
  return el;
}

/** SVG-элемент. */
export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setProps(el, props, true);
  put(el, children);
  return el;
}

/** Текст только для чтеца экрана. */
export const sr = (text) => h('span', { class: 'sr-only' }, text);

/** Точка состояния + слово для чтеца (цвет никогда не единственный носитель смысла). */
export function dot(level, word) {
  return h('span', { class: `dot d-${level || 'off'}`, role: word ? 'img' : null, 'aria-label': word || null, 'aria-hidden': word ? null : 'true' });
}

// ---------- Подсказка и наведение на графики ----------

let tipEl = null;
let liveEl = null;

function tip() {
  tipEl ??= document.getElementById('tip');
  return tipEl;
}

/** Объявить чтецу экрана (для выбора на графике с клавиатуры). */
export function announce(text) {
  liveEl ??= document.getElementById('live');
  if (liveEl) liveEl.textContent = text;
}

/** Показать подсказку у точки (clientX, clientY). lines: [{ strong, text }] — значение крупно, подпись мельче. */
export function showTip(lines, x, y) {
  const t = tip();
  if (!t) return;
  t.replaceChildren(...lines.map((l) => h('div', { class: 'tip-line' }, l.strong ? h('b', null, l.strong) : null, l.strong && l.text ? ' ' : null, l.text ? h('span', null, l.text) : null)));
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  let left = x + 14, top = y - r.height - 12;
  if (left + r.width > vw - 8) left = Math.max(8, x - r.width - 14);
  if (top < 8) top = Math.min(vh - r.height - 8, y + 18);
  t.style.left = `${Math.round(left)}px`;
  t.style.top = `${Math.round(top)}px`;
}

export function hideTip() {
  const t = tip();
  if (t) t.hidden = true;
}

// Активный график (с показанной подсказкой): один на страницу. Касание вне него или прокрутка — снять выбор.
let active = null; // { svg, clear }
export function clearActive() {
  if (active) { const a = active; active = null; a.clear(); }
  hideTip();
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (ev) => { if (active && !active.svg.contains(ev.target)) clearActive(); }, { passive: true });
  window.addEventListener('scroll', () => { if (active) clearActive(); }, { passive: true });
}

/**
 * Наведение и клавиатура для графика.
 * items: [{ x, y?, row?, lines: [{strong,text}], say: 'текст для чтеца', mark?: Element }] — x, y в координатах svg.
 * mode 'x' — ближайший по x (линии и столбики, с перекрестием при crosshair: {top, bottom});
 * mode 'row' — строка по y (rows: [{top, bottom}]), в ней ближайший по x в пределах tol.
 */
export function interact(svg, items, opts = {}) {
  if (!items.length) return;
  const mode = opts.mode || 'x';
  const tol = opts.tol ?? 24;
  let cur = -1;
  let hair = null, ring = null;
  if (opts.crosshair) {
    hair = s('line', { class: 'hair', y1: opts.crosshair.top, y2: opts.crosshair.bottom, x1: 0, x2: 0, display: 'none', 'aria-hidden': 'true' });
    ring = s('circle', { class: 'hair-dot', r: 4, cx: 0, cy: 0, display: 'none', 'aria-hidden': 'true' });
    svg.append(hair, ring);
  }
  const order = items.map((_, i) => i).sort((a, b) => ((items[a].row ?? 0) - (items[b].row ?? 0)) || (items[a].x - items[b].x));

  function select(i, clientX, clientY, viaKeys) {
    if (cur >= 0 && items[cur].mark) items[cur].mark.classList.remove('hot');
    cur = i;
    if (i < 0) {
      if (active?.svg === svg) active = null;
      hideTip();
      if (hair) { hair.setAttribute('display', 'none'); ring.setAttribute('display', 'none'); }
      return;
    }
    if (active && active.svg !== svg) clearActive();
    active = { svg, clear: () => select(-1) };
    const it = items[i];
    if (it.mark) it.mark.classList.add('hot');
    if (hair) {
      hair.setAttribute('x1', it.x); hair.setAttribute('x2', it.x); hair.removeAttribute('display');
      if (it.y != null) { ring.setAttribute('cx', it.x); ring.setAttribute('cy', it.y); ring.removeAttribute('display'); } else ring.setAttribute('display', 'none');
    }
    const box = svg.getBoundingClientRect();
    const vb = svg.viewBox?.baseVal;
    const kx = vb && vb.width ? box.width / vb.width : 1;
    const ky = vb && vb.height ? box.height / vb.height : 1;
    const px = clientX ?? box.left + it.x * kx;
    const py = clientY ?? box.top + (it.y ?? (opts.crosshair ? opts.crosshair.top : 0)) * ky;
    showTip(it.lines, px, py);
    if (viaKeys) announce(it.say || it.lines.map((l) => [l.strong, l.text].filter(Boolean).join(' ')).join('. '));
  }

  function pick(ev) {
    const box = svg.getBoundingClientRect();
    const vb = svg.viewBox?.baseVal;
    const x = (ev.clientX - box.left) * (vb && vb.width ? vb.width / box.width : 1);
    const y = (ev.clientY - box.top) * (vb && vb.height ? vb.height / box.height : 1);
    let best = -1, bd = Infinity;
    if (mode === 'row') {
      const rowIdx = (opts.rows || []).findIndex((r) => y >= r.top && y <= r.bottom);
      if (rowIdx < 0) return -1;
      items.forEach((it, i) => {
        if (it.row !== rowIdx) return;
        const d = it.x0 != null && x >= it.x0 && x <= it.x1 ? 0 : Math.min(Math.abs(x - (it.x0 ?? it.x)), Math.abs(x - (it.x1 ?? it.x)));
        if (d < bd) { bd = d; best = i; }
      });
      return bd <= tol ? best : -1;
    }
    if (opts.plot && (x < opts.plot.left - tol || x > opts.plot.right + tol)) return -1;
    items.forEach((it, i) => { const d = Math.abs(x - it.x); if (d < bd) { bd = d; best = i; } });
    return opts.maxDist != null && bd > opts.maxDist ? -1 : best;
  }

  svg.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'touch') return; const i = pick(ev); if (i !== cur || i >= 0) select(i, ev.clientX, ev.clientY, false); });
  // Касание на телефоне: показать подсказку по месту касания; убирается касанием вне графика или прокруткой.
  svg.addEventListener('pointerdown', (ev) => { if (ev.pointerType !== 'mouse') { svg.classList.add('touched'); select(pick(ev), ev.clientX, ev.clientY, false); } });
  svg.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') select(-1); });
  svg.setAttribute('tabindex', '0');
  svg.addEventListener('focus', () => { if (cur < 0 && svg.matches(':focus-visible')) select(order[order.length - 1], null, null, true); });
  svg.addEventListener('blur', () => select(-1));
  svg.addEventListener('keydown', (ev) => {
    svg.classList.remove('touched');
    const pos = order.indexOf(cur);
    let next = null;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = order[pos < 0 ? 0 : Math.min(order.length - 1, pos + 1)];
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = order[pos < 0 ? order.length - 1 : Math.max(0, pos - 1)];
    else if (ev.key === 'Home') next = order[0];
    else if (ev.key === 'End') next = order[order.length - 1];
    else if (ev.key === 'Escape') { select(-1); return; }
    if (next != null) { ev.preventDefault(); select(next, null, null, true); }
  });
}
