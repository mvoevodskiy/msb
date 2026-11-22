// The user-facing Codex table must keep its requested column order and honest missing values.
import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
}
const text = node => typeof node === 'string' ? node : node.children.map(text).join(' ');
const find = (node, tag) => typeof node === 'string' ? [] :
  [...(node.tag === tag ? [node] : []), ...node.children.flatMap(child => find(child, tag))];

test('Codex usage shows uncached, cached and total in order and explains tariffs', async () => {
  globalThis.Node = Element;
  globalThis.document = { createElement: tag => new Element(tag), addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  const { botUsageSection } = await import('../../src/ui/view-bot-usage.js');
  const section = botUsageSection([{ name: 'Тест', codexUsage: { providerId: 'codex',
    week: 100, month: 200, all: 300, withoutCache: { week: 20, month: null, all: 60 },
    cacheRead: { week: 80, month: null, all: 240 }, incomplete: true,
    updatedAt: null, timezone: 'UTC' } }], Date.now());
  const table = find(section, 'table')[0];
  const rows = find(table, 'tr');
  assert.deepEqual(find(rows[0], 'th').map(text), ['Период', 'Без кеша', 'Из кеша', 'Всего']);
  assert.deepEqual(find(rows[1], 'td').map(text), ['20', '80', '100']);
  assert.deepEqual(find(rows[2], 'td').map(text), ['Недоступно', 'Недоступно', '200']);
  assert.match(text(section), /чтение кеша обычно дешевле/);
  assert.match(text(section), /история может быть неполной/);
  const complete = botUsageSection([{ name: 'Тест', codexUsage: { providerId: 'codex',
    week: 100, month: 200, all: 300, withoutCache: { week: 20, month: 40, all: 60 },
    cacheRead: { week: 80, month: 160, all: 240 }, incomplete: false,
    updatedAt: null, timezone: 'UTC' } }], Date.now());
  assert.doesNotMatch(text(complete), /история может быть неполной/);
});
