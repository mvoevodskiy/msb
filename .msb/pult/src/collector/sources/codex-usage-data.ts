// Per-bot ownership and saved-prompt usage; never return prompts or native content.
// [Aggregation and ccusage](./codex-usage.ts) · [bot writer](../../../../bot/src/autonomy/reminder-runs.mjs)
// · [checks](../../../tests/collector/codex-usage.test.ts).
import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SESSION = /^ext:codex:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {};

export function nativeCodexId(value: unknown): string | null {
  return typeof value === 'string' ? SESSION.exec(value)?.[1]?.toLowerCase() ?? null : null;
}

export function botCodexIdentity(directory: string): { ids: Set<string>; selected: boolean; partial: boolean } {
  let state: Obj;
  try { state = obj(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ids: new Set(), selected: false, partial: false };
    throw new Error('Не удалось прочитать состояние учёта');
  }
  const ids = new Set<string>();
  let partial = false;
  const add = (value: unknown) => { const id = nativeCodexId(value); if (id) ids.add(id); };
  add(state.ccSessionId);
  add(obj(state.parkedCcSessions).codex);
  if (Array.isArray(state.sessionHistory)) for (const raw of state.sessionHistory) {
    const row = obj(raw);
    if ((row.engine === undefined || row.engine === 'cc') && (row.providerId === undefined || row.providerId === 'codex')) add(row.id);
  }
  if (state.codexUsageSessions !== undefined) {
    if (!Array.isArray(state.codexUsageSessions)) partial = true;
    else for (const value of state.codexUsageSessions) { if (!nativeCodexId(value)) partial = true; else add(value); }
  }
  for (const raw of Object.values(obj(state.codexBootstrap))) add(obj(raw).sessionId);
  return { ids, selected: state.extAuthBypass === 'codex', partial };
}

/** Read only the first metadata record of each native session, never conversation entries. */
export function codexEdges(home: string): { children: Map<string, Set<string>>; forkParents: Map<string, string>; partial: boolean } {
  const children = new Map<string, Set<string>>();
  const forkParents = new Map<string, string>();
  let partial = false, files = 0, roots = 0;
  const pending: { directory: string; depth: number }[] = [];
  for (const name of ['sessions', 'archived_sessions']) {
    const directory = join(home, name);
    if (existsSync(directory)) {
      try {
        const info = lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) { partial = true; continue; }
        pending.push({ directory, depth: 0 }); roots++;
      } catch { partial = true; }
    }
  }
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > 8) { partial = true; continue; }
    let entries;
    try { entries = readdirSync(item.directory, { withFileTypes: true }); }
    catch { partial = true; continue; }
    for (const entry of entries) {
      const file = join(item.directory, entry.name);
      if (entry.isSymbolicLink()) { partial = true; continue; }
      if (entry.isDirectory()) { pending.push({ directory: file, depth: item.depth + 1 }); continue; }
      if (entry.name.endsWith('.jsonl.zst')) { partial = true; continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (++files > 100000) return { children, forkParents, partial: true };
      try {
        const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        let text: string;
        try {
          const chunks: Buffer[] = [];
          let offset = 0, found = false;
          while (offset < 2 * 1024 * 1024) {
            const buffer = Buffer.allocUnsafe(64 * 1024);
            const size = readSync(fd, buffer, 0, buffer.length, offset);
            if (!size) break;
            const end = buffer.subarray(0, size).indexOf(10);
            chunks.push(buffer.subarray(0, end < 0 ? size : end));
            offset += size;
            if (end >= 0) { found = true; break; }
          }
          if (!found) throw new Error();
          text = Buffer.concat(chunks).toString('utf8');
        } finally { closeSync(fd); }
        const first = obj(JSON.parse(text)), payload = obj(first.payload), source = obj(payload.source);
        const subagent = obj(source.subagent), spawn = obj(subagent.thread_spawn);
        const child = typeof payload.id === 'string' ? payload.id.toLowerCase() : '';
        if (first.type !== 'session_meta' || !UUID.test(child)) throw new Error();
        const fork = typeof payload.forked_from_id === 'string' ? payload.forked_from_id.toLowerCase() : '';
        if (fork) { if (!UUID.test(fork) || fork === child) throw new Error(); forkParents.set(child, fork); }
        if (payload.thread_source === 'subagent' || Object.keys(subagent).length) {
          const parent = typeof payload.parent_thread_id === 'string' ? payload.parent_thread_id.toLowerCase()
            : typeof spawn.parent_thread_id === 'string' ? spawn.parent_thread_id.toLowerCase() : '';
          if (!UUID.test(parent) || parent === child) throw new Error();
          if (!children.has(parent)) children.set(parent, new Set());
          children.get(parent)!.add(child);
        }
      } catch { partial = true; }
    }
  }
  return { children, forkParents, partial: partial || roots === 0 };
}

export interface SavedUsageRow {
  id: string;
  startedAt: string;
  completedAt: string;
  input: number | null;
  output: number | null;
  cached: number | null;
  incomplete: boolean;
}
export interface SavedUsage { rows: SavedUsageRow[]; unknown: string[]; partial: boolean; hasCodex: boolean }
const count = (x: unknown): number | null => Number.isSafeInteger(x) && Number(x) >= 0 ? Number(x) : null;
const instant = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));

/** Read a bounded snapshot of the per-bot journal; truncation is explicitly partial. */
export async function readSavedCodexUsage(directory: string): Promise<SavedUsage> {
  const file = join(directory, 'autonomy', 'runs.jsonl');
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], unknown: [], partial: true, hasCodex: false };
    throw new Error('Не удалось прочитать журнал фоновых задач');
  }
  let stat;
  try { stat = fstatSync(fd); } catch { closeSync(fd); throw new Error('Не удалось проверить журнал фоновых задач'); }
  if (!stat.isFile()) { closeSync(fd); throw new Error('Журнал фоновых задач не является файлом'); }
  if (!stat.size) { closeSync(fd); return { rows: [], unknown: [], partial: false, hasCodex: false }; }
  const start = Math.max(0, stat.size - 128 * 1024 * 1024);
  const rows = new Map<string, SavedUsageRow | null>();
  const unknown: string[] = [];
  let partial = start > 0, hasCodex = false, first = true;
  const lines = createInterface({ input: createReadStream(file, { fd, autoClose: true, encoding: 'utf8', start, end: stat.size - 1 }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (first && start > 0) { first = false; continue; }
      first = false;
      if (!line.trim()) continue;
      let raw: Obj;
      try { raw = obj(JSON.parse(line)); } catch { partial = true; continue; }
      if (raw.kind !== 'prompt') continue;
      if (raw.providerId !== 'codex' || raw.usageSource !== 'saved-prompt') {
        if (raw.providerId === undefined && instant(raw.ts)) unknown.push(raw.ts);
        else if (raw.providerId === undefined || raw.providerId === 'codex') partial = true;
        continue;
      }
      hasCodex = true;
      if (typeof raw.usageRunId !== 'string' || !UUID.test(raw.usageRunId) || !instant(raw.ts) || !instant(raw.usageCompletedAt)) {
        partial = true; continue;
      }
      const row: SavedUsageRow = { id: raw.usageRunId.toLowerCase(), startedAt: raw.ts,
        completedAt: raw.usageCompletedAt, input: count(raw.usageTokensIn), output: count(raw.usageTokensOut),
        cached: count(raw.usageCachedTokens),
        incomplete: raw.usageAccountingIncomplete === true };
      const existing = rows.get(row.id);
      if (existing === undefined) rows.set(row.id, row);
      else if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
        const { cached: oldCache, ...oldTotal } = existing;
        const { cached: newCache, ...newTotal } = row;
        // Different cache receipts must not erase an otherwise identical total.
        if (JSON.stringify(oldTotal) === JSON.stringify(newTotal)) rows.set(row.id, { ...existing, cached: null });
        else rows.set(row.id, null);
        partial = true;
      }
    }
  } catch { throw new Error('Не удалось прочитать журнал фоновых задач'); }
  return { rows: [...rows.values()].filter((row): row is SavedUsageRow => row !== null), unknown, partial, hasCodex };
}
