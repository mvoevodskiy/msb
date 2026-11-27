import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { viewOverview } from '../../src/ui/view-overview.js';
import { viewProjects } from '../../src/ui/view-projects.js';

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
const overview = changes => viewOverview({ s: { ...quiet, ...changes }, now, resp: {}, chart: () => null, history: () => ({}) });

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
