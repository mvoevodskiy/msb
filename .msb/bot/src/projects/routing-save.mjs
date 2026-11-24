/**
 * Write `<cwd>/.msb/settings.yaml` for project routing. Validates via schema first.
 * Load → [routing-load](./routing-load.mjs). Wizard → [routes/routing](../telegram/routes/routing.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRoutingSettings } from './routing-schema.mjs';
import { ROUTING_MODES, DEFAULT_ROUTING_ALIASES } from './routing-modes.mjs';
import { loadProjectRouting } from './routing-load.mjs';

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  if (text === '' || /[:#\n\r]|^\s|\s$/.test(text) || ['true', 'false', 'null', '~'].includes(text)) {
    return JSON.stringify(text);
  }
  return text;
}

/**
 * @param {object} settings normalized or raw object with version+routing
 * @returns {string}
 */
export function formatRoutingSettingsYaml(settings) {
  const normalized = normalizeRoutingSettings(settings);
  const { routing } = normalized;
  const lines = [
    '# MSB project routing — режимы задачи → provider/model',
    '# Документ: docs/tdr/project-task-routing.md',
    'version: 1',
    '',
    'routing:',
    `  enabled: ${routing.enabled !== false}`,
    `  default: ${routing.default}`,
    `  apply: ${routing.apply}`,
    '  types:',
  ];
  for (const mode of ROUTING_MODES) {
    const row = routing.types[mode];
    lines.push(`    ${mode}:`);
    lines.push(`      provider: ${yamlScalar(row.provider)}`);
    lines.push(`      model: ${yamlScalar(row.model)}`);
    lines.push(`      effort: ${yamlScalar(row.effort)}`);
  }
  lines.push('  aliases:');
  const extras = Object.entries(routing.aliases)
    .filter(([key, target]) => !ROUTING_MODES.includes(key) && DEFAULT_ROUTING_ALIASES[key] !== target)
    .sort(([a], [b]) => a.localeCompare(b, 'ru'));
  // Keep built-in aliases explicit for human edits; wizard writes the defaults once.
  const aliases = extras.length
    ? extras
    : Object.entries(DEFAULT_ROUTING_ALIASES).sort(([a], [b]) => a.localeCompare(b, 'ru'));
  for (const [alias, target] of aliases) {
    lines.push(`    ${alias}: ${target}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function defaultRoutingDraft(availableProviders = ['claude']) {
  const primary = availableProviders.includes('claude') ? 'claude' : availableProviders[0] || 'claude';
  const code = availableProviders.includes('codex') ? 'codex' : primary;
  const run = availableProviders.includes('cursor') ? 'cursor' : primary;
  return {
    version: 1,
    routing: {
      enabled: true,
      default: 'ask',
      apply: 'sticky',
      types: {
        ask: { provider: primary, model: primary === 'claude' ? 'sonnet' : null, effort: primary === 'claude' ? 'medium' : null },
        make: { provider: code, model: null, effort: code === 'claude' ? 'high' : null },
        study: { provider: primary, model: primary === 'claude' ? 'opus' : null, effort: primary === 'claude' ? 'high' : null },
        check: { provider: primary, model: primary === 'claude' ? 'opus' : null, effort: primary === 'claude' ? 'high' : null },
        run: { provider: run, model: null, effort: null },
      },
      aliases: { ...DEFAULT_ROUTING_ALIASES },
    },
  };
}

/**
 * @param {string} cwd captured project/workspace directory
 * @param {object} settings
 */
export async function saveProjectRouting(cwd, settings) {
  if (typeof cwd !== 'string' || !cwd) {
    throw Object.assign(new Error('нет каталога проекта'), { code: 'ROUTING_PATH' });
  }
  const root = await fs.realpath(cwd);
  const dir = path.join(root, '.msb');
  const file = path.join(dir, 'settings.yaml');
  const text = formatRoutingSettingsYaml(settings);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
  const actual = await fs.realpath(file);
  const relative = path.relative(root, actual);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('файл настроек вне каталога проекта'), { code: 'ROUTING_PATH' });
  }
  return { path: actual, settings: normalizeRoutingSettings(settings) };
}

/** Flip routing.enabled without removing the file. */
export async function setProjectRoutingEnabled(cwd, enabled) {
  const loaded = await loadProjectRouting(cwd);
  if (!loaded) {
    throw Object.assign(new Error('нет файла настроек маршрутизации'), { code: 'ROUTING_MISSING' });
  }
  const next = {
    version: 1,
    routing: {
      ...loaded.settings.routing,
      enabled: Boolean(enabled),
      types: Object.fromEntries(
        Object.entries(loaded.settings.routing.types).map(([mode, row]) => [mode, { ...row }]),
      ),
      aliases: { ...loaded.settings.routing.aliases },
    },
  };
  return saveProjectRouting(cwd, next);
}

export async function deleteProjectRouting(cwd) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const root = await fs.realpath(cwd);
  for (const name of ['settings.yaml', 'settings.yml', 'settings.json']) {
    const candidate = path.join(root, '.msb', name);
    let actual;
    try { actual = await fs.realpath(candidate); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const relative = path.relative(root, actual);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    await fs.unlink(actual);
    return true;
  }
  return false;
}
