import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { sendSnapshot, tickLine } from '../../src/collector/main.ts';
import type { Snapshot } from '../../src/shared/types.ts';
import { FIX } from './helpers.ts';

const MAIN = join(import.meta.dirname, '../../src/collector/main.ts');
const TOKEN = 'test-token-0123456789abcdef';
const snap = { collectMs: 820, sourceErrors: [] } as unknown as Snapshot;

test('отправка: принят — null; отказ — код и тело без ключа; нет связи; таймаут', async () => {
  let seen: RequestInit | undefined;
  const okFetch = (async (_url: string, init: RequestInit) => {
    seen = init;
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await sendSnapshot('http://x/api/ingest', TOKEN, snap, okFetch), null);
  assert.equal((seen?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.equal((seen?.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal(seen?.method, 'POST');

  const denied = (async () => new Response(`неверный ключ ${TOKEN}`, { status: 401 })) as unknown as typeof fetch;
  assert.equal(await sendSnapshot('http://x/api/ingest', TOKEN, snap, denied), 'ответ HTTP 401: неверный ключ ***');

  const refused = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  }) as unknown as typeof fetch;
  assert.equal(await sendSnapshot('http://x/api/ingest', TOKEN, snap, refused), 'нет связи (ECONNREFUSED)');

  const slow = (async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  }) as unknown as typeof fetch;
  assert.equal(await sendSnapshot('http://x/api/ingest', TOKEN, snap, slow), 'нет ответа за 15 с');
});

test('строка журнала на тик', () => {
  assert.equal(tickLine(snap, null), 'сбор 820 мс, отправлено');
  assert.equal(tickLine({ ...snap, collectMs: 790 } as Snapshot, 'нет связи (ECONNREFUSED)'), 'сбор 790 мс, не отправлено: нет связи (ECONNREFUSED)');
  const withErrors = { ...snap, sourceErrors: [{ source: 'Deepgram', message: 'нет ключа' }, { source: 'git «demo»', message: 'не репозиторий' }] } as Snapshot;
  assert.equal(tickLine(withErrors, null), 'сбор 820 мс, отправлено · не прочитано: Deepgram (нет ключа); git «demo» (не репозиторий)');
});

// ---- запуск как команды ----

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('PULT_') || k === 'DEEPGRAM_API_KEY') delete env[k];
  return { ...env, ...extra };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, ...args], { env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => (stdout += d));
    p.stderr.on('data', d => (stderr += d));
    p.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function tempConfig(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pult-cli-'));
  // Только alpha: иначе discoverExtraBots подхватит beta/gamma из общей фикстуры (у gamma битый actions.json — для других тестов).
  const botsRoot = join(dir, 'bots');
  mkdirSync(botsRoot);
  symlinkSync(join(FIX, 'home/.msb/bots/alpha'), join(botsRoot, 'alpha'));
  const path = join(dir, 'pult.config.json');
  writeFileSync(path, JSON.stringify({
    host: 'Тестовый сервер', timezone: 'Europe/Moscow', intervalSec: 5,
    botsRoot,
    bots: [{ id: 'alpha', name: 'Альфа', unit: 'pult-test-nonexistent-alpha.service', projects: [] }],
    services: [{ id: 'web', name: 'Сайт', unit: 'pult-test-nonexistent-web.service', project: null, optional: true }],
    platformUnits: [],
    timers: [],
    taskRules: [{ match: 'Разработка', project: 'Демо' }],
    registry: { projects: join(FIX, 'registry/projects.json'), asks: join(FIX, 'registry/asks.json') },
    balances: { proxyapi: { file: join(FIX, 'proxyapi-balance.json'), lowRub: 50 } },
    thresholds: { memPct: 99, diskPct: 99, heavyServiceMemMb: 2048, heavyServiceCores: 0.5, missedRunsWarn: 3, expensiveTaskTokens24h: 5e9 },
  }));
  return { dir, path };
}

test('--help и неизвестная команда', async () => {
  const help = await runCli(['--help'], cleanEnv({}));
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Сборщик Пульта/);
  assert.match(help.stdout, /PULT_INGEST_TOKEN/);
  const bad = await runCli(['fly'], cleanEnv({}));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Неизвестная команда «fly»/);
});

test('run без ключа, с ключом не-ASCII и с битым конфигом — понятная ошибка и код 2', async () => {
  const { dir, path } = tempConfig();
  try {
    const noToken = await runCli(['run'], cleanEnv({ PULT_CONFIG: path }));
    assert.equal(noToken.code, 2);
    assert.match(noToken.stderr, /PULT_INGEST_TOKEN не задан/);
    const cyr = await runCli(['run'], cleanEnv({ PULT_CONFIG: path, PULT_INGEST_TOKEN: 'ключ-кириллицей' }));
    assert.equal(cyr.code, 2);
    assert.match(cyr.stderr, /PULT_INGEST_TOKEN задан неверно/);
    writeFileSync(join(dir, 'bad.json'), '{"host": ""}');
    const bad = await runCli(['run'], cleanEnv({ PULT_CONFIG: join(dir, 'bad.json'), PULT_INGEST_TOKEN: TOKEN }));
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /host: пустое/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check: построчно ✓/✗, ключ не печатается, --json, ненулевой код при ошибке', async () => {
  const { dir, path } = tempConfig();
  try {
    const r = await runCli(['check'], cleanEnv({ PULT_CONFIG: path }));
    assert.equal(r.code, 1, 'нет PULT_INGEST_TOKEN — проверка не прошла');
    assert.match(r.stdout, /^✓ конфиг: /m);
    assert.match(r.stdout, /^✗ PULT_INGEST_TOKEN: не задан/m);
    assert.match(r.stdout, /^✓ бот «Альфа»: журналы читаются, задач 6/m);
    assert.match(r.stdout, /^✓ остаток ProxyAPI: 334,75 ₽/m);
    const j = await runCli(['check', '--json'], cleanEnv({ PULT_CONFIG: path, PULT_INGEST_TOKEN: TOKEN }));
    assert.equal(j.code, 0, j.stdout);
    const parsed = JSON.parse(j.stdout) as { ok: boolean; checks: { ok: boolean; name: string; detail: string }[] };
    assert.equal(parsed.ok, true);
    assert.ok(parsed.checks.some(c => c.name === 'PULT_INGEST_TOKEN' && c.detail === 'задан'));
    assert.ok(!j.stdout.includes(TOKEN), 'ключ не печатается');
    const broken = await runCli(['check', '--json'], cleanEnv({ PULT_CONFIG: join(dir, 'нет.json'), PULT_INGEST_TOKEN: TOKEN }));
    assert.equal(broken.code, 1);
    assert.equal(JSON.parse(broken.stdout).checks[0].ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('once: снимок в stdout, ничего не отправляет', async () => {
  const { dir, path } = tempConfig();
  try {
    const r = await runCli(['once', '--pretty'], cleanEnv({ PULT_CONFIG: path, PULT_URL: 'http://127.0.0.1:9' }));
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(r.stdout) as Snapshot;
    assert.equal(s.host, 'Тестовый сервер');
    assert.equal(s.bots[0].name, 'Альфа');
    assert.ok(r.stdout.includes('\n  "schema"'), '--pretty — с отступами');
    assert.ok(!r.stdout.toLowerCase().includes('iia'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withIngest(status: number, fn: (url: string, got: Promise<{ req: IncomingMessage; body: string }>) => Promise<void>) {
  let resolveGot!: (v: { req: IncomingMessage; body: string }) => void;
  const got = new Promise<{ req: IncomingMessage; body: string }>(r => (resolveGot = r));
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': 'text/plain' }).end(status === 200 ? 'ok' : `отказ для ${TOKEN}`);
      resolveGot({ req, body });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const limited = Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('сборщик не прислал снимок за 10 с')), 10_000).unref())]);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, limited);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function startRun(env: NodeJS.ProcessEnv) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, 'run'], { env });
  let out = '';
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (out += d));
  const exited = new Promise<number | null>(r => p.on('close', code => r(code)));
  const waitFor = async (re: RegExp) => {
    for (let i = 0; i < 100 && !re.test(out); i++) await new Promise(r => setTimeout(r, 100));
    return out;
  };
  return { p, exited, waitFor, log: () => out };
}

test('run: POST /api/ingest с ключом, строка журнала на тик, выход по SIGTERM', async () => {
  const { dir, path } = tempConfig();
  try {
    await withIngest(200, async (url, got) => {
      const r = startRun(cleanEnv({ PULT_CONFIG: path, PULT_URL: url + '/', PULT_INGEST_TOKEN: TOKEN }));
      const { req, body } = await got;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/api/ingest');
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(req.headers['content-type'], 'application/json');
      assert.equal((JSON.parse(body) as Snapshot).host, 'Тестовый сервер');
      await r.waitFor(/отправлено/);
      r.p.kill('SIGTERM');
      assert.equal(await r.exited, 0);
      const log = r.log();
      assert.match(log, /сборщик запущен: каждые 5 с → http:\/\/127\.0\.0\.1:\d+\/api\/ingest/);
      assert.match(log, /^сбор \d+ мс, отправлено/m);
      assert.match(log, /получен SIGTERM/);
      assert.match(log, /сборщик остановлен/);
      assert.ok(!log.includes(TOKEN), 'ключ не попадает в журнал');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run: отказ веб-сервиса — «не отправлено: …» без ключа, служба продолжает работать', async () => {
  const { dir, path } = tempConfig();
  try {
    await withIngest(401, async (url, got) => {
      const r = startRun(cleanEnv({ PULT_CONFIG: path, PULT_URL: url, PULT_INGEST_TOKEN: TOKEN }));
      await got;
      const log = await r.waitFor(/не отправлено/);
      assert.match(log, /^сбор \d+ мс, не отправлено: ответ HTTP 401: отказ для \*\*\*/m);
      assert.ok(!log.includes(TOKEN));
      assert.equal(r.p.exitCode, null, 'после неудачи процесс жив и ждёт следующего тика');
      r.p.kill('SIGTERM');
      assert.equal(await r.exited, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
