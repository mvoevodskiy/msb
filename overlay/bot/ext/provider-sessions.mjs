/**
 * Park inactive CLI conversations in the core state transaction. The provider
 * store's sessions remain last-seen metadata; they are not safe to resume after
 * an explicit reset. Only the active ccSessionId is ever sent to a runner.
 * Navigation: [Provider integration](./README.md#выбор-и-авторизация).
 */
import { decodeExtSession } from './store.mjs';
import { isProviderId } from './providers.mjs';
import { isProviderSession as matchesProvider } from '../shared/session-starts.mjs';

export function currentSessionProvider(state) {
  const decoded = decodeExtSession(state.ccSessionId);
  if (decoded) return decoded.providerId;
  if (typeof state.ccSessionId === 'string' && !state.ccSessionId.startsWith('ext:')) return 'claude';
  return isProviderId(state.extAuthBypass) ? state.extAuthBypass : 'claude';
}

/** Called only for an actual provider/engine transition inside updateBotState. */
export function switchProviderSession(state, previous, next) {
  const raw = state.parkedCcSessions;
  const parked = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  const current = state.ccSessionId;
  if (previous !== next) {
    if (matchesProvider(current, previous)) parked[previous] = current;
    else delete parked[previous]; // /newtask or /clear must not resurrect the old session.
    if (matchesProvider(parked[next], next)) state.ccSessionId = parked[next];
    else delete state.ccSessionId;
  } else if (!matchesProvider(current, next)) {
    if (matchesProvider(parked[next], next)) state.ccSessionId = parked[next];
    else delete state.ccSessionId;
  }
  delete parked[next]; // Active session has a single source in ccSessionId.
  if (Object.keys(parked).length) state.parkedCcSessions = parked;
  else delete state.parkedCcSessions;
  state.sessionEpoch = (Number.isSafeInteger(state.sessionEpoch) ? state.sessionEpoch : 0) + 1;
}
