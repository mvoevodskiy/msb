/**
 * Orchestrate load → resolve → validate for one turn or /type action.
 * Provider switch itself stays outside: [routing](./routing.mjs) + overlay hook.
 */
import { resolveProjectCwd } from './paths.mjs';
import { loadProjectRouting } from './routing-load.mjs';
import { resolveTaskMode } from './routing-resolve.mjs';
import { validateRoute } from './routing-validate.mjs';
import { isRoutingMode } from './routing-modes.mjs';
import { isRoutingEnabled } from './routing-schema.mjs';

/**
 * @param {object} opts
 * @param {object} opts.state
 * @param {string} [opts.text]
 * @param {string|null} [opts.forcedMode]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string[]} [opts.availableProviders]
 * @param {(providerId:string, modelId:string)=>boolean|Promise<boolean>} [opts.modelAllowed]
 */
export async function prepareProjectRouting({
  state,
  text = '',
  forcedMode = null,
  env = process.env,
  availableProviders = ['claude'],
  modelAllowed,
} = {}) {
  const cwd = await resolveProjectCwd(state, env);
  let loaded;
  try { loaded = await loadProjectRouting(cwd); }
  catch (error) {
    return {
      active: true,
      cwd,
      error: error.message || String(error),
      prompt: text,
    };
  }
  if (!loaded) return { active: false, cwd, prompt: text };
  if (!isRoutingEnabled(loaded.settings)) {
    return {
      active: false,
      cwd,
      path: loaded.path,
      settings: loaded.settings,
      disabled: true,
      prompt: text,
    };
  }

  const resolved = resolveTaskMode({
    text,
    stickyMode: state.projectTaskMode,
    onceMode: state.projectTaskModeOnce,
    routing: loaded.settings.routing,
    forcedMode,
  });
  if (resolved.error) {
    return {
      active: true,
      cwd,
      path: loaded.path,
      settings: loaded.settings,
      error: resolved.error,
      prompt: resolved.prompt,
      source: resolved.source,
    };
  }

  try {
    await validateRoute(resolved.route, {
      availableProviders,
      claudeOnly: env.JARVIS_CC_ONLY === '1',
      modelAllowed,
    });
  } catch (error) {
    return {
      active: true,
      cwd,
      path: loaded.path,
      settings: loaded.settings,
      mode: resolved.mode,
      route: resolved.route,
      source: resolved.source,
      error: error.message || String(error),
      prompt: resolved.prompt,
      stickyNext: resolved.stickyNext,
      clearOnce: resolved.clearOnce,
    };
  }

  return {
    active: true,
    cwd,
    path: loaded.path,
    settings: loaded.settings,
    mode: resolved.mode,
    route: resolved.route,
    source: resolved.source,
    prompt: resolved.prompt,
    stickyNext: resolved.stickyNext,
    clearOnce: resolved.clearOnce,
  };
}

/** Persist sticky/once markers after a successful resolve (no provider switch). */
export function applyRoutingModeState(state, prepared) {
  if (!prepared?.active || prepared.error) return state;
  if (prepared.clearOnce) delete state.projectTaskModeOnce;
  if (prepared.settings?.routing?.apply === 'sticky') {
    if (prepared.stickyNext && isRoutingMode(prepared.stickyNext)) state.projectTaskMode = prepared.stickyNext;
    else delete state.projectTaskMode;
  }
  return state;
}

export function setForcedRoutingMode(state, mode, apply) {
  if (!isRoutingMode(mode)) return false;
  if (apply === 'once') {
    state.projectTaskModeOnce = mode;
    return true;
  }
  state.projectTaskMode = mode;
  delete state.projectTaskModeOnce;
  return true;
}
