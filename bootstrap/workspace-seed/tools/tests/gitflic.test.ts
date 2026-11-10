import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { run, untarEntry, unzipEntry } from '../gitflic.ts';
import { ToolError, UsageError } from '../lib.ts';

const env = { GITFLIC_TOKEN: 'gf-secret' };
const P = 'owner/example-project';

/** Минимальный zip с одним файлом (deflate) — как отдаёт архив артефактов. */
function zip(name: string, content: string): Buffer {
  const data = deflateRawSync(Buffer.from(content));
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

/** Настоящий tar.gz системной tar — как artifact.tar.gz агента shell. */
function targz(files: Record<string, string>, gzip = true): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'gf-tar-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, 'in', name)), { recursive: true });
      writeFileSync(join(dir, 'in', name), content);
    }
    const out = join(dir, 'a.tar');
    execFileSync('tar', [gzip ? '-czf' : '-cf', out, '-C', join(dir, 'in'), ...Object.keys(files)]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Мир GitFlic: конвейеры меняют статус с каждым опросом списка. */
function gitflic(opts: { statuses?: string[]; report?: Buffer | string; startFails?: number } = {}) {
  const calls: Call[] = [];
  let polls = 0;
  const statuses = opts.statuses ?? ['RUNNING', 'SUCCESS'];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', url: url.href, headers: { ...(init.headers as Record<string, string>) }, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.pathname;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === `/project/${P}/cicd/pipeline/start`) {
      return opts.startFails ? json({ message: 'forbidden' }, opts.startFails) : json({ pipeline_uuid: 'uuid-7' });
    }
    if (path === `/project/${P}/cicd/pipeline`) {
      const status = statuses[Math.min(polls++, statuses.length - 1)];
      return json({
        _embedded: {
          restPipelineModelList: [
            { id: 'uuid-7', localId: 7, status, commitId: 'abc1234def5678', ref: 'main', createdAt: '2026-10-26T10:00:00' },
            { id: 'uuid-6', localId: 6, status: 'SUCCESS', commitId: '0000111', ref: 'main', createdAt: '2026-10-26T09:00:00' },
          ],
        },
      });
    }
    if (path === `/project/${P}/cicd/pipeline/7/jobs`) {
      return json({ _embedded: { restPipelineJobModelList: [{ localId: 21, name: 'ops', status: statuses.at(-1) }] } });
    }
    if (path === `/project/${P}/cicd/job/21/artifacts`) {
      return json({
        _embedded: {
          restPipelineJobArtifactModelList: [{ id: 'art-1', fileType: 'archive', fileName: 'artifacts.zip', downloadUrl: `api.gitflic.ru/project/${P}/cicd/job/21/artifact/art-1/download` }],
        },
      });
    }
    if (path === `/project/${P}/cicd/job/21/artifact/art-1/download`) {
      const body = opts.report ?? zip("ops-report.txt", "✓ ключ принят\n");
      return new Response(typeof body === "string" ? body : new Uint8Array(body));
    }
    return new Response('not found', { status: 404 });
  };
  const sleeps: number[] = [];
  return { deps: { env, fetch: fetchImpl as typeof fetch, sleep: async (ms: number) => void sleeps.push(ms) }, calls, sleeps };
}

test('ops: запуск с переменной OPS, ожидание, отчёт из zip; токен — заголовок token', async () => {
  const g = gitflic();
  const out = await run(['ops', P, 'check'], g.deps);
  const start = g.calls.find((c) => c.method === 'POST')!;
  assert.deepEqual(start.body, { refName: 'main', isTag: false, variables: [{ key: 'OPS', value: 'check' }] });
  assert.equal(start.headers.Authorization, 'token gf-secret');
  assert.match(out, /Конвейер #7 \(main, abc1234def56\): SUCCESS/);
  assert.match(out, /— отчёт ops —\n✓ ключ принят/);
  assert.equal(g.sleeps.length, 1, 'один раз подождал, пока RUNNING');
  assert.doesNotMatch(out, /gf-secret/);
});

test('ops: отчёт обычным файлом; упавший конвейер — код 1', async () => {
  const g = gitflic({ statuses: ['FAILED'], report: 'служба лежит\n' });
  // артефакт отдан не zip-ом — имя файла должно оканчиваться на report.txt
  const out = await run(['ops', P, 'status', '--json'], {
    ...g.deps,
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const res = await g.deps.fetch(input, init);
      if (String(input).endsWith('/artifacts')) {
        return new Response(JSON.stringify({ _embedded: { restPipelineJobArtifactModelList: [{ id: 'art-1', fileName: 'ops-report.txt' }] } }));
      }
      return res;
    }) as typeof fetch,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.pipeline.status, 'FAILED');
  assert.equal(parsed.reports.ops, 'служба лежит\n');
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});

test('ops: белый список команд; не запустился — понятная ошибка; тайм-аут ожидания', async () => {
  for (const bad of ['rm', 'logs:abc', 'replay:', 'check;ls']) {
    await assert.rejects(run(['ops', P, bad], gitflic().deps), UsageError);
  }
  await assert.rejects(run(['ops', P, 'check'], gitflic({ startFails: 403 }).deps), (e: Error) => e instanceof ToolError && /403.*нет прав/.test(e.message));
  await assert.rejects(run(['ops', P, 'check', '--timeout', '0'], gitflic({ statuses: ['RUNNING'] }).deps), /не завершился за 0 с \(статус RUNNING\)/);
});

test('wait по коммиту и pipelines', async () => {
  const g = gitflic();
  assert.match(await run(['wait', P, '--commit', 'abc1234'], g.deps), /SUCCESS/);
  const list = await run(['pipelines', P], gitflic().deps);
  assert.match(list, /^#7 RUNNING main abc1234def56/m);
  assert.match(list, /^#6 SUCCESS/m);
});

test('неверный вызов и нет токена', async () => {
  await assert.rejects(run(['pipelines', 'без-слеша'], gitflic().deps), UsageError);
  await assert.rejects(run(['wait', P], gitflic().deps), UsageError);
  await assert.rejects(run(['pipelines', P], { env: {} }), /GITFLIC_TOKEN/);
  assert.match(await run([], gitflic().deps), /GitFlic: конвейеры/);
});

test('wait: отчёт выкладки из artifact.tar.gz, журнал задачи (trace) не скачивается', async () => {
  const g = gitflic({ report: targz({ 'deploy-report.txt': 'Выложено: abc1234def56\n' }) });
  const out = await run(['wait', P, '--commit', 'abc1234'], {
    ...g.deps,
    fetch: (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith('/artifacts')) {
        return new Response(
          JSON.stringify({
            _embedded: {
              restPipelineJobArtifactModelList: [
                { id: 'log-1', fileType: 'trace', fileName: 'x.log', downloadUrl: `https://api.gitflic.ru/project/${P}/cicd/job/21/artifact/log-1/download` },
                { id: 'art-1', fileType: 'archive', fileName: 'artifact.tar.gz', downloadUrl: `https://api.gitflic.ru/project/${P}/cicd/job/21/artifact/art-1/download` },
              ],
            },
          }),
        );
      }
      return g.deps.fetch(input, init);
    }) as typeof fetch,
  });
  assert.match(out, /— отчёт ops —\nВыложено: abc1234def56/);
  assert.ok(!g.calls.some((c) => c.url.includes('log-1')), 'trace не качаем');
});

test('untar: tar.gz и tar, вложенная папка, длинное имя, нет файла или мусор — undefined', () => {
  const long = `${'d'.repeat(120)}/ops-report.txt`;
  const files = { 'other.txt': 'x'.repeat(700), 'sub/deploy-report.txt': 'Выложено: abc', [long]: 'длинное' };
  for (const gzip of [true, false]) {
    const buf = targz(files, gzip);
    assert.equal(untarEntry(buf, (n) => n.endsWith('deploy-report.txt'))?.toString(), 'Выложено: abc');
    assert.equal(untarEntry(buf, (n) => n === long)?.toString(), 'длинное');
    assert.equal(untarEntry(buf, (n) => n === 'нет'), undefined);
  }
  assert.equal(untarEntry(Buffer.from([0x1f, 0x8b, 1, 2, 3]), () => true), undefined);
  assert.equal(untarEntry(Buffer.from('не tar'), () => true), undefined);
});

test('unzip: нужный файл среди нескольких, нет файла — undefined', () => {
  const buf = zip('dir/deploy-report.txt', 'Выложено: abc');
  assert.equal(unzipEntry(buf, (n) => n.endsWith('report.txt'))?.toString(), 'Выложено: abc');
  assert.equal(unzipEntry(buf, (n) => n === 'other'), undefined);
  assert.equal(unzipEntry(Buffer.from('не zip'), () => true), undefined);
});
