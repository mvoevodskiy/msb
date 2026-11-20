// Типы для logic.js (чистая логика интерфейса). Нужны тестам на TypeScript; при изменении logic.js — править и здесь.

import type {
  Snapshot, SnapshotResponse, Task, Run, Gap, Bot, Span, Subscription, Balance, Project, Service, ServerState, Level, Tab, RunStatus,
} from './logic-types.ts';

export const TZ: string;
export const NBSP: string;
export function toMs(t: string | number): number;
export function msk(t: string | number): { y: number; mo: number; d: number; hh: string; mm: string; ss: string };
export function mskOffsetMs(t: string | number): number;
export function dayDiff(a: string | number, b: string | number): number;
export function fmtTime(t: string | number): string;
export function fmtDate(t: string | number): string;
export function fmtDateTime(t: string | number): string;
export function fmtWhen(t: string | number, now: number): string;
export function plural(n: number, one: string, few: string, many: string): string;
export function count(n: number, one: string, few: string, many: string): string;
export function fmtInt(n: number): string;
export function fmtFixed(n: number, d: number): string;
export function fmtPct(v: number): string;
export function fmtSpan(sec: number): string;
export function fmtAgo(sec: number): string;
export function fmtDur(sec: number): string;
export function fmtDurShort(sec: number): string;
export function fmtMinutes(min: number): string;
export function fmtTokens(n: number, precise?: boolean): string;
export function fmtMb(mb: number | null | undefined): string;
export function gbNum(mb: number): string;
export function fmtGb(gb: number): string;
export function fmtCores(c: number | null | undefined): string;
export function fmtUsd(n: number | null | undefined): string;
export function joinAnd(items: string[]): string;

export type Range = '24h' | '7d' | '30d';
export const RANGES: Range[];
export const RANGE_MS: Record<Range, number>;
export const RANGE_LABEL: Record<Range, string>;
export interface Route { name: 'overview' | 'bots' | 'tasks' | 'task' | 'projects' | 'server' | 'notfound'; tab: Tab | null; id: string | null; query: Record<string, string> }
export function parseRoute(hash: string): Route;
export function buildHash(tab: Tab, id?: string | null, query?: Record<string, string | null | undefined> | null): string;
export function validRange(r: unknown, def?: Range): Range;
export function attentionHref(link: { tab: Tab; id?: string } | null | undefined): string;
export function attentionLinkLabel(link: { tab: Tab; id?: string } | null | undefined): string;

export function serverNow(resp: SnapshotResponse | null, fetchedAtClient: number, clientNow: number): number;
export function currentAgeSec(resp: SnapshotResponse | null, fetchedAtClient: number, clientNow: number): number | null;

export function serviceStateWord(state: string): string;
export type DotLevel = 'good' | 'warn' | 'serious' | 'crit' | 'off' | 'pause';
export function serviceLevel(state: string, heavy?: boolean): DotLevel;
export function botLabel(name: string, id?: string): string;
export function botShortName(botId: string, bots: Bot[], fallback?: string): string;

export interface OverviewSummary { asks: number; longestSec: number; attention: number; attentionWhere: string; totals: string; failing: string[] }
export function overviewSummary(s: Snapshot, now: number): OverviewSummary;
export function nextDigestAt(now: number, hour?: number): number;
export interface UpcomingRow { at: number; name: string; taskId: string | null; digest: boolean }
export function upcomingRows(s: Snapshot, notify: SnapshotResponse['notify'] | null | undefined, now: number): UpcomingRow[];
export function botNowInfo(bot: Bot, s: Snapshot, now: number): { status: string; busy: boolean; level: DotLevel; about: string; sub: string };
export function botsServiceLine(bots: Bot[]): string;
export function subscriptionInfo(sub: Subscription | null, now: number): { text: string; level: 'warn' | 'crit' | null; stale: boolean } | null;
export function balanceInfo(b: Balance, now: number): { text: string; level: 'warn' | null; stale: boolean; checked: string | null };
export function projectLevel(p: Project): DotLevel;
export function projectServicesParts(p: Project, services: Service[]): { text: string; level: DotLevel | null }[];

export const RUN_WORD: Record<RunStatus, string>;
export function splitTasks(tasks: Task[]): { attention: Task[]; ok: Task[] };
export function botFilters(tasks: Task[], bots: Bot[]): { key: string; label: string; count: number }[];
export function filterTasks(tasks: Task[], key: string | null | undefined): Task[];
export function taskSubtitle(t: Task): string;
export function lastRunText(t: Task, now: number): string;
export function nextRunText(t: Task, now: number): string;
export function gapSlotsIn(gap: Gap, from: number, to: number): number;
export interface RangeStats {
  runs: number; ok: number; silent: number; error: number; missed: number; tokens: number; minutes: number; usd: number | null; expected: number | null;
  from: number; to: number; runList: Run[]; gaps: Gap[]; commits: Task['commits'];
}
export function rangeStats(t: Task, range: Range, now: number): RangeStats;
export function gapDates(gaps: Gap[]): string;
export function stripSummary(t: Task, range: Range, now: number): { text: string; warn: boolean; empty: boolean };
export type Cell = RunStatus | 'none';
export function dayCells(t: Task, range: '7d' | '30d', now: number): Cell[];
export function slotsSummary(slots: Cell[]): string;
export function commitsForRun(t: Task, runIndex: number, now: number): Task['commits'];
export function runOutcome(t: Task, runIndex: number, now: number): string;
export function lastRuns(t: Task, n?: number): { run: Run; index: number }[];
export function groupedLastRuns(t: Task, n: number, now: number): { run: Run; index: number; count: number }[];
export function gapWhen(g: Gap): string;
export function observations(t: Task, range: Range, now: number): string[];
export interface Kpi { label: string; value: string; extra: string | null; sub: string; level: 'warn' | 'crit' | null; dot?: DotLevel; dotWord?: string }
export function taskKpis(t: Task, range: Range, now: number): Kpi[];
export function taskParams(t: Task, now: number): string;
export function taskCron(t: Task): string | null;

export function serverKpis(sv: ServerState): { label: string; value: string; sub: string }[];
export interface ServiceRow {
  id: string; name: string; project: string | null; state: string; since: string | null; restarts: number;
  memMb: number | null; cpuCores: number | null; heavy: boolean; bot: boolean;
}
export function serviceRows(s: Snapshot): ServiceRow[];
export function platformLine(p: Snapshot['platform']): { text: string; level: 'crit' | null } | null;

export function niceMax(v: number): number;
export interface Pt { t: number; v: number }
export function splitSegments<T extends { t: number }>(points: T[], maxGapMs: number): T[][];
export function medianStep(points: { t: number }[]): number;
export function timeTicks(from: number, to: number, maxTicks: number): { t: number; label: string; midnight: boolean }[];
export function midnights(from: number, to: number): number[];
export function seriesOf(points: { t: string; cpu: number; mem: number; disk: number; swap: number }[], key: 'cpu' | 'mem' | 'disk' | 'swap'): Pt[];
export function seriesSummary(pts: Pt[], unit?: string): string;
export interface LaneRow { key: string; label: string; kind: 'chat' | 'bg'; spans: Span[]; gaps: (Gap & { taskName: string })[] }
export function laneRows(s: Snapshot, now: number): { from: number; to: number; rows: LaneRow[] };
export function spanTooltip(sp: Span, now: number): { title: string; sub: string };

export function headerStatus(o: { resp: SnapshotResponse | null; error: unknown; loading: boolean; ageSec: number | null }): { level: DotLevel; text: string; short?: string };
export function staleBanner(resp: SnapshotResponse | null, ageSec: number | null, now: number): string | null;

export type { Level };
