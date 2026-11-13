/**
 * Captured pending record + current state → whether a recovered Codex request
 * still belongs to the same profile, project, workspace and session epoch.
 * Called by [turn](./turn.mjs) immediately before claiming and by
 * [Telegram recovery](../telegram/bot.mjs); journal → [pending](./intro-pending.mjs).
 * [Recovery/fence checks](../../tests/codex-bootstrap.test.mjs).
 */
import fs from 'node:fs/promises';
import { projectLocations, resolveProjectCwd } from '../projects/paths.mjs';
import { resolveSelectedCodexProfileDir } from '../../shared/codex-profile.mjs';

export async function introductionPendingCurrent(record, state, env) {
  if (!record || state.engine === 'oc' || state.extAuthBypass !== 'codex' || env.JARVIS_CC_ONLY === '1' ||
      (state.activeProject || null) !== (record.project || null) ||
      (Number.isSafeInteger(state.sessionEpoch) ? state.sessionEpoch : 0) !== record.epoch ||
      projectLocations(env).workspace !== record.workspace) return false;
  const before = record.activeSessionId || null;
  const current = state.ccSessionId || null;
  // Completion may activate the captured introduction only if the ordinary
  // slot was empty. An unrelated ordinary session must never take its place.
  if (before ? current !== before : current && current !== record.sessionId) return false;
  try {
    const profile = await resolveSelectedCodexProfileDir(state, env);
    const cwd = await fs.realpath(await resolveProjectCwd(state, env, record.workspace));
    return profile === record.profileDir && cwd === record.cwd;
  } catch {
    return false;
  }
}
