import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseArgs } from '../../src/cli/pult.ts';
import { RegistryError } from '../../src/shared/registry.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pult-cli-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ registry: { projects: join(dir, 'reg/projects.json'), asks: join(dir, 'reg/asks.json') } }));
  return { dir, cfg: ['--config', config], asksPath: join(dir, 'reg/asks.json'), projectsPath: join(dir, 'reg/projects.json') };
}

const NOW = new Date('2026-10-29T10:00:00Z');

test('parseArgs: позиционные, флаги со значением, повторяемые, булевы, пустое значение', () => {
  const r = parseArgs(['project', 'set', 'x', '--fact', 'A=1', '--fact=B=2', '--stage', '', '--json']);
  assert.deepEqual(r.pos, ['project', 'set', 'x']);
  assert.deepEqual(r.flags.get('fact'), ['A=1', 'B=2']);
  assert.deepEqual(r.flags.get('stage'), ['']);
  assert.deepEqual(r.flags.get('json'), ['true']);
});

test('без аргументов и с --help — справка', () => {
  assert.match(run([]).out, /pult ask add/);
  assert.match(run(['--help']).out, /pult project set/);
});

test('ask add → list → close: id по дате, закрытый не виден в list', () => {
  const s = setup();
  const added = JSON.parse(run(['ask', 'add', '--bot', 'default', '--project', 'socpublisher', '--text', ' Где боевой? ', '--blocks', 'прод', '--json', ...s.cfg], NOW).out);
  assert.equal(added.id, 'a20261029-1');
  assert.equal(added.text, 'Где боевой?');
  assert.equal(added.since, NOW.toISOString());
  const second = JSON.parse(run(['ask', 'add', '--bot', 'SMM', '--text', 'Каналы?', '--json', ...s.cfg], NOW).out);
  assert.equal(second.id, 'a20261029-2');
  assert.equal(second.project, null);

  const listed = JSON.parse(run(['ask', 'list', '--json', ...s.cfg]).out);
  assert.equal(listed.length, 2);
  assert.match(run(['ask', 'list', ...s.cfg]).out, /a20261029-1 {2}Где боевой\?/);

  run(['ask', 'close', 'a20261029-1', '--note', 'на ВМ', ...s.cfg], new Date('2026-10-29T12:00:00Z'));
  const open = JSON.parse(run(['ask', 'list', '--json', ...s.cfg]).out);
  assert.deepEqual(open.map((a: { id: string }) => a.id), ['a20261029-2']);
  const all = JSON.parse(run(['ask', 'list', '--all', '--json', ...s.cfg]).out);
  const closed = all.find((a: { id: string }) => a.id === 'a20261029-1');
  assert.equal(closed.closedNote, 'на ВМ');
  assert.equal(closed.closedAt, '2026-10-29T12:00:00.000Z');
  // повторное закрытие — без ошибки и без смены даты
  run(['ask', 'close', 'a20261029-1', ...s.cfg]);
  assert.equal(JSON.parse(readFileSync(s.asksPath, 'utf8')).asks[0].closedAt, '2026-10-29T12:00:00.000Z');
});

test('ask add --since: задним числом, id по дате вопроса; будущее — ошибка', () => {
  const s = setup();
  const a = JSON.parse(run(['ask', 'add', '--bot', 'personal', '--text', 'x', '--since', '2026-10-27T09:00:00Z', '--json', ...s.cfg], NOW).out);
  assert.equal(a.id, 'a20261027-1');
  assert.equal(a.since, '2026-10-27T09:00:00.000Z');
  assert.throws(() => run(['ask', 'add', '--bot', 'personal', '--text', 'x', '--since', '2026-10-30T09:00:00Z', ...s.cfg], NOW), /--since/);
  assert.throws(() => run(['ask', 'add', '--bot', 'personal', '--text', 'x', '--since', 'вчера', ...s.cfg], NOW), /--since/);
});

test('ask: ошибки — нет текста, неизвестный id, неизвестный флаг', () => {
  const s = setup();
  assert.throws(() => run(['ask', 'add', '--bot', 'SMM', ...s.cfg]), RegistryError);
  assert.throws(() => run(['ask', 'close', 'нет-такого', ...s.cfg]), /нет/);
  assert.throws(() => run(['ask', 'add', '--bot', 'SMM', '--text', 'x', '--srok', '1', ...s.cfg]), /неизвестный флаг --srok/);
  assert.throws(() => run(['ask', 'add', '--bot', '--text', 'x', ...s.cfg]), /нужно значение|нужны/);
});

test('project set: создание, правка, факты, очистка поля, статус по умолчанию', () => {
  const s = setup();
  assert.throws(() => run(['project', 'set', 'zapcita', '--stage', 'x', ...s.cfg]), /укажи хотя бы --name/);
  run(['project', 'set', 'zapcita', '--name', 'Zapcita', '--owner', 'основной бот', '--status', 'ok', '--stage', 'продажи',
    '--fact', 'Деньги=ProxyAPI 334,75 ₽', '--fact', 'Тесты=10', '--by', 'default', ...s.cfg], NOW);
  let p = JSON.parse(run(['project', 'show', 'zapcita', '--json', ...s.cfg]).out);
  assert.equal(p.statusText, 'работает');
  assert.equal(p.order, 10);
  assert.equal(p.updatedBy, 'default');
  assert.deepEqual(p.facts, [{ label: 'Деньги', value: 'ProxyAPI 334,75 ₽' }, { label: 'Тесты', value: '10' }]);

  run(['project', 'set', 'zapcita', '--fact', 'Тесты=12', '--drop-fact', 'Деньги', '--stage', '', '--status', 'pause', ...s.cfg], NOW);
  p = JSON.parse(run(['project', 'show', 'zapcita', '--json', ...s.cfg]).out);
  assert.deepEqual(p.facts, [{ label: 'Тесты', value: '12' }]);
  assert.equal(p.stage, null);
  assert.equal(p.status, 'pause');
  assert.equal(p.statusText, 'работает', 'явно заданный текст статуса не перетирается');

  run(['project', 'set', 'kempery', '--name', 'Кемперы', ...s.cfg], NOW);
  assert.match(run(['project', 'list', ...s.cfg]).out, /zapcita {2}Zapcita[\s\S]*kempery {2}Кемперы/);
});

test('project set: проверка значений', () => {
  const s = setup();
  assert.throws(() => run(['project', 'set', 'Плохой id', '--name', 'x', ...s.cfg]), /латиница/);
  assert.throws(() => run(['project', 'set', 'x', '--name', 'x', '--status', 'горит', ...s.cfg]), /--status/);
  assert.throws(() => run(['project', 'set', 'x', '--name', 'x', '--order', 'первый', ...s.cfg]), /--order/);
  assert.throws(() => run(['project', 'set', 'x', '--name', 'x', '--fact', 'безравно', ...s.cfg]), /Метка=значение/);
  assert.equal(existsSync(s.projectsPath), false, 'при ошибке файл не создаётся');
});

test('повреждённый реестр — понятная ошибка, а не тихая перезапись', () => {
  const s = setup();
  mkdirSync(join(s.dir, 'reg'), { recursive: true });
  writeFileSync(s.asksPath, '{ сломано');
  assert.throws(() => run(['ask', 'add', '--bot', 'SMM', '--text', 'x', ...s.cfg]), /повреждён/);
  assert.equal(readFileSync(s.asksPath, 'utf8'), '{ сломано');
});
