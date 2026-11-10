import os from 'node:os';
import { loadStore } from './store.mjs';
import { getProvider } from './providers.mjs';

/** Read-only view of existing CLI selection; no second engine state or login probe. */
export async function buildEngineProviderView(state = {}, env = process.env, home = os.homedir()) {
  if (env.MSB_CC_ONLY === '1' || env.JARVIS_CC_ONLY === '1') return null;
  const store = await loadStore(env, home);
  const provider = getProvider(store.active) || getProvider('claude');
  const codex = getProvider('codex');
  return {
    activeTitle: state.engine === 'oc' ? 'OpenClaw' : provider.title,
    choices: [{ text: `${codex.icon} ${codex.title}${state.engine !== 'oc' && provider.id === codex.id ? ' ✓' : ''}`,
      callback_data: 'ext:conn:set:codex' }],
  };
}

/** Optional bridge: core without the CLI extension exposes no dead Codex button. */
export function registerEngineProviderView(BotClass, env = process.env) {
  BotClass.prototype[Symbol.for('msb.engineProviderView')] = state => buildEngineProviderView(state, env);
}
