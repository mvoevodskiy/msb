// Графики Пульта — SVG руками, без библиотек. Цвета задаёт app.css через классы (серое; цвет — только у
// пропусков, ошибок и тяжёлого). Каждый график: role="img" + <title> с текстовым итогом, наведение и клавиатура
// (стрелки) через interact() из dom.js. Ширина — фактическая ширина контейнера (перерисовка при изменении окна).

import { s, interact } from './dom.js';
import {
  toMs, fmtTime, fmtDateTime, fmtTokens, fmtDur, fmtPct, RUN_WORD, count,
  niceMax, splitSegments, medianStep, timeTicks, midnights, seriesSummary, gapWhen, gapSlotsIn, spanTooltip, commitsForRun,
} from './logic.js';

const r1 = (v) => Math.round(v * 10) / 10;

function frame(w, hgt, label) {
  const svg = s('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': label, class: 'chart-svg' });
  svg.append(s('title', null, label));
  return svg;
}

/** Прореживание длинного ряда до ~2 точек на пиксель (минимум и максимум корзины — пики не теряются). */
function thin(pts, x, maxPerPx = 2) {
  if (pts.length <= 1) return pts;
  const span = Math.abs(x(pts[pts.length - 1].t) - x(pts[0].t));
  if (pts.length <= span * maxPerPx) return pts;
  const out = [];
  let bx = null, mn = null, mx = null;
  const flush = () => { if (mn) { if (mn.t <= mx.t) out.push(mn, ...(mx !== mn ? [mx] : [])); else out.push(mx, mn); } };
  for (const p of pts) {
    const px = Math.floor(x(p.t));
    if (px !== bx) { flush(); bx = px; mn = mx = p; }
    else { if (p.v < mn.v) mn = p; if (p.v > mx.v) mx = p; }
  }
  flush();
  return out;
}

/**
 * Линейный график процента (процессор, память) с перекрестием.
 * o: { points: [{t,v}], from, to, height, title, now }
 */
export function lineChart(w, o) {
  const H = o.height ?? 170;
  const L = 34, R = 10, T = 12, B = H - 24;
  const PW = Math.max(10, w - L - R);
  const x = (t) => L + (PW * (t - o.from)) / (o.to - o.from);
  const y = (v) => B - ((B - T) * Math.max(0, Math.min(100, v))) / 100;
  const pts = o.points.filter((p) => p.t >= o.from && p.t <= o.to);
  const svg = frame(w, H, `${o.title}: ${seriesSummary(pts)}`);

  for (const v of [0, 50, 100]) {
    svg.append(s('line', { class: v ? 'grid' : 'axis', x1: L, x2: L + PW, y1: y(v), y2: y(v) }));
    svg.append(s('text', { class: 'tick', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
  }
  for (const tk of timeTicks(o.from, o.to, Math.floor(PW / 70))) {
    const tx = x(tk.t);
    if (tx < L + 14 || tx > L + PW - 14) continue;
    svg.append(s('text', { class: 'tick', x: tx, y: H - 6, 'text-anchor': 'middle' }, tk.label));
  }
  if (!pts.length) {
    svg.append(s('text', { class: 'chart-empty', x: L + PW / 2, y: (T + B) / 2, 'text-anchor': 'middle' }, 'за этот период точек нет'));
    return svg;
  }
  const step = medianStep(pts);
  const segs = splitSegments(pts, Math.max(step * 3, 5 * 60e3));
  // Дыры в данных: подпись «нет данных», если есть место.
  for (let i = 1; i < segs.length; i++) {
    const a = x(segs[i - 1][segs[i - 1].length - 1].t), b = x(segs[i][0].t);
    if (b - a > 70) svg.append(s('text', { class: 'chart-note', x: (a + b) / 2, y: T + 10, 'text-anchor': 'middle' }, 'нет данных'));
  }
  for (const sg of segs) {
    const tp = thin(sg, x);
    let d = '';
    tp.forEach((p, i) => { d += `${i ? 'L' : 'M'}${r1(x(p.t))},${r1(y(p.v))}`; });
    if (tp.length === 1) d += `h1`;
    svg.append(s('path', { class: 'ln', d }));
  }
  const last = pts[pts.length - 1];
  svg.append(s('circle', { class: 'ln-end', cx: r1(x(last.t)), cy: r1(y(last.v)), r: 3.5 }));
  svg.append(s('text', { class: 'ln-label', x: x(last.t) - 8, y: Math.max(T + 10, y(last.v) - 9), 'text-anchor': 'end' }, fmtPct(last.v)));

  // Наведение: ближайшая точка по времени (прореженно — не больше точки на 2 пикселя).
  const every = Math.max(1, Math.ceil(pts.length / (PW / 2)));
  const items = [];
  for (let i = 0; i < pts.length; i += every) items.push(pts[i]);
  if (items[items.length - 1] !== last) items.push(last);
  interact(svg, items.map((p) => ({
    x: x(p.t), y: y(p.v),
    lines: [{ strong: fmtPct(p.v), text: fmtDateTime(p.t) }],
    say: `${fmtDateTime(p.t)}: ${fmtPct(p.v)}`,
  })), { mode: 'x', crosshair: { top: T, bottom: B }, plot: { left: L, right: L + PW } });
  return svg;
}

/** Мини-график (обзор): одна линия без осей, с подсказкой. */
export function spark(w, o) {
  const H = o.height ?? 24;
  const pts = o.points.filter((p) => p.t >= o.from && p.t <= o.to);
  const svg = frame(w, H, `${o.title} за 24 часа: ${seriesSummary(pts)}`);
  svg.classList.add('spark');
  if (!pts.length) {
    svg.append(s('line', { class: 'axis', x1: 0, x2: w, y1: H - 2, y2: H - 2 }));
    return svg;
  }
  const x = (t) => 1 + ((w - 6) * (t - o.from)) / (o.to - o.from);
  const y = (v) => H - 3 - ((H - 6) * Math.max(0, Math.min(100, v))) / 100;
  const segs = splitSegments(pts, Math.max(medianStep(pts) * 3, 5 * 60e3));
  for (const sg of segs) {
    let d = '';
    thin(sg, x, 1).forEach((p, i) => { d += `${i ? 'L' : 'M'}${r1(x(p.t))},${r1(y(p.v))}`; });
    svg.append(s('path', { class: 'ln ln-spark', d }));
  }
  const every = Math.max(1, Math.ceil(pts.length / (w / 3)));
  const items = [];
  for (let i = 0; i < pts.length; i += every) items.push(pts[i]);
  if (items[items.length - 1] !== pts[pts.length - 1]) items.push(pts[pts.length - 1]);
  interact(svg, items.map((p) => ({ x: x(p.t), y: y(p.v), lines: [{ strong: fmtPct(p.v), text: `${o.title.toLowerCase()} · ${fmtDateTime(p.t)}` }], say: `${fmtDateTime(p.t)}: ${fmtPct(p.v)}` })),
    { mode: 'x', crosshair: { top: 1, bottom: H - 1 } });
  return svg;
}

/**
 * Ходы задачи: столбики по времени, высота — токены; пропуски — жёлтой подложкой; коммиты — метки под осью.
 * o: { task, from, to, now, height }
 */
export function runBars(w, o) {
  const t = o.task;
  const H = o.height ?? 210;
  const narrow = w < 560;
  const L = narrow ? 44 : 52, R = 8, T = 10, B = H - 40;
  const PW = Math.max(10, w - L - R);
  const x = (ms) => L + (PW * (ms - o.from)) / (o.to - o.from);
  const runs = t.runs.map((r, i) => ({ r, i, at: toMs(r.at) })).filter((q) => q.at >= o.from && q.at <= o.to);
  const real = runs.filter((q) => q.r.status !== 'missed');
  const gaps = t.gaps.filter((g) => toMs(g.to) >= o.from && toMs(g.from) <= o.to);
  const commits = t.commits.filter((c) => { const m = toMs(c.at); return m >= o.from && m <= o.to; });
  const maxTok = Math.max(0, ...real.map((q) => q.r.tokens || 0));
  const byTokens = maxTok > 0;
  const top = byTokens ? niceMax(maxTok) : 1;
  const y = (v) => B - ((B - T) * v) / top;

  const total = real.reduce((n, q) => n + (q.r.tokens || 0), 0);
  const summary = `${count(real.length, 'ход', 'хода', 'ходов')}${byTokens ? `, ${fmtTokens(total)} токенов, самый затратный — ${fmtTokens(maxTok, true)}` : ''}${gaps.length ? `, пропусков: ${gaps.reduce((n, g) => n + gapSlotsIn(g, o.from, o.to), 0)}` : ''}${commits.length ? `, коммитов: ${commits.length}` : ''}`;
  const svg = frame(w, H, `Ходы задачи «${t.name}»: ${summary}`);

  // Сетка и подписи оси значений.
  const yTicks = byTokens ? [0, top / 2, top] : [0];
  for (const v of yTicks) {
    svg.append(s('line', { class: v ? 'grid' : 'axis', x1: L, x2: L + PW, y1: y(v), y2: y(v) }));
    svg.append(s('text', { class: 'tick', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, v ? fmtTokens(v) : '0'));
  }
  // Разделители дней и подписи времени.
  const span = o.to - o.from;
  if (span <= 36 * 3600e3) {
    for (const tk of timeTicks(o.from, o.to, Math.floor(PW / 64))) {
      const tx = x(tk.t);
      if (tx < L + 12 || tx > L + PW - 12) continue;
      svg.append(s('text', { class: 'tick', x: tx, y: H - 8, 'text-anchor': 'middle' }, tk.label));
    }
    for (const m of midnights(o.from, o.to)) {
      svg.append(s('line', { class: 'grid day', x1: x(m), x2: x(m), y1: T, y2: B }));
      svg.append(s('text', { class: 'tick', x: x(m) + 5, y: T + 10 }, fmtDateTime(m).slice(0, 5)));
    }
  } else {
    const mids = midnights(o.from, o.to);
    const every = Math.max(1, Math.ceil(mids.length / Math.max(1, Math.floor(PW / 56))));
    mids.forEach((m, i) => {
      svg.append(s('line', { class: 'grid day', x1: x(m), x2: x(m), y1: T, y2: B }));
      if (i % every === 0 && x(m) + 34 < L + PW) svg.append(s('text', { class: 'tick', x: x(m) + 5, y: H - 8 }, fmtDateTime(m).slice(0, 5)));
    });
  }
  // Ширина столбика — от типичного шага между ходами.
  const step = medianStep(real.map((q) => ({ t: q.at }))) || 3600e3;
  const slotPx = (PW * step) / span;
  const bw = Math.max(1.5, Math.min(9, slotPx * 0.6));

  const items = [];
  // Пропуски — подложкой.
  for (const g of gaps) {
    const a = Math.max(L, x(toMs(g.from)) - slotPx / 2), b = Math.min(L + PW, x(toMs(g.to)) + slotPx / 2);
    const gr = s('rect', { class: 'gap-area', x: r1(a), y: T, width: r1(Math.max(2, b - a)), height: B - T });
    svg.append(gr);
    const inWin = gapSlotsIn(g, o.from, o.to);
    const label = `пропуск — ${count(inWin, 'ход', 'хода', 'ходов')}`;
    if (b - a > label.length * 6.2 + 8) svg.append(s('text', { class: 'gap-text', x: (a + b) / 2, y: T + 14, 'text-anchor': 'middle' }, label));
    const tail = inWin < g.missed ? `, из них на графике ${inWin}` : '';
    items.push({ x: (a + b) / 2, mark: gr, lines: [{ strong: 'пропуск', text: `${gapWhen(g)}` }, { text: `по расписанию не случились ${count(g.missed, 'ход', 'хода', 'ходов')}${tail}` }] });
  }
  // Столбики.
  for (const q of runs) {
    const cx = x(q.at);
    if (q.r.status === 'missed') {
      const m = s('rect', { class: 'bar bar-missed', x: r1(cx - bw / 2), y: B - 6, width: r1(bw), height: 6, rx: 1 });
      svg.append(m);
      items.push({ x: cx, mark: m, lines: [{ strong: 'пропуск', text: fmtDateTime(q.at) }] });
      continue;
    }
    const v = byTokens ? q.r.tokens || 0 : top * 0.6;
    const hgt = Math.max(2, B - y(v));
    const bar = s('rect', { class: `bar bar-${q.r.status}`, x: r1(cx - bw / 2), y: r1(B - hgt), width: r1(bw), height: r1(hgt), rx: Math.min(2, bw / 2) });
    svg.append(bar);
    const lines = [];
    lines.push(byTokens ? { strong: fmtTokens(q.r.tokens, true), text: 'токенов' } : { strong: RUN_WORD[q.r.status] });
    lines.push({ text: `${fmtDateTime(q.at)} · ${RUN_WORD[q.r.status] ?? q.r.status} · ${fmtDur(q.r.durationSec)}` });
    if (q.r.helpers > 0) lines.push({ text: count(q.r.helpers, 'помощник', 'помощника', 'помощников') });
    for (const c of commitsForRun(t, q.i, o.now)) lines.push({ text: `коммит ${c.hash.slice(0, 7)} в ${fmtTime(c.at)}` });
    if (q.r.detail) lines.push({ text: q.r.detail });
    items.push({ x: cx, y: B - hgt, mark: bar, lines });
  }
  // Коммиты — метки под осью.
  for (const c of commits) svg.append(s('rect', { class: 'commit', x: r1(x(toMs(c.at)) - 1), y: B + 4, width: 2, height: 8 }));

  interact(svg, items, { mode: 'x', plot: { left: L, right: L + PW } });
  return svg;
}

/**
 * Лента «кто что делал» за 24 часа. lane — результат laneRows(); на узком экране подписи строк — над строкой.
 */
export function lanes(w, lane, now) {
  const narrow = w < 640;
  const LBL = narrow ? 0 : 132;
  const rowH = narrow ? 46 : 38;
  const T = 6, L = LBL + 4, R = 6;
  const PW = Math.max(10, w - L - R);
  const H = T + lane.rows.length * rowH + 26;
  const x = (ms) => L + (PW * (Math.max(lane.from, Math.min(lane.to, ms)) - lane.from)) / (lane.to - lane.from);
  const total = lane.rows.reduce((n, r) => n + r.spans.length, 0);
  const svg = frame(w, H, `Кто что делал за 24 часа: ${lane.rows.map((r) => `${r.label} — ${count(r.spans.length, 'отрезок', 'отрезка', 'отрезков')}`).join('; ')}${total ? '' : ' (пусто)'}`);

  const rowsGeo = [];
  const items = [];
  const ticks = timeTicks(lane.from, lane.to, Math.floor(PW / (narrow ? 52 : 70))).filter((tk) => x(tk.t) >= L + 12 && x(tk.t) <= L + PW - 12);
  // Вертикальная сетка — под отрезками; на узком экране только в полосе строки, чтобы не резать подписи над ней.
  for (const tk of ticks) {
    const tx = x(tk.t);
    if (narrow) lane.rows.forEach((_, ri) => svg.append(s('line', { class: 'grid', x1: tx, x2: tx, y1: T + ri * rowH + 19, y2: T + ri * rowH + 41 })));
    else svg.append(s('line', { class: 'grid', x1: tx, x2: tx, y1: T, y2: H - 22 }));
  }
  lane.rows.forEach((row, ri) => {
    const top = T + ri * rowH;
    const mid = narrow ? top + 30 : top + rowH / 2;
    rowsGeo.push({ top, bottom: top + rowH });
    if (narrow) svg.append(s('text', { class: 'lane-label', x: 0, y: top + 13 }, row.label));
    else svg.append(s('text', { class: 'lane-label', x: 0, y: mid + 4 }, row.label));
    svg.append(s('rect', { class: 'lane-base', x: L, y: mid - 1, width: PW, height: 2 }));
    for (const g of row.gaps) {
      const a = x(toMs(g.from)) - 4, b = x(toMs(g.to)) + 4;
      const gr = s('rect', { class: 'gap-box', x: r1(a), y: mid - 10, width: r1(Math.max(6, b - a)), height: 20, rx: 3 });
      svg.append(gr);
      const inWin = gapSlotsIn(g, lane.from, lane.to);
      const long = `«${g.taskName}» не запускался — ${count(inWin, 'пропуск', 'пропуска', 'пропусков')}`;
      const short = count(inWin, 'пропуск', 'пропуска', 'пропусков');
      const fit = (txt) => b - a > txt.length * 6 + 10;
      const txt = fit(long) ? long : fit(short) ? short : null;
      if (txt) svg.append(s('text', { class: 'gap-text', x: (a + b) / 2, y: mid + 4, 'text-anchor': 'middle' }, txt));
      items.push({ row: ri, x: (a + b) / 2, x0: a, x1: b, mark: gr, lines: [{ strong: 'пропуск', text: `«${g.taskName}»` },
        { text: `${gapWhen(g)} · не случились ${count(g.missed, 'ход', 'хода', 'ходов')}${inWin < g.missed ? `, за эти сутки ${inWin}` : ''}` }] });
    }
    for (const sp of row.spans) {
      const a = x(toMs(sp.start));
      const b = sp.live ? x(now) : x(toMs(sp.end));
      const wd = Math.max(3, b - a);
      const hh = sp.kind === 'chat' ? 18 : 14;
      const cls = sp.live ? 'span span-live' : sp.status === 'error' ? 'span span-err' : sp.kind === 'chat' ? 'span span-chat' : 'span span-bg';
      const el = s('rect', { class: cls, x: r1(a), y: mid - hh / 2, width: r1(wd), height: hh, rx: 2 });
      svg.append(el);
      const tt = spanTooltip(sp, now);
      items.push({ row: ri, x: a + wd / 2, x0: a, x1: a + wd, mark: el, lines: [{ strong: tt.title }, { text: tt.sub }], say: `${row.label}: ${tt.title}, ${tt.sub}` });
    }
  });
  for (const tk of ticks) svg.append(s('text', { class: 'tick', x: x(tk.t), y: H - 6, 'text-anchor': 'middle' }, tk.label));
  interact(svg, items, { mode: 'row', rows: rowsGeo, tol: 10 });
  return svg;
}

/** Полоса суток бота для обзора: чаты светлые, фоновые ходы тёмные, идущее — контуром. */
export function dayStrip(w, bot, now) {
  const H = 20;
  const from = now - 864e5;
  const x = (ms) => ((w - 2) * (Math.max(from, Math.min(now, ms)) - from)) / 864e5 + 1;
  const spans = bot.timeline.filter((sp) => toMs(sp.end) >= from || sp.live);
  const chats = spans.filter((sp) => sp.kind === 'chat').length;
  const bgs = spans.length - chats;
  const svg = frame(w, H, `${bot.name}, последние 24 часа: ${count(chats, 'запрос', 'запроса', 'запросов')} в чате, ${count(bgs, 'фоновый ход', 'фоновых хода', 'фоновых ходов')}`);
  svg.classList.add('daystrip');
  svg.append(s('rect', { class: 'lane-base', x: 0, y: 9, width: w, height: 2 }));
  const items = [];
  for (const sp of spans) {
    const a = x(toMs(sp.start)), b = sp.live ? x(now) : x(toMs(sp.end));
    const wd = Math.max(2, b - a);
    const el = sp.live
      ? s('rect', { class: 'span span-live', x: r1(a), y: 3.5, width: r1(Math.max(4, wd - 1)), height: 13, rx: 2 })
      : sp.kind === 'chat'
        ? s('rect', { class: 'span span-chat', x: r1(a), y: 3, width: r1(wd), height: 14, rx: 2 })
        : s('rect', { class: sp.status === 'error' ? 'span span-err' : 'span span-bg', x: r1(a), y: 6, width: r1(wd), height: 8, rx: 1 });
    svg.append(el);
    const tt = spanTooltip(sp, now);
    items.push({ row: 0, x: a + wd / 2, x0: a, x1: a + wd, mark: el, lines: [{ strong: tt.title }, { text: tt.sub }] });
  }
  interact(svg, items, { mode: 'row', rows: [{ top: -4, bottom: H + 4 }], tol: 6 });
  return svg;
}
