/**
 * Validate a bounded introduction summary and append it to owner context files.
 * Caller supplies workspace/backup and cancellation; no model or session access.
 * Uses shared physical-file-path/file-lock; checks: tests/intro-memory.test.mjs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withFileLock } from '../../shared/file-lock.mjs';
import { physicalFilePath } from '../../shared/physical-file-path.mjs';

const bad = () => new Error('Invalid introduction summary');
const maxBytes = 16_384;
const unsafe = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]|(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|system|instructions)|(?:ignore|override)\s+(?:all\s+)?(?:instructions|rules)|(?:игнорируй|забудь|отмени)\s+(?:все\s+)?(?:предыдущие|инструкции|правила)|(?:фиктивн\p{L}*|тестов\p{L}*|синтетическ\p{L}*|контрольн\p{L}*)\s+(?:фраз\p{L}*|данн\p{L}*|текст\p{L}*|маркер\p{L}*)|\b(?:(?:test|synthetic|fixture|canary)[-_ ](?:marker|phrase))\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{25,}|AKIA[0-9A-Z]{16})\b|\bBearer\s+[A-Za-z0-9._~-]{12,}|\b\d{7,12}:[A-Za-z0-9_-]{30,}\b|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|пароль|токен|ключ api)\s*[:=]\s*\S+/iu;

export function parseIntroductionSummary(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) throw bad();
  let value;
  try { value = JSON.parse(text); } catch { throw bad(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'memory,save,user,version' ||
      value.version !== 1 || typeof value.save !== 'boolean') throw bad();
  for (const name of ['user', 'memory']) {
    const items = value[name];
    if (!Array.isArray(items) || items.length > 20 || (!value.save && items.length)) throw bad();
    for (const item of items) {
      if (typeof item !== 'string' || item.length > 500 || !item.trim() || unsafe.test(item)) throw bad();
    }
  }
  return { version: 1, save: value.save, user: value.user.map(x => x.trim()), memory: value.memory.map(x => x.trim()) };
}

async function readSnapshot(file) {
  try {
    const [stat, bytes] = await Promise.all([fs.stat(file, { bigint: true }), fs.readFile(file)]);
    if (!stat.isFile()) throw new Error('Introduction target is not a regular file');
    return { stat, bytes };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function equalSnapshot(a, b) {
  if (!a || !b) return a === b;
  return a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino && a.stat.mode === b.stat.mode &&
    a.stat.uid === b.stat.uid && a.stat.gid === b.stat.gid && a.stat.mtimeNs === b.stat.mtimeNs &&
    a.stat.ctimeNs === b.stat.ctimeNs && a.bytes.equals(b.bytes);
}
async function appendFile(logical, items, backupDir, signal) {
  if (!items.length) return;
  const physical = await physicalFilePath(logical);
  const lockId = createHash('sha256').update(physical).digest('hex');
  await withFileLock(path.join(backupDir, lockId), async () => {
    signal?.throwIfAborted();
    if (await physicalFilePath(logical) !== physical) throw new Error('Introduction target changed');
    const before = await readSnapshot(physical);
    const old = before?.bytes.toString('utf8') ?? '';
    if (before && !Buffer.from(old, 'utf8').equals(before.bytes)) throw new Error('Introduction target is not UTF-8');
    const present = new Set(old.split(/\r?\n/).map(line => line.trim().replace(/^[-*] /, '')));
    const added = [...new Set(items)].filter(item => !present.has(item));
    if (!added.length) return;
    const initial = old || (before ? '' : (path.basename(logical) === 'USER.md' ? '# Профиль\n' : '# Память\n'));
    const text = initial + (initial && !initial.endsWith('\n') ? '\n' : '') +
      (initial ? '\n' : '') + '## Знакомство\n\n' + added.map(item => `- ${item}\n`).join('');
    if (before) {
      const backup = path.join(backupDir, `${path.basename(logical)}.${randomUUID()}.bak`);
      await fs.writeFile(backup, before.bytes, { flag: 'wx', mode: 0o600 });
    }
    signal?.throwIfAborted();
    const temp = path.join(path.dirname(physical), `.intro-memory-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', before ? Number(before.stat.mode & 0o7777n) : 0o600);
      await handle.writeFile(text); await handle.sync();
      if (before) {
        await handle.chown(Number(before.stat.uid), Number(before.stat.gid));
        await handle.chmod(Number(before.stat.mode & 0o7777n));
      }
      await handle.close(); handle = undefined;
      signal?.throwIfAborted();
      if (await physicalFilePath(logical) !== physical || !equalSnapshot(before, await readSnapshot(physical))) {
        throw new Error('Introduction target changed during write');
      }
      if (before) await fs.rename(temp, physical);
      else await fs.link(temp, physical);
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  });
}

export async function saveIntroductionSummary({ workspace, backupDir, summary, signal }) {
  const validated = parseIntroductionSummary(JSON.stringify(summary));
  signal?.throwIfAborted();
  if (!validated.save || (!validated.user.length && !validated.memory.length)) return { saved: false };
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || typeof backupDir !== 'string' || !path.isAbsolute(backupDir)) throw new Error('Absolute introduction paths required');
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupStat = await fs.lstat(backupDir);
  if (!backupStat.isDirectory() || (backupStat.mode & 0o777) !== 0o700) throw new Error('Introduction backup directory is not private');
  const physicalBackupDir = await fs.realpath(backupDir);
  signal?.throwIfAborted();
  await appendFile(path.join(workspace, 'USER.md'), validated.user, physicalBackupDir, signal);
  signal?.throwIfAborted();
  await appendFile(path.join(workspace, 'MEMORY.md'), validated.memory, physicalBackupDir, signal);
  return { saved: true };
}
