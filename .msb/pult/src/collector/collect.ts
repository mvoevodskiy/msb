// Сбор одного снимка. Каждый источник — в своей обёртке: упал один — в снимке null/пусто и запись
// в sourceErrors, остальное собирается. Медленное (замер процессора, Deepgram, systemctl, git, журнал)
// идёт параллельно, поэтому сбор укладывается примерно в секунду-две даже на первом тике.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { activeProvider } from './sources/provider.ts';
import { CodexQuota, readCodexLimits } from './sources/codex-quota.ts';
import { performance } from 'node:perf_hooks';
import { SNAPSHOT_SCHEMA, type Balance, type Bot, type ServerState, type Service, type Snapshot, type Subscription, type Task } from '../shared/types.ts';
import type { PultConfig } from '../shared/config.ts';
import { expandHome, openAsks, readAsks, readProjects } from '../shared/registry.ts';
import { analyze, type ServiceStatus, type TaskFindings } from './analyze.ts';
import { execCmd, iso, type Exec, Problems, readJsonFile, utcDay } from './util.ts';
import { parseBootMs, readServer, type CpuSample } from './sources/system.ts';
import { journalRuns, prop, serverTimeZone, showUnits, unitHealth, type Props, type UnitHealth } from './sources/systemd.ts';
import { cleanTaskName, readDaily, readBotData, type BotData, type RateLimitInfo, type TraceRec, type TranscriptRec } from './sources/journal.ts';
import { agentProcesses, bg24h, botNow, chat24h, lastResult, pendingRequest, timeline } from './sources/bots.ts';
import { actionSchedule, applyFindings, buildTask, expensiveFinding, isActiveAction, sortTasks, taskCommits, type Finding } from './sources/tasks.ts';
import { buildTimerTask } from './sources/timers.ts';
import { GitCache } from './sources/git.ts';
import { buildProject, toAsk } from './sources/projects.ts';
import { apifyBalance, DeepgramBalance, proxyapiBalance } from './sources/balances.ts';

export interface CollectorOptions {
  procRoot?: string;
  cgroupRoot?: string;
  diskPath?: string;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  /** Пауза между двумя замерами процессора на первом тике, мс. */
  firstCpuSampleMs?: number;
  /** Пояс, в котором systemd понимает OnCalendar; по умолчанию — системный. */
  serverTz?: string;
  /** Тиков в секунде для /proc/<pid>/stat; по умолчанию — getconf CLK_TCK. */
  clkTck?: number;
  /** Сколько ждать медленные остатки (Deepgram); не задано — ждать до конца (once, check). */
  slowSourceWaitMs?: number;
  readCodexQuota?: () => Promise<unknown>;
}

const DAY = 86_400_000;

const EMPTY_SERVER: ServerState = {
  cores: 0, cpuPct: 0, iowaitPct: 0, load1: 0, memTotalMb: 0, memUsedMb: 0, memCacheMb: 0, memAvailMb: 0,
  swapTotalMb: 0, swapUsedMb: 0, diskTotalGb: 0, diskUsedGb: 0, bootAt: new Date(0).toISOString(),
};

const health = (h: UnitHealth) => ({ state: h.state, since: h.since, restarts: h.restarts, memMb: h.memMb, cpuCores: h.cpuCores });

export class Collector {
  private readonly config: PultConfig;
  private readonly procRoot: string;
  private readonly cgroupRoot: string;
  private readonly diskPath: string;
  private readonly exec: Exec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: () => Date;
  private readonly firstCpuSampleMs: number;
  private readonly serverTz: string;
  private readonly deepgram: DeepgramBalance | null;
  private readonly slowSourceWaitMs: number | undefined;
  private clkTck: number | null;
  private prevCpu: CpuSample | null = null;
  private readonly codexQuota: CodexQuota;

  constructor(config: PultConfig, opts: CollectorOptions = {}) {
    this.config = config;
    const quotaEnv = opts.env ?? process.env;
    const profileBin = join(dirname(config.botsRoot), 'ext-tools/bin/codex');
    const binary = quotaEnv.PULT_CODEX_BIN || (existsSync(profileBin) ? profileBin : 'codex');
    this.codexQuota = new CodexQuota(opts.readCodexQuota ?? (() => readCodexLimits(binary, quotaEnv)));
    this.procRoot = opts.procRoot ?? '/proc';
    this.cgroupRoot = opts.cgroupRoot ?? '/sys/fs/cgroup';
    this.diskPath = opts.diskPath ?? '/';
    this.exec = opts.exec ?? execCmd;
    this.env = opts.env ?? process.env;
    this.clock = opts.clock ?? (() => new Date());
    this.firstCpuSampleMs = opts.firstCpuSampleMs ?? 1000;
    this.serverTz = opts.serverTz ?? serverTimeZone();
    this.clkTck = opts.clkTck ?? null;
    this.slowSourceWaitMs = opts.slowSourceWaitMs;
    this.deepgram = config.balances.deepgram ? new DeepgramBalance(config.balances.deepgram, this.exec) : null;
  }

  private async ticksPerSecond(): Promise<number> {
    if (this.clkTck === null) {
      const r = await this.exec('getconf', ['CLK_TCK'], { timeoutMs: 3000 });
      const n = Number(r.stdout.trim());
      this.clkTck = r.code === 0 && n > 0 ? n : 100;
    }
    return this.clkTck;
  }

  async collect(): Promise<Snapshot> {
    const t0 = performance.now();
    const now = this.clock();
    const nowMs = now.getTime();
    const cfg = this.config;
    const tz = cfg.timezone;
    const problems = new Problems();
    const git = new GitCache(this.exec);

    // ---- параллельно: процессор, systemd, журналы таймеров, Deepgram ----
    const serverP = problems.guardAsync('сервер', async () => {
      const r = await readServer({ procRoot: this.procRoot, diskPath: this.diskPath, firstSampleMs: this.firstCpuSampleMs }, this.prevCpu);
      this.prevCpu = r.sample;
      return r.state;
    }, null);
    const unitNames = [
      ...cfg.bots.map(b => b.unit), ...cfg.services.map(s => s.unit), ...cfg.platformUnits,
      ...cfg.timers.flatMap(t => [t.timer, t.service]),
    ];
    const unitsP = problems.guardAsync('systemd', () => showUnits(this.exec, unitNames), new Map<string, Props>());
    const journalP = Promise.all(cfg.timers.map(t => journalRuns(this.exec, t.service).catch(() => [])));
    const deepgramP = this.deepgram ? this.deepgram.get(nowMs, this.env, this.slowSourceWaitMs) : Promise.resolve(null);
    const clkP = this.ticksPerSecond();

    const units = await unitsP;
    const platformTimerServices = cfg.platformUnits.filter(u => u.endsWith('.timer')).map(u => prop(units.get(u), 'Unit')).filter(Boolean);
    const platformSvcP = platformTimerServices.length
      ? problems.guardAsync('systemd', () => showUnits(this.exec, platformTimerServices), new Map<string, Props>())
      : Promise.resolve(new Map<string, Props>());
    const bootMs = problems.guard('сервер: время загрузки', () => parseBootMs(readFileSync(join(this.procRoot, 'stat'), 'utf8')), null);
    const clkTck = await clkP;

    // ---- боты и их задачи ----
    const bots: Bot[] = [];
    const botTasks: { task: Task; findings: Finding[]; repo: string | null }[] = [];
    let tasksHidden = 0;
    const rates: RateLimitInfo[] = [];
    let hasCodex = false;
    for (const b of cfg.bots) {
      const h = unitHealth(units.get(b.unit), this.cgroupRoot, nowMs);
      const data = readBotData(join(cfg.botsRoot, b.id), nowMs, problems, b.name);
      if (data.rate) rates.push(data.rate);
      if (problems.guard(`бот «${b.name}»: провайдер`, () => activeProvider(join(cfg.botsRoot, b.id)), 'unknown') === 'codex') hasCodex = true;

      for (const a of data.actions) {
        if (!isActiveAction(a, nowMs)) {
          tasksHidden++;
          continue;
        }
        const built = problems.guard(`задача бота «${b.name}»`, () => buildTask(a, data.runs, { botId: b.id, botName: b.name, config: cfg, now, problems }), null);
        if (built) botTasks.push(built);
      }

      const procs = h.controlGroup && bootMs !== null && (h.state === 'active' || h.state === 'reloading')
        ? problems.guard(`бот «${b.name}»: процессы`, () => agentProcesses({ procRoot: this.procRoot, cgroupRoot: this.cgroupRoot, controlGroup: h.controlGroup!, bootMs, clkTck }), [])
        : [];
      const triggers = data.actions.map(a => {
        const s = actionSchedule(a, tz, now, null);
        return { name: cleanTaskName(a.name), spec: s.spec, tz: s.tz, atMs: s.atMs };
      });
      const botNowState = botNow(procs, pendingRequest(data.transcripts), triggers);
      bots.push({
        id: b.id,
        name: b.name,
        projects: b.projects,
        service: health(h),
        now: botNowState,
        lastResult: problems.guard(`бот «${b.name}»: последний итог`, () => this.lastResultFor(data, join(cfg.botsRoot, b.id), nowMs), null),
        chat24h: chat24h(data.traces, nowMs),
        bg24h: bg24h(data.runs, nowMs),
        timeline: timeline(data.traces, data.runs, botNowState, nowMs),
      });
    }
    // коммиты для задач-разработок
    await Promise.all(botTasks.filter(t => t.repo).map(async t => {
      const repo = t.repo!;
      t.task.commits = await problems.guardAsync(`git «${repo.split('/').pop()}»`, async () => taskCommits(await git.recent(repo)), []);
    }));

    // ---- таймеры сервера ----
    const journals = await journalP;
    const timerTasks = cfg.timers.map((t, i) => {
      const statusData = t.statusFile ? problems.guard(`таймер «${t.name}»: файл состояния`, () => readJsonFile(t.statusFile!), null) : null;
      const botName = t.bot === 'server' ? 'Сервер' : cfg.bots.find(b => b.id === t.bot)?.name ?? t.bot;
      return buildTimerTask({
        cfg: t, botName, timer: units.get(t.timer), service: units.get(t.service), journal: journals[i], statusData,
        serverTz: this.serverTz, displayTz: tz, missedRunsWarn: cfg.thresholds.missedRunsWarn, now,
      });
    });

    // самый дорогой фон за сутки — одна задача на весь сервер
    const all = [...botTasks, ...timerTasks];
    const priciest = all.reduce<(typeof all)[number] | null>((m, t) => (!m || t.task.stats24h.tokens > m.task.stats24h.tokens ? t : m), null);
    if (priciest && priciest.task.stats24h.tokens > cfg.thresholds.expensiveTaskTokens24h) {
      priciest.findings.push(expensiveFinding(priciest.task.stats24h.tokens));
      applyFindings(priciest.task, priciest.findings);
    }
    const tasks = sortTasks(all.map(t => t.task));

    // ---- службы и платформа ----
    const serviceStatus: ServiceStatus[] = [];
    const services: Service[] = [];
    for (const s of cfg.services) {
      const h = unitHealth(units.get(s.unit), this.cgroupRoot, nowMs);
      serviceStatus.push({ id: s.id, name: s.name, optional: s.optional, loaded: h.loaded, state: h.state, since: h.since });
      if (!h.loaded && s.optional) continue;
      const heavy = (h.memMb !== null && h.memMb > cfg.thresholds.heavyServiceMemMb) || (h.cpuCores !== null && h.cpuCores > cfg.thresholds.heavyServiceCores);
      services.push({ id: s.id, name: s.name, project: s.project, heavy, ...health(h) });
    }
    services.sort((a, b) => (b.memMb ?? -1) - (a.memMb ?? -1));

    const platformSvc = await platformSvcP;
    const platform = { total: cfg.platformUnits.length, ok: 0, failed: 0 };
    for (const u of cfg.platformUnits) {
      const p = units.get(u);
      const state = prop(p, 'ActiveState');
      const result = u.endsWith('.timer') ? prop(platformSvc.get(prop(p, 'Unit')), 'Result') : prop(p, 'Result');
      if (state === 'active' && (result === 'success' || result === '')) platform.ok++;
      else if (state === 'failed' || (result !== '' && result !== 'success')) platform.failed++;
    }

    // ---- проекты и вопросы ----
    const projectsFile = problems.guard('реестр проектов', () => readProjects(cfg.registry.projects), { version: 1 as const, projects: [] });
    const asksFile = problems.guard('реестр вопросов', () => readAsks(cfg.registry.asks), { version: 1 as const, asks: [] });
    const projects = await Promise.all([...projectsFile.projects].sort((a, b) => a.order - b.order).map(async p => {
      const repo = p.repo ? expandHome(p.repo) : null;
      const g = repo
        ? await problems.guardAsync(`git проекта «${p.name}»`, async () => ({ commits: await git.recent(repo), latest: await git.latest(repo) }), null)
        : null;
      return buildProject(p, { services, asks: asksFile.asks, git: g, nowMs, tz });
    }));
    const asks = openAsks(asksFile).map(a => toAsk(a, cfg));

    // ---- подписка и остатки ----
    const freshest = rates.filter(r => typeof r.lastUpdatedAt === 'number').sort((a, b) => b.lastUpdatedAt! - a.lastUpdatedAt!)[0];
    const subscription: Subscription | null = freshest
      ? {
        status: String(freshest.status ?? 'unknown'),
        resetsAt: typeof freshest.resetsAt === 'number' ? iso(freshest.resetsAt * 1000) : null,
        windowType: typeof freshest.rateLimitType === 'string' ? freshest.rateLimitType : null,
        overage: freshest.isUsingOverage === true,
        updatedAt: iso(freshest.lastUpdatedAt! * 1000),
      }
      : null;

    const subscriptions: Subscription[] = subscription ? [{ ...subscription, providerId: 'claude' }] : [];
    if (hasCodex) {
      const quota = await this.codexQuota.get(nowMs);
      if (quota.subscription) subscriptions.push(quota.subscription);
      if (quota.error) problems.add('подписка Codex', new Error(quota.error));
    }

    const balances: Balance[] = [];
    if (cfg.balances.proxyapi) balances.push(proxyapiBalance(cfg.balances.proxyapi.file, cfg.balances.proxyapi.lowRub, nowMs));
    if (cfg.balances.apify) balances.push(apifyBalance(cfg.balances.apify.file, nowMs));
    const dg = await problems.guardAsync('Deepgram', () => deepgramP, null);
    if (dg) balances.push(dg);

    const upcoming = tasks
      .filter(t => t.nextRunAt && Date.parse(t.nextRunAt) > nowMs)
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
      .slice(0, 8)
      .map(t => ({ at: t.nextRunAt!, name: t.name, taskId: t.id }));

    const server = (await serverP) ?? EMPTY_SERVER;

    const base: Omit<Snapshot, 'attention'> = {
      schema: SNAPSHOT_SCHEMA,
      host: cfg.host,
      collectedAt: now.toISOString(),
      collectMs: 0,
      server,
      bots,
      tasks,
      tasksHidden,
      services,
      platform,
      projects,
      asks,
      subscription,
      subscriptions,
      balances,
      upcoming,
      sourceErrors: problems.list,
    };
    const taskFindings: TaskFindings[] = all.map(t => ({ taskId: t.task.id, taskName: t.task.name, project: t.task.project, findings: t.findings }));
    const attention = analyze({ snapshot: base, services: serviceStatus, tasks: taskFindings, thresholds: cfg.thresholds, tz, now });
    return { ...base, attention, collectMs: Math.round(performance.now() - t0) };
  }

  /** Последний итог; если ответ старше вчерашнего дня, дочитываем журналы его дня. */
  private lastResultFor(data: BotData, dir: string, nowMs: number): Bot['lastResult'] {
    const reply = [...data.diary].reverse().find(r => r.kind === 'agent_reply');
    if (!reply) return null;
    const day = utcDay(Date.parse(reply.ts));
    if (day === utcDay(nowMs) || day === utcDay(nowMs - DAY)) return lastResult(data.diary, data.traces, data.transcripts);
    const traces = readDaily<TraceRec>(join(dir, 'traces'), [day]);
    const transcripts = readDaily<TranscriptRec>(join(dir, 'transcripts'), [day]);
    return lastResult(data.diary, traces, transcripts);
  }
}
