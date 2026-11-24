/**
 * Core project routing → provider store + session switch + optional model.
 * Registered on Bot as msb.applyProjectRoute / msb.routingProviders.
 * Core admit → [.msb/bot/src/projects/routing.mjs](../../../.msb/bot/src/projects/routing.mjs).
 */
import os from 'node:os';
import { PROVIDERS, getProvider, isProviderId } from './providers.mjs';
import { providerConfigured } from './env.mjs';
import { setActive } from './store.mjs';
import { syncExtAuthGate, hasClaudeCreds } from './setup-bypass.mjs';
import { applyProviderEffort, applyProviderModel } from './apply-model.mjs';
import { listModelsForProvider } from './models-catalog.mjs';

export async function listConfiguredRoutingProviders(state, env = process.env, home = env.HOME || os.homedir()) {
  const out = [];
  if (await hasClaudeCreds(env, home)) out.push('claude');
  for (const provider of PROVIDERS) {
    if (provider.id === 'claude') continue;
    if (await providerConfigured(provider, env, home, state)) out.push(provider.id);
  }
  return out;
}

export async function routingModelAllowed(providerId, modelId, state, env = process.env, home = env.HOME || os.homedir()) {
  if (!isProviderId(providerId) || providerId === 'claude') return true;
  const models = await listModelsForProvider(providerId, env, home).catch(() => []);
  if (!Array.isArray(models) || !models.length) return true;
  const id = String(modelId || '').trim();
  return models.some(row => row === id || row?.id === id || row?.model === id);
}

export async function applyProjectRoute({ provider, model, effort, env = process.env, state } = {}) {
  const home = env.HOME || os.homedir();
  if (!isProviderId(provider)) return { ok: false, error: `неизвестный провайдер: ${provider}` };
  const meta = getProvider(provider);
  if (provider !== 'claude' && !(await providerConfigured(meta, env, home, state))) {
    return { ok: false, error: `провайдер «${provider}» не настроен` };
  }
  if (provider === 'claude' && !(await hasClaudeCreds(env, home))) {
    return { ok: false, error: 'Claude не авторизован' };
  }

  const before = state?.extAuthBypass || 'claude';
  await setActive(provider, env, home);
  const sync = await syncExtAuthGate(env, home, provider === 'claude' ? {} : undefined);
  if (sync?.reason === 'pause-switch-need-claude-setup') {
    return { ok: false, error: 'нужна авторизация Claude' };
  }

  if (model != null && provider !== 'claude') {
    const applied = await applyProviderModel(provider, model, env, home);
    if (!applied?.ok) return { ok: false, error: applied?.error || `модель ${model} для ${provider}` };
  }
  if (effort != null && provider !== 'claude') {
    const applied = await applyProviderEffort(provider, effort, env, home);
    if (!applied?.ok) return { ok: false, error: applied?.error || `effort ${effort} для ${provider}` };
  }
  return { ok: true, switched: before !== provider };
}

export function registerProjectRouting(BotClass, env = process.env) {
  BotClass.prototype[Symbol.for('msb.applyProjectRoute')] = (args) =>
    applyProjectRoute({ ...args, env: args?.env || env });
  BotClass.prototype[Symbol.for('msb.routingProviders')] = (state, callEnv) =>
    listConfiguredRoutingProviders(state, callEnv || env);
  BotClass.prototype[Symbol.for('msb.routingModelAllowed')] = (provider, model, state, callEnv) =>
    routingModelAllowed(provider, model, state, callEnv || env);
}
