#!/usr/bin/env node
// Команда для ботов: вести на Пульте вопросы к Михаилу и карточки проектов.
// Пишет реестры из config/pult.config.json → registry; сборщик подхватит изменения за минуту.
// Без ИИ, бесплатно, секретов не нужно.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AsksFile, type ProjectsFile, type RegistryAsk, type RegistryProject,
  PROJECT_STATUSES, RegistryError, openAsks, parseAsks, parseProjects, readAsks, readProjects,
  withLock, writeJsonAtomic, expandHome,
} from '../shared/registry.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const HELP = `pult — вопросы к Михаилу и карточки проектов на Пульте

  pult ask add --bot <бот> --text "<вопрос>" [--project <проект>] [--blocks "<что стоит без ответа>"]
               [--since <дата ISO>]   записать вопрос к Михаилу; печатает его id
                                   (--since — когда вопрос задан, если раньше, чем сейчас)
  pult ask close <id> [--note "<ответ или решение>"]
                                   закрыть вопрос, когда Михаил ответил
  pult ask list [--all]            открытые вопросы (--all — и закрытые)

  pult project list                проекты
  pult project show <id>           карточка проекта целиком
  pult project set <id> [--name ..] [--owner ..] [--status ok|warn|pause|unknown] [--status-text ..]
                   [--stage ..] [--next ..] [--repo <каталог git>] [--order N]
                   [--fact "Метка=значение"]... [--drop-fact "Метка"]...
                                   создать или поправить проект; пустое значение ("") очищает поле

Боты: default (основной), SMM, personal (личный).
Общие флаги: --json — машиночитаемый вывод; --config <путь> — другой конфиг (или PULT_CONFIG).
Без ИИ и бесплатно. Изменения видны на Пульте в течение минуты.`;

export interface CliResult { code: number; out: string }

interface Paths { projects: string; asks: string }

function loadPaths(configPath: string | undefined): Paths {
  const file = configPath ?? process.env.PULT_CONFIG ?? resolve(ROOT, 'config/pult.config.json');
  let cfg: { registry?: { projects?: unknown; asks?: unknown } };
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RegistryError(`не прочитать конфиг ${file}: ${(e as Error).message}`);
  }
  const { projects, asks } = cfg.registry ?? {};
  if (typeof projects !== 'string' || typeof asks !== 'string') throw new RegistryError(`${file}: нет registry.projects или registry.asks`);
  return { projects: expandHome(projects), asks: expandHome(asks) };
}

/** Разбор аргументов: позиционные + --флаг значение; повторяемые флаги собираются в массив. */
export function parseArgs(argv: string[]): { pos: string[]; flags: Map<string, string[]> } {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    let name: string; let value: string;
    if (eq > 0) { name = a.slice(2, eq); value = a.slice(eq + 1); }
    else {
      name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) value = 'true';
      else { value = next; i++; }
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { pos, flags };
}

const one = (f: Map<string, string[]>, k: string): string | undefined => f.get(k)?.at(-1);
const BOOL_FLAGS = new Set(['json', 'all', 'help']);

function checkFlags(flags: Map<string, string[]>, allowed: string[]): void {
  for (const k of flags.keys()) {
    if (!allowed.includes(k) && k !== 'config') throw new RegistryError(`неизвестный флаг --${k} (см. pult --help)`);
    if (BOOL_FLAGS.has(k)) continue;
    if (flags.get(k)!.includes('true') && !['json', 'all'].includes(k)) throw new RegistryError(`флагу --${k} нужно значение`);
  }
}

const fmtMsk = (iso: string): string => new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
}).format(new Date(iso)).replace(',', '');

function newAskId(file: AsksFile, now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  const taken = new Set(file.asks.map(a => a.id));
  for (let n = 1; ; n++) {
    const id = `a${day}-${n}`;
    if (!taken.has(id)) return id;
  }
}

function askLine(a: RegistryAsk): string {
  const tail = [a.project, `бот ${a.bot}`, `с ${fmtMsk(a.since)}`].filter(Boolean).join(' · ');
  const closed = a.closedAt ? ` · закрыт ${fmtMsk(a.closedAt)}${a.closedNote ? ` — ${a.closedNote}` : ''}` : '';
  return `${a.id}  ${a.text}\n    ${tail}${a.blocks ? ` · без ответа стоит: ${a.blocks}` : ''}${closed}`;
}

const emptyToNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());

export function run(argv: string[], now = new Date()): CliResult {
  const { pos, flags } = parseArgs(argv);
  const json = flags.has('json');
  if (flags.has('help') || pos.length === 0 || pos[0] === 'help') return { code: 0, out: HELP };
  const paths = loadPaths(one(flags, 'config'));
  const [area, cmd, arg] = pos;

  if (area === 'ask') {
    if (cmd === 'add') {
      checkFlags(flags, ['bot', 'text', 'project', 'blocks', 'since', 'json']);
      const bot = one(flags, 'bot'); const text = one(flags, 'text');
      if (!bot || !text?.trim()) throw new RegistryError('нужны --bot и --text');
      const sinceArg = one(flags, 'since');
      const since = sinceArg === undefined ? now : new Date(sinceArg);
      if (Number.isNaN(since.getTime()) || since > now) throw new RegistryError('--since — дата ISO не позже текущего момента, например 2026-10-28T22:00:00Z');
      const ask = withLock(paths.asks, () => {
        const file = readAsks(paths.asks);
        const a: RegistryAsk = {
          id: newAskId(file, since), project: emptyToNull(one(flags, 'project') ?? ''), bot, text: text.trim(),
          blocks: emptyToNull(one(flags, 'blocks') ?? ''), since: since.toISOString(), closedAt: null, closedNote: null,
        };
        file.asks.push(a);
        writeJsonAtomic(paths.asks, parseAsks(file, paths.asks));
        return a;
      });
      return { code: 0, out: json ? JSON.stringify(ask) : `Записал вопрос ${ask.id}. Закрыть, когда Михаил ответит: pult ask close ${ask.id}` };
    }
    if (cmd === 'close') {
      checkFlags(flags, ['note', 'json']);
      if (!arg) throw new RegistryError('укажи id вопроса: pult ask close <id>');
      const ask = withLock(paths.asks, () => {
        const file = readAsks(paths.asks);
        const a = file.asks.find(x => x.id === arg);
        if (!a) throw new RegistryError(`вопроса ${arg} нет (pult ask list --all)`);
        if (a.closedAt) return a;
        a.closedAt = now.toISOString();
        a.closedNote = emptyToNull(one(flags, 'note') ?? '');
        writeJsonAtomic(paths.asks, file);
        return a;
      });
      return { code: 0, out: json ? JSON.stringify(ask) : `Вопрос ${ask.id} закрыт.` };
    }
    if (cmd === 'list') {
      checkFlags(flags, ['all', 'json']);
      const file = readAsks(paths.asks);
      const list = flags.has('all') ? file.asks : openAsks(file);
      if (json) return { code: 0, out: JSON.stringify(list) };
      return { code: 0, out: list.length ? list.map(askLine).join('\n') : 'Открытых вопросов нет.' };
    }
  }

  if (area === 'project') {
    if (cmd === 'list') {
      checkFlags(flags, ['json']);
      const ps = [...readProjects(paths.projects).projects].sort((a, b) => a.order - b.order);
      if (json) return { code: 0, out: JSON.stringify(ps) };
      return { code: 0, out: ps.length ? ps.map(p => `${p.id}  ${p.name} · ${p.statusText}${p.stage ? ` · ${p.stage}` : ''}`).join('\n') : 'Проектов нет.' };
    }
    if (cmd === 'show') {
      checkFlags(flags, ['json']);
      const p = readProjects(paths.projects).projects.find(x => x.id === arg);
      if (!p) throw new RegistryError(`проекта ${arg ?? '(не указан)'} нет (pult project list)`);
      return { code: 0, out: JSON.stringify(p, null, json ? 0 : 2) };
    }
    if (cmd === 'set') {
      checkFlags(flags, ['name', 'owner', 'status', 'status-text', 'stage', 'next', 'repo', 'order', 'fact', 'drop-fact', 'by', 'json']);
      if (!arg || !/^[a-z0-9][a-z0-9-]*$/.test(arg)) throw new RegistryError('id проекта — латиница, цифры, дефис: pult project set zapcita …');
      const status = one(flags, 'status');
      if (status && !(PROJECT_STATUSES as readonly string[]).includes(status)) throw new RegistryError(`--status: одно из ${PROJECT_STATUSES.join(', ')}`);
      const order = one(flags, 'order');
      if (order !== undefined && !/^-?\d+$/.test(order)) throw new RegistryError('--order — целое число');
      const project = withLock(paths.projects, () => {
        const file: ProjectsFile = readProjects(paths.projects);
        let p = file.projects.find(x => x.id === arg);
        if (!p) {
          const name = one(flags, 'name');
          if (!name) throw new RegistryError(`проекта ${arg} нет; чтобы создать, укажи хотя бы --name`);
          p = { id: arg, name, owner: '', status: 'unknown', statusText: '', stage: null, next: null, repo: null, facts: [],
            order: Math.max(0, ...file.projects.map(x => x.order)) + 10, updatedAt: null, updatedBy: null } satisfies RegistryProject;
          file.projects.push(p);
        }
        const set = (flag: string, apply: (v: string) => void) => { const v = one(flags, flag); if (v !== undefined) apply(v); };
        set('name', v => { if (v.trim()) p.name = v.trim(); });
        set('owner', v => { p.owner = v.trim(); });
        set('status', v => { p.status = v as RegistryProject['status']; });
        set('status-text', v => { p.statusText = v.trim(); });
        set('stage', v => { p.stage = emptyToNull(v); });
        set('next', v => { p.next = emptyToNull(v); });
        set('repo', v => { p.repo = emptyToNull(v); });
        set('order', v => { p.order = Number(v); });
        for (const label of flags.get('drop-fact') ?? []) p.facts = p.facts.filter(f => f.label !== label);
        for (const f of flags.get('fact') ?? []) {
          const eq = f.indexOf('=');
          if (eq <= 0) throw new RegistryError(`--fact "${f}": нужен вид "Метка=значение"`);
          const label = f.slice(0, eq).trim(); const value = f.slice(eq + 1).trim();
          const old = p.facts.find(x => x.label === label);
          if (old) old.value = value; else p.facts.push({ label, value });
        }
        if (!p.statusText) p.statusText = { ok: 'работает', warn: 'есть вопросы', pause: 'пауза', unknown: 'нет данных' }[p.status];
        p.updatedAt = now.toISOString();
        p.updatedBy = one(flags, 'by') ?? process.env.MSB_BOT_ID ?? process.env.IIA_BOT_ID ?? null;
        writeJsonAtomic(paths.projects, parseProjects(file, paths.projects));
        return p;
      });
      return { code: 0, out: json ? JSON.stringify(project) : `Проект ${project.id} обновлён.` };
    }
  }

  throw new RegistryError(`не понял команду «${pos.join(' ')}» (pult --help)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = run(process.argv.slice(2));
    process.stdout.write(r.out + '\n');
    process.exitCode = r.code;
  } catch (e) {
    process.stderr.write(`Ошибка: ${e instanceof RegistryError ? e.message : (e as Error).stack}\n`);
    process.exitCode = e instanceof RegistryError ? 2 : 1;
  }
}
