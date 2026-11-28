import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { viewOverview } from '../../src/ui/view-overview.js';
import { viewProjects } from '../../src/ui/view-projects.js';
import { viewTask, viewTasks } from '../../src/ui/view-tasks.js';

class Element {
  children = [];
  attributes = new Map();
  dataset = {};
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener() {}
  text() { return this.children.map(child => child instanceof Element ? child.text() : String(child)).join(' '); }
  region(label) {
    if (this.attributes.get('aria-label') === label) return this;
    const elements = this.children.filter(child => child instanceof Element);
    if (this.tag === 'details' && elements.some(child => child.attributes.get('aria-label') === label)) return this;
    return elements.map(child => child.region(label)).find(Boolean);
  }
}

globalThis.Node = Element;
globalThis.document = { createElement: tag => Object.assign(new Element(), { tag }) };
const quiet = JSON.parse(readFileSync(new URL('../fixtures/ui/snapshot-quiet.json', import.meta.url), 'utf8'));
const now = Date.parse(quiet.collectedAt);
const overview = (changes, notify) => viewOverview({ s: { ...quiet, ...changes }, now, resp: { notify }, chart: () => null, history: () => ({}) });

test('an unreadable Codex subscription is not marked healthy alongside a known balance', () => {
  const snapshot = { subscription: null, subscriptions: [], balances: [{ name: 'Другой сервис', value: '50', ok: true }] };
  const confirmed = overview({ ...snapshot, sourceErrors: [] }).region('Подписка и остатки').text();
  assert.match(confirmed, /все в норме/);
  assert.doesNotMatch(confirmed, /Codex/);

  const unavailable = overview({ ...snapshot, sourceErrors: [{ source: 'подписка Codex', message: 'timeout' }] })
    .region('Подписка и остатки').text();
  assert.match(unavailable, /1 проблема/);
  assert.match(unavailable, /Codex · подписка\s+нет данных/);
  assert.doesNotMatch(unavailable, /все в норме/);
  assert.match(unavailable, /Другой сервис/);
});

test('a failed project registry read is distinct from a successful empty registry', () => {
  const empty = { projects: [], sourceErrors: [] };
  const bad = { projects: [], sourceErrors: [{ source: 'реестр проектов', message: 'invalid JSON' }] };
  assert.match(overview(empty).text(), /Проектов нет/);
  assert.match(viewProjects({ s: empty, now }).text(), /Проектов нет/);
  for (const view of [overview(bad), viewProjects({ s: bad, now })]) {
    assert.match(view.text(), /Не удалось прочитать реестр проектов/);
    assert.doesNotMatch(view.text(), /Проектов нет/);
  }
});

test('an unreadable task schedule is distinct from a successful empty schedule', () => {
  const view = s => viewTasks({ s: { ...quiet, ...s }, now, route: { query: {} } }).text();
  const upcoming = (s, notify) => overview(s, notify).region('Дальше по расписанию').text();
  const empty = { tasks: [], upcoming: [], tasksHidden: 0, sourceErrors: [] };
  assert.match(view(empty), /Фоновых задач нет/);
  assert.match(upcoming(empty), /ничего не запланировано/);

  for (const source of ['бот «Пример»: фоновые задачи', 'задача бота «Пример»', 'systemd', 'каталог ботов']) {
    const failed = { ...empty, sourceErrors: [{ source, message: 'unavailable' }] };
    assert.match(view(failed), /Не удалось прочитать расписание/);
    assert.doesNotMatch(view(failed), /Фоновых задач нет/);
    assert.match(upcoming(failed), /Не удалось прочитать расписание/);
    assert.doesNotMatch(upcoming(failed), /ничего не запланировано/);
    const withDigest = upcoming(failed, { configured: true });
    assert.match(withDigest, /Не удалось прочитать расписание/);
    assert.match(withDigest, /Сводка пульта/);
  }
  const unrelated = { ...empty, sourceErrors: [{ source: 'Расход Codex', message: 'unavailable' }] };
  assert.match(view(unrelated), /Фоновых задач нет/);
});

test('legacy task links open only an unambiguous card and scoped links keep their owner', () => {
  const task = JSON.parse(readFileSync(new URL('../fixtures/ui/snapshot.json', import.meta.url), 'utf8')).tasks[0];
  const id = 'ff33905573';
  const alpha = { ...task, id: id + '-587b98fc96', name: 'Задача Альфы' };
  const beta = { ...task, id: id + '-93ffb71be7', name: 'Задача Беты' };
  const view = (id, tasks) => viewTask({
    s: { ...quiet, tasks }, now, route: { id, query: {} }, chart: () => null,
  }).text();
  assert.match(view(id, [alpha]), /Задача Альфы/);
  assert.match(view(id, [alpha, beta]), /Задача больше не активна/);
  assert.match(view(id, [alpha, { ...beta, id }]), /Задача больше не активна/);
  assert.match(view(alpha.id, [alpha, beta]), /Задача Альфы/);
  assert.match(view(alpha.id, [beta]), /Задача больше не активна/);
});
