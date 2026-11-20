// Реестры, которые ведут боты: вопросы к Михаилу (asks.json) и карточки проектов (projects.json).
// Пишет только CLI (src/cli/pult.ts), читает сборщик. Запись атомарная (временный файл + rename)
// под блокировкой-каталогом, чтобы два бота не затёрли друг друга.

import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

export interface RegistryProject {
  id: string;
  name: string;
  /** Кто ведёт, для людей: «основной бот · соцсети — SMM». */
  owner: string;
  status: 'ok' | 'warn' | 'pause' | 'unknown';
  statusText: string;
  stage: string | null;
  next: string | null;
  /** Каталог git-репозитория — для «коммитов сегодня». */
  repo: string | null;
  facts: { label: string; value: string }[];
  /** Порядок на панели: меньше — выше. */
  order: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface RegistryAsk {
  id: string;
  project: string | null;
  bot: string;
  text: string;
  blocks: string | null;
  since: string;
  closedAt: string | null;
  closedNote: string | null;
}

export interface ProjectsFile { version: 1; projects: RegistryProject[] }
export interface AsksFile { version: 1; asks: RegistryAsk[] }

export const PROJECT_STATUSES = ['ok', 'warn', 'pause', 'unknown'] as const;

export class RegistryError extends Error {}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new RegistryError(`${path}: файл повреждён, это не JSON (${(e as Error).message})`);
  }
}

const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

export function parseProjects(data: unknown, path = 'projects.json'): ProjectsFile {
  if (data === null || data === undefined) return { version: 1, projects: [] };
  const d = data as Partial<ProjectsFile>;
  if (d.version !== 1 || !Array.isArray(d.projects)) throw new RegistryError(`${path}: ожидается {"version":1,"projects":[…]}`);
  d.projects.forEach((p, i) => {
    const where = `${path}: проект №${i + 1}`;
    if (!str(p.id) || !p.id) throw new RegistryError(`${where}: нет id`);
    if (!str(p.name) || !p.name) throw new RegistryError(`${where} (${p.id}): нет name`);
    if (!PROJECT_STATUSES.includes(p.status)) throw new RegistryError(`${where} (${p.id}): status должен быть одним из ${PROJECT_STATUSES.join(', ')}`);
    if (!str(p.owner) || !str(p.statusText)) throw new RegistryError(`${where} (${p.id}): нужны owner и statusText`);
    if (!strOrNull(p.stage) || !strOrNull(p.next) || !strOrNull(p.repo)) throw new RegistryError(`${where} (${p.id}): stage, next, repo — строка или null`);
    if (!Array.isArray(p.facts) || !p.facts.every(f => str(f?.label) && str(f?.value))) throw new RegistryError(`${where} (${p.id}): facts — список {label, value}`);
    if (typeof p.order !== 'number') throw new RegistryError(`${where} (${p.id}): order — число`);
  });
  return d as ProjectsFile;
}

export function parseAsks(data: unknown, path = 'asks.json'): AsksFile {
  if (data === null || data === undefined) return { version: 1, asks: [] };
  const d = data as Partial<AsksFile>;
  if (d.version !== 1 || !Array.isArray(d.asks)) throw new RegistryError(`${path}: ожидается {"version":1,"asks":[…]}`);
  d.asks.forEach((a, i) => {
    const where = `${path}: вопрос №${i + 1}`;
    if (!str(a.id) || !a.id) throw new RegistryError(`${where}: нет id`);
    if (!str(a.bot) || !str(a.text) || !a.text) throw new RegistryError(`${where} (${a.id}): нужны bot и text`);
    if (!str(a.since) || Number.isNaN(Date.parse(a.since))) throw new RegistryError(`${where} (${a.id}): since — дата ISO`);
    if (!strOrNull(a.project) || !strOrNull(a.blocks) || !strOrNull(a.closedAt) || !strOrNull(a.closedNote)) throw new RegistryError(`${where} (${a.id}): project, blocks, closedAt, closedNote — строка или null`);
  });
  return d as AsksFile;
}

export function readProjects(path: string): ProjectsFile {
  const p = expandHome(path);
  return parseProjects(readJson(p), p);
}

export function readAsks(path: string): AsksFile {
  const p = expandHome(path);
  return parseAsks(readJson(p), p);
}

/** Открытые вопросы, старые первыми. */
export function openAsks(file: AsksFile): RegistryAsk[] {
  return file.asks.filter(a => !a.closedAt).sort((a, b) => a.since.localeCompare(b.since));
}

const LOCK_STALE_MS = 30_000;

/** Блокировка через mkdir: атомарна на одной ФС. Старая (>30 с) блокировка считается брошенной. */
export function withLock<T>(path: string, fn: () => T): T {
  const lock = expandHome(path) + '.lock';
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmdirSync(lock); continue; }
      } catch { /* блокировку уже сняли — пробуем снова */ }
      if (Date.now() > deadline) throw new RegistryError(`${lock}: реестр занят дольше 10 с, повтори позже`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(lock); } catch { /* уже снята */ }
  }
}

export function writeJsonAtomic(path: string, data: unknown): void {
  const p = expandHome(path);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
}
