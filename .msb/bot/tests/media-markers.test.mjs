import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMediaMarkers } from '../src/telegram/media-markers.mjs';

test('extractMediaMarkers strips Russian and English tags into a send queue', () => {
  const { text, items } = extractMediaMarkers([
    'Озвучу урок.',
    '',
    '[ГОЛОС: /home/client/workspace/runs/voice/01-lesson-part1.ogg Урок 1, часть 1]',
    '[ГОЛОС: runs/voice/01-lesson-part2.ogg Урок 1, часть 2]',
    '',
    'Текст урока: course/lessons/01.md',
    '[ФОТО: /tmp/a.png]',
    '[FILE: report.pdf итоговый отчёт]',
  ].join('\n'));

  assert.equal(items.length, 4);
  assert.deepEqual(items[0], {
    type: 'voice',
    path: '/home/client/workspace/runs/voice/01-lesson-part1.ogg',
    caption: 'Урок 1, часть 1',
  });
  assert.deepEqual(items[1], {
    type: 'voice',
    path: 'runs/voice/01-lesson-part2.ogg',
    caption: 'Урок 1, часть 2',
  });
  assert.deepEqual(items[2], { type: 'photo', path: '/tmp/a.png', caption: undefined });
  assert.deepEqual(items[3], { type: 'document', path: 'report.pdf', caption: 'итоговый отчёт' });
  assert.match(text, /Озвучу урок/);
  assert.match(text, /Текст урока/);
  assert.doesNotMatch(text, /ГОЛОС:|ФОТО:|FILE:/);
});

test('extractMediaMarkers leaves ordinary brackets alone', () => {
  const { text, items } = extractMediaMarkers('См. [план работ] и [КНОПКИ: plan]');
  assert.equal(items.length, 0);
  assert.equal(text, 'См. [план работ] и [КНОПКИ: plan]');
});
