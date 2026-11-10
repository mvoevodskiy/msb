#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// GitFlic: конвейеры проекта и отчёты задач без захода на сервер. Бесплатно. Токен — GITFLIC_TOKEN
// (пользователь-агент с правами PROJECT_READ и PROJECT_WRITE; без второго запуск конвейера — 403). Первый клиент —
// «Задачи с созвонов»: служебные задачи там запускаются переменной OPS, отчёт — артефакт *-report.txt
// (агент shell отдаёт артефакты архивом artifact.tar.gz, ранние версии — zip).

import { gunzipSync, inflateRawSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { asUsageError, type Deps, main, requireEnv, ToolError, UsageError } from './lib.ts';

const HELP = `GitFlic: конвейеры и отчёты задач. Бесплатно.

  gitflic.ts pipelines ВЛАДЕЛЕЦ/ПРОЕКТ [--limit 5]         последние конвейеры и их задачи
  gitflic.ts report ВЛАДЕЛЕЦ/ПРОЕКТ [НОМЕР] [--job deploy]  отчёт задачи (по умолчанию — последний конвейер)
  gitflic.ts wait ВЛАДЕЛЕЦ/ПРОЕКТ --commit SHA [--timeout 900]
                                                          дождаться конвейера коммита, показать отчёт выкладки
  gitflic.ts ops ВЛАДЕЛЕЦ/ПРОЕКТ КОМАНДА [--ref main] [--timeout 600]
                                                          служебная задача (OPS=КОМАНДА) и её отчёт
  --json                                                  машиночитаемый вывод

Код выхода: 0 — конвейер успешен, 1 — упал или ошибка, 2 — неверный вызов.
Окружение: GITFLIC_TOKEN; GITFLIC_API (по умолчанию https://api.gitflic.ru).`;

export interface GitflicDeps extends Deps {
  sleep?: (ms: number) => Promise<void>;
}

interface Pipeline {
  id: string;
  localId: number;
  status: string;
  commitId: string;
  ref: string;
  createdAt: string;
}

interface Job {
  localId: number;
  name: string;
  status: string;
}

/** Статусы, после которых конвейер или задача уже не изменятся. */
const FINAL = new Set(['SUCCESS', 'FAILED', 'CANCELED', 'CANCELLED', 'SKIPPED', 'MANUAL', 'ERROR']);
const OK = new Set(['SUCCESS', 'SKIPPED', 'MANUAL']);

class Api {
  readonly #base: string;
  readonly #token: string;
  readonly #deps: GitflicDeps;

  constructor(deps: GitflicDeps) {
    this.#token = requireEnv(deps.env, 'GITFLIC_TOKEN');
    this.#base = (deps.env.GITFLIC_API?.trim() || 'https://api.gitflic.ru').replace(/\/+$/, '');
    this.#deps = deps;
  }

  async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    // downloadUrl в ответах GitFlic бывает без схемы: «api.gitflic.ru/project/…».
    const url = /^https?:\/\//.test(path) ? path : path.startsWith('/') ? `${this.#base}${path}` : `https://${path}`;
    const doFetch = this.#deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: init.method ?? 'GET',
        headers: { Authorization: `token ${this.#token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.#deps.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new ToolError(`GitFlic: сеть недоступна (${(error as Error).message})`);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      const why = res.status === 403 ? ' — у токена нет прав на проект (нужны PROJECT_READ, для ops — и PROJECT_WRITE)' : '';
      throw new ToolError(`GitFlic: HTTP ${res.status} ${new URL(url).pathname}${why} ${text}`.trim());
    }
    return res;
  }

  async json(path: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
    const res = await this.request(path, init);
    const text = await res.text();
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new ToolError(`GitFlic: ответ не JSON: ${text.slice(0, 200)}`);
    }
  }
}

function list(data: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const embedded = data._embedded as Record<string, unknown> | undefined;
  const items = embedded?.[key];
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

function project(value: string | undefined): string {
  if (!value || !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new UsageError('Нужен проект в виде ВЛАДЕЛЕЦ/ПРОЕКТ');
  return `/project/${value}`;
}

async function pipelines(api: Api, proj: string, size = 10): Promise<Pipeline[]> {
  const data = await api.json(`${proj}/cicd/pipeline?size=${size}&page=0`);
  return list(data, 'restPipelineModelList').map((p) => ({
    id: String(p.id),
    localId: Number(p.localId),
    status: String(p.status ?? '?'),
    commitId: String(p.commitId ?? ''),
    ref: String(p.ref ?? ''),
    createdAt: String(p.createdAt ?? ''),
  }));
}

async function jobs(api: Api, proj: string, localId: number): Promise<Job[]> {
  const data = await api.json(`${proj}/cicd/pipeline/${localId}/jobs`);
  return list(data, 'restPipelineJobModelList').map((j) => ({ localId: Number(j.localId), name: String(j.name), status: String(j.status ?? '?') }));
}

/** Достаёт файл из zip-архива (без зависимостей): центральный каталог → локальный заголовок → данные. */
export function unzipEntry(buf: Buffer, wanted: (name: string) => boolean): Buffer | undefined {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return undefined;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data);
    throw new ToolError(`zip: метод сжатия ${method} не поддержан`);
  }
  return undefined;
}

/** Достаёт файл из tar или tar.gz (ustar: заголовки по 512 байт, имя = prefix/name, размер — восьмеричный).
 *  Длинные имена: GNU tar кладёт их отдельной записью «L», pax — записью «x» с path=. */
export function untarEntry(buf: Buffer, wanted: (name: string) => boolean): Buffer | undefined {
  let tar = buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      tar = gunzipSync(buf);
    } catch {
      return undefined;
    }
  }
  const str = (from: number, len: number) => tar.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '');
  let longName: string | undefined;
  for (let h = 0; h + 512 <= tar.length; ) {
    const name = str(h, 100);
    if (!name) return undefined; // нулевой блок — конец архива
    const size = parseInt(str(h + 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size)) return undefined;
    const type = String.fromCharCode(tar[h + 156] || 0x30); // «\0» у старых tar — тоже обычный файл
    const data = tar.subarray(h + 512, h + 512 + size);
    const prefix = str(h + 257, 6).startsWith('ustar') ? str(h + 345, 155) : '';
    h += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '');
    } else if (type === 'x') {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? longName;
    } else {
      const full = longName ?? (prefix ? `${prefix}/${name}` : name);
      longName = undefined;
      if (type === '0' && wanted(full)) return data;
    }
  }
  return undefined;
}

/** Текст отчёта задачи: артефакт *report.txt (сам файл, tar.gz или zip с ним). */
async function jobReport(api: Api, proj: string, job: Job): Promise<string | undefined> {
  const data = await api.json(`${proj}/cicd/job/${job.localId}/artifacts`);
  const artifacts = list(data, 'restPipelineJobArtifactModelList');
  for (const a of artifacts) {
    if (a.fileType === 'trace' || (a.fileType === 'metadata' && !String(a.fileName).endsWith('.txt'))) continue;
    const url = String(a.downloadUrl ?? `${proj}/cicd/job/${job.localId}/artifact/${a.id}/download`);
    const buf = Buffer.from(await (await api.request(url)).arrayBuffer());
    const isReport = (n: string) => n.endsWith('report.txt');
    if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      const entry = unzipEntry(buf, isReport);
      if (entry) return entry.toString('utf8');
    } else if ((buf[0] === 0x1f && buf[1] === 0x8b) || /\.tar(\.gz)?$|\.tgz$/.test(String(a.fileName))) {
      const entry = untarEntry(buf, isReport);
      if (entry) return entry.toString('utf8');
    } else if (String(a.fileName).endsWith('report.txt')) {
      return buf.toString('utf8');
    }
  }
  return undefined;
}

async function waitFinal(api: Api, proj: string, find: (p: Pipeline[]) => Pipeline | undefined, deps: GitflicDeps, timeoutSec: number): Promise<Pipeline> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const p = find(await pipelines(api, proj, 20));
    if (p && FINAL.has(p.status)) return p;
    if (Date.now() >= deadline) throw new ToolError(`Конвейер не завершился за ${timeoutSec} с${p ? ` (статус ${p.status})` : ' (ещё не создан)'}`);
    await sleep(5000);
  }
}

async function describe(api: Api, proj: string, p: Pipeline, jobName?: string): Promise<{ text: string; ok: boolean; json: unknown }> {
  const js = await jobs(api, proj, p.localId);
  const lines = [`Конвейер #${p.localId} (${p.ref}, ${p.commitId.slice(0, 12)}): ${p.status}`, ...js.map((j) => `  ${j.name}: ${j.status}`)];
  const reported = js.filter((j) => (jobName ? j.name === jobName : j.name === 'deploy' || j.name === 'ops') && FINAL.has(j.status));
  const reports: Record<string, string> = {};
  for (const j of reported) {
    const r = await jobReport(api, proj, j);
    if (r) {
      reports[j.name] = r;
      lines.push(`\n— отчёт ${j.name} —\n${r.trimEnd()}`);
    }
  }
  return { text: lines.join('\n'), ok: OK.has(p.status), json: { pipeline: p, jobs: js, reports } };
}

export async function run(argv: string[], deps: GitflicDeps): Promise<string> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        limit: { type: 'string' },
        job: { type: 'string' },
        commit: { type: 'string' },
        ref: { type: 'string' },
        timeout: { type: 'string' },
      },
    });
  } catch (error) {
    asUsageError(error);
  }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) return HELP;
  const [command, projArg, extra] = positionals;
  const proj = project(projArg);
  const api = new Api(deps);
  const timeout = Number(values.timeout ?? (command === 'wait' ? 900 : 600));
  const out = (r: { text: string; ok: boolean; json: unknown }) => {
    if (!r.ok) process.exitCode = 1;
    return values.json ? JSON.stringify(r.json) : r.text;
  };

  switch (command) {
    case 'pipelines': {
      const ps = await pipelines(api, proj, Number(values.limit ?? 5));
      if (values.json) return JSON.stringify(ps);
      return ps.map((p) => `#${p.localId} ${p.status} ${p.ref} ${p.commitId.slice(0, 12)} ${p.createdAt}`).join('\n') || 'Конвейеров нет';
    }
    case 'report': {
      const ps = await pipelines(api, proj, 20);
      const p = extra ? ps.find((x) => x.localId === Number(extra)) : ps[0];
      if (!p) throw new ToolError(extra ? `Конвейера #${extra} нет среди последних 20` : 'Конвейеров нет');
      return out(await describe(api, proj, p, values.job));
    }
    case 'wait': {
      const sha = values.commit;
      if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) throw new UsageError('wait: нужен --commit SHA');
      const p = await waitFinal(api, proj, (ps) => ps.find((x) => x.commitId.startsWith(sha)), deps, timeout);
      return out(await describe(api, proj, p));
    }
    case 'ops': {
      if (!extra || !/^(check|probe|status|reset-owner|rollback|logs(:\d{1,4})?|replay:[0-9A-Za-z:.+-]{2,32})$/.test(extra)) {
        throw new UsageError('ops: check | probe | status | reset-owner | logs[:N] | rollback | replay:6h');
      }
      const started = await api.json(`${proj}/cicd/pipeline/start`, {
        method: 'POST',
        body: { refName: values.ref ?? 'main', isTag: false, variables: [{ key: 'OPS', value: extra }] },
      });
      const uuid = String(started.pipeline_uuid ?? started.id ?? '');
      if (!uuid) throw new ToolError(`GitFlic: конвейер не запущен: ${JSON.stringify(started).slice(0, 200)}`);
      const p = await waitFinal(api, proj, (ps) => ps.find((x) => x.id === uuid), deps, timeout);
      return out(await describe(api, proj, p, 'ops'));
    }
    default:
      throw new UsageError(`Неизвестная команда «${command}»`);
  }
}

main(import.meta.url, run);
