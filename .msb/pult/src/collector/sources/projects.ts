// Проекты и вопросы к Михаилу — из реестров, которые ведут боты через CLI; плюс службы и коммиты проекта.

import type { Ask, Project, Service } from '../../shared/types.ts';
import type { PultConfig } from '../../shared/config.ts';
import { openAsks, type RegistryAsk, type RegistryProject } from '../../shared/registry.ts';
import { zonedParts, zonedToUtc } from '../../shared/cron.ts';
import { clip } from '../../shared/format.ts';
import type { Commit } from './git.ts';
import { scrub } from '../util.ts';

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Полночь сегодняшнего дня в поясе панели, мс UTC. */
export function midnightMs(nowMs: number, tz: string): number {
  const p = zonedParts(nowMs, tz);
  return zonedToUtc(p.y, p.mo, p.d, 0, 0, tz);
}

export function toAsk(a: RegistryAsk, config: PultConfig): Ask {
  return {
    id: a.id,
    project: a.project,
    bot: a.bot,
    botName: config.bots.find(b => b.id === a.bot)?.name ?? a.bot,
    text: scrub(a.text),
    blocks: a.blocks === null ? null : scrub(a.blocks),
    since: new Date(a.since).toISOString(),
  };
}

export function askBelongs(a: { project: string | null }, p: { id: string; name: string }): boolean {
  return same(a.project, p.id) || same(a.project, p.name);
}

export interface ProjectGit { commits: Commit[]; latest: Commit | null }

export function buildProject(p: RegistryProject, opts: {
  services: Service[];
  asks: RegistryAsk[];
  git: ProjectGit | null;
  nowMs: number;
  tz: string;
}): Project {
  const midnight = midnightMs(opts.nowMs, opts.tz);
  return {
    id: p.id,
    name: p.name,
    owner: p.owner,
    status: p.status,
    statusText: p.statusText,
    stage: p.stage,
    next: p.next,
    services: opts.services.filter(s => same(s.project, p.name)).map(s => ({ name: s.name, state: s.state })),
    commitsToday: opts.git ? opts.git.commits.filter(c => Date.parse(c.at) >= midnight).length : null,
    lastCommit: opts.git?.latest ? { at: opts.git.latest.at, subject: clip(scrub(opts.git.latest.subject), 200) } : null,
    facts: p.facts,
    asks: openAsks({ version: 1, asks: opts.asks }).filter(a => askBelongs(a, p)).map(a => clip(scrub(a.text), 200)),
    updatedAt: p.updatedAt,
  };
}

