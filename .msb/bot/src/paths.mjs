import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import profile from '../shared/profile.cjs';

export function homeDir(env = process.env) {
  return env.HOME || os.homedir();
}

export function botId(env = process.env) {
  return profile.botId(env);
}

export function msbRoot(env = process.env) {
  return profile.resolveProfile(env).root;
}

export function botRoot(env = process.env) {
  return path.join(msbRoot(env), 'bots', botId(env));
}

export function statePath(env = process.env) {
  return path.join(botRoot(env), 'state.json');
}

export function sessionDir(env = process.env) {
  return profile.envValue(env, 'MSB_SESSION_DIR') || path.join(botRoot(env), 'sessions');
}

// The legacy actions, schedules, and STOP live beside the session directory.
export function actionRoot(env = process.env) {
  return path.resolve(path.dirname(sessionDir(env)));
}

export function workspaceDir(env = process.env) {
  const workspace = profile.envValue(env, 'MSB_WORKSPACE_DIR');
  if (workspace) return workspace;
  // cwd is bind-mount of workspace in production
  return process.cwd();
}

export function autonomyDir(env = process.env) {
  return env.AUTONOMY_DIR || path.join(msbRoot(env), 'autonomy');
}

export function heartbeatPath(env = process.env) {
  return path.join(botRoot(env), '.heartbeat-ok');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
