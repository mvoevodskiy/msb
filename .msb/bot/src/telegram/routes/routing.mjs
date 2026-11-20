/**
 * Mode picker + settings wizard for project routing.
 * Save → [routing-save](../../projects/routing-save.mjs); screens → [routing](../screens/routing.mjs),
 * [routing-wizard](../screens/routing-wizard.mjs).
 */
import { resolveProjectCwd } from '../../projects/paths.mjs';
import {
  applyResolvedRoute,
  isRoutingMode,
  loadProjectRouting,
  listRoutingProviders,
  setForcedRoutingMode,
  ROUTING_MODES,
} from '../../projects/routing.mjs';
import {
  defaultRoutingDraft,
  deleteProjectRouting,
  saveProjectRouting,
  setProjectRoutingEnabled,
} from '../../projects/routing-save.mjs';
import { isRoutingEnabled } from '../../projects/routing-schema.mjs';
import { ROUTING_MODE_LABELS } from '../../projects/routing-modes.mjs';
import { updateState } from '../../state.mjs';
import { routingModeScreen } from '../screens/routing.mjs';
import {
  routingDeleteConfirmScreen,
  routingDisableConfirmScreen,
  routingSettingsHome,
  routingWizardApplyScreen,
  routingWizardConfirmScreen,
  routingWizardDefaultScreen,
  routingWizardModelScreen,
  routingWizardProviderScreen,
} from '../screens/routing-wizard.mjs';
import { escapeHtml } from '../edit.mjs';
import { UNHANDLED } from './shared.mjs';

const WIZARD = 'routing-wizard';

function effortFor(provider, model) {
  if (provider !== 'claude' || !model) return null;
  if (model === 'opus') return 'high';
  if (model === 'haiku') return 'medium';
  return 'medium';
}

async function homeView(state, bot, env) {
  const cwd = await resolveProjectCwd(state, env);
  let loaded = null;
  let error = null;
  try { loaded = await loadProjectRouting(cwd); }
  catch (err) { error = err.message || String(err); }
  return routingSettingsHome({
    loaded,
    cwd,
    projectName: state.activeProject || null,
    mode: state.projectTaskMode || null,
    error,
  });
}

function nextMode(mode) {
  const index = ROUTING_MODES.indexOf(mode);
  return index >= 0 && index < ROUTING_MODES.length - 1 ? ROUTING_MODES[index + 1] : null;
}

function wizardDraft(pending, chatId) {
  return pending.get(chatId) === WIZARD ? pending.payload(chatId) : null;
}

function beginWizard(pending, chatId, draft, providers) {
  pending.set(chatId, WIZARD);
  pending.advance(chatId, WIZARD, { step: 'default', draft, providers });
}

export async function handleRoutingRoute({
  data, state, show, bot, pending, chatId, env = process.env,
}) {
  if (data === 'settings:routing' || data === 'settings:routing:wiz:cancel') {
    pending?.delete?.(chatId);
    return show(await homeView(state, bot, env));
  }

  if (data === 'settings:routing:disable') {
    return show(routingDisableConfirmScreen());
  }
  if (data === 'settings:routing:disable:yes') {
    const cwd = await resolveProjectCwd(state, env);
    try { await setProjectRoutingEnabled(cwd, false); }
    catch (error) {
      return show({ text: `❌ ${escapeHtml(error.message)}` });
    }
    const next = await updateState(s => {
      delete s.projectTaskMode;
      delete s.projectTaskModeOnce;
      return s;
    }, env);
    return show(await homeView(next, bot, env));
  }
  if (data === 'settings:routing:enable') {
    const cwd = await resolveProjectCwd(state, env);
    try { await setProjectRoutingEnabled(cwd, true); }
    catch (error) {
      return show({ text: `❌ ${escapeHtml(error.message)}` });
    }
    return show(await homeView(state, bot, env));
  }
  if (data === 'settings:routing:delete') {
    return show(routingDeleteConfirmScreen());
  }
  if (data === 'settings:routing:delete:yes') {
    const cwd = await resolveProjectCwd(state, env);
    await deleteProjectRouting(cwd);
    const next = await updateState(s => {
      delete s.projectTaskMode;
      delete s.projectTaskModeOnce;
      return s;
    }, env);
    return show(await homeView(next, bot, env));
  }

  if (data === 'settings:routing:wiz') {
    const providers = await listRoutingProviders(bot, state, env);
    const cwd = await resolveProjectCwd(state, env);
    const existing = await loadProjectRouting(cwd).catch(() => null);
    const draft = existing
      ? {
        version: 1,
        routing: {
          enabled: true,
          default: existing.settings.routing.default,
          apply: existing.settings.routing.apply,
          types: Object.fromEntries(ROUTING_MODES.map(mode => {
            const row = existing.settings.routing.types[mode];
            return [mode, { provider: row.provider, model: row.model, effort: row.effort }];
          })),
          aliases: { ...existing.settings.routing.aliases },
        },
      }
      : defaultRoutingDraft(providers);
    beginWizard(pending, chatId, draft, providers);
    return show(routingWizardDefaultScreen(draft.routing));
  }

  if (data.startsWith('settings:routing:wiz:default:')) {
    const mode = data.slice('settings:routing:wiz:default:'.length);
    const session = wizardDraft(pending, chatId);
    if (!session || !isRoutingMode(mode)) return show(await homeView(state, bot, env));
    session.draft.routing.default = mode;
    session.step = 'apply';
    pending.advance(chatId, WIZARD, session);
    return show(routingWizardApplyScreen(session.draft.routing));
  }

  if (data.startsWith('settings:routing:wiz:apply:')) {
    const apply = data.slice('settings:routing:wiz:apply:'.length);
    const session = wizardDraft(pending, chatId);
    if (!session || !['sticky', 'once'].includes(apply)) return show(await homeView(state, bot, env));
    session.draft.routing.apply = apply;
    session.step = 'provider:ask';
    pending.advance(chatId, WIZARD, session);
    return show(routingWizardProviderScreen(session.draft.routing, 'ask', session.providers));
  }

  if (data.startsWith('settings:routing:wiz:prov:')) {
    const rest = data.slice('settings:routing:wiz:prov:'.length);
    const sep = rest.indexOf(':');
    const mode = rest.slice(0, sep);
    const provider = rest.slice(sep + 1);
    const session = wizardDraft(pending, chatId);
    if (!session || !isRoutingMode(mode) || !session.providers.includes(provider)) {
      return show(await homeView(state, bot, env));
    }
    const row = session.draft.routing.types[mode] || {};
    session.draft.routing.types[mode] = {
      provider,
      model: provider === 'claude' ? (row.model || 'sonnet') : null,
      effort: provider === 'claude' ? (row.effort || effortFor(provider, row.model || 'sonnet')) : null,
    };
    session.step = `model:${mode}`;
    pending.advance(chatId, WIZARD, session);
    return show(routingWizardModelScreen(session.draft.routing, mode));
  }

  if (data.startsWith('settings:routing:wiz:model:')) {
    const rest = data.slice('settings:routing:wiz:model:'.length);
    const sep = rest.indexOf(':');
    const mode = rest.slice(0, sep);
    const choice = rest.slice(sep + 1);
    const session = wizardDraft(pending, chatId);
    if (!session || !isRoutingMode(mode)) return show(await homeView(state, bot, env));
    const row = session.draft.routing.types[mode];
    if (choice === 'skip') {
      row.model = null;
      row.effort = null;
    } else if (['sonnet', 'opus', 'haiku'].includes(choice)) {
      row.model = choice;
      row.effort = effortFor(row.provider, choice);
    } else {
      return show(await homeView(state, bot, env));
    }
    const following = nextMode(mode);
    if (following) {
      session.step = `provider:${following}`;
      pending.advance(chatId, WIZARD, session);
      return show(routingWizardProviderScreen(session.draft.routing, following, session.providers));
    }
    session.step = 'confirm';
    pending.advance(chatId, WIZARD, session);
    const cwd = await resolveProjectCwd(state, env);
    return show(routingWizardConfirmScreen(session.draft.routing, cwd));
  }

  if (data === 'settings:routing:wiz:save') {
    const session = wizardDraft(pending, chatId);
    if (!session) return show(await homeView(state, bot, env));
    const cwd = await resolveProjectCwd(state, env);
    try {
      session.draft.routing.enabled = true;
      await saveProjectRouting(cwd, session.draft);
    } catch (error) {
      pending.delete(chatId);
      return show({ text: `❌ Не удалось сохранить: ${escapeHtml(error.message)}` });
    }
    pending.delete(chatId);
    return show(await homeView(state, bot, env));
  }

  if (data === 'menu:routing' || data === 'routing:home') {
    const cwd = await resolveProjectCwd(state, env);
    const loaded = await loadProjectRouting(cwd).catch(() => null);
    if (!loaded || !isRoutingEnabled(loaded.settings)) {
      return show(await homeView(state, bot, env));
    }
    return show(routingModeScreen({
      mode: state.projectTaskMode || loaded.settings.routing.default,
      path: loaded.path,
      apply: loaded.settings.routing.apply,
    }));
  }

  if (!data.startsWith('routing:mode:')) return UNHANDLED;
  const mode = data.slice('routing:mode:'.length);
  if (!isRoutingMode(mode)) return;

  const cwd = await resolveProjectCwd(state, env);
  let loaded;
  try { loaded = await loadProjectRouting(cwd); }
  catch (error) {
    return show({ text: `❌ Настройки маршрутизации: ${escapeHtml(error.message)}` });
  }
  if (!loaded) {
    return show({ text: '❌ Нет <code>.msb/settings.yaml</code> — открой Настройки → Маршрутизация.' });
  }
  if (!isRoutingEnabled(loaded.settings)) {
    return show(await homeView(state, bot, env));
  }

  const route = loaded.settings.routing.types[mode];
  const available = await listRoutingProviders(bot, state, env);
  if (!available.includes(route.provider)) {
    return show({
      text: `❌ Режим <b>${escapeHtml(ROUTING_MODE_LABELS[mode])}</b> требует «${escapeHtml(route.provider)}». Доступны: ${escapeHtml(available.join(', '))}`,
    });
  }

  await updateState(s => {
    setForcedRoutingMode(s, mode, loaded.settings.routing.apply);
    return s;
  }, env);

  const applied = await applyResolvedRoute({ bot, route, env });
  if (!applied.ok) {
    return show({ text: `❌ ${escapeHtml(applied.error)}` });
  }

  return show(routingModeScreen({
    mode,
    path: loaded.path,
    apply: loaded.settings.routing.apply,
  }));
}
