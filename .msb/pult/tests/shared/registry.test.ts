import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  expandHome, openAsks, parseAsks, parseProjects, readAsks, readProjects, withLock, writeJsonAtomic, RegistryError,
} from '../../src/shared/registry.ts';

const project = { id: 'z', name: 'Z', owner: 'бот', status: 'ok', statusText: 'работает', stage: null, next: null, repo: null, facts: [], order: 1, updatedAt: null, updatedBy: null };
const ask = { id: 'a1', project: null, bot: 'SMM', text: 'вопрос', blocks: null, since: '2026-10-29T10:00:00Z', closedAt: null, closedNote: null };

test('expandHome раскрывает только ведущую ~', () => {
  assert.equal(expandHome('~/x'), join(homedir(), 'x'));
  assert.equal(expandHome('/a/~/b'), '/a/~/b');
});

test('нет файла — пустой реестр', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pult-reg-'));
  assert.deepEqual(readProjects(join(dir, 'p.json')), { version: 1, projects: [] });
  assert.deepEqual(readAsks(join(dir, 'a.json')), { version: 1, asks: [] });
});

test('проверка проектов: понятные ошибки по полям', () => {
  assert.doesNotThrow(() => parseProjects({ version: 1, projects: [project] }));
  assert.throws(() => parseProjects({ projects: [] }), /version/);
  assert.throws(() => parseProjects({ version: 1, projects: [{ ...project, status: 'горит' }] }), /status/);
  assert.throws(() => parseProjects({ version: 1, projects: [{ ...project, facts: [{ label: 'x' }] }] }), /facts/);
  assert.throws(() => parseProjects({ version: 1, projects: [{ ...project, order: '1' }] }), /order/);
});

test('проверка вопросов и порядок открытых', () => {
  assert.throws(() => parseAsks({ version: 1, asks: [{ ...ask, since: 'вчера' }] }), /since/);
  const file = parseAsks({ version: 1, asks: [
    { ...ask, id: 'b', since: '2026-10-29T12:00:00Z' },
    { ...ask, id: 'c', since: '2026-10-27T12:00:00Z' },
    { ...ask, id: 'd', closedAt: '2026-10-29T13:00:00Z' },
  ] });
  assert.deepEqual(openAsks(file).map(a => a.id), ['c', 'b']);
});

test('битый JSON — RegistryError с путём', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pult-reg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, 'не json');
  assert.throws(() => readAsks(p), (e: unknown) => e instanceof RegistryError && e.message.includes(p));
});

test('withLock: снимает блокировку и после исключения; брошенную старую — перехватывает', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pult-reg-'));
  const p = join(dir, 'x.json');
  assert.throws(() => withLock(p, () => { throw new Error('сбой'); }), /сбой/);
  assert.equal(existsSync(p + '.lock'), false);

  mkdirSync(p + '.lock');
  const old = new Date(Date.now() - 60_000);
  utimesSync(p + '.lock', old, old);
  assert.equal(withLock(p, () => 42), 42);
  assert.equal(existsSync(p + '.lock'), false);
});

test('writeJsonAtomic создаёт каталоги и пишет читаемый JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pult-reg-'));
  const p = join(dir, 'deep/er/a.json');
  writeJsonAtomic(p, { version: 1, asks: [ask] });
  assert.equal(readAsks(p).asks[0]!.id, 'a1');
});
