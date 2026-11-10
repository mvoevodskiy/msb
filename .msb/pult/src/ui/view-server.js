// Экран «Сервер»: 4 показателя, графики процессора и памяти из истории, службы.

import { h } from './dom.js';
import { pageTitle, secTitle, empty, levelDot, seg } from './parts.js';
import { lineChart } from './charts.js';
import {
  serverKpis, serviceRows, platformLine, fmtMb, fmtCores, fmtDateTime, fmtWhen, serviceStateWord, serviceLevel,
  RANGES, RANGE_LABEL, RANGE_MS, validRange, buildHash, seriesOf,
} from './logic.js';

export function viewServer(ctx) {
  const { s, now, route } = ctx;
  const range = validRange(route.query.range);
  const root = h('div', { class: 'server' });
  root.append(h('div', { class: 'pagehead' },
    h('div', { class: 'ph-left' }, pageTitle('Сервер')),
    h('div', { class: 'ph-right' }, seg('Период графиков', RANGES.map((r) => ({ key: r, label: RANGE_LABEL[r], href: buildHash('server', null, r === '24h' ? null : { range: r }) })), range, 'sr'))));

  root.append(h('dl', { class: 'kpis k4' }, serverKpis(s.server).map((k) => h('div', { class: 'kpi' },
    h('dt', { class: 'l' }, k.label), h('dd', { class: 'v' }, k.value), h('dd', { class: 'd' }, k.sub)))));

  const hist = ctx.history(range);
  const from = now - RANGE_MS[range];
  const chartBlock = (key, title) => {
    const id = `sv-${key}`;
    const sec = h('section', { class: 'sec', 'aria-labelledby': id }, secTitle(`${title}, % · ${RANGE_LABEL[range]}`, id));
    if (hist.error && !hist.points.length) sec.append(h('p', { class: 'chart-msg' }, `Историю не удалось загрузить: ${hist.error}. Повторю при следующем обновлении.`));
    else if (hist.loading && !hist.points.length) sec.append(h('p', { class: 'chart-msg', 'aria-busy': 'true' }, 'Загружаю историю…'));
    else if (!hist.points.length) sec.append(h('p', { class: 'chart-msg' }, 'Истории за этот период пока нет — точки копятся с каждым снимком.'));
    else sec.append(ctx.chart((w) => lineChart(w, { points: seriesOf(hist.points, key), from, to: now, title, height: w < 560 ? 150 : 180 }), `line-host${hist.dim ? ' dim' : ''}`));
    return sec;
  };
  root.append(h('div', { class: 'charts2' }, chartBlock('cpu', 'Процессор'), chartBlock('mem', 'Память')));

  const rows = serviceRows(s);
  const sec = h('section', { class: 'sec', 'aria-labelledby': 'sv-svc' }, secTitle('Службы · кто сколько берёт', 'sv-svc'));
  if (!rows.length) sec.append(empty('Служб в снимке нет'));
  else {
    const maxMem = Math.max(1, ...rows.map((r) => r.memMb ?? 0));
    const memCell = (r) => h('span', { class: 'memcell' },
      h('span', { class: `membar${r.heavy ? ' heavy' : ''}`, style: `width:${Math.max(2, Math.round((220 * (r.memMb ?? 0)) / maxMem))}px`, 'aria-hidden': 'true' }),
      h('span', { class: 'num' }, fmtMb(r.memMb)));
    const lvl = (r) => serviceLevel(r.state, r.heavy);
    const stateNote = (r) => (r.state !== 'active' ? h('span', { class: lvl(r) === 'crit' ? 'red small' : 'muted small' }, ` · ${serviceStateWord(r.state)}`) : r.heavy ? h('span', { class: 'orange small' }, ' · тяжёлая') : null);
    sec.append(h('table', { class: 'tbl svc-tbl wide-only' },
      h('caption', { class: 'sr-only' }, 'Службы сервера: память, процессор, время работы, перезапуски'),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', class: 'c-dot' }, h('span', { class: 'sr-only' }, 'Состояние')),
        h('th', { scope: 'col' }, 'Служба'), h('th', { scope: 'col' }, 'Проект'), h('th', { scope: 'col', class: 'c-mem' }, 'Память'),
        h('th', { scope: 'col', class: 'r' }, 'Процессор, ядер в среднем'), h('th', { scope: 'col' }, 'Работает с'), h('th', { scope: 'col', class: 'r' }, 'Перезапусков'))),
      h('tbody', null, rows.map((r) => h('tr', { class: r.heavy ? 'heavy' : null },
        h('td', { class: 'c-dot' }, levelDot(lvl(r))),
        h('th', { scope: 'row', class: r.heavy ? 'tn' : 'tn-normal' }, r.name, stateNote(r)),
        h('td', { class: 'ink2' }, r.project ?? '—'),
        h('td', { class: 'c-mem' }, memCell(r)),
        h('td', { class: r.cpuCores != null && r.cpuCores < 0.005 ? 'r muted' : 'r' }, fmtCores(r.cpuCores)),
        h('td', { class: 'ink2 nowrap' }, r.state === 'active' && r.since ? fmtDateTime(r.since) : '—'),
        h('td', { class: r.restarts ? 'r amber' : 'r' }, String(r.restarts ?? 0)))))));
    sec.append(h('ul', { class: 'cards narrow-only svc-cards' }, rows.map((r) => h('li', { class: 'card' },
      h('div', { class: 'card-head' }, h('span', null, levelDot(lvl(r)), ' ', h('b', { class: r.heavy ? null : 'normal' }, r.name), stateNote(r)), h('span', { class: 'muted small' }, r.project ?? '')),
      memCell(r),
      h('span', { class: 'muted small block' }, [`ядер ${fmtCores(r.cpuCores)}`, r.state === 'active' && r.since ? `с ${fmtDateTime(r.since)}` : null, `перезапусков ${r.restarts ?? 0}`].filter(Boolean).join(' · '))))));
  }
  const pl = platformLine(s.platform);
  const notes = [];
  if (pl) notes.push(h('span', { class: pl.level === 'crit' ? 'red' : null }, pl.text));
  notes.push(`сервер загружен ${fmtWhen(s.server.bootAt, now)}`);
  notes.push(`снимок собран за ${(s.collectMs / 1000).toFixed(1).replace('.', ',')} с`);
  sec.append(h('p', { class: 'note' }, notes.flatMap((n, i) => (i ? [' · ', n] : [n]))));
  root.append(sec);
  return root;
}

