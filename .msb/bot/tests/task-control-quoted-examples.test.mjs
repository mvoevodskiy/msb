/** Owner-turn controls ignore quoted examples while processing genuine markers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { reminderFixture } from './helpers/reminder-registration-fixture.mjs';

const row = (id, name) => ({ id, name, enabled: true, trigger: { kind: 'interval', intervalMinutes: 60 },
  task: { kind: 'reminder', text: name } });
const paused = row => ({ ...row, enabled: false, disabledReason: 'owner' });

test('quoted pause and resume examples stay inert next to genuine controls', async t => {
  const quotedPause = row('quoted-pause', 'Только пример паузы');
  const quotedResume = paused(row('quoted-resume', 'Только пример возобновления'));
  const livePause = row('live-pause', 'Сверка "почта"');
  const liveResume = row('live-resume', 'Отправка отчёта');
  const f = await reminderFixture(t, {
    output: `Пример: "[PAUSE_TASK:quoted-pause]" или '[RESUME_TASK:quoted-resume]'.\n` +
      `[PAUSE_TASK:${livePause.name}]\n[RESUME_TASK:${liveResume.id}]`,
  });
  await fs.writeFile(f.actionFile, JSON.stringify([quotedPause, quotedResume, livePause, paused(liveResume)]));

  await f.request('Поставь сверку на паузу, верни отправку в работу и покажи два примера.');
  const reply = await f.final();
  assert.match(reply, /⏸ «Сверка "почта"» на паузе/);
  assert.match(reply, /▶ «Отправка отчёта» снова в работе/);
  assert.deepEqual(await f.records(), [quotedPause, quotedResume, paused(livePause), liveResume]);
});
