/**
 * Штатный e1() держит Setup Mode, пока нет Claude OAuth / Anthropic key / authMode.
 * Активный Cursor/Codex/Qwen с ключом должен считаться «подключённым», иначе
 * сообщения уходят в Ru() («AI ещё не подключён») и shim никогда не вызывается.
 *
 * Пишем в state.json authMode=subscription (+ маркер extAuthBypass), бандл не трогаем.
 */
import os from 'node:os';
import { invalidateFirstSession } from '../shared/session-starts.mjs';
import { getProvider } from './providers.mjs';
import { providerConfigured } from './env.mjs';
import { loadStore, setActive, setActiveIf } from './store.mjs';
import { selectedCodexProfileDir } from './codex-native.mjs';
import { updateBotState } from './state-update.mjs';
import { currentSessionProvider, switchProviderSession } from './provider-sessions.mjs';

const MARK = '[msb/ext/setup-bypass]';
export const EXT_AUTH_FLAG = 'extAuthBypass';
export const CODEX_PAUSE_SWITCH = 'codexPauseSwitch';
export function validCodexPauseSwitch(value) {
  return Boolean(value && typeof value === 'object' && typeof value.id === 'string' &&
    /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.revision === 'string' &&
    /^\d+:\d+:\d+$/.test(value.revision) && Number.isSafeInteger(value.sourceEpoch) &&
    (value.phase === 'prepared' || (value.phase === 'committed' && Number.isSafeInteger(value.targetEpoch))));
}

export async function hasClaudeCreds(env = process.env) {
  return !!(
    env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
    env.MSB_ANTHROPIC_API_KEY?.trim() ||
    env.ANTHROPIC_API_KEY?.trim()
  );
}

/**
 * Синхронизирует state.authMode с активным ext-провайдером.
 * The [native login](./integration/native-login.mjs) may submit a verified
 * Codex profile. Recheck the live project in the same state transaction.
 * A [paused Codex → Claude](./codex-pause-switch.mjs) intent uses the same
 * session transition, with a compare-and-set provider selection and recovery.
 * @returns {{ changed: boolean, reason: string, selected?: boolean }}
 */
export async function syncExtAuthGate(env = process.env, home = env.HOME || os.homedir(), { activateCli = false, verifiedCodexProfile, pauseSwitch } = {}) {
  let outcome;
  await updateBotState(async (state) => {
  const store = await loadStore(env, home);
  const intent = validCodexPauseSwitch(state[CODEX_PAUSE_SWITCH]) ? state[CODEX_PAUSE_SWITCH] : null;
  const epoch = Number.isSafeInteger(state.sessionEpoch) ? state.sessionEpoch : 0;
  let claudeOk;
  let provider = getProvider(verifiedCodexProfile ? 'codex' : store.active) || getProvider('claude');
  let pauseCommit = false;
  if (pauseSwitch) {
    claudeOk = await hasClaudeCreds(env);
    if (!intent || intent.id !== pauseSwitch.id || intent.revision !== pauseSwitch.revision) {
      outcome = { changed: false, reason: 'pause-switch-superseded' }; return null;
    }
    if (!claudeOk) { outcome = { changed: false, reason: 'pause-switch-need-claude-setup' }; return null; }
    if (intent.phase === 'committed' && !state[EXT_AUTH_FLAG] && state.engine !== 'oc' &&
        store.active === 'claude' && epoch === intent.targetEpoch) {
      outcome = { changed: false, reason: 'pause-switch-ready', selected: true }; return null;
    }
    if (intent.phase !== 'prepared' || state[EXT_AUTH_FLAG] !== 'codex' || state.engine === 'oc' ||
        epoch !== intent.sourceEpoch || !['codex', 'claude'].includes(store.active)) {
      outcome = { changed: false, reason: 'pause-switch-superseded' }; return null;
    }
    if (store.active === 'codex' && !await setActiveIf('claude', 'codex', env, home)) {
      outcome = { changed: false, reason: 'pause-switch-superseded' }; return null;
    }
    provider = getProvider('claude');
    pauseCommit = true;
  } else if (intent?.phase === 'prepared' && state[EXT_AUTH_FLAG] === 'codex' && state.engine !== 'oc' &&
             epoch === intent.sourceEpoch && store.active === 'claude' && !verifiedCodexProfile) {
    // Recover a process interrupted after store publication, without waking it.
    claudeOk = await hasClaudeCreds(env);
    if (!claudeOk) { outcome = { changed: false, reason: 'pause-switch-need-claude-setup' }; return null; }
    pauseCommit = true;
  }
  const previousProvider = currentSessionProvider(state);
  let sessionSwitched = false;

  if (state?.engine === 'oc' && !activateCli) {
    outcome = { changed: false, reason: 'oc-engine' };
    return null;
  }

  const configured = await providerConfigured(provider, env, home, state);
  if (pauseCommit && !configured) {
    outcome = { changed: false, reason: 'pause-switch-need-claude-setup' }; return null;
  }
  if (verifiedCodexProfile) {
    const directory = await selectedCodexProfileDir(env, home, state).catch(() => null);
    if (!configured || directory !== verifiedCodexProfile) {
      outcome = { changed: false, reason: 'codex-profile-not-ready' };
      return null;
    }
    if (store.active !== 'codex') await setActive('codex', env, home);
  }
  if (claudeOk === undefined) claudeOk = await hasClaudeCreds(env);
  // A transient loss of the selected CLI's credentials must not discard its
  // conversation. The adapter still reports missing auth on the next turn.
  if (provider.id !== 'claude' && !configured && state[EXT_AUTH_FLAG] === provider.id) {
    outcome = { changed: false, reason: 'active-provider-auth-missing' };
    return null;
  }
  let changed = false;
  let reason = 'noop';
  if (state.engine === 'oc' && activateCli && provider.id !== 'claude' && configured) {
    state.engine = 'cc';
    switchProviderSession(state, previousProvider, provider.id);
    sessionSwitched = true;
    changed = true;
    reason = 'select-cli-engine';
  }

  if (provider.id !== 'claude' && configured) {
    if (state.authMode !== 'subscription' || !state.hasSubscriptionAuth || state[EXT_AUTH_FLAG] !== provider.id || previousProvider !== provider.id) {
      state.authMode = 'subscription';
      state.hasSubscriptionAuth = true;
      // Each CLI resumes only its own previously parked conversation.
      if (!sessionSwitched && previousProvider !== provider.id) {
        switchProviderSession(state, previousProvider, provider.id);
      }
      state[EXT_AUTH_FLAG] = provider.id;
      changed = true;
      reason = `bypass:${provider.id}`;
    }
  } else if (state[EXT_AUTH_FLAG]) {
    // Сняли ext-байпас: либо снова Claude, либо ключ пропал.
    // Never give Claude a foreign CLI session; restore its own if parked.
    if (provider.id === 'claude') {
      switchProviderSession(state, previousProvider, 'claude');
    } else {
      invalidateFirstSession(state);
      delete state.ccSessionId;
    }
    delete state[EXT_AUTH_FLAG];
    if (!claudeOk && provider.id === 'claude') {
      if (state.authMode === 'subscription') delete state.authMode;
      if (state.hasSubscriptionAuth) delete state.hasSubscriptionAuth;
      reason = 'clear-bypass-need-claude-setup';
    } else {
      reason = 'clear-bypass-flag';
    }
    changed = true;
  } else if (provider.id === 'claude' && typeof state.ccSessionId === 'string' && state.ccSessionId.startsWith('ext:')) {
    switchProviderSession(state, previousProvider, 'claude');
    changed = true;
    reason = 'drop-foreign-ext-session';
  }

  if (pauseCommit) {
    state[CODEX_PAUSE_SWITCH] = { ...intent, phase: 'committed',
      targetEpoch: Number.isSafeInteger(state.sessionEpoch) ? state.sessionEpoch : 0 };
    changed = true;
  } else if (intent && verifiedCodexProfile) {
    delete state[CODEX_PAUSE_SWITCH];
    changed = true;
  }

  if (changed) {
    console.error(`${MARK} ${reason}`);
  }
  outcome = { changed, reason, ...(verifiedCodexProfile ? { selected: state[EXT_AUTH_FLAG] === 'codex' } : {}),
    ...(pauseCommit ? { selected: true } : {}) };
  return changed ? state : null;
  }, env, home);
  return outcome;
}
