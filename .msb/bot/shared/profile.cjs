// One source for core, overlay and release entrypoints. No native auth paths here.
// Навигация: [Runtime profile](./README.md) → [entry preload](./preload.mjs).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROFILES = Object.freeze({
  msb: Object.freeze({ id: 'msb', rootLeaf: '.msb', envPrefix: 'MSB_', codexHttpProviderId: 'msb_http', codexMarker: 'msb-ext', codexTitle: 'MSB', osEngine: 'native', lanExample: '192.168.1.10' }),
  jar1: Object.freeze({ id: 'jar1', rootLeaf: '.iia', envPrefix: 'IIA_', codexHttpProviderId: 'iia_http', codexMarker: 'iia-ext', codexTitle: 'IIA', osEngine: 'legacy', lanExample: '192.168.33.203' }),
});

function readReleaseProfile(file = path.join(__dirname, '..', 'runtime-profile.json')) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return 'msb'; throw err; }
  if (!data || !Object.hasOwn(PROFILES, data.profile)) throw Error('Invalid runtime-profile.json: expected profile msb or jar1');
  return data.profile;
}
// Only the release default is static. HOME, bot id and root are always resolved per call.
const releaseDefault = readReleaseProfile();

function envValue(env, key) {
  if (env[key] !== undefined) return env[key];
  if (key.startsWith('MSB_')) return env[`IIA_${key.slice(4)}`];
  return undefined;
}

function resolveProfile(env = process.env, home, defaultProfile = releaseDefault) {
  const id = env.MSB_RUNTIME_PROFILE !== undefined ? env.MSB_RUNTIME_PROFILE
    : env.MSB_BOT_ID !== undefined ? 'msb'
      : env.IIA_BOT_ID !== undefined ? 'jar1' : defaultProfile;
  if (!Object.hasOwn(PROFILES, id)) throw Error(`Unknown runtime profile: ${id}`);
  const selected = PROFILES[id];
  const effectiveHome = home ?? (env.HOME || os.homedir());
  const root = path.resolve(effectiveHome, envValue(env, 'MSB_RUNTIME_ROOT') || selected.rootLeaf);
  return { ...selected, home: effectiveHome, root };
}

function botId(env = process.env) {
  const id = String(envValue(env, 'MSB_BOT_ID') ?? 'default').trim();
  return /^[a-zA-Z0-9_-]{1,32}$/.test(id) ? id : 'default';
}

// Remember only aliases injected into this exact env object. Explicit MSB keys win.
const inheritedAliases = new WeakMap();
function initialize(env = process.env) {
  const profile = resolveProfile(env);
  if (profile.id === 'jar1' && envValue(env, 'MSB_OS_ENGINE') === 'native') {
    throw Error('The jar1 profile does not enable native OS-engine routes');
  }
  if (env.MSB_RUNTIME_PROFILE === undefined) env.MSB_RUNTIME_PROFILE = profile.id;
  const aliases = inheritedAliases.get(env) || new Map();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('IIA_')) continue;
    const canonical = `MSB_${key.slice(4)}`;
    if (env[canonical] === undefined) {
      env[canonical] = value;
      aliases.set(canonical, { key, value });
    }
  }
  inheritedAliases.set(env, aliases);
  if (env.MSB_OS_ENGINE === undefined) env.MSB_OS_ENGINE = profile.osEngine;
  return profile;
}

function setEnvValue(env, key, value) {
  const aliases = inheritedAliases.get(env);
  if (value === undefined) delete env[key];
  else env[key] = value;
  if (key.startsWith('MSB_')) aliases?.delete(key);
  if (!key.startsWith('IIA_')) return;
  const canonical = `MSB_${key.slice(4)}`;
  const alias = aliases?.get(canonical);
  if (env[canonical] !== undefined && (!alias || env[canonical] !== alias.value)) return;
  if (value === undefined) {
    delete env[canonical]; aliases?.delete(canonical);
  } else {
    env[canonical] = value;
    const next = aliases || new Map();
    next.set(canonical, { key, value }); inheritedAliases.set(env, next);
  }
}

function profileEnvKey(key, env = process.env) {
  return key.startsWith('MSB_') ? `${resolveProfile(env).envPrefix}${key.slice(4)}` : key;
}

function shouldSkipVendorUpdate(kind, env = process.env, installedRoot) {
  if (!['puller', 'sync'].includes(kind)) throw Error('Unknown legacy updater');
  const root = kind === 'puller' && env.LIVE_DIR ? path.resolve(env.LIVE_DIR)
    : installedRoot ? path.resolve(installedRoot) : resolveProfile(env).root;
  return fs.existsSync(path.join(root, 'bot', 'OPEN-CORE.md'))
    && envValue(env, `MSB_ALLOW_VENDOR_${kind.toUpperCase()}`) !== '1';
}

exports.resolveProfile = resolveProfile;
exports.envValue = envValue;
exports.botId = botId;
exports.initialize = initialize;
exports.setEnvValue = setEnvValue;
exports.profileEnvKey = profileEnvKey;
exports.readReleaseProfile = readReleaseProfile;
exports.shouldSkipVendorUpdate = shouldSkipVendorUpdate;
