// Сборщик Пульта: точка входа. run — цикл «собрать → отправить» раз в intervalSec, once — один снимок в stdout,
// check — проверка конфига, источников и переменных окружения. Ключ приёма (PULT_INGEST_TOKEN) никогда не печатается.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from '../shared/types.ts';
import { ConfigError, configPath, loadConfig, type PultConfig } from '../shared/config.ts';
import { readAsks, readProjects } from '../shared/registry.ts';
import { clip, fmtMb, fmtNumber, plural } from '../shared/format.ts';
import { Collector } from './collect.ts';
import { execCmd, firstLine, readJsonFile, scrub } from './util.ts';
import { readServer } from './sources/system.ts';
import { journalRuns, showUnits, unitHealth } from './sources/systemd.ts';
import { readBotData } from './sources/journal.ts';
import { apifyBalance, DeepgramBalance, proxyapiBalance } from './sources/balances.ts';
import { Problems } from './util.ts';
import { IngestWatch } from './watch.ts';
import { sendTg, tgFromEnv } from '../shared/tg.ts';

const HELP = `Сборщик Пульта: раз в intervalSec собирает снимок сервера ботов (боты, фоновые задачи, службы,
проекты, ресурсы) и отправляет его веб-сервису Пульта.

Запуск: node --disable-warning=ExperimentalWarning src/collector/main.ts <команда> [флаги]

Команды:
  run              цикл: собрать снимок → POST $PULT_URL/api/ingest; одна строка журнала на тик;
                   неудачная отправка повторяется на следующем тике свежим снимком; SIGTERM — штатный выход
  once [--pretty]  собрать один снимок и напечатать JSON (ничего не отправляет)
  check [--json]   проверить конфиг, доступ к каждому источнику и переменные окружения
  --help           эта справка

Окружение:
  PULT_URL            адрес веб-сервиса, по умолчанию http://127.0.0.1:8791
  PULT_INGEST_TOKEN   ключ приёма снимков — обязателен для run (не печатается)
  PULT_CONFIG         путь к конфигу, по умолчанию config/pult.config.json в корне проекта
  DEEPGRAM_API_KEY    для остатка Deepgram; нет ключа — остаток «нет данных», сбор не падает
  PULT_TG_TOKEN, PULT_TG_CHAT_ID (или OWNER_USER_ID), PULT_PUBLIC_URL
                      сторож: веб-сервис не принимает снимки 10 мин — тревога в Telegram от сборщика

Коды выхода: 0 — успех, 1 — проверка не прошла, 2 — ошибка запуска (конфиг, переменные, команда).`;

const DEFAULT_URL = 'http://127.0.0.1:8791';
const SEND_TIMEOUT_MS = 15_000;

function ingestUrl(env: NodeJS.ProcessEnv): string {
  const base = (env.PULT_URL || DEFAULT_URL).replace(/\/+$/, '');
  new URL(base); // неверный адрес — исключение с понятным текстом выше
  return `${base}/api/ingest`;
}

function die(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function load(): PultConfig {
  try {
    return loadConfig();
  } catch (e) {
    die(e instanceof ConfigError ? e.message : `Конфиг не загружен: ${(e as Error).message}`);
  }
}

/** Отправить снимок. null — принят; иначе причина по-русски одной строкой (без ключа). */
export async function sendSnapshot(url: string, token: string, snapshot: Snapshot, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const hide = (s: string) => (token ? s.split(token).join('***') : s);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) {
      await res.body?.cancel();
      return null;
    }
    const body = await res.text().catch(() => '');
    return `ответ HTTP ${res.status}${body.trim() ? `: ${clip(hide(body), 120)}` : ''}`;
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `нет ответа за ${SEND_TIMEOUT_MS / 1000} с`;
    if (err.cause?.code) return `нет связи (${err.cause.code})`;
    return hide(firstLine(err.message)) || 'неизвестная ошибка';
  }
}

/** Строка журнала на тик: «сбор 820 мс, отправлено» + ошибки источников одной строкой. */
export function tickLine(snapshot: Snapshot, sendError: string | null): string {
  let line = `сбор ${snapshot.collectMs} мс, ${sendError === null ? 'отправлено' : `не отправлено: ${sendError}`}`;
  if (snapshot.sourceErrors.length) line += ` · не прочитано: ${snapshot.sourceErrors.map(e => `${e.source} (${e.message})`).join('; ')}`;
  return line;
}

async function run(env: NodeJS.ProcessEnv): Promise<void> {
  const cfg = load();
  const token = env.PULT_INGEST_TOKEN ?? '';
  if (!token) die('PULT_INGEST_TOKEN не задан: без ключа веб-сервис не примет снимок. Задай его в окружении службы (см. README).');
  // Ключ уходит в HTTP-заголовок: там допустимы только печатные символы ASCII, иначе каждая отправка молча падает.
  if (!/^[\x21-\x7e]+$/.test(token)) die('PULT_INGEST_TOKEN задан неверно: допустимы только латиница, цифры и знаки ASCII без пробелов (deploy/secrets.sh создаёт такой сам).');
  let url: string;
  try {
    url = ingestUrl(env);
  } catch {
    die(`PULT_URL задан неверно: «${env.PULT_URL}» — нужен адрес вида http://127.0.0.1:8791`);
  }
  // тик не ждёт Deepgram дольше 1,5 с: ответ дойдёт в следующий снимок
  const collector = new Collector(cfg, { env, slowSourceWaitMs: 1500 });
  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`получен ${sig}: дозавершаю тик и выхожу`);
    wake?.();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  console.log(`сборщик запущен: каждые ${cfg.intervalSec} с → ${url}`);
  const tg = tgFromEnv(env);
  if (!tg) console.log('сторож: бот уведомлений не задан — о недоступности веб-сервиса сообщить не смогу');
  const watch = new IngestWatch({ publicUrl: env.PULT_PUBLIC_URL || undefined });

  while (!stopping) {
    const started = Date.now();
    try {
      const snapshot = await collector.collect();
      const sendError = await sendSnapshot(url, token, snapshot);
      console.log(tickLine(snapshot, sendError));
      const msg = watch.update(sendError, Date.now());
      if (msg && tg) {
        const err = await sendTg(tg, msg.text);
        console.log(err === null ? `сторож: ${msg.kind === 'alert' ? 'тревога' : 'восстановление'} отправлено в Telegram` : `сторож: не отправил в Telegram — ${err}`);
        if (err !== null && msg.kind === 'alert') watch.retry();
      }
    } catch (e) {
      console.log(`сбор не удался: ${scrub(firstLine((e as Error).message ?? String(e)))}`);
    }
    if (stopping) break;
    const wait = Math.max(1000, cfg.intervalSec * 1000 - (Date.now() - started));
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, wait);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    wake = null;
  }
  console.log('сборщик остановлен');
}

async function once(pretty: boolean, env: NodeJS.ProcessEnv): Promise<void> {
  const snapshot = await new Collector(load(), { env }).collect();
  process.stdout.write(JSON.stringify(snapshot, null, pretty ? 2 : undefined) + '\n');
}

// ---- check ----

interface CheckLine { ok: boolean; name: string; detail: string }

async function check(asJson: boolean, env: NodeJS.ProcessEnv): Promise<number> {
  const lines: CheckLine[] = [];
  const add = (ok: boolean, name: string, detail: string) => lines.push({ ok, name, detail: scrub(detail) });
  const attempt = async (name: string, fn: () => Promise<string> | string) => {
    try {
      add(true, name, await fn());
    } catch (e) {
      add(false, name, firstLine((e as Error).message ?? String(e)));
    }
  };

  let cfg: PultConfig | null = null;
  try {
    cfg = loadConfig();
    add(true, 'конфиг', `${configPath(env)}: ботов ${cfg.bots.length}, служб ${cfg.services.length}, таймеров ${cfg.timers.length}`);
  } catch (e) {
    add(false, 'конфиг', e instanceof ConfigError ? e.message.replace(/\n\s*-\s*/g, '; ') : (e as Error).message);
  }
  await attempt('PULT_URL', () => {
    try {
      return `${ingestUrl(env)}${env.PULT_URL ? '' : ' (по умолчанию)'}`;
    } catch {
      throw new Error(`задан неверно: «${env.PULT_URL}»`);
    }
  });
  if (env.PULT_INGEST_TOKEN && !/^[\x21-\x7e]+$/.test(env.PULT_INGEST_TOKEN)) add(false, 'PULT_INGEST_TOKEN', 'задан неверно: только латиница, цифры и знаки ASCII');
  else if (env.PULT_INGEST_TOKEN) add(true, 'PULT_INGEST_TOKEN', 'задан');
  else add(false, 'PULT_INGEST_TOKEN', 'не задан — run не сможет отправлять снимки');

  if (cfg) {
    const c = cfg;
    await attempt('сервер', async () => {
      const r = await readServer({ procRoot: '/proc', diskPath: '/', firstSampleMs: 200 }, null);
      return `ядер ${r.state.cores}, память ${fmtMb(r.state.memTotalMb)}, диск ${fmtNumber(r.state.diskTotalGb, 1)} ГБ`;
    });

    const units = await (async () => {
      try {
        const u = await showUnits(execCmd, [...c.bots.map(b => b.unit), ...c.services.map(s => s.unit), ...c.platformUnits, ...c.timers.flatMap(t => [t.timer, t.service])]);
        const missing = c.services.filter(s => !unitHealth(u.get(s.unit), '/sys/fs/cgroup', Date.now()).loaded).map(s => `«${s.name}»${s.optional ? ' (необязательная)' : ''}`);
        add(true, 'systemd', `юнитов ${u.size}${missing.length ? `; не установлены: ${missing.join(', ')}` : ''}`);
        return u;
      } catch (e) {
        add(false, 'systemd', (e as Error).message);
        return null;
      }
    })();

    for (const b of c.bots) {
      await attempt(`бот «${b.name}»`, () => {
        const dir = join(c.botsRoot, b.id);
        if (!statSync(dir).isDirectory()) throw new Error('нет каталога бота');
        const problems = new Problems();
        const data = readBotData(dir, Date.now(), problems, b.name);
        if (problems.list.length) throw new Error(problems.list.map(p => `${p.source}: ${p.message}`).join('; '));
        const h = units ? unitHealth(units.get(b.unit), '/sys/fs/cgroup', Date.now()) : null;
        if (h?.controlGroup) readFileSync(join('/sys/fs/cgroup', h.controlGroup, 'cgroup.procs'), 'utf8');
        const n = data.actions.length;
        return `журналы читаются, задач ${n}${h ? `, служба: ${h.state}` : ''}`;
      });
    }

    await attempt('журнал таймеров', async () => {
      const runs = await Promise.all(c.timers.map(t => journalRuns(execCmd, t.service)));
      return runs.some(r => r.length) ? 'ходы таймеров читаются из журнала' : 'журнал systemd недоступен пользователю — у таймеров будет только последний ход (это штатно)';
    });
    for (const t of c.timers.filter(t => t.statusFile)) {
      await attempt(`таймер «${t.name}»`, () => {
        if (readJsonFile(t.statusFile!) === null) throw new Error('нет файла состояния');
        return 'файл состояния читается';
      });
    }
    for (const r of c.taskRules.filter(r => r.pulseFile)) {
      await attempt(`пульс «${r.match}»`, () => {
        if (readJsonFile(r.pulseFile!) === null) throw new Error('нет файла пульса');
        return 'читается';
      });
    }
    await attempt('git', async () => {
      const r = await execCmd('git', ['--version']);
      if (r.code !== 0) throw new Error(r.error ?? 'git не запускается');
      return r.stdout.trim();
    });
    await attempt('реестр проектов', () => {
      const n = readProjects(c.registry.projects).projects.length;
      return n ? `проектов ${n}` : 'пусто (файла может ещё не быть)';
    });
    await attempt('реестр вопросов', () => {
      const n = readAsks(c.registry.asks).asks.filter(a => !a.closedAt).length;
      return `открытых вопросов ${n}`;
    });

    const nowMs = Date.now();
    if (c.balances.proxyapi) {
      const b = proxyapiBalance(c.balances.proxyapi.file, c.balances.proxyapi.lowRub, nowMs);
      add(b.value !== 'нет данных', 'остаток ProxyAPI', b.value === 'нет данных' ? b.note ?? 'нет данных' : `${b.value}${b.stale ? ' (устарел)' : ''}`);
    }
    if (c.balances.apify) {
      const b = apifyBalance(c.balances.apify.file, nowMs);
      add(b.value !== 'нет данных', 'остаток Apify', b.value === 'нет данных' ? b.note ?? 'нет данных' : b.value);
    }
    if (c.balances.deepgram) {
      if (!env.DEEPGRAM_API_KEY) add(true, 'остаток Deepgram', 'ключа DEEPGRAM_API_KEY нет — остаток будет «нет данных» (сбор не падает)');
      else {
        const b = await new DeepgramBalance(c.balances.deepgram, execCmd).get(nowMs, env);
        add(b.value !== 'нет данных', 'остаток Deepgram', b.value === 'нет данных' ? b.note ?? 'нет данных' : b.value);
      }
    }
  }

  const failed = lines.filter(l => !l.ok).length;
  if (asJson) process.stdout.write(JSON.stringify({ ok: failed === 0, checks: lines }, null, 2) + '\n');
  else {
    for (const l of lines) console.log(`${l.ok ? '✓' : '✗'} ${l.name}: ${l.detail}`);
    console.log(failed ? `\nне прошло ${failed} ${plural(failed, 'проверка', 'проверки', 'проверок')}` : '\nвсё в порядке');
  }
  return failed ? 1 : 0;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || flags.has('--help')) {
    console.log(HELP);
    return;
  }
  const env = process.env;
  if (cmd === 'run') return run(env);
  if (cmd === 'once') return once(flags.has('--pretty'), env);
  if (cmd === 'check') {
    process.exitCode = await check(flags.has('--json'), env);
    return;
  }
  die(`Неизвестная команда «${cmd}».\n\n${HELP}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(e => die(`Сборщик упал: ${scrub(firstLine((e as Error)?.message ?? String(e)))}`, 2));
}
