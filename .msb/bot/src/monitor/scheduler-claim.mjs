/**
 * Non-blocking per-bot monitor tick claim, separate from the metadata lock.
 * [Scheduler](./scheduler.mjs) holds it across collection and digest delivery;
 * [shared lock](../../shared/file-lock.mjs) is released by the OS on exit.
 * [Cross-process checks](../../tests/monitor-scheduler-claim.test.mjs).
 */
import path from 'node:path';
import { monitorDir } from './config.mjs';
import { botId } from '../paths.mjs';
import { tryWithFileLock } from '../../shared/file-lock.mjs';

export function tryMonitorSchedulerClaim(action, env = process.env) {
  return tryWithFileLock(path.join(monitorDir(env), '.scheduler-claims', botId(env)), action);
}
