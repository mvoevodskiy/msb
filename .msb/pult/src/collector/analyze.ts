// Что требует внимания: правила поверх готового снимка. Ключи стабильные и без времени —
// по ним веб-сервис отличает новую проблему от продолжающейся (и не шлёт тревогу повторно).

import type { Attention, Level, Snapshot } from '../shared/types.ts';
import type { Thresholds } from '../shared/config.ts';
import { fmtCores, fmtMb, fmtNumber, fmtWhen } from '../shared/format.ts';
import type { Finding } from './sources/tasks.ts';

export interface ServiceStatus {
  id: string;
  name: string;
  optional: boolean;
  loaded: boolean;
  state: string;
  since: string | null;
}

export interface TaskFindings {
  taskId: string;
  taskName: string;
  project: string | null;
  findings: Finding[];
}

export interface AnalyzeInput {
  snapshot: Omit<Snapshot, 'attention'>;
  services: ServiceStatus[];
  tasks: TaskFindings[];
  thresholds: Thresholds;
  tz: string;
  now: Date;
}

const ORDER: Record<Level, number> = { crit: 0, serious: 1, warn: 2 };

export function analyze(inp: AnalyzeInput): Attention[] {
  const { snapshot: s, thresholds: t, tz } = inp;
  const nowMs = inp.now.getTime();
  const out: Attention[] = [];
  const add = (a: Attention) => out.push(a);

  for (const b of s.bots) {
    if (b.service.state !== 'active') {
      add({ key: `bot:${b.id}:down`, level: 'crit', text: `Бот «${b.name}» не работает (состояние: ${b.service.state})`, project: null, link: { tab: 'bots' }, since: b.service.since });
    }
  }

  for (const svc of inp.services) {
    if (svc.optional) continue;
    const project = s.services.find(x => x.id === svc.id)?.project ?? null;
    if (!svc.loaded) {
      add({ key: `service:${svc.id}:down`, level: 'crit', text: `Служба «${svc.name}» не установлена`, project, link: { tab: 'server' }, since: null });
    } else if (svc.state !== 'active') {
      add({ key: `service:${svc.id}:down`, level: 'crit', text: `Служба «${svc.name}» не работает (состояние: ${svc.state})`, project, link: { tab: 'server' }, since: svc.since });
    }
  }

  const srv = s.server;
  if (srv.memTotalMb > 0) {
    const pct = (100 * srv.memUsedMb) / srv.memTotalMb;
    if (pct >= t.memPct) {
      add({ key: 'server:mem', level: 'crit', text: `Память сервера занята на ${Math.round(pct)} %: ${fmtMb(srv.memUsedMb)} из ${fmtMb(srv.memTotalMb)}`, project: null, link: { tab: 'server' }, since: null });
    }
  }
  if (srv.diskTotalGb > 0) {
    const pct = (100 * srv.diskUsedGb) / srv.diskTotalGb;
    if (pct >= t.diskPct) {
      add({ key: 'server:disk', level: 'crit', text: `Диск заполнен на ${Math.round(pct)} %: свободно ${fmtNumber(srv.diskTotalGb - srv.diskUsedGb, 1)} ГБ`, project: null, link: { tab: 'server' }, since: null });
    }
  }

  for (const svc of s.services) {
    if (!svc.heavy) continue;
    const parts: string[] = [];
    if (svc.memMb !== null) parts.push(`${fmtMb(svc.memMb)} памяти`);
    if (svc.cpuCores !== null) parts.push(fmtCores(svc.cpuCores));
    const since = svc.since ? `, работает с ${fmtWhen(svc.since, nowMs, tz)}` : '';
    add({ key: `service:${svc.id}:heavy`, level: 'serious', text: `${svc.name}: ${parts.join(' и ')}${since}`, project: svc.project, link: { tab: 'server' }, since: svc.since });
  }

  for (const tf of inp.tasks) {
    for (const f of tf.findings) {
      const text = f.kind === 'expensive'
        ? `Самый дорогой фон — «${tf.taskName}»: ${f.text.replace(/^самый дорогой фон:\s*/u, '')}`
        : `«${tf.taskName}» ${f.text}`;
      add({ key: `task:${tf.taskId}:${f.kind}`, level: f.level, text, project: tf.project, link: { tab: 'tasks', id: tf.taskId }, since: f.since });
    }
  }

  for (const sub of s.subscriptions ?? (s.subscription ? [s.subscription] : [])) {
    // allowed и allowed_warning — окно ещё открыто; исчерпано — всё остальное (rejected и т. п.)
    if (sub && !sub.status.startsWith('allowed')) {
      const resets = sub.resetsAt ? Date.parse(sub.resetsAt) : null;
      // окно уже сбросилось, а свежей записи ещё нет — не тревожим
      if (resets === null || resets > nowMs) {
        const when = resets === null ? '' : `, сброс в ${fmtWhen(resets, nowMs, tz)}`;
        add({ key: sub.providerId ? `subscription:${sub.providerId}` : 'subscription', level: 'warn', text: `${sub.providerId === 'codex' ? 'Codex: ' : sub.providerId === 'claude' ? 'Claude: ' : ''}Окно подписки исчерпано${when}`, project: null, link: { tab: 'overview' }, since: sub.updatedAt });
      }
    }
  }

  for (const e of s.sourceErrors) {
    add({ key: `source:${e.source}`, level: 'warn', text: `Не удалось прочитать: ${e.source}`, project: null, link: { tab: 'server' }, since: null });
  }

  // одинаковые ключи (например, одна ошибка источника дважды) — оставляем первую
  const seen = new Set<string>();
  return out
    .filter(a => (seen.has(a.key) ? false : (seen.add(a.key), true)))
    .map((a, i) => ({ a, i }))
    .sort((x, y) => ORDER[x.a.level] - ORDER[y.a.level] || x.i - y.i)
    .map(x => x.a);
}

