// Настройки сборщика: config/pult.config.json (или путь из PULT_CONFIG). Проверяются целиком при загрузке:
// каждое пустое или неверное поле — отдельная строка ошибки по-русски, чтобы служба не стартовала молча
// с дырявым конфигом. Пути с ~ раскрываются здесь же — дальше код работает с готовыми абсолютными путями.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome } from './registry.ts';
import { isValidTimeZone } from './cron.ts';
import { plural } from './format.ts';

/** Имена для автообнаруженных ботов (каталог в botsRoot без записи в конфиге). */
const KNOWN_BOT_NAMES: Record<string, string> = {
  default: 'Основной',
  SMM: 'SMM',
  personal: 'Личный',
  sales: 'Sales',
};

/** Шаблон systemd-юнита бота MSB: msb-bot@<id>.service */
export const BOT_UNIT_TEMPLATE = 'msb-bot@%s.service';

export function botUnitName(id: string): string {
  return BOT_UNIT_TEMPLATE.replace('%s', id);
}

/**
 * Боты из каталога botsRoot, которых ещё нет в конфиге.
 * Новый бот появляется на Пульте сам — без правки конфига.
 */
export function discoverExtraBots(botsRoot: string, configured: BotConfig[]): BotConfig[] {
  const known = new Set(configured.map(b => b.id));
  let dirs: string[] = [];
  try {
    dirs = readdirSync(botsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && /^[A-Za-z0-9_-]+$/.test(d.name))
      .map(d => d.name);
  } catch {
    return [];
  }
  return dirs.filter(id => !known.has(id)).map(id => ({
    id,
    name: KNOWN_BOT_NAMES[id] ?? id,
    unit: botUnitName(id),
    projects: [],
  }));
}

export interface BotConfig {
  id: string;
  name: string;
  unit: string;
  projects: string[];
}

export interface ServiceConfig {
  id: string;
  name: string;
  unit: string;
  project: string | null;
  /** Необязательная: не тревожить, если не установлена; в снимке — только если юнит существует. */
  optional: boolean;
}

export interface TimerConfig {
  id: string;
  name: string;
  timer: string;
  service: string;
  /** Ключ бота или 'server'. */
  bot: string;
  project: string | null;
  expect: string | null;
  /** JSON-файл состояния скрипта таймера (сейчас понимаем формат x-status.json). */
  statusFile: string | null;
  /** Расписание словами, если из TimersCalendar/TimersMonotonic не разобрать. */
  scheduleText: string | null;
}

export interface TaskRule {
  match: string;
  re: RegExp;
  project: string | null;
  expect: string | null;
  pulseFile: string | null;
  repo: string | null;
}

export interface Thresholds {
  memPct: number;
  diskPct: number;
  heavyServiceMemMb: number;
  heavyServiceCores: number;
  missedRunsWarn: number;
  expensiveTaskTokens24h: number;
}

export interface BalancesConfig {
  proxyapi: { file: string; lowRub: number | null } | null;
  apify: { file: string } | null;
  deepgram: { command: string[]; everyMin: number; lowUsd: number | null } | null;
}

export interface PultConfig {
  host: string;
  timezone: string;
  intervalSec: number;
  botsRoot: string;
  bots: BotConfig[];
  services: ServiceConfig[];
  /** Служебные юниты платформы ботов — в снимок идут только счётчики. */
  platformUnits: string[];
  timers: TimerConfig[];
  taskRules: TaskRule[];
  registry: { projects: string; asks: string };
  balances: BalancesConfig;
  thresholds: Thresholds;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(problems.length ? `${message}\n${problems.map(p => `  - ${p}`).join('\n')}` : message);
    this.problems = problems;
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function defaultConfigPath(): string {
  return resolve(ROOT, 'config/pult.config.json');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PULT_CONFIG ? resolve(expandHome(env.PULT_CONFIG)) : defaultConfigPath();
}

export function loadConfig(path = configPath()): PultConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigError(`Нет файла конфига ${path}: положи config/pult.config.json или укажи путь в PULT_CONFIG`);
    throw new ConfigError(`Не читается конфиг ${path}: ${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Конфиг ${path} — не JSON: ${(e as Error).message}`);
  }
  return validateConfig(data, path);
}

// ---- Проверка ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const UNIT_RE = /^[\w@:.\\-]+\.(service|timer|socket|target|path|mount|scope|slice)$/;

class Checker {
  readonly problems: string[] = [];

  fail(at: string, msg: string): void {
    this.problems.push(`${at}: ${msg}`);
  }

  str(o: Obj, key: string, at: string): string {
    const v = o[key];
    if (v === undefined) this.fail(`${at}${key}`, 'нет поля');
    else if (typeof v !== 'string') this.fail(`${at}${key}`, 'должно быть строкой');
    else if (!v.trim()) this.fail(`${at}${key}`, 'пустое');
    else return v;
    return '';
  }

  /** Строка или null; отсутствие поля — тоже null. */
  strOrNull(o: Obj, key: string, at: string): string | null {
    const v = o[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || !v.trim()) {
      this.fail(`${at}${key}`, 'должно быть непустой строкой или null');
      return null;
    }
    return v;
  }

  num(o: Obj, key: string, at: string, min: number, max = Infinity): number {
    const v = o[key];
    if (v === undefined) this.fail(`${at}${key}`, 'нет поля');
    else if (typeof v !== 'number' || !Number.isFinite(v)) this.fail(`${at}${key}`, 'должно быть числом');
    else if (v < min || v > max) this.fail(`${at}${key}`, `должно быть от ${min}${max === Infinity ? '' : ` до ${max}`}`);
    else return v;
    return min;
  }

  unit(o: Obj, key: string, at: string, suffix?: string): string {
    const v = this.str(o, key, at);
    if (v && !UNIT_RE.test(v)) this.fail(`${at}${key}`, `«${v}» не похоже на имя юнита systemd`);
    else if (v && suffix && !v.endsWith(suffix)) this.fail(`${at}${key}`, `ожидается юнит ${suffix}`);
    return v;
  }

  list(o: Obj, key: string, at: string): unknown[] {
    const v = o[key];
    if (!Array.isArray(v)) {
      this.fail(`${at}${key}`, v === undefined ? 'нет поля' : 'должно быть списком');
      return [];
    }
    return v;
  }

  items(o: Obj, key: string, at: string): [Obj, string][] {
    return this.list(o, key, at).flatMap((v, i): [Obj, string][] => {
      const where = `${at}${key}[${i}].`;
      if (!isObj(v)) {
        this.fail(`${at}${key}[${i}]`, 'должно быть объектом');
        return [];
      }
      return [[v, where]];
    });
  }

  unique(values: string[], at: string, what: string): void {
    const seen = new Set<string>();
    for (const v of values) {
      if (v && seen.has(v)) this.fail(at, `${what} «${v}» повторяется`);
      seen.add(v);
    }
  }
}

export function validateConfig(data: unknown, source = 'pult.config.json'): PultConfig {
  if (!isObj(data)) throw new ConfigError(`Конфиг ${source}: ожидается объект JSON`);
  const c = new Checker();

  const host = c.str(data, 'host', '');
  const timezone = c.str(data, 'timezone', '');
  if (timezone && !isValidTimeZone(timezone)) c.fail('timezone', `неизвестный часовой пояс «${timezone}» (нужно имя IANA, например Europe/Moscow)`);
  const intervalSec = c.num(data, 'intervalSec', '', 5, 3600);
  const botsRoot = c.str(data, 'botsRoot', '');

  const bots: BotConfig[] = c.items(data, 'bots', '').map(([b, at]) => {
    const projects = c.list(b, 'projects', at);
    if (!projects.every(p => typeof p === 'string')) c.fail(`${at}projects`, 'должно быть списком строк');
    return { id: c.str(b, 'id', at), name: c.str(b, 'name', at), unit: c.unit(b, 'unit', at, '.service'), projects: projects.filter((p): p is string => typeof p === 'string') };
  });
  if (Array.isArray(data.bots) && !bots.length) c.fail('bots', 'нужен хотя бы один бот');
  c.unique(bots.map(b => b.id), 'bots', 'id');
  const botIds = new Set(bots.map(b => b.id));

  const services: ServiceConfig[] = c.items(data, 'services', '').map(([s, at]) => {
    if (s.optional !== undefined && typeof s.optional !== 'boolean') c.fail(`${at}optional`, 'должно быть true или false');
    return { id: c.str(s, 'id', at), name: c.str(s, 'name', at), unit: c.unit(s, 'unit', at), project: c.strOrNull(s, 'project', at), optional: s.optional === true };
  });
  c.unique(services.map(s => s.id), 'services', 'id');

  const platformUnits = c.list(data, 'platformUnits', '').map((u, i) => {
    if (typeof u !== 'string' || !UNIT_RE.test(u)) c.fail(`platformUnits[${i}]`, 'должно быть именем юнита systemd');
    return String(u);
  });

  const timers: TimerConfig[] = c.items(data, 'timers', '').map(([t, at]) => {
    const bot = c.str(t, 'bot', at);
    if (bot && bot !== 'server' && !botIds.has(bot)) c.fail(`${at}bot`, `нет бота «${bot}» (допустимо: ${[...botIds, 'server'].join(', ')})`);
    const statusFile = c.strOrNull(t, 'statusFile', at);
    return {
      id: c.str(t, 'id', at), name: c.str(t, 'name', at), timer: c.unit(t, 'timer', at, '.timer'), service: c.unit(t, 'service', at, '.service'),
      bot, project: c.strOrNull(t, 'project', at), expect: c.strOrNull(t, 'expect', at),
      statusFile: statusFile && expandHome(statusFile), scheduleText: c.strOrNull(t, 'scheduleText', at),
    };
  });
  c.unique(timers.map(t => t.id), 'timers', 'id');

  const taskRules: TaskRule[] = c.items(data, 'taskRules', '').map(([r, at]) => {
    const match = c.str(r, 'match', at);
    let re = /$^/;
    try {
      if (match) re = new RegExp(match, 'iu');
    } catch (e) {
      c.fail(`${at}match`, `неверное регулярное выражение: ${(e as Error).message}`);
    }
    const rule = {
      match, re,
      project: c.strOrNull(r, 'project', at), expect: c.strOrNull(r, 'expect', at),
      pulseFile: c.strOrNull(r, 'pulseFile', at), repo: c.strOrNull(r, 'repo', at),
    };
    if (!rule.project && !rule.expect && !rule.pulseFile && !rule.repo) c.fail(at.slice(0, -1), 'правило ничего не задаёт: нужен project, expect, pulseFile или repo');
    rule.pulseFile = rule.pulseFile && expandHome(rule.pulseFile);
    rule.repo = rule.repo && expandHome(rule.repo);
    return rule;
  });

  let registry = { projects: '', asks: '' };
  if (!isObj(data.registry)) c.fail('registry', 'нет раздела {projects, asks}');
  else registry = { projects: expandHome(c.str(data.registry, 'projects', 'registry.')), asks: expandHome(c.str(data.registry, 'asks', 'registry.')) };

  const balances: BalancesConfig = { proxyapi: null, apify: null, deepgram: null };
  if (data.balances !== undefined && !isObj(data.balances)) c.fail('balances', 'должно быть объектом');
  else if (isObj(data.balances)) {
    const b = data.balances;
    if (isObj(b.proxyapi)) {
      const lowRub = b.proxyapi.lowRub === undefined ? null : c.num(b.proxyapi, 'lowRub', 'balances.proxyapi.', 0);
      balances.proxyapi = { file: expandHome(c.str(b.proxyapi, 'file', 'balances.proxyapi.')), lowRub };
    } else if (b.proxyapi !== undefined) c.fail('balances.proxyapi', 'должно быть объектом {file, lowRub}');
    if (isObj(b.apify)) balances.apify = { file: expandHome(c.str(b.apify, 'file', 'balances.apify.')) };
    else if (b.apify !== undefined) c.fail('balances.apify', 'должно быть объектом {file}');
    if (isObj(b.deepgram)) {
      const cmd = c.list(b.deepgram, 'command', 'balances.deepgram.');
      if (!cmd.length || !cmd.every(a => typeof a === 'string' && a)) c.fail('balances.deepgram.command', 'нужен непустой список строк: команда и аргументы');
      const lowUsd = b.deepgram.lowUsd === undefined ? null : c.num(b.deepgram, 'lowUsd', 'balances.deepgram.', 0);
      balances.deepgram = { command: cmd.map(a => expandHome(String(a))), everyMin: c.num(b.deepgram, 'everyMin', 'balances.deepgram.', 1), lowUsd };
    } else if (b.deepgram !== undefined) c.fail('balances.deepgram', 'должно быть объектом {command, everyMin}');
  }

  let thresholds: Thresholds = { memPct: 90, diskPct: 90, heavyServiceMemMb: 2048, heavyServiceCores: 0.5, missedRunsWarn: 3, expensiveTaskTokens24h: 5e6 };
  if (!isObj(data.thresholds)) c.fail('thresholds', 'нет раздела порогов');
  else {
    const t = data.thresholds;
    const at = 'thresholds.';
    thresholds = {
      memPct: c.num(t, 'memPct', at, 1, 100), diskPct: c.num(t, 'diskPct', at, 1, 100),
      heavyServiceMemMb: c.num(t, 'heavyServiceMemMb', at, 1), heavyServiceCores: c.num(t, 'heavyServiceCores', at, 0.01),
      missedRunsWarn: c.num(t, 'missedRunsWarn', at, 1), expensiveTaskTokens24h: c.num(t, 'expensiveTaskTokens24h', at, 1),
    };
  }

  if (c.problems.length) {
    const n = c.problems.length;
    throw new ConfigError(`Конфиг ${source}: ${n} ${plural(n, 'ошибка', 'ошибки', 'ошибок')}`, c.problems);
  }
  const root = expandHome(botsRoot);
  const allBots = [...bots, ...discoverExtraBots(root, bots)];
  return {
    host, timezone, intervalSec, botsRoot: root, bots: allBots, services, platformUnits, timers, taskRules,
    registry, balances, thresholds,
  };
}
