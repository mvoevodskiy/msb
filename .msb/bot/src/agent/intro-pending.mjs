/**
 * Durable private journal for a fully prepared Codex introduction handoff.
 * No Telegram context, auth token, or polling state is serialized here.
 * Caller obtains destination/update IDs and normalized prompt from the existing
 * inbox/executeTurn path; this module only stages/claims records and never runs them.
 * cancelId may clear a started record only after its caller has aborted or otherwise
 * retired that runner; the journal cannot infer whether a provider process is alive.
 * release may reset started→prepared only when the caller proves launch never began.
 * [Bootstrap](./codex-bootstrap.mjs) stages, [turn](./turn.mjs) claims,
 * [Telegram](../telegram/bot.mjs) recovers or cancels, [scope](./intro-pending-scope.mjs) fences.
 * [Per-bot root](../paths.mjs) · [cross-process transaction](../../shared/file-lock.mjs) ·
 * [isolated tests](../../tests/intro-pending.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { withFileLock } from '../../shared/file-lock.mjs';
import { botRoot } from '../paths.mjs';
import { isProviderSession } from '../../shared/session-starts.mjs';

const DIR_NAME = 'intro-pending';
const LOCK_NAME = '.intro-pending-transaction';
const MAX_PROMPT_BYTES = 9 * 1024 * 1024;
// JSON may escape each input byte into a six-byte \uXXXX sequence.
const MAX_RECORD_BYTES = MAX_PROMPT_BYTES * 6 + 256 * 1024;
const ID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const TEMP_RE = /^\.tmp-[0-9a-f-]{36}\.json$/i;
const IMMUTABLE_KEYS = [
  'id', 'scope', 'prompt', 'chatId', 'userId', 'threadId', 'incomingMessageId',
  'statusId', 'updateId', 'sourceUpdateIds', 'requireCodex', 'sessionId', 'activeSessionId',
  'project', 'epoch', 'profileDir', 'workspace', 'cwd',
];
const STORED_KEYS = new Set([
  'version', ...IMMUTABLE_KEYS, 'fingerprint', 'status', 'createdAt', 'startedAt', 'cancelledAt',
]);
const NOFOLLOW = constants.O_NOFOLLOW || 0;

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function isObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireInteger(value, { positive = false, nonzero = false } = {}) {
  return Number.isSafeInteger(value) && (!positive || value > 0) && (!nonzero || value !== 0);
}

function requireText(value, max, code, { allowNul = false } = {}) {
  if (typeof value !== 'string' || !value.length || value.length > max || (!allowNul && value.includes('\0'))) throw fail(code);
  return value;
}

function requirePrompt(value) {
  if (typeof value !== 'string' || !value.length) throw fail('INTRO_PENDING_INVALID_PROMPT');
  if (Buffer.byteLength(value, 'utf8') > MAX_PROMPT_BYTES) throw fail('INTRO_PENDING_PROMPT_TOO_LARGE');
  return value;
}

function normalizeInput(input) {
  if (!isObject(input)) throw fail('INTRO_PENDING_INVALID_RECORD');
  const unknown = Object.keys(input).some(key => !IMMUTABLE_KEYS.includes(key));
  if (unknown) throw fail('INTRO_PENDING_INVALID_RECORD');

  const id = requireText(input.id, 36, 'INTRO_PENDING_INVALID_ID');
  if (!ID_RE.test(id)) throw fail('INTRO_PENDING_INVALID_ID');
  const scope = requireText(input.scope, 256, 'INTRO_PENDING_INVALID_RECORD');
  const prompt = requirePrompt(input.prompt);

  if (!requireInteger(input.chatId, { nonzero: true }) ||
      !requireInteger(input.userId, { positive: true }) ||
      !requireInteger(input.incomingMessageId, { positive: true }) ||
      !requireInteger(input.statusId, { positive: true }) ||
      (input.threadId !== undefined && input.threadId !== null && !requireInteger(input.threadId, { positive: true })) ||
      (input.updateId !== undefined && input.updateId !== null && !requireInteger(input.updateId, { nonzero: true })) ||
      !requireInteger(input.epoch) || input.epoch < 0 || typeof input.requireCodex !== 'boolean') {
    throw fail('INTRO_PENDING_INVALID_RECORD');
  }

  const project = input.project === undefined ? null : input.project;
  if (project !== null && (typeof project !== 'string' || project.length > 256 || project.includes('\0'))) {
    throw fail('INTRO_PENDING_INVALID_RECORD');
  }
  const sessionId = input.sessionId === undefined ? null : input.sessionId;
  if (sessionId !== null && !isProviderSession(sessionId, 'codex')) throw fail('INTRO_PENDING_INVALID_SESSION');
  const activeSessionId = input.activeSessionId === undefined ? null : input.activeSessionId;
  if (activeSessionId !== null && !['claude', 'codex'].some(provider => isProviderSession(activeSessionId, provider))) {
    throw fail('INTRO_PENDING_INVALID_ACTIVE_SESSION');
  }

  const profileDir = requireText(input.profileDir, 4096, 'INTRO_PENDING_INVALID_RECORD');
  const workspace = requireText(input.workspace, 4096, 'INTRO_PENDING_INVALID_RECORD');
  const cwd = requireText(input.cwd, 4096, 'INTRO_PENDING_INVALID_RECORD');
  if (![profileDir, workspace, cwd].every(value => path.isAbsolute(value))) {
    throw fail('INTRO_PENDING_INVALID_RECORD');
  }

  const sourceUpdateIds = input.sourceUpdateIds === undefined ? [] : input.sourceUpdateIds;
  if (!Array.isArray(sourceUpdateIds) || sourceUpdateIds.length > 1024 ||
      sourceUpdateIds.some(value => !requireInteger(value, { nonzero: true }))) {
    throw fail('INTRO_PENDING_INVALID_RECORD');
  }
  const uniqueUpdateIds = [...new Set(sourceUpdateIds)];
  const topic = input.threadId != null && input.threadId > 1 ? input.threadId : 0;
  if (scope !== `${input.chatId}:${input.userId}:${topic}`) throw fail('INTRO_PENDING_SCOPE_IDENTITY_MISMATCH');

  return {
    id,
    scope,
    prompt,
    chatId: input.chatId,
    userId: input.userId,
    threadId: input.threadId ?? null,
    incomingMessageId: input.incomingMessageId,
    statusId: input.statusId,
    updateId: input.updateId ?? null,
    sourceUpdateIds: uniqueUpdateIds,
    requireCodex: input.requireCodex,
    sessionId,
    activeSessionId,
    project,
    epoch: input.epoch,
    profileDir,
    workspace,
    cwd,
  };
}

function fingerprint(record) {
  const payload = {};
  for (const key of IMMUTABLE_KEYS) payload[key] = record[key];
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && value.length <= 40;
}

function validateStored(record, expectedId) {
  if (!isObject(record) || Object.keys(record).some(key => !STORED_KEYS.has(key)) ||
      record.version !== 1 || record.id !== expectedId || !['prepared', 'started', 'cancelled'].includes(record.status) ||
      !isIsoDate(record.createdAt) || !/^[0-9a-f]{64}$/.test(record.fingerprint || '')) {
    throw fail('INTRO_PENDING_CORRUPT_RECORD');
  }

  const immutable = {};
  for (const key of IMMUTABLE_KEYS) {
    if (Object.hasOwn(record, key)) immutable[key] = record[key];
  }
  if (record.status === 'cancelled') {
    if (Object.hasOwn(record, 'prompt') || !Object.hasOwn(record, 'cancelledAt') || !isIsoDate(record.cancelledAt)) {
      throw fail('INTRO_PENDING_CORRUPT_RECORD');
    }
    // Cancellation redacts the prompt; retain only its hash for duplicate-ID fencing.
    normalizeInput({ ...immutable, prompt: 'cancelled' });
  } else {
    if (typeof record.prompt !== 'string' || Buffer.byteLength(record.prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw fail('INTRO_PENDING_CORRUPT_RECORD');
    }
    const normalized = normalizeInput(immutable);
    if (record.fingerprint !== fingerprint(normalized)) throw fail('INTRO_PENDING_CORRUPT_RECORD');
    if (record.status === 'started' && !isIsoDate(record.startedAt)) throw fail('INTRO_PENDING_CORRUPT_RECORD');
    if (record.status === 'prepared' && Object.hasOwn(record, 'startedAt')) throw fail('INTRO_PENDING_CORRUPT_RECORD');
  }
  return record;
}

async function rootState(root, { create = false } = {}) {
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('INTRO_PENDING_UNSAFE_ROOT');
  } catch (error) {
    if (error?.code !== 'ENOENT' || !create) {
      if (error?.code === 'ENOENT' && !create) return false;
      throw error?.code === 'ENOENT' ? fail('INTRO_PENDING_UNSAFE_ROOT') : error;
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('INTRO_PENDING_UNSAFE_ROOT');
  }
  return true;
}

async function journalDirectory(root, { create = false } = {}) {
  if (!await rootState(root, { create })) return null;
  const directory = path.join(root, DIR_NAME);
  let directoryEntryChanged = false;
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('INTRO_PENDING_UNSAFE_DIRECTORY');
    if (create && (stat.mode & 0o777) !== 0o700) {
      await fs.chmod(directory, 0o700);
      directoryEntryChanged = true;
    }
    else if ((stat.mode & 0o777) !== 0o700) throw fail('INTRO_PENDING_UNSAFE_DIRECTORY_MODE');
  } catch (error) {
    if (error?.code !== 'ENOENT' || !create) {
      if (error?.code === 'ENOENT' && !create) return null;
      throw error?.code === 'ENOENT' ? fail('INTRO_PENDING_UNSAFE_DIRECTORY') : error;
    }
    await fs.mkdir(directory, { mode: 0o700 });
    directoryEntryChanged = true;
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('INTRO_PENDING_UNSAFE_DIRECTORY');
    if ((stat.mode & 0o777) !== 0o700) {
      await fs.chmod(directory, 0o700);
      directoryEntryChanged = true;
    }
  }

  const rootReal = await fs.realpath(root);
  const directoryReal = await fs.realpath(directory);
  if (path.relative(rootReal, directoryReal) !== DIR_NAME) throw fail('INTRO_PENDING_UNSAFE_DIRECTORY');
  if (directoryEntryChanged) {
    await syncDirectory(directory);
    await syncDirectory(root);
  }
  return directory;
}

async function assertRegularPrivateFile(file) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw fail('INTRO_PENDING_UNSAFE_FILE');
  if ((stat.mode & 0o777) !== 0o600) throw fail('INTRO_PENDING_UNSAFE_FILE_MODE');
  return true;
}

async function readRecord(directory, id) {
  const file = path.join(directory, `${id}.json`);
  if (!await assertRegularPrivateFile(file)) return null;
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_RECORD_BYTES) {
      throw fail('INTRO_PENDING_UNSAFE_FILE');
    }
    const bytes = await handle.readFile();
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let value;
    try { value = JSON.parse(raw); } catch { throw fail('INTRO_PENDING_CORRUPT_RECORD'); }
    return validateStored(value, id);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (['INTRO_PENDING_UNSAFE_FILE', 'INTRO_PENDING_UNSAFE_FILE_MODE', 'INTRO_PENDING_CORRUPT_RECORD',
      'INTRO_PENDING_INVALID_RECORD', 'INTRO_PENDING_INVALID_ID', 'INTRO_PENDING_INVALID_PROMPT',
      'INTRO_PENDING_PROMPT_TOO_LARGE', 'INTRO_PENDING_INVALID_SESSION'].includes(error?.code)) throw error;
    throw fail('INTRO_PENDING_CORRUPT_RECORD');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeAtomic(directory, record) {
  const target = path.join(directory, `${record.id}.json`);
  const existing = await assertRegularPrivateFile(target);
  if (existing && path.basename(target) !== `${record.id}.json`) throw fail('INTRO_PENDING_UNSAFE_FILE');

  const temporary = path.join(directory, `.tmp-${randomUUID()}.json`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function cleanupTemps(directory) {
  let changed = false;
  const names = await fs.readdir(directory);
  for (const name of names) {
    if (!TEMP_RE.test(name)) continue;
    const file = path.join(directory, name);
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (stat.isFile() && !stat.isSymbolicLink()) {
      await fs.unlink(file);
      changed = true;
    }
  }
  if (changed) await syncDirectory(directory);
}

async function cancelRecord(directory, record) {
  if (record.status === 'cancelled') return false;
  const cancelled = { ...record, status: 'cancelled', cancelledAt: new Date().toISOString() };
  delete cancelled.prompt;
  await writeAtomic(directory, cancelled);
  return true;
}

async function readAll(directory) {
  const names = await fs.readdir(directory);
  const records = [];
  for (const name of names) {
    if (TEMP_RE.test(name)) continue;
    const match = /^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.json$/i.exec(name);
    if (!match) continue;
    const record = await readRecord(directory, match[1]);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function withTransaction(root, action, { createRoot = false } = {}) {
  return rootState(root, { create: createRoot }).then(exists => {
    if (!exists) return null;
    return withFileLock(path.join(root, LOCK_NAME), action);
  });
}

export function createIntroPendingJournal(env = process.env) {
  const getRoot = () => path.resolve(botRoot(env));

  return Object.freeze({
    async stage(input) {
      const normalized = normalizeInput(input);
      const record = {
        version: 1,
        ...normalized,
        fingerprint: fingerprint(normalized),
        status: 'prepared',
        createdAt: new Date().toISOString(),
      };
      const root = getRoot();
      const outcome = await withTransaction(root, async () => {
        const directory = await journalDirectory(root, { create: true });
        await cleanupTemps(directory);
        const current = await readRecord(directory, record.id);
        if (current) {
          if (current.fingerprint !== record.fingerprint) throw fail('INTRO_PENDING_ID_CONFLICT');
          return { id: current.id, created: false, status: current.status };
        }
        await writeAtomic(directory, record);
        return { id: record.id, created: true, status: record.status };
      }, { createRoot: true });
      return outcome;
    },

    async list() {
      const root = getRoot();
      try {
        const directory = await journalDirectory(root);
        if (!directory) return [];
        return await readAll(directory);
      } catch (error) {
        // A successfully delivered last record can remove the private directory
        // between lstat, realpath and readdir in a concurrent read.
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },

    async claim(id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('INTRO_PENDING_INVALID_ID');
      const root = getRoot();
      const outcome = await withTransaction(root, async () => {
        const directory = await journalDirectory(root);
        if (!directory) return null;
        await cleanupTemps(directory);
        const record = await readRecord(directory, id);
        if (!record || record.status !== 'prepared') return null;
        const claimed = { ...record, status: 'started', startedAt: new Date().toISOString() };
        await writeAtomic(directory, claimed);
        return claimed;
      });
      return outcome;
    },

    async release(id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('INTRO_PENDING_INVALID_ID');
      const root = getRoot();
      const outcome = await withTransaction(root, async () => {
        const directory = await journalDirectory(root);
        if (!directory) return false;
        await cleanupTemps(directory);
        const record = await readRecord(directory, id);
        if (!record || record.status !== 'started') return false;
        const prepared = { ...record, status: 'prepared' };
        delete prepared.startedAt;
        await writeAtomic(directory, prepared);
        return true;
      });
      return outcome ?? false;
    },

    async remove(id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('INTRO_PENDING_INVALID_ID');
      const root = getRoot();
      const outcome = await withTransaction(root, async () => {
        const directory = await journalDirectory(root);
        if (!directory) return false;
        await cleanupTemps(directory);
        const file = path.join(directory, `${id}.json`);
        if (!await assertRegularPrivateFile(file)) return false;
        await fs.unlink(file);
        await syncDirectory(directory);
        const remaining = await fs.readdir(directory);
        if (!remaining.some(name => name.endsWith('.json') || TEMP_RE.test(name))) {
          await fs.rmdir(directory).catch(error => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error; });
          await syncDirectory(root);
        }
        return true;
      });
      return outcome ?? false;
    },

    async cancelId(id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('INTRO_PENDING_INVALID_ID');
      const root = getRoot();
      const outcome = await withTransaction(root, async () => {
        const directory = await journalDirectory(root);
        if (!directory) return false;
        await cleanupTemps(directory);
        const record = await readRecord(directory, id);
        if (!record) return false;
        return cancelRecord(directory, record);
      });
      return outcome ?? false;
    },

    async cancel(scope) {
      requireText(scope, 256, 'INTRO_PENDING_INVALID_SCOPE');
      const root = getRoot();
      const outcome = await withTransaction(root, async () => {
        const directory = await journalDirectory(root);
        if (!directory) return 0;
        await cleanupTemps(directory);
        const records = await readAll(directory);
        let count = 0;
        for (const record of records) {
          if (record.scope !== scope || record.status !== 'prepared') continue;
          if (await cancelRecord(directory, record)) count++;
        }
        return count;
      });
      return outcome ?? 0;
    },
  });
}
