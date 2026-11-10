/**
 * Explicit project/default choice → one core state transaction. Native files stay.
 * [Routes/forms](../telegram/routes/projects.mjs) validate via [paths](./paths.mjs).
 * Existing first-turn placement is [shared](../../shared/session-starts.mjs): cancel
 * all old workspace reservations so a late provider cannot park its ID again.
 * [Contract](../../tests/reference/parity-projects-contract.txt), [checks](../../tests/projects.test.mjs).
 */
import {updateState} from '../state.mjs';
import {resolveProjectDirectory} from './paths.mjs';

export async function selectProject(name, env = process.env) {
  if (name !== undefined) await resolveProjectDirectory(name, env);
  return updateState(state => applyProjectSelection(state,name), env);
}

export function applyProjectSelection(state,name) {
  if (name === undefined) delete state.activeProject;
  else state.activeProject = name;
  delete state.ccSessionId;
  delete state.lastCcUsage;
  delete state.parkedCcSessions;
  delete state.pendingCcSessionStarts;
  state.sessionEpoch = (Number.isSafeInteger(state.sessionEpoch) ? state.sessionEpoch : 0) + 1;
  return state;
}
