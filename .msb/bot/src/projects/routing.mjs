/**
 * Project task-mode routing: settings → mode → provider/model for the next turn.
 * Prepare → [routing-prepare](./routing-prepare.mjs); Telegram → [routes/routing](../telegram/routes/routing.mjs).
 * Overlay may register `msb.applyProjectRoute` / `msb.routingProviders` on Bot.
 * TDR: [project-task-routing](../../../../docs/tdr/project-task-routing.md).
 */
import { loadState, updateState } from '../state.mjs';
import { applyEffort } from '../telegram/actions.mjs';
import { getClaudeModel, cleanClaudeModelId } from '../agent/models.mjs';
import { currentSessionProvider } from './routing-provider.mjs';
import {
  applyRoutingModeState,
  prepareProjectRouting,
  setForcedRoutingMode,
} from './routing-prepare.mjs';
import { ROUTING_MODES, ROUTING_MODE_LABELS, isRoutingMode } from './routing-modes.mjs';
import { normalizeModeToken } from './routing-resolve.mjs';
import { loadProjectRouting } from './routing-load.mjs';
import {
  defaultRoutingDraft,
  deleteProjectRouting,
  formatRoutingSettingsYaml,
  saveProjectRouting,
  setProjectRoutingEnabled,
} from './routing-save.mjs';
import { isRoutingEnabled } from './routing-schema.mjs';

export {
  prepareProjectRouting,
  applyRoutingModeState,
  setForcedRoutingMode,
  loadProjectRouting,
  saveProjectRouting,
  setProjectRoutingEnabled,
  deleteProjectRouting,
  defaultRoutingDraft,
  formatRoutingSettingsYaml,
  isRoutingEnabled,
  ROUTING_MODES,
  ROUTING_MODE_LABELS,
  isRoutingMode,
  normalizeModeToken,
  currentSessionProvider,
};

const APPLY = Symbol.for('msb.applyProjectRoute');
const PROVIDERS = Symbol.for('msb.routingProviders');
const MODEL_OK = Symbol.for('msb.routingModelAllowed');

export async function listRoutingProviders(bot, state, env = process.env) {
  const hook = bot?.[PROVIDERS];
  if (typeof hook === 'function') {
    const listed = await hook(state, env);
    if (Array.isArray(listed) && listed.length) return listed.map(String);
  }
  return ['claude'];
}

/**
 * Prepare + optional provider/model switch before runAgentTurn.
 * @returns {{ok:true, prompt:string, prepared:object}|{ok:false, error:string, prepared?:object}}
 */
export async function admitProjectRouting({ bot, state, text, env = process.env } = {}) {
  const availableProviders = await listRoutingProviders(bot, state, env);
  const prepared = await prepareProjectRouting({
    state,
    text,
    env,
    availableProviders,
    modelAllowed: typeof bot?.[MODEL_OK] === 'function'
      ? (provider, model) => bot[MODEL_OK](provider, model, state, env)
      : undefined,
  });
  if (!prepared.active) return { ok: true, prompt: text, prepared };
  if (prepared.error) return { ok: false, error: prepared.error, prepared };

  await updateState(s => applyRoutingModeState(s, prepared), env);

  const applied = await applyResolvedRoute({ bot, route: prepared.route, env });
  if (!applied.ok) return { ok: false, error: applied.error, prepared };

  return { ok: true, prompt: prepared.prompt, prepared, switched: applied.switched };
}

export async function applyResolvedRoute({ bot, route, env = process.env }) {
  if (!route?.provider) return { ok: true, switched: false };
  const { state } = await loadState(env);
  const previous = currentSessionProvider(state);
  const provider = route.provider;
  const applyHook = bot?.[APPLY];
  const needSwitch = previous !== provider;

  if (provider !== 'claude') {
    if (!needSwitch && route.model == null && route.effort == null) {
      return { ok: true, switched: false };
    }
    if (typeof applyHook !== 'function') {
      return { ok: false, error: `провайдер «${provider}» требует обвязку CLI` };
    }
    const result = await applyHook({
      provider,
      model: route.model != null ? route.model : undefined,
      effort: route.effort != null ? route.effort : undefined,
      env,
      state,
    });
    if (!result?.ok) return { ok: false, error: result?.error || `не удалось включить ${provider}` };
    return { ok: true, switched: Boolean(result.switched ?? needSwitch) };
  }

  if (needSwitch) {
    if (typeof applyHook === 'function') {
      const result = await applyHook({ provider: 'claude', model: route.model, effort: route.effort, env, state });
      if (!result?.ok) return { ok: false, error: result?.error || 'не удалось включить Claude' };
    } else {
      await updateState(s => {
        delete s.extAuthBypass;
        return s;
      }, env);
    }
  }

  if (route.model != null) {
    const known = getClaudeModel(route.model) || getClaudeModel(cleanClaudeModelId(route.model));
    const cliModel = known?.cliModel || known?.key || String(route.model).trim();
    const { state: current } = await loadState(env);
    if (current.ccModel !== cliModel && current.model !== cliModel) {
      await updateState(s => {
        s.ccModel = cliModel;
        s.model = cliModel;
        return s;
      }, env);
    }
  }
  if (route.effort != null) {
    const { state: current } = await loadState(env);
    if (current.ccEffort !== route.effort && current.effort !== route.effort) {
      await applyEffort(route.effort);
    }
  }
  return { ok: true, switched: needSwitch };
}
