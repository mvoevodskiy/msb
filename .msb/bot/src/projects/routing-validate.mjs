/**
 * Runtime checks for a resolved route against available providers / Claude models.
 * Shape already normalized by [routing-schema](./routing-schema.mjs).
 */
import { cleanClaudeModelId, getClaudeModel } from '../agent/models.mjs';
import { isClaudeEffort } from '../agent/effort.mjs';

function fail(message) {
  return Object.assign(new Error(message), { code: 'ROUTING_VALIDATE' });
}

/**
 * @param {object} route {provider,model,effort}
 * @param {object} opts
 * @param {string[]} opts.availableProviders configured provider ids
 * @param {boolean} [opts.claudeOnly]
 * @param {(providerId:string, modelId:string)=>boolean|Promise<boolean>} [opts.modelAllowed]
 */
export async function validateRoute(route, {
  availableProviders = ['claude'],
  claudeOnly = false,
  modelAllowed,
} = {}) {
  if (!route || typeof route !== 'object') throw fail('маршрут пуст');
  const provider = String(route.provider || '').trim();
  if (!provider) throw fail('не задан provider');
  if (claudeOnly && provider !== 'claude') {
    throw fail(`JARVIS_CC_ONLY: режим требует ${provider}, доступен только claude`);
  }
  const available = new Set(availableProviders);
  if (!available.has(provider)) {
    throw fail(`провайдер «${provider}» недоступен. Доступны: ${[...available].join(', ') || '—'}`);
  }
  if (route.model != null) {
    if (provider === 'claude') {
      const id = cleanClaudeModelId(route.model) || String(route.model).trim();
      if (!getClaudeModel(id) && !getClaudeModel(route.model)) {
        throw fail(`неизвестная модель Claude: ${route.model}`);
      }
    } else if (modelAllowed) {
      if (!await modelAllowed(provider, route.model)) {
        throw fail(`модель «${route.model}» недопустима для ${provider}`);
      }
    }
  }
  if (route.effort != null) {
    if (provider === 'claude' && !isClaudeEffort(route.effort)) {
      throw fail(`недопустимый effort Claude: ${route.effort}`);
    }
  }
  return true;
}
