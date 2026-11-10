/**
 * Disposable bot and scheduler for [one-off](../one-shot-reminder.test.mjs)
 * and [recurring](../recurring-reminder-registration.test.mjs) conversation markers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../../src/autonomy/scheduler.mjs';
import { sessionDir } from '../../src/paths.mjs';
import { loadState, saveState } from '../../src/state.mjs';
import { fixture } from './menu-fixture.mjs';

const time = Date.parse('2026-11-08T10:00:00.000Z');
export const scheduledAt = '2026-11-08T10:30:00.000Z';
export const chat = -100321;
export const ownerChat = -100777;
const body = { trigger: { kind: 'once', at: '+30m' }, task: { kind: 'reminder', text: '  Проверить почту <входящие>  ' } };
export const marker = (value = body) => '[SCHEDULE_TASK]' + JSON.stringify(value) + '[/SCHEDULE_TASK]';

export async function until(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

export async function reminderFixture(t, { output = marker(), enabled = '1', engine = 'cc', bound = true } = {}) {
  let clock = time;
  const modelCalls = [];
  const f = await fixture(t, async args => {
    modelCalls.push(args);
    const { state } = await loadState();
    const turn = typeof output === 'function' ? await output(args) : { ok: true, text: output };
    return { ...turn, ...(state.engine === 'cc' ? { reminderRail: 'cc' } : {}) };
  }, { overlay: false, runtimeProfile: 'jar1', now: () => clock });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_MAX_ACTIONS']) delete process.env[key];
  if (enabled === null) delete process.env.AUTONOMY_ENABLED;
  else process.env.AUTONOMY_ENABLED = enabled;
  await saveState({ ...(await loadState()).state, engine, ...(bound ? { chatId: ownerChat, userId: 42 } : {}), timezone: 'Europe/Moscow' });
  const directory = path.dirname(sessionDir());
  const actionFile = path.join(directory, 'actions.json');
  const schedules = path.join(directory, 'schedules.json');
  const sent = [];
  const originalSend = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (destination, text, ...rest) => {
    sent.push({ destination, text, options: rest[0] });
    return originalSend(destination, text, ...rest);
  };
  function scheduler() {
    const instance = startScheduler({ api: f.bot.api, adminId: 42, timezone: 'Europe/Moscow',
      scheduledTurns: f.bot[Symbol.for('msb.scheduledTurns')], now: () => clock,
      log() {}, runTurn: async () => assert.fail('Direct reminders must not invoke the interval model'),
    });
    t.after(() => instance.stop());
    return instance;
  }
  let messageId = 42;
  async function request(text, userId = 42) {
    await f.bot.handleUpdate({ message: { message_id: ++messageId, text, from: { id: userId },
      chat: { id: chat }, message_thread_id: 17 } });
  }
  async function final() {
    await until(() => f.edits.some(text => text.includes('⏱')), 'final Telegram edit missing');
    return f.edits.find(text => text.includes('⏱'));
  }
  return { ...f, actionFile, schedules, directory, modelCalls, sent, scheduler, request, final,
    setTime(value) { clock = value; },
    records: async () => JSON.parse(await fs.readFile(actionFile, 'utf8')),
    delivered: () => sent.filter(row => row.text.startsWith('⏰ ')),
  };
}
