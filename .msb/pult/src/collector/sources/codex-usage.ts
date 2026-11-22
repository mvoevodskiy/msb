// Per-bot Codex usage: ccusage session totals + separately metered saved prompts.
// [Ownership and journals](./codex-usage-data.ts) · [collector](../collect.ts)
// · [display](../../ui/view-bots.js) · [checks](../../../tests/collector/codex-usage.test.ts).
import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { botCodexIdentity, codexEdges, readSavedCodexUsage, type SavedUsage } from './codex-usage-data.ts';
import type { CodexUsage } from '../../shared/types.ts';

const execFileAsync = promisify(execFile);
const UUID_END = /(?:^|[-/])([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
const CONFIG = fileURLToPath(new URL('../../../config/ccusage-report.json', import.meta.url));
const DAY = 86_400_000;
type Report = { sessions: { sessionId: string; totalTokens: number; cacheReadTokens?: number }[] };
type Reports = { all: Report; week: Report; month: Report; at: string };
type BotInput = { id: string; directory: string };
type Identity = { ids: Set<string>; selected: boolean; partial: boolean; saved: SavedUsage };
type Period = 'week' | 'month' | 'all';
type Edges = { children: Map<string, Set<string>>; forkParents?: Map<string, string>; partial: boolean };

function day(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(instant);
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function precedingDay(today: string, days: number): string {
  const at = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(at)) throw new Error('Некорректная дата учёта');
  return new Date(at - days * DAY).toISOString().slice(0, 10);
}

type SessionUsage = { total: number; cached: number | null };
function sessionRows(report: Report): Map<string, SessionUsage | null> {
  if (!report || !Array.isArray(report.sessions)) throw new Error('Некорректный отчёт Codex');
  const rows = new Map<string, SessionUsage | null>();
  for (const row of report.sessions) {
    if (!row || typeof row.sessionId !== 'string') continue;
    const id = UUID_END.exec(row.sessionId)?.[1]?.toLowerCase();
    if (!id) continue;
    const total = Number.isSafeInteger(row.totalTokens) && row.totalTokens >= 0 ? row.totalTokens : null;
    const cached = total !== null && Number.isSafeInteger(row.cacheReadTokens) && Number(row.cacheReadTokens) >= 0 &&
      Number(row.cacheReadTokens) <= total ? Number(row.cacheReadTokens) : null;
    const value = total === null ? null : { total, cached };
    if (rows.has(id)) rows.set(id, null); // Two native files with the same ID are ambiguous.
    else rows.set(id, value);
  }
  return rows;
}

/** ccusage sees all local sessions for replay deduplication; only owned IDs enter a bot's snapshot. */
export function combineCodexUsage(bots: BotInput[], identities: Map<string, Identity>,
  edges: Edges, reports: Reports | null, timezone: string, now: Date): Map<string, CodexUsage> {
  const today = day(now, timezone), starts = { week: precedingDay(today, 6), month: precedingDay(today, 29), all: '1970-01-01' };
  const maps = reports ? { week: sessionRows(reports.week), month: sessionRows(reports.month), all: sessionRows(reports.all) } : null;
  const families = new Map<string, Set<string>>(), owners = new Map<string, Set<string>>();
  const runOwners = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  for (const [parent, children] of edges.children) for (const child of children) {
    if (!parents.has(child)) parents.set(child, new Set());
    parents.get(child)!.add(parent);
  }
  for (const bot of bots) {
    const identity = identities.get(bot.id);
    if (!identity) continue;
    const family = new Set(identity.ids), queue = [...family];
    for (let index = 0; index < queue.length && index < 100000; index++) {
      for (const child of edges.children.get(queue[index]!) ?? []) if (!family.has(child)) { family.add(child); queue.push(child); }
    }
    families.set(bot.id, family);
    for (const id of family) { if (!owners.has(id)) owners.set(id, new Set()); owners.get(id)!.add(bot.id); }
    for (const row of identity.saved.rows) { if (!runOwners.has(row.id)) runOwners.set(row.id, new Set()); runOwners.get(row.id)!.add(bot.id); }
  }
  const output = new Map<string, CodexUsage>();
  for (const bot of bots) {
    const identity = identities.get(bot.id);
    if (!identity || (!identity.selected && !identity.ids.size && !identity.saved.hasCodex)) continue;
    const family = families.get(bot.id) ?? new Set<string>();
    const result: Record<Period, number | null> = { week: 0, month: 0, all: 0 };
    const cacheRead: Record<Period, number | null> = { week: 0, month: 0, all: 0 };
    const withoutCache: Record<Period, number | null> = { week: 0, month: 0, all: 0 };
    const missingSplit: Record<Period, boolean> = { week: false, month: false, all: false };
    const known: Record<Period, number> = { week: 0, month: 0, all: 0 };
    // Report concrete gaps in owned data; unrelated native sessions do not imply a gap for this bot.
    let incomplete = false;
    if ((family.size && !maps) || (!family.size && !identity.saved.hasCodex)) result.week = result.month = result.all = null;
    const safe = new Set<string>();
    if (maps) {
      const queue = [...identity.ids].filter(id => !parents.has(id));
      for (let index = 0; index < queue.length && index < 100000; index++) {
        const id = queue[index]!;
        const forkParent = edges.forkParents?.get(id);
        if (safe.has(id) || (owners.get(id)?.size ?? 0) !== 1 || maps.all.get(id) == null ||
            (forkParent && maps.all.get(forkParent) == null)) { incomplete = true; continue; }
        safe.add(id);
        for (const child of edges.children.get(id) ?? []) {
          if (parents.get(child)?.size === 1 && family.has(child)) queue.push(child);
          else incomplete = true;
        }
      }
      if (safe.size !== family.size) incomplete = true;
    }
    if (maps) for (const id of safe) {
      for (const period of ['week', 'month', 'all'] as const) {
        const value = maps[period].get(id);
        if (value === null) { incomplete = true; continue; }
        result[period] = (result[period] ?? 0) + (value?.total ?? 0);
        if (value?.cached === null) missingSplit[period] = true;
        else if (value) {
          cacheRead[period]! += value.cached!;
          withoutCache[period]! += value.total - value.cached!;
        }
        known[period]++;
      }
    }
    for (const row of identity.saved.rows) {
      if ((runOwners.get(row.id)?.size ?? 0) !== 1) { incomplete = true; continue; }
      if (row.incomplete || row.input === null || row.output === null) incomplete = true;
      const completed = day(new Date(row.completedAt), timezone), started = day(new Date(row.startedAt), timezone);
      for (const period of ['week', 'month', 'all'] as const) {
        if (completed < starts[period] || completed > today || result[period] === null) continue;
        if (started < starts[period]) { incomplete = true; continue; }
        const subtotal = (row.input ?? 0) + (row.output ?? 0);
        result[period]! += subtotal;
        if (row.input === null || row.output === null || !Number.isSafeInteger(row.cached) ||
            row.cached === null || row.cached < 0 || row.cached > row.input) {
          missingSplit[period] = true;
        } else {
          cacheRead[period]! += row.cached;
          withoutCache[period]! += subtotal - row.cached;
        }
        if (row.input !== null || row.output !== null) known[period]++;
      }
    }
    if (identity.partial || identity.saved.partial || identity.saved.unknown.length || (family.size > 0 && edges.partial)) incomplete = true;
    for (const period of ['week', 'month', 'all'] as const) {
      if (!known[period] || (result[period] !== null && !Number.isSafeInteger(result[period]))) {
        result[period] = null; incomplete = true;
      }
      if (result[period] === null || missingSplit[period] || !Number.isSafeInteger(cacheRead[period]) ||
          !Number.isSafeInteger(withoutCache[period])) {
        cacheRead[period] = withoutCache[period] = null;
        incomplete = true;
      }
    }
    if ((result.week !== null && result.month !== null && result.week > result.month) ||
        (result.month !== null && result.all !== null && result.month > result.all)) {
      result.week = result.month = result.all = null;
      cacheRead.week = cacheRead.month = cacheRead.all = null;
      withoutCache.week = withoutCache.month = withoutCache.all = null;
      incomplete = true;
    }
    for (const part of [cacheRead, withoutCache]) {
      if ((part.week !== null && part.month !== null && part.week > part.month) ||
          (part.month !== null && part.all !== null && part.month > part.all)) {
        cacheRead.week = cacheRead.month = cacheRead.all = null;
        withoutCache.week = withoutCache.month = withoutCache.all = null;
        incomplete = true;
        break;
      }
    }
    output.set(bot.id, { providerId: 'codex', week: result.week, month: result.month, all: result.all,
      cacheRead, withoutCache, incomplete, updatedAt: reports?.at ?? null, timezone });
  }
  return output;
}

export class CodexUsageReader {
  private cached: Reports | null = null;
  private cachedEdges: ReturnType<typeof codexEdges> | null = null;
  private edgesAt = '';
  private nextAt = 0;
  private cachedTimezone = '';
  private readonly savedCache = new Map<string, { signature: string; saved: SavedUsage }>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly binary: string;
  private readonly home: string;
  constructor(env: NodeJS.ProcessEnv, botsRoot: string) {
    this.env = env;
    this.home = resolve(env.CODEX_HOME || join(env.HOME || '', '.codex'));
    const installed = '/usr/local/lib/msb-tools/ccusage-20.0.51';
    this.binary = env.PULT_CCUSAGE_BIN || (existsSync(installed) ? installed : join(botsRoot, '..', 'ext-tools', 'bin', 'ccusage'));
  }
  private async saved(directory: string): Promise<SavedUsage> {
    let signature = 'missing';
    try {
      const stat = lstatSync(join(directory, 'autonomy', 'runs.jsonl'));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Некорректный журнал фоновых задач');
      signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A missing optional journal can become a confirmed gap when an action finishes.
    if (signature === 'missing') return readSavedCodexUsage(directory);
    const cached = this.savedCache.get(directory);
    if (cached?.signature === signature) return cached.saved;
    const saved = await readSavedCodexUsage(directory);
    this.savedCache.set(directory, { signature, saved });
    return saved;
  }
  private async reports(now: Date, timezone: string): Promise<Reports> {
    if (this.cached && this.cachedTimezone === timezone && day(new Date(this.cached.at), timezone) === day(now, timezone) &&
        now.getTime() >= Date.parse(this.cached.at) && now.getTime() < this.nextAt) return this.cached;
    const childEnv = { HOME: this.env.HOME, CODEX_HOME: this.home, PATH: this.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' };
    const options = { env: childEnv, timeout: 20000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' as const };
    const version = await execFileAsync(this.binary, ['--version'], options);
    if (version.stdout.trim() !== 'ccusage 20.0.51') throw new Error('Недоступна проверенная версия ccusage');
    const today = day(now, timezone);
    const run = async (since: string): Promise<Report> => {
      const args = ['codex', 'session', '--json', '--offline', '--no-cost', '--timezone', timezone,
        '--config', CONFIG, '--since', since, '--until', today];
      const result = await execFileAsync(this.binary, args, options);
      const report = JSON.parse(result.stdout) as Report;
      sessionRows(report); // Reject an unexpected format before caching it.
      return report;
    };
    // A concurrent turn can only add to later snapshots; take narrower windows first.
    const week = await run(precedingDay(today, 6)), month = await run(precedingDay(today, 29)), all = await run('1970-01-01');
    this.cached = { all, week, month, at: now.toISOString() };
    this.nextAt = now.getTime() + 5 * 60_000;
    this.cachedTimezone = timezone;
    return this.cached;
  }
  async collect(bots: BotInput[], timezone: string, now: Date): Promise<{ usage: Map<string, CodexUsage>; failed: boolean }> {
    const identities = new Map<string, Identity>();
    let failed = false;
    for (const bot of bots) {
      try {
        const identity = botCodexIdentity(bot.directory);
        const saved = await this.saved(bot.directory);
        identities.set(bot.id, { ...identity, saved });
      } catch { failed = true; }
    }
    const hasIds = [...identities.values()].some(identity => identity.ids.size > 0);
    let reports: Reports | null = null;
    if (hasIds) {
      try { reports = await this.reports(now, timezone); }
      catch { failed = true; }
    }
    if (reports && reports.at !== this.edgesAt) { this.cachedEdges = codexEdges(this.home); this.edgesAt = reports.at; }
    const edges = reports && this.cachedEdges ? this.cachedEdges : { children: new Map<string, Set<string>>(), partial: true };
    return { usage: combineCodexUsage(bots, identities, edges, reports, timezone, now), failed };
  }
}
