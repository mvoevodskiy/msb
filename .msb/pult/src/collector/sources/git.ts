// Коммиты из git-репозиториев: для карточек задач (30 дней) и проектов (сегодня, последний).

import { type Exec, SourceFailure } from '../util.ts';

export interface Commit {
  at: string;
  hash: string;
  subject: string;
}

const FORMAT = '--format=%H%x09%aI%x09%s';

/** Вывод `git log --format=%H%x09%aI%x09%s` → коммиты, новые первыми (как печатает git). */
export function parseGitLog(text: string): Commit[] {
  const out: Commit[] = [];
  for (const line of text.split('\n')) {
    const [hash, date, ...rest] = line.split('\t');
    const t = Date.parse(date ?? '');
    if (!hash || !/^[0-9a-f]{7,}$/.test(hash) || !Number.isFinite(t)) continue;
    out.push({ at: new Date(t).toISOString(), hash: hash.slice(0, 7), subject: rest.join('\t').trim() });
  }
  return out;
}

export async function gitLog(exec: Exec, repo: string, args: string[]): Promise<Commit[]> {
  const r = await exec('git', ['-C', repo, 'log', ...args, FORMAT], { timeoutMs: 8000 });
  // в новом репозитории ещё нет коммитов — это не ошибка
  if (r.code !== 0 && /does not have any commits/.test(r.stderr)) return [];
  if (r.code !== 0) throw new SourceFailure(r.error ?? 'git log не сработал');
  return parseGitLog(r.stdout);
}

/** Кеш на один сбор: один репозиторий нужен и задаче, и проекту — читаем его один раз. */
export class GitCache {
  private readonly exec: Exec;
  private readonly month = new Map<string, Promise<Commit[]>>();
  private readonly last = new Map<string, Promise<Commit | null>>();

  constructor(exec: Exec) {
    this.exec = exec;
  }

  /** Коммиты за 30 дней, новые первыми. */
  recent(repo: string): Promise<Commit[]> {
    let p = this.month.get(repo);
    if (!p) {
      p = gitLog(this.exec, repo, ['--since=30.days']);
      this.month.set(repo, p);
    }
    return p;
  }

  /** Последний коммит (даже если старше 30 дней). */
  async latest(repo: string): Promise<Commit | null> {
    const recent = await this.recent(repo);
    if (recent.length) return recent[0];
    let p = this.last.get(repo);
    if (!p) {
      p = gitLog(this.exec, repo, ['-1']).then(c => c[0] ?? null);
      this.last.set(repo, p);
    }
    return p;
  }
}
