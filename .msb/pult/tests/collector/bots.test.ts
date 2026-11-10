import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  agentProcesses, bg24h, botNow, chat24h, cleanReply, isAgentCmdline, lastResult, pendingRequest, procStartTicks, timeline,
} from '../../src/collector/sources/bots.ts';
import { readBotData, type RunRec, type TraceRec, type TranscriptRec } from '../../src/collector/sources/journal.ts';
import { parseCron } from '../../src/shared/cron.ts';
import { Problems } from '../../src/collector/util.ts';
import { FIX, NOW } from './helpers.ts';

const BOTS = join(FIX, 'home/.msb/bots');
const BOOT = Date.parse('2026-10-29T00:00:00Z');

test('агентский процесс — сам claude, а не всё, где встречается слово', () => {
  assert.equal(isAgentCmdline('claude\0-p\0--verbose\0'), true);
  assert.equal(isAgentCmdline('/usr/local/bin/claude\0-p\0'), true);
  assert.equal(isAgentCmdline('/usr/bin/node\0/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js\0-p\0'), true);
  assert.equal(isAgentCmdline('/bin/bash\0-c\0source /home/u/.claude/shell-snapshots/x.sh\0'), false);
  assert.equal(isAgentCmdline('/usr/bin/node\0/opt/bot/index.js\0'), false);
  assert.equal(isAgentCmdline(''), false);
});

test('/proc/<pid>/stat: поле 22, имя процесса со скобками и пробелами', () => {
  assert.equal(procStartTicks('42 (claude) S 1 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 3780000 1000'), 3780000);
  assert.equal(procStartTicks('43 (my (odd) proc) S 1 43 43 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 777 1000'), 777);
  assert.equal(procStartTicks('мусор'), null);
});

test('процессы бота из cgroup: только агентские, время старта по тикам', () => {
  const procs = agentProcesses({ procRoot: join(FIX, 'proc'), cgroupRoot: join(FIX, 'cgroup'), controlGroup: '/system.slice/bot-alpha.service', bootMs: BOOT, clkTck: 100 });
  assert.deepEqual(procs.map(p => [p.pid, new Date(p.startMs).toISOString()]), [
    [102, '2026-10-29T10:30:00.000Z'],
    [104, '2026-10-29T10:35:00.000Z'],
  ]);
  assert.deepEqual(agentProcesses({ procRoot: join(FIX, 'proc'), cgroupRoot: join(FIX, 'cgroup'), controlGroup: '/system.slice/bot-beta.service', bootMs: BOOT, clkTck: 100 }), []);
  assert.throws(() => agentProcesses({ procRoot: join(FIX, 'proc'), cgroupRoot: join(FIX, 'cgroup'), controlGroup: '/нет', bootMs: BOOT, clkTck: 100 }), /ENOENT/);
});

test('чтение файлов бота: битые строки пропускаются, из state.json — только окно подписки', () => {
  const p = new Problems();
  const d = readBotData(join(BOTS, 'alpha'), NOW.getTime(), p, 'Альфа');
  assert.deepEqual(p.list, []);
  assert.equal(d.traces.length, 2, 'вчера и сегодня, битая строка пропущена');
  assert.equal(d.transcripts.length, 3);
  assert.equal(d.runs.length, 5);
  assert.equal(d.actions.length, 6);
  assert.deepEqual(Object.keys(d.rate ?? {}).sort(), ['isUsingOverage', 'lastUpdatedAt', 'rateLimitType', 'resetsAt', 'status']);
  assert.ok(!JSON.stringify(d.rate).includes('do-not-leak'));
});

test('нет actions.json — задач нет, это не ошибка; битый — ошибка источника без пути', () => {
  const p = new Problems();
  assert.deepEqual(readBotData(join(BOTS, 'beta'), NOW.getTime(), p, 'Бета').actions, []);
  assert.deepEqual(p.list, []);
  const g = readBotData(join(BOTS, 'gamma'), NOW.getTime(), p, 'Гамма');
  assert.deepEqual(g.actions, []);
  assert.deepEqual(p.list, [{ source: 'бот «Гамма»: фоновые задачи', message: 'файл повреждён (не JSON)' }]);
});

const tr = (ts: string, role: string, text = ''): TranscriptRec => ({ ts, role, text });

test('незакрытый запрос — последнее сообщение пользователя после последнего ответа', () => {
  assert.deepEqual(pendingRequest([
    tr('2026-10-29T10:00:00Z', 'user', 'старый'),
    tr('2026-10-29T10:10:00Z', 'assistant', 'ответ'),
    tr('2026-10-29T10:20:00Z', 'user', 'Проверь сервер'),
    tr('2026-10-29T10:21:00Z', 'user', 'И ещё логи\nподробно'),
  ]), { atMs: Date.parse('2026-10-29T10:21:00Z'), text: 'И ещё логи' });
  // ход оборвался без ответа (лимит), через 6 ч пришло новое сообщение — бот работает над ним
  assert.deepEqual(pendingRequest([
    tr('2026-10-29T11:05:00Z', 'assistant', 'ответ'),
    tr('2026-10-29T11:18:00Z', 'user', 'Делай'),
    tr('2026-10-29T17:15:00Z', 'user', 'Продолжи'),
  ]), { atMs: Date.parse('2026-10-29T17:15:00Z'), text: 'Продолжи' });
  assert.equal(pendingRequest([tr('2026-10-29T10:00:00Z', 'user'), tr('2026-10-29T10:10:00Z', 'assistant')]), null);
  assert.equal(pendingRequest([]), null);
});

test('итог ответа: без HTML и зелёной пометки; красная остаётся; предисловие до пометки отбрасывается', () => {
  assert.equal(cleanReply('🟢 <b>От тебя ничего не нужно</b>\n\nПонял. &lt;тест&gt;'), 'Понял. <тест>');
  assert.equal(cleanReply('🟢 От тебя ничего не нужно, пока не скажешь продолжать'), 'пока не скажешь продолжать');
  assert.equal(cleanReply('🔴 <b>Нужно от тебя:</b> скажи, зачем'), '🔴 Нужно от тебя: скажи, зачем');
  assert.equal(cleanReply('Останавливаю проверки. 🟢 От тебя ничего не нужно Фоновые тесты остановлены'), 'Фоновые тесты остановлены');
  assert.equal(cleanReply('<b>Прожарка</b> всё ок <i'), 'Прожарка всё ок');
  assert.equal(cleanReply('Смотри ~/.msb/bots/default/state.json и msb-bot@SMM.service'), 'Смотри … и …');
  assert.equal(Array.from(cleanReply('а'.repeat(300))).length, 120);
});

test('последний итог: длительность и действия из чат-журнала, полный текст из переписки', () => {
  const traces: TraceRec[] = [{ ts: '2026-10-29T08:10:00.000Z', query: 'q', toolCalls: 234, elapsedMs: 5_340_000 }];
  const diary = [
    { ts: '2026-10-29T07:00:00.000Z', kind: 'agent_reply', summary: 'раньше' },
    { ts: '2026-10-29T08:10:00.200Z', kind: 'agent_reply', summary: '🟢 От тебя ничего не нужно Отчёт гот' },
    { ts: '2026-10-29T08:10:00.300Z', kind: 'door_result', summary: 'не ответ' },
  ];
  const transcripts = [tr('2026-10-29T06:41:00Z', 'user', 'q'), tr('2026-10-29T08:10:00.100Z', 'assistant', '🟢 От тебя ничего не нужно\n\nОтчёт готов полностью.')];
  assert.deepEqual(lastResult(diary, traces, transcripts), { at: '2026-10-29T08:10:00.200Z', text: 'Отчёт готов полностью.', durationMin: 89, actions: 234 });
  // нет записи в чат-журнале — длительность по переписке, действий не знаем
  assert.deepEqual(lastResult(diary, [], transcripts), { at: '2026-10-29T08:10:00.200Z', text: 'Отчёт готов полностью.', durationMin: 89, actions: null });
  // нет ничего — текст из дневника
  assert.deepEqual(lastResult(diary, [], []), { at: '2026-10-29T08:10:00.200Z', text: 'Отчёт гот', durationMin: 0, actions: null });
  assert.equal(lastResult([], traces, transcripts), null);
  // оборванный ход оставил пустой ответ — итогом остаётся последний настоящий
  const cut = [...diary, { ts: '2026-10-29T12:17:00.000Z', kind: 'agent_reply', summary: '' }, { ts: '2026-10-29T12:18:00.000Z', kind: 'agent_reply', summary: '<b> </b>' }];
  assert.equal(lastResult(cut, [], [])?.at, '2026-10-29T08:10:00.200Z');
});

test('что бот делает сейчас', () => {
  const procs = [{ pid: 1, startMs: Date.parse('2026-10-29T11:00:20Z') }, { pid: 2, startMs: Date.parse('2026-10-29T11:05:00Z') }];
  const hourly = { name: 'Разработка', spec: parseCron('0 * * * *'), tz: 'Europe/Moscow', atMs: null };
  assert.deepEqual(botNow([], null, [hourly]), { busy: false, since: null, kind: null, text: null, helpers: 0 });
  // процесс стартовал через 20 с после срабатывания cron — это фоновый ход
  assert.deepEqual(botNow(procs, null, [hourly]), { busy: true, since: '2026-10-29T11:00:20.000Z', helpers: 1, kind: 'task', text: 'Разработка' });
  // незакрытый запрос важнее совпадения с расписанием
  assert.deepEqual(botNow(procs, { atMs: Date.parse('2026-10-29T10:55:00Z'), text: 'Проверь сервер' }, [hourly]),
    { busy: true, since: '2026-10-29T11:00:20.000Z', helpers: 1, kind: 'chat', text: 'Проверь сервер' });
  // запрос слишком старый (раньше since − 10 мин) и расписание не совпало — чат без текста
  const odd = [{ pid: 1, startMs: Date.parse('2026-10-29T11:20:00Z') }];
  assert.deepEqual(botNow(odd, { atMs: Date.parse('2026-10-29T10:00:00Z'), text: 'старое' }, [hourly]),
    { busy: true, since: '2026-10-29T11:20:00.000Z', helpers: 0, kind: 'chat', text: null });
  // разовая задача
  const once = { name: 'Напоминание', spec: null, tz: 'Europe/Moscow', atMs: Date.parse('2026-10-29T11:19:00Z') };
  assert.equal(botNow(odd, null, [hourly, once]).text, 'Напоминание');
});

test('сутки: чаты и фон', () => {
  const traces: TraceRec[] = [
    { ts: '2026-10-28T10:00:00Z', elapsedMs: 600_000 },
    { ts: '2026-10-28T20:00:00Z', elapsedMs: 600_000 },
    { ts: '2026-10-29T08:10:00Z', elapsedMs: 5_340_000 },
  ];
  assert.deepEqual(chat24h(traces, NOW.getTime()), { requests: 2, minutes: 99 });
  const runs: RunRec[] = [
    { ts: '2026-10-29T04:00:00Z', actionId: 'a', tokensIn: 1000, tokensOut: 100, durationMs: 60_000 },
    { ts: '2026-10-29T05:00:00Z', actionId: 'a', tokensIn: 2000, tokensOut: 0, durationMs: 120_000 },
    { ts: '2026-10-29T06:00:00Z', actionId: 'b', durationMs: 30_000 },
    { ts: '2026-10-27T06:00:00Z', actionId: 'c', tokensIn: 9e9 },
  ];
  assert.deepEqual(bg24h(runs, NOW.getTime()), { tasks: 2, runs: 3, tokens: 3100, minutes: 4 });
});

test('отрезки за сутки: чат, фон и то, что идёт сейчас', () => {
  const traces: TraceRec[] = [
    { ts: '2026-10-27T08:00:00Z', query: 'давно', elapsedMs: 1000 },
    { ts: '2026-10-29T08:10:00Z', query: 'Собери отчёт\nпо задачам, очень длинный запрос, который не влезет в подпись целиком', elapsedMs: 600_000 },
  ];
  const runs: RunRec[] = [{ ts: '2026-10-29T09:00:30Z', actionId: 'a', name: 'Задача: Разработка демо…', status: 'skipped', durationMs: 120_000 }];
  const now = { busy: true, since: '2026-10-29T10:30:00.000Z', kind: 'chat' as const, text: 'Проверь сервер', helpers: 1 };
  assert.deepEqual(timeline(traces, runs, now, NOW.getTime()), [
    { start: '2026-10-29T08:00:00.000Z', end: '2026-10-29T08:10:00.000Z', kind: 'chat', label: 'Собери отчёт по задачам, очень длинный запрос, который не в…' },
    { start: '2026-10-29T09:00:30.000Z', end: '2026-10-29T09:02:30.000Z', kind: 'bg', status: 'silent', label: 'Разработка демо · молча' },
    { start: '2026-10-29T10:30:00.000Z', end: '2026-10-29T10:45:00.000Z', kind: 'chat', live: true, label: 'Проверь сервер' },
  ]);
  const idle = { busy: false, since: null, kind: null, text: null, helpers: 0 };
  assert.equal(timeline([], [], idle, NOW.getTime()).length, 0);
});


test('provider CLI identity includes Codex, Cursor and Qwen but never arbitrary arguments', () => {
  for (const cmd of ['/opt/codex/bin/codex\0exec\0--json', '/usr/bin/node\0/opt/node_modules/@openai/codex/bin/codex.js\0exec', '/opt/cursor-agent\0-p', '/usr/bin/qwen\0-p']) assert.equal(isAgentCmdline(cmd), true, cmd);
  for (const cmd of ['/bin/bash\0-c\0codex exec hi', '/usr/bin/node\0/opt/bot/index.js\0codex', '/usr/bin/cat\0/tmp/codex', '/usr/bin/node\0/tmp/codex.js']) assert.equal(isAgentCmdline(cmd), false, cmd);
});

test('turn IDs prevent a fast provider switch from borrowing another reply or action count', () => {
  const ts = '2026-11-06T00:00:00.000Z';
  const result = lastResult([{ ts, turnId: 'codex-turn', kind: 'agent_reply', summary: 'Codex' }],
    [{ ts, turnId: 'claude-turn', toolCalls: 17, elapsedMs: 5000 }, { ts, turnId: 'codex-turn', elapsedMs: 2000 }],
    [{ ts, turnId: 'claude-turn', role: 'assistant', text: 'Claude' }, { ts, turnId: 'codex-turn', role: 'assistant', text: 'Codex' }]);
  assert.equal(result?.text, 'Codex'); assert.equal(result?.actions, null);
});


test('Codex npm launcher beside native worker is not counted as a helper', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const root = await fs.mkdtemp(join(os.tmpdir(), 'codex-processes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, 'group'));
  await fs.writeFile(join(root, 'group/cgroup.procs'), '1\n2\n');
  for (const [pid, command] of [[1, '/usr/bin/node\0/opt/node_modules/@openai/codex/bin/codex.js'], [2, '/opt/vendor/codex/codex\0exec']] as const) {
    await fs.mkdir(join(root, String(pid)));
    await fs.writeFile(join(root, String(pid), 'cmdline'), command);
    await fs.writeFile(join(root, String(pid), 'stat'), `${pid} (codex) S 1 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 777 1000`);
  }
  const opts = { procRoot: root, cgroupRoot: root, controlGroup: 'group', bootMs: BOOT, clkTck: 100 };
  assert.deepEqual(agentProcesses(opts).map(p => p.pid), [2]);
  await fs.writeFile(join(root, 'group/cgroup.procs'), '1\n');
  assert.deepEqual(agentProcesses(opts).map(p => p.pid), [1]);
});


test('late previous completion never closes the next request with a different turn ID', () => {
  const records = [
    { ts: '2026-11-06T00:00:00Z', turnId: 'old', role: 'user', text: 'old' },
    { ts: '2026-11-06T00:00:02Z', turnId: 'new', role: 'user', text: 'new' },
    { ts: '2026-11-06T00:00:03Z', turnId: 'old', role: 'assistant', text: 'old finished late' },
  ];
  assert.equal(pendingRequest(records)?.text, 'new');
  assert.equal(pendingRequest([...records, { ts: '2026-11-06T00:00:04Z', turnId: 'new', role: 'assistant', text: '' }]), null);
});


test('new-format duration fallback uses only its own request when trace is missing', () => {
  const ts = '2026-11-06T00:03:00Z';
  const r = lastResult([{ ts, turnId: 'new', kind: 'agent_reply', summary: 'done' }], [], [
    { ts: '2026-11-06T00:00:00Z', turnId: 'old', role: 'user' },
    { ts: '2026-11-06T00:02:00Z', turnId: 'new', role: 'user' },
    { ts, turnId: 'new', role: 'assistant', text: 'done' },
  ]);
  assert.equal(r?.durationMin, 1);
});
