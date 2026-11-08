/**
 * Persist agent choices from [agent routes](./routes/agent.mjs) via [state](../state.mjs).
 * Model/effort keep the native conversation; explicit mode reset invalidates its
 * first-start token. Provider selection/slots belong to overlay, not these setters.
 * Checks: [model conversation](../../tests/model-conversation.test.mjs),
 * [first start/reset fences](../../tests/first-session.test.mjs).
 */
import { invalidateFirstSession } from '../../shared/session-starts.mjs';
import { normalizePermissionMode } from '../../shared/permission-modes.mjs';
import { getClaudeModel, familyChoice, modelLocked } from '../agent/models.mjs';
import { isClaudeEffort } from '../agent/effort.mjs';
import { updateState, NO_STATE_WRITE } from '../state.mjs';

/** Early open-core compatibility export; choices/locks use shared catalogue. */
export const MODEL_MAP = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  fable: 'claude-fable-5',
};

export async function applyModelFamily(family, version) {
  if (family !== 'fable' && !getClaudeModel(family)) return null;
  let applied = null;
  await updateState(async (s) => {
    const currentVersion = typeof version === 'function' ? await version() : version;
    const option = family === 'fable' ? familyChoice('fable',currentVersion)?.model : getClaudeModel(family);
    if (!option || modelLocked(option,currentVersion)) return NO_STATE_WRITE;
    applied = option.cliModel;
    s.ccModel = applied;
    s.model = applied;
    return s;
  });
  return applied;
}

export async function applyEffort(value) {
  if (!isClaudeEffort(value)) return false;
  await updateState((s) => {
    s.ccEffort = value;
    s.effort = value;
    return s;
  });
  return true;
}

export async function applyPermMode(value) {
  value = normalizePermissionMode(value);
  await updateState((s) => {
    s.permissionMode = value;
    s.permMode = value;
    invalidateFirstSession(s);
    delete s.ccSessionId;
    return s;
  });
}
