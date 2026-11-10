import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { askBelongs, buildProject, midnightMs, toAsk } from '../../src/collector/sources/projects.ts';
import { parseGitLog } from '../../src/collector/sources/git.ts';
import { readAsks, readProjects } from '../../src/shared/registry.ts';
import type { Service } from '../../src/shared/types.ts';
import { FIX, GIT_LOG, NOW, fixtureConfig } from './helpers.ts';

test('git log → коммиты: время в UTC, хеш 7 знаков, мусор пропускается', () => {
  const c = parseGitLog(GIT_LOG + 'не коммит\n\n');
  assert.deepEqual(c[0], { at: '2026-10-29T10:23:00.000Z', hash: 'a1b2c3d', subject: 'Тесты на выживших' });
  assert.equal(c.length, 3);
});

test('полночь по Москве', () => {
  assert.equal(new Date(midnightMs(NOW.getTime(), 'Europe/Moscow')).toISOString(), '2026-10-28T21:00:00.000Z');
  assert.equal(new Date(midnightMs(Date.parse('2026-10-29T22:00:00Z'), 'Europe/Moscow')).toISOString(), '2026-10-29T21:00:00.000Z');
});

test('вопрос: имя бота из конфига, иначе как есть', () => {
  const cfg = fixtureConfig();
  const asks = readAsks(join(FIX, 'registry/asks.json')).asks;
  assert.equal(toAsk(asks[0], cfg).botName, 'Альфа');
  assert.equal(toAsk(asks[2], cfg).botName, 'someone');
  assert.equal(askBelongs({ project: 'ДЕМО' }, { id: 'demo', name: 'Демо' }), true);
  assert.equal(askBelongs({ project: 'demo' }, { id: 'demo', name: 'Демо' }), true);
  assert.equal(askBelongs({ project: null }, { id: 'demo', name: 'Демо' }), false);
});

test('проект: службы по имени без учёта регистра, коммиты сегодня по Москве, открытые вопросы', () => {
  const p = readProjects(join(FIX, 'registry/projects.json')).projects.find(x => x.id === 'demo')!;
  const svc = (name: string, project: string | null, state = 'active') => ({ id: name, name, project, state, heavy: false, since: null, restarts: 0, memMb: null, cpuCores: null }) as Service;
  const commits = parseGitLog(GIT_LOG);
  const proj = buildProject(p, {
    services: [svc('Проверки', 'Демо'), svc('Сайт', 'демо', 'failed'), svc('Чужая', 'Другое')],
    asks: readAsks(join(FIX, 'registry/asks.json')).asks,
    git: { commits, latest: commits[0] },
    nowMs: NOW.getTime(),
    tz: 'Europe/Moscow',
  });
  assert.deepEqual(proj.services, [{ name: 'Проверки', state: 'active' }, { name: 'Сайт', state: 'failed' }]);
  assert.equal(proj.commitsToday, 2, 'коммит в 23:30 МСК вчера не считается');
  assert.deepEqual(proj.lastCommit, { at: '2026-10-29T10:23:00.000Z', subject: 'Тесты на выживших' });
  assert.deepEqual(proj.asks, ['Доступ к базе', 'Где ставить боевой экземпляр'], 'закрытые не попадают, старые первыми');
  assert.deepEqual(proj.facts, [{ label: 'Тесты', value: '6 037 зелёных' }]);
  const noRepo = buildProject({ ...p, repo: null }, { services: [], asks: [], git: null, nowMs: NOW.getTime(), tz: 'Europe/Moscow' });
  assert.equal(noRepo.commitsToday, null);
  assert.equal(noRepo.lastCommit, null);
});
