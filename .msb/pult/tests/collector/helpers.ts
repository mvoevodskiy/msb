// Общее для тестов сборщика: конфиг на фикстурах, поддельный запуск команд (systemctl, journalctl, git,
// getconf, Deepgram) и фиксированные часы. Фикстуры синтетические — живых журналов ботов здесь нет.

import { join } from 'node:path';
import { validateConfig, type PultConfig } from '../../src/shared/config.ts';
import type { Exec, ExecResult } from '../../src/collector/util.ts';

export const FIX = join(import.meta.dirname, '../fixtures/collector');
export const NOW = new Date('2026-10-29T10:45:00.000Z');

export function fixtureConfig(patch: Record<string, unknown> = {}): PultConfig {
  return validateConfig({
    host: 'Тестовый сервер',
    timezone: 'Europe/Moscow',
    intervalSec: 60,
    botsRoot: join(FIX, 'home/.msb/bots'),
    bots: [
      { id: 'alpha', name: 'Альфа', unit: 'msb-bot@alpha.service', projects: ['Демо'] },
      { id: 'beta', name: 'Бета', unit: 'msb-bot@beta.service', projects: ['Инструменты'] },
      { id: 'gamma', name: 'Гамма', unit: 'msb-bot@gamma.service', projects: [] },
    ],
    services: [
      { id: 'heavy', name: 'Проверки демо', unit: 'heavy.service', project: 'Демо' },
      { id: 'web', name: 'Сайт', unit: 'web.service', project: 'демо' },
      { id: 'opt', name: 'Необязательная', unit: 'opt.service', project: null, optional: true },
      { id: 'down', name: 'Почта', unit: 'down.service', project: null },
    ],
    platformUnits: ['msb-sync.timer', 'msb-engine-tick.timer'],
    timers: [
      { id: 'xcollect', name: 'Сбор постов X', timer: 'xcollect.timer', service: 'xcollect.service', bot: 'beta', project: 'Демо', expect: 'пополняет ленту', statusFile: join(FIX, 'x-status.json') },
      { id: 'backup', name: 'Резервная копия', timer: 'backup.timer', service: 'backup.service', bot: 'server', project: null, expect: 'копия раз в сутки' },
    ],
    taskRules: [
      { match: '^Разработка', project: 'Демо' },
      { match: 'Разработка демо', expect: 'итог этапа в чат', pulseFile: join(FIX, 'pulse.json'), repo: '/srv/demo' },
      { match: 'тревога', project: 'Демо', expect: 'сообщит, если фон завис' },
    ],
    registry: { projects: join(FIX, 'registry/projects.json'), asks: join(FIX, 'registry/asks.json') },
    balances: {
      proxyapi: { file: join(FIX, 'proxyapi-balance.json'), lowRub: 50 },
      apify: { file: join(FIX, 'x-status.json') },
      deepgram: { command: ['deepgram-fake', 'balance', '--json'], everyMin: 60 },
    },
    thresholds: { memPct: 90, diskPct: 90, heavyServiceMemMb: 2048, heavyServiceCores: 0.5, missedRunsWarn: 3, expensiveTaskTokens24h: 5_000_000 },
    ...patch,
  }, 'fixture');
}

/** Блоки `systemctl show` по юнитам; неизвестный юнит — not-found, как у настоящего systemctl. */
export const UNITS: Record<string, string> = {
  'msb-bot@alpha.service': `Result=success
NRestarts=0
ControlGroup=/system.slice/bot-alpha.service
MemoryCurrent=3250000000
CPUUsageNSec=753089157000
LoadState=loaded
ActiveState=active
SubState=running
ActiveEnterTimestamp=Wed 2026-10-28 20:25:21 UTC
StateChangeTimestamp=Wed 2026-10-28 20:25:21 UTC`,
  'msb-bot@beta.service': `LoadState=loaded
ActiveState=active
SubState=running
Result=success
NRestarts=1
ControlGroup=/system.slice/bot-beta.service
MemoryCurrent=900000000
CPUUsageNSec=100000000000
ActiveEnterTimestamp=Wed 2026-10-28 20:25:21 UTC`,
  'msb-bot@gamma.service': `LoadState=loaded
ActiveState=failed
SubState=failed
Result=exit-code
NRestarts=3
ControlGroup=
MemoryCurrent=[not set]
CPUUsageNSec=[not set]
ActiveEnterTimestamp=Wed 2026-10-28 20:25:21 UTC
StateChangeTimestamp=Thu 2026-10-29 09:00:00 UTC`,
  'heavy.service': `LoadState=loaded
ActiveState=active
Result=success
NRestarts=0
ControlGroup=/system.slice/heavy.service
MemoryCurrent=5624000000
CPUUsageNSec=43902810000000
ActiveEnterTimestamp=Wed 2026-10-28 21:02:51 UTC`,
  'web.service': `LoadState=loaded
ActiveState=active
Result=success
NRestarts=0
ControlGroup=
MemoryCurrent=52428800
CPUUsageNSec=10000000
ActiveEnterTimestamp=Wed 2026-10-28 20:25:13 UTC`,
  'down.service': `LoadState=loaded
ActiveState=failed
Result=exit-code
NRestarts=0
ControlGroup=
MemoryCurrent=[not set]
CPUUsageNSec=48158242804000
ActiveEnterTimestamp=Wed 2026-10-28 21:02:51 UTC
StateChangeTimestamp=Thu 2026-10-29 09:30:00 UTC`,
  'msb-sync.timer': `Unit=msb-sync.service
LoadState=loaded
ActiveState=active
Result=success`,
  'msb-engine-tick.timer': `Unit=msb-engine-tick.service
LoadState=loaded
ActiveState=active
Result=success`,
  'msb-sync.service': 'Result=success\nLoadState=loaded\nActiveState=inactive',
  'msb-engine-tick.service': 'Result=exit-code\nLoadState=loaded\nActiveState=failed',
  'xcollect.timer': `Unit=xcollect.service
TimersCalendar={ OnCalendar=*-*-* 00/3:20:00 ; next_elapse=Thu 2026-10-29 12:20:00 UTC }
NextElapseUSecRealtime=Thu 2026-10-29 12:22:12 UTC
LastTriggerUSec=
RandomizedDelayUSec=5min
LoadState=loaded
ActiveState=active`,
  'xcollect.service': `Result=success
ExecMainStartTimestamp=
ExecMainExitTimestamp=
LoadState=loaded
ActiveState=inactive`,
  'backup.timer': `Unit=backup.service
TimersCalendar={ OnCalendar=*-*-* 03:00:00 ; next_elapse=Fri 2026-10-30 03:00:00 UTC }
NextElapseUSecRealtime=Fri 2026-10-30 03:16:19 UTC
LastTriggerUSec=Thu 2026-10-29 03:08:09 UTC
RandomizedDelayUSec=30min
LoadState=loaded
ActiveState=active`,
  'backup.service': `Result=success
ExecMainStartTimestamp=Thu 2026-10-29 03:08:14 UTC
ExecMainExitTimestamp=Thu 2026-10-29 03:12:02 UTC
LoadState=loaded
ActiveState=inactive`,
};

export function showOutput(units: string[], blocks: Record<string, string> = UNITS): string {
  return units.map(u => `Id=${u}\n${blocks[u] ?? 'LoadState=not-found\nActiveState=inactive\nResult=success'}`).join('\n\n') + '\n';
}

const us = (iso: string) => String(Date.parse(iso) * 1000);
export const BACKUP_JOURNAL = [
  { __REALTIME_TIMESTAMP: us('2026-10-28T03:05:00Z'), SYSLOG_IDENTIFIER: 'systemd', MESSAGE: 'Starting backup.service - Резервная копия...' },
  { __REALTIME_TIMESTAMP: us('2026-10-28T03:05:30Z'), SYSLOG_IDENTIFIER: 'backup.sh', MESSAGE: 'Started copying files' },
  { __REALTIME_TIMESTAMP: us('2026-10-28T03:09:00Z'), SYSLOG_IDENTIFIER: 'systemd', MESSAGE: 'backup.service: Deactivated successfully.' },
  { __REALTIME_TIMESTAMP: us('2026-10-28T03:09:00Z'), SYSLOG_IDENTIFIER: 'systemd', MESSAGE: 'Finished backup.service - Резервная копия.' },
  { __REALTIME_TIMESTAMP: us('2026-10-29T03:08:14Z'), SYSLOG_IDENTIFIER: 'systemd', MESSAGE: 'Starting backup.service - Резервная копия...' },
  { __REALTIME_TIMESTAMP: us('2026-10-29T03:12:02Z'), SYSLOG_IDENTIFIER: 'systemd', MESSAGE: 'backup.service: Deactivated successfully.' },
].map(e => JSON.stringify(e)).join('\n') + '\n';

export const GIT_LOG = [
  'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0\t2026-10-29T13:23:00+03:00\tТесты на выживших',
  'b1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0\t2026-10-29T09:17:00+03:00\tКоммит утра',
  'c1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0\t2026-10-28T23:30:00+03:00\tПоздний коммит',
].join('\n') + '\n';

export const DEEPGRAM_OUT = '{"balances":[{"amount":199.89790582,"units":"usd"}]}\n';

export interface FakeExec extends Exec {
  calls: { cmd: string; args: string[] }[];
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', error: null });

/** Поддельный запуск команд; overrides — подменить ответ для команды целиком. */
export function fakeExec(overrides: Record<string, (args: string[]) => ExecResult> = {}): FakeExec {
  const calls: { cmd: string; args: string[] }[] = [];
  const fn = (async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (overrides[cmd]) return overrides[cmd](args);
    if (cmd === 'systemctl') return ok(showOutput(args.slice(1).filter((a, i, all) => a !== '-p' && all[i - 1] !== '-p')));
    if (cmd === 'journalctl') return ok(args[1] === 'backup.service' ? BACKUP_JOURNAL : '');
    if (cmd === 'git') return ok(args.includes('-1') ? GIT_LOG.split('\n')[0] + '\n' : GIT_LOG);
    if (cmd === 'getconf') return ok('100\n');
    if (cmd === 'deepgram-fake') return ok(DEEPGRAM_OUT);
    return { code: null, stdout: '', stderr: '', error: `команда не найдена: ${cmd}` };
  }) as FakeExec;
  fn.calls = calls;
  return fn;
}
