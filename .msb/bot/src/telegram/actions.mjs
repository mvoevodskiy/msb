/**
 * Persist agent choices from [agent routes](./routes/agent.mjs) via [state](../state.mjs).
 * Model/effort keep the native conversation; explicit mode reset invalidates its
 * first-start token. Provider selection/slots belong to overlay, not these setters.
 * Checks: [model conversation](../../tests/model-conversation.test.mjs),
 * [first start/reset fences](../../tests/first-session.test.mjs).
 */
import { invalidateFirstSession } from '../../shared/session-starts.mjs';
import { normalizePermissionMode } from '../../shared/permission-modes.mjs';
import { updateState } from '../state.mjs';

export const MODEL_MAP = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5',
};

export async function applyModelFamily(family) {
  const model = Object.hasOwn(MODEL_MAP, family) ? MODEL_MAP[family] : null;
  if (!model) return null;
  await updateState((s) => {
    s.ccModel = family;
    s.model = model;
    return s;
  });
  return model;
}

export async function applyEffort(value) {
  await updateState((s) => {
    if (value === 'off') {
      delete s.ccEffort;
      delete s.effort;
    } else {
      s.ccEffort = value;
      s.effort = value;
    }
    return s;
  });
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
