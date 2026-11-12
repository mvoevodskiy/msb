/**
 * Read-only views of every bot under the runtime profile root.
 * Paths: [bot paths](../../bot/src/paths.mjs), list pattern: [bots/manage](../../bot/src/bots/manage.mjs).
 * Does not call bot-ctl, read .env, or open native Claude/Codex conversations.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { msbRoot } from '../../bot/src/paths.mjs';
import { loadState } from '../../bot/src/state.mjs';
import { listProjectNames } from '../../bot/src/projects/files.mjs';
import { projectLocations } from '../../bot/src/projects/paths.mjs';
import { sanitizeState, historyPreview } from './sanitize.mjs';

const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export function botsRoot(env = process.env) {
  return path.join(msbRoot(env), 'bots');
}

export function botEnv(botId, env = process.env) {
  const id = String(botId || '').trim();
  if (!BOT_ID_RE.test(id)) throw Object.assign(new Error(`Некорректный botId: ${botId}`), { code: 'INVALID_BOT_ID' });
  return { ...env, MSB_BOT_ID: id, IIA_BOT_ID: id };
}

export async function listBots(env = process.env) {
  const root = botsRoot(env);
  let names = [];
  try {
    const ents = await fs.readdir(root, { withFileTypes: true });
    names = ents.filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => BOT_ID_RE.test(n));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  names = [...new Set(names)].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
  const out = [];
  for (const id of names) {
    const dir = path.join(root, id);
    let hasState = false;
    let hasEnv = false;
    let mtime = null;
    try {
      await fs.access(path.join(dir, 'state.json'));
      hasState = true;
      mtime = (await fs.stat(path.join(dir, 'state.json'))).mtime.toISOString();
    } catch { /* optional */ }
    try {
      await fs.access(path.join(dir, '.env'));
      hasEnv = true;
    } catch { /* optional */ }
    out.push({ botId: id, hasState, hasEnv, stateMtime: mtime, root: dir });
  }
  return out;
}

export async function getBotState(botId, env = process.env) {
  const scoped = botEnv(botId, env);
  const { state, exists, file } = await loadState(scoped);
  return {
    botId,
    exists,
    file,
    state: sanitizeState(state),
    activeProject: state.activeProject ?? null,
    sessionCount: Array.isArray(state.sessionHistory) ? state.sessionHistory.length : 0,
  };
}

export async function listSessions(botId, env = process.env) {
  const scoped = botEnv(botId, env);
  const { state, exists } = await loadState(scoped);
  const history = Array.isArray(state.sessionHistory) ? state.sessionHistory : [];
  return {
    botId,
    exists,
    activeProject: state.activeProject ?? null,
    ccSessionId: state.ccSessionId ?? null,
    sessions: history.map((row) => sanitizeState(row)),
  };
}

async function readJsonlTail(file, { limit = 50, offset = 0 } = {}) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], total: 0 };
    throw error;
  }
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  const total = lines.length;
  const start = Math.max(0, total - limit - offset);
  const end = Math.max(0, total - offset);
  const slice = lines.slice(start, end);
  const rows = [];
  for (const line of slice) {
    try {
      rows.push(sanitizeState(JSON.parse(line)));
    } catch {
      rows.push({ raw: historyPreview(line) });
    }
  }
  return { rows, total };
}

export async function readDiary(botId, { limit = 50, offset = 0 } = {}, env = process.env) {
  const scoped = botEnv(botId, env);
  const file = path.join(msbRoot(scoped), 'bots', botId, 'chat-diary.jsonl');
  const { rows, total } = await readJsonlTail(file, { limit, offset });
  return { botId, file, total, rows };
}

export async function readTranscriptDay(botId, day, { limit = 100 } = {}, env = process.env) {
  const scoped = botEnv(botId, env);
  const safeDay = String(day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDay)) {
    throw Object.assign(new Error('day must be YYYY-MM-DD'), { code: 'INVALID_DAY' });
  }
  const file = path.join(msbRoot(scoped), 'bots', botId, 'transcripts', `${safeDay}.jsonl`);
  const { rows, total } = await readJsonlTail(file, { limit, offset: 0 });
  return { botId, day: safeDay, file, total, rows };
}

export async function listBotProjects(botId, env = process.env) {
  const scoped = botEnv(botId, env);
  const { state } = await loadState(scoped);
  const names = await listProjectNames(scoped);
  const locations = projectLocations(scoped);
  return {
    botId,
    activeProject: state.activeProject ?? null,
    workspace: locations.workspace,
    projectsRoot: locations.root,
    projects: names,
  };
}

export async function botsOverview(env = process.env) {
  const bots = await listBots(env);
  const locations = projectLocations(env);
  const details = [];
  for (const bot of bots) {
    try {
      const view = await getBotState(bot.botId, env);
      details.push({
        botId: bot.botId,
        hasState: view.exists,
        hasEnv: bot.hasEnv,
        activeProject: view.activeProject,
        sessionCount: view.sessionCount,
        engine: view.state.engine ?? null,
        ccModel: view.state.ccModel ?? view.state.model ?? null,
      });
    } catch (error) {
      details.push({ botId: bot.botId, error: String(error.message || error) });
    }
  }
  return {
    profileRoot: msbRoot(env),
    workspace: locations.workspace,
    projectsRoot: locations.root,
    bots: details,
  };
}
