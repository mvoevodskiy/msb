import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpuUsage, parseBootMs, parseCpuSample, parseLoad1, parseMeminfo, readServer } from '../../src/collector/sources/system.ts';
import { FIX } from './helpers.ts';

test('/proc/stat: строка cpu и время загрузки', () => {
  const stat = readFileSync(join(FIX, 'proc/stat'), 'utf8');
  assert.deepEqual(parseCpuSample(stat), { total: 10000, idle: 8000, iowait: 500 });
  assert.equal(new Date(parseBootMs(stat)).toISOString(), '2026-10-29T00:00:00.000Z');
  assert.throws(() => parseCpuSample('intr 1\n'), /нет строки cpu/);
  assert.throws(() => parseBootMs('cpu 1 2 3 4\n'), /нет btime/);
});

test('занятость процессора и ожидание диска — по разнице замеров', () => {
  const a = { total: 10000, idle: 8000, iowait: 500 };
  const b = { total: 11000, idle: 8600, iowait: 600 };
  // из 1000 тиков: 600 простоя, 100 ожидания диска → занято 30 %, ожидание 10 %
  assert.deepEqual(cpuUsage(a, b), { cpuPct: 30, iowaitPct: 10 });
  assert.deepEqual(cpuUsage(a, a), { cpuPct: 0, iowaitPct: 0 });
});

test('/proc/meminfo: занято без кэша, кэш, подкачка', () => {
  const m = parseMeminfo(readFileSync(join(FIX, 'proc/meminfo'), 'utf8'));
  assert.deepEqual(m, { totalMb: 9944, usedMb: 2082, cacheMb: 5347, availMb: 7862, swapTotalMb: 4096, swapUsedMb: 307 });
  assert.throws(() => parseMeminfo('MemFree: 1 kB\n'), /MemTotal/);
});

test('/proc/loadavg', () => {
  assert.equal(parseLoad1('2.20 1.50 1.00 3/400 12345\n'), 2.2);
  assert.throws(() => parseLoad1('x'), /не разобран/);
});

test('состояние сервера целиком на фикстуре', async () => {
  const prev = { total: 9000, idle: 7400, iowait: 400 };
  const r = await readServer({ procRoot: join(FIX, 'proc'), diskPath: FIX, firstSampleMs: 0 }, prev);
  assert.equal(r.state.cpuPct, 30);
  assert.equal(r.state.iowaitPct, 10);
  assert.equal(r.state.load1, 2.2);
  assert.equal(r.state.memUsedMb, 2082);
  assert.equal(r.state.bootAt, '2026-10-29T00:00:00.000Z');
  assert.ok(r.state.cores > 0);
  assert.ok(r.state.diskTotalGb > 0 && r.state.diskUsedGb <= r.state.diskTotalGb);
  assert.deepEqual(r.sample, { total: 10000, idle: 8000, iowait: 500 });
  // первый тик без прошлого замера — два замера одного и того же файла → 0 %
  const first = await readServer({ procRoot: join(FIX, 'proc'), diskPath: FIX, firstSampleMs: 0 }, null);
  assert.equal(first.state.cpuPct, 0);
});
