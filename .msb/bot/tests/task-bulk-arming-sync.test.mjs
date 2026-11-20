/** The actual CANCEL_ALL card remains usable after a known failure before STOP. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { botRoot } from '../src/paths.mjs';
import { chat, reminderFixture } from './helpers/reminder-registration-fixture.mjs';

const action = { id: 'fixture', name: 'Сохранённая задача', enabled: true, trigger: { kind: 'interval', intervalMinutes: 60 },
  task: { kind: 'reminder', text: 'Тестовая задача' } };

async function profile(t) {
  const f = await reminderFixture(t, { output: '[CANCEL_ALL]' });
  await fs.writeFile(f.actionFile, JSON.stringify([action]));
  await f.request('Удали все фоновые задачи.');
  assert.match(await f.final(), /Спросил подтверждение/);
  const messageId = f.messages.findIndex(body => body.startsWith('Снести все фоновые задачи')) + 1;
  assert.ok(messageId);
  return { ...f,
    questionFile: path.join(botRoot(), 'autonomy', 'spent-task-questions.json'),
    stopFile: path.join(f.directory, 'autonomy', 'STOP'),
    async click() {
      await f.callback('ct-all', 42, { chatId: chat, messageId });
      return f.callbackAnswers.at(-1)[0].text;
    },
  };
}

async function assertUntouched(f) {
  assert.deepEqual(await f.records(), [action]);
  await assert.rejects(fs.stat(f.stopFile), { code: 'ENOENT' });
  assert.equal((await fs.readdir(f.directory)).filter(name => name.startsWith('actions.removed-')).length, 0);
}

test('the same bulk card can retry when syncing applying failed before STOP', async t => {
  const f = await profile(t);
  const open = fs.open;
  let failed = false;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (!failed && file === f.questionFile && args[0] === 'r') {
      const [question] = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(question.applying, true);
      failed = true;
      throw Object.assign(new Error('synthetic question sync failed'), { code: 'EIO' });
    }
    return open(file, ...args);
  });

  assert.match(await f.click(), /попробуй ещё раз/);
  assert.ok(failed);
  await assertUntouched(f);

  assert.equal(await f.click(), 'Снёс');
  assert.deepEqual(await f.records(), []);
  assert.ok((await fs.stat(f.stopFile)).isFile());
});

test('an applying record from an interrupted bulk confirmation stays stale', async t => {
  const f = await profile(t);
  const [question] = JSON.parse(await fs.readFile(f.questionFile, 'utf8'));
  await fs.writeFile(f.questionFile, JSON.stringify([{ ...question, applying: true }]));

  assert.equal(await f.click(), 'Подтверждение устарело');
  await assertUntouched(f);
});
