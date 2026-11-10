/**
 * Isolated saved-action fixtures for [recurring reminders](../recurring-reminder.test.mjs)
 * and [frequency decisions](../reminder-frequency.test.mjs). Production scheduler,
 * owner callback routing, time and files with the Telegram harness.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../../src/autonomy/scheduler.mjs';
import { actionRoot } from '../../src/paths.mjs';
import { loadState, saveState } from '../../src/state.mjs';
import { fixture } from './menu-fixture.mjs';

export const initial = Date.parse('2026-11-09T06:00:00.000Z');
export const min = 60_000;
export const owner = -100777;
export const at = time => new Date(time).toISOString();
export const every = minutes => ({ kind: 'interval', intervalMinutes: minutes });
export const cron = (expression, timezone) => ({ kind: 'cron', cron: expression, ...(timezone ? { timezone } : {}) });
export const record = (id, trigger, extra = {}) => ({ id, name: 'Сохранено ' + id, enabled: true,
  trigger, task: { kind: 'reminder', text: 'Дословно ' + id }, runner: 'auto', retained: id, ...extra });

export async function profile(t, rows, { state = {}, now = initial } = {}) {
  let clock = now;
  const f = await fixture(t, async () => assert.fail('The scheduled literal text must not start an owner turn'),
    { overlay: false, runtimeProfile: 'jar1', now: () => clock });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_DAILY_CAP_USD',
    'AUTONOMY_DAILY_CAP_RUNS', 'AUTONOMY_DAILY_CAP_TOKENS', 'AUTONOMY_RESERVE_FRACTION']) delete process.env[key];
  process.env.AUTONOMY_ENABLED = '1';
  await saveState({ ...(await loadState()).state, engine: 'cc', timezone: 'Europe/Moscow', chatId: owner, userId: 42, ...state });
  const root = actionRoot();
  const file = path.join(root, 'actions.json');
  const autonomy = path.join(root, 'autonomy');
  const journal = path.join(autonomy, 'runs.jsonl');
  const decisionFile = path.join(root, 'owner-decisions.json');
  await fs.mkdir(autonomy, { recursive: true });
  const saveRows = actions => fs.writeFile(file, JSON.stringify(actions));
  await saveRows(rows);
  const sent = [];
  const send = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    sent.push({ chat, text });
    return send(chat, text, ...options);
  };
  const makeScheduler = () => startScheduler({ api: f.bot.api, adminId: 42, timezone: 'UTC',
    runTurn: async () => assert.fail('The interval approximation must not execute actions.json'), now: () => clock, log() {} });
  const scheduler = makeScheduler();
  t.after(() => scheduler.stop());
  return { ...f, file, journal, autonomy, decisionFile, scheduler, makeScheduler, saveRows, sent,
    deliveries: () => sent.filter(row => row.text.startsWith('⏰')),
    rows: async () => JSON.parse(await fs.readFile(file, 'utf8')),
    runs: async () => (await fs.readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse),
    advance: async value => { clock = value; await scheduler.tickNow(); },
    setTime(value) { clock = value; },
    decisions: rows => fs.writeFile(decisionFile, JSON.stringify({ decisions: rows })),
    decisionBook: async () => JSON.parse(await fs.readFile(decisionFile, 'utf8')),
  };
}
