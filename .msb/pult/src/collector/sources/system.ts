// Сервер: процессор (по разнице двух замеров /proc/stat), нагрузка, память, подкачка, диск, время загрузки.

import { readFileSync, statfsSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { ServerState } from '../../shared/types.ts';
import { iso, sleep, SourceFailure } from '../util.ts';

export interface CpuSample {
  total: number;
  idle: number;
  iowait: number;
}

/** Первая строка «cpu …» из /proc/stat. guest/guest_nice уже входят в user/nice — не складываем. */
export function parseCpuSample(stat: string): CpuSample {
  const line = stat.split('\n').find(l => l.startsWith('cpu '));
  if (!line) throw new SourceFailure('в /proc/stat нет строки cpu');
  const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
  return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle, iowait };
}

/** Время загрузки (btime) из /proc/stat, мс. */
export function parseBootMs(stat: string): number {
  const m = /^btime\s+(\d+)/m.exec(stat);
  if (!m) throw new SourceFailure('в /proc/stat нет btime');
  return Number(m[1]) * 1000;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function cpuUsage(a: CpuSample, b: CpuSample): { cpuPct: number; iowaitPct: number } {
  const total = b.total - a.total;
  if (total <= 0) return { cpuPct: 0, iowaitPct: 0 };
  const idle = b.idle - a.idle;
  const iowait = b.iowait - a.iowait;
  return { cpuPct: round1(Math.max(0, (100 * (total - idle - iowait)) / total)), iowaitPct: round1(Math.max(0, (100 * iowait) / total)) };
}

export function parseLoad1(loadavg: string): number {
  const v = Number(loadavg.trim().split(/\s+/)[0]);
  if (!Number.isFinite(v)) throw new SourceFailure('/proc/loadavg не разобран');
  return v;
}

export interface MemInfo {
  totalMb: number;
  usedMb: number;
  cacheMb: number;
  availMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
}

export function parseMeminfo(text: string): MemInfo {
  const kb: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
    if (m) kb[m[1]] = Number(m[2]);
  }
  if (kb.MemTotal === undefined || kb.MemAvailable === undefined) throw new SourceFailure('в /proc/meminfo нет MemTotal/MemAvailable');
  const mb = (v = 0) => Math.round(v / 1024);
  return {
    totalMb: mb(kb.MemTotal),
    usedMb: mb(kb.MemTotal - kb.MemAvailable),
    cacheMb: mb((kb.Cached ?? 0) + (kb.Buffers ?? 0) + (kb.SReclaimable ?? 0)),
    availMb: mb(kb.MemAvailable),
    swapTotalMb: mb(kb.SwapTotal),
    swapUsedMb: mb((kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0)),
  };
}

export function diskUsage(path: string): { totalGb: number; usedGb: number } {
  const s = statfsSync(path);
  const gb = (blocks: number) => round1((blocks * s.bsize) / 1024 ** 3);
  return { totalGb: gb(s.blocks), usedGb: gb(s.blocks - s.bfree) };
}

export interface SystemReader {
  procRoot: string;
  diskPath: string;
  /** Пауза между замерами процессора на первом тике. */
  firstSampleMs: number;
}

/**
 * Состояние сервера. prev — замер прошлого тика; если его нет, делаем два замера с паузой.
 * Возвращает и новый замер — его нужно передать в следующий вызов.
 */
export async function readServer(r: SystemReader, prev: CpuSample | null): Promise<{ state: ServerState; sample: CpuSample; bootMs: number }> {
  const readStat = () => readFileSync(join(r.procRoot, 'stat'), 'utf8');
  let first = prev;
  if (!first) {
    first = parseCpuSample(readStat());
    await sleep(r.firstSampleMs);
  }
  const stat = readStat();
  const sample = parseCpuSample(stat);
  const bootMs = parseBootMs(stat);
  const mem = parseMeminfo(readFileSync(join(r.procRoot, 'meminfo'), 'utf8'));
  const disk = diskUsage(r.diskPath);
  return {
    sample,
    bootMs,
    state: {
      cores: cpus().length,
      ...cpuUsage(first, sample),
      load1: parseLoad1(readFileSync(join(r.procRoot, 'loadavg'), 'utf8')),
      memTotalMb: mem.totalMb,
      memUsedMb: mem.usedMb,
      memCacheMb: mem.cacheMb,
      memAvailMb: mem.availMb,
      swapTotalMb: mem.swapTotalMb,
      swapUsedMb: mem.swapUsedMb,
      diskTotalGb: disk.totalGb,
      diskUsedGb: disk.usedGb,
      bootAt: iso(bootMs),
    },
  };
}
