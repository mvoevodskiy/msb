import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, configPath, defaultConfigPath, discoverExtraBots, loadConfig, validateConfig } from '../../src/shared/config.ts';

const base = () => JSON.parse(JSON.stringify({
  host: 'Сервер ботов',
  timezone: 'Europe/Moscow',
  intervalSec: 60,
  botsRoot: '~/bots',
  bots: [{ id: 'default', name: 'Основной', unit: 'bot@default.service', projects: ['Zapcita'] }],
  services: [{ id: 'nginx', name: 'nginx', unit: 'nginx.service', project: null }],
  platformUnits: ['sync.timer'],
  timers: [{ id: 'backup', name: 'Копия', timer: 'backup.timer', service: 'backup.service', bot: 'server', project: null, expect: 'копия' }],
  taskRules: [{ match: '^socpublisher', project: 'socpublisher', repo: '~/projects/socpublisher' }],
  registry: { projects: '~/ops/projects.json', asks: '~/ops/asks.json' },
  balances: { proxyapi: { file: '~/p.json', lowRub: 50 } },
  thresholds: { memPct: 90, diskPct: 90, heavyServiceMemMb: 2048, heavyServiceCores: 0.5, missedRunsWarn: 3, expensiveTaskTokens24h: 5e6 },
}));

function problems(data: unknown): string[] {
  try {
    validateConfig(data, 'тест');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.problems;
  }
  return [];
}

test('сток-конфиг MSB проходит проверку', () => {
  const c = loadConfig(defaultConfigPath());
  assert.equal(c.timezone, 'Europe/Moscow');
  assert.ok(c.botsRoot.endsWith('.msb/bots') || c.botsRoot.includes('/.msb/bots'), 'botsRoot → ~/.msb/bots');
  assert.ok(!c.botsRoot.startsWith('~'), '~ раскрыт');
  assert.ok(c.bots.some(b => b.id === 'default' && b.unit === 'msb-bot@default.service'));
  assert.equal(c.services.find(s => s.id === 'pult-web')?.optional, true);
  assert.equal(c.services.find(s => s.id === 'nginx')?.optional, true);
  assert.deepEqual(c.timers, []);
  assert.deepEqual(c.taskRules, []);
  assert.ok(c.platformUnits.every(u => u.startsWith('msb-')), 'платформенные юниты MSB');
  assert.equal(c.balances.proxyapi, null);
});

test('discoverExtraBots: каталог без записи в конфиге → карточка бота', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pult-bots-'));
  try {
    mkdirSync(join(dir, 'default'));
    mkdirSync(join(dir, 'sales'));
    mkdirSync(join(dir, '.skip'));
    const extra = discoverExtraBots(dir, [{ id: 'default', name: 'Основной', unit: 'msb-bot@default.service', projects: [] }]);
    assert.deepEqual(extra, [{ id: 'sales', name: 'Sales', unit: 'msb-bot@sales.service', projects: [] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('пути с ~ раскрываются, необязательные поля получают null', () => {
  const c = validateConfig(base());
  assert.equal(c.botsRoot, join(homedir(), 'bots'));
  assert.equal(c.registry.asks, join(homedir(), 'ops/asks.json'));
  assert.equal(c.taskRules[0].repo, join(homedir(), 'projects/socpublisher'));
  assert.equal(c.taskRules[0].expect, null);
  assert.equal(c.timers[0].statusFile, null);
  assert.equal(c.timers[0].scheduleText, null);
  assert.equal(c.balances.apify, null);
  assert.equal(c.balances.proxyapi?.file, join(homedir(), 'p.json'));
  assert.ok(c.taskRules[0].re.test('SOCPUBLISHER: разработчик'), 'правила без учёта регистра');
});

test('каждое пустое или неверное поле — своя строка ошибки', () => {
  const d = base();
  d.host = '';
  d.timezone = 'Марс/Олимп';
  d.intervalSec = 0;
  d.bots[0].unit = 'не юнит';
  d.services.push({ id: 'nginx', name: '', unit: 'x.service', project: null });
  d.timers[0].bot = 'nobody';
  d.timers[0].timer = 'backup.service';
  d.taskRules.push({ match: '(' }, { match: 'x' });
  d.thresholds.memPct = 120;
  delete d.registry;
  const p = problems(d);
  const has = (re: RegExp) => assert.ok(p.some(x => re.test(x)), `нет ошибки ${re} в\n${p.join('\n')}`);
  has(/^host: пустое/);
  has(/^timezone: неизвестный часовой пояс/);
  has(/^intervalSec: должно быть от 5 до 3600/);
  has(/^bots\[0\]\.unit: «не юнит» не похоже на имя юнита/);
  has(/^services\[1\]\.name: пустое/);
  has(/^services: id «nginx» повторяется/);
  has(/^timers\[0\]\.bot: нет бота «nobody»/);
  has(/^timers\[0\]\.timer: ожидается юнит \.timer/);
  has(/^taskRules\[1\]\.match: неверное регулярное выражение/);
  has(/^taskRules\[2\]: правило ничего не задаёт/);
  has(/^thresholds\.memPct: должно быть от 1 до 100/);
  has(/^registry: нет раздела/);
});

test('сообщение об ошибке перечисляет всё сразу', () => {
  const d = base();
  d.host = '';
  d.bots = [];
  try {
    validateConfig(d, 'pult.config.json');
    assert.fail('должна быть ошибка');
  } catch (e) {
    assert.match((e as Error).message, /^Конфиг pult\.config\.json: 2 ошибки\n  - host: пустое\n  - bots: нужен хотя бы один бот$/);
  }
});

test('нет полей и неверные типы', () => {
  assert.throws(() => validateConfig([]), /ожидается объект/);
  const p = problems({});
  for (const k of ['host', 'timezone', 'intervalSec', 'botsRoot', 'bots', 'services', 'platformUnits', 'timers', 'taskRules']) {
    assert.ok(p.some(x => x.startsWith(`${k}: нет поля`)), k);
  }
  const d = base();
  d.balances.deepgram = { command: [], everyMin: 0 };
  d.services[0].optional = 'да';
  const q = problems(d);
  assert.ok(q.some(x => /balances\.deepgram\.command/.test(x)));
  assert.ok(q.some(x => /balances\.deepgram\.everyMin/.test(x)));
  assert.ok(q.some(x => /services\[0\]\.optional: должно быть true или false/.test(x)));
});

test('загрузка: путь из PULT_CONFIG, нет файла, не JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pult-config-'));
  try {
    assert.equal(configPath({}), defaultConfigPath());
    assert.equal(configPath({ PULT_CONFIG: join(dir, 'c.json') }), join(dir, 'c.json'));
    assert.throws(() => loadConfig(join(dir, 'нет.json')), /Нет файла конфига .*PULT_CONFIG/);
    writeFileSync(join(dir, 'bad.json'), '{oops');
    assert.throws(() => loadConfig(join(dir, 'bad.json')), /не JSON/);
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(base()));
    assert.equal(loadConfig(join(dir, 'ok.json')).host, 'Сервер ботов');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
