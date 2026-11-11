/**
 * Локальные пакеты вне дерева релиза: <root>/local/ext/<id>/.
 * Загрузка на prepare; onCallback — после штатной обвязки, до passthrough в ядро.
 * Ошибка/несовместимость одного пакета не останавливает остальные и бот.
 * Документация: [local-ext/README.md](./local-ext/README.md).
 * Вызовы: [startup prepare](./integration/startup.mjs),
 * [update-hook](./integration/update-hook.mjs).
 * applyExt не пишет сюда: [update/client](./update/client.mjs), [safe-path](./update/safe-path.mjs).
 * Проверка: [tests/local-ext.test.mjs](./tests/local-ext.test.mjs).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { msbRoot } from './paths.mjs';
import { EXT_MARKER } from './integration/shared.mjs';

/** Версия контракта local-ext в этой обвязке. Пакет с msbApi > этого значения пропускается. */
export const MSB_LOCAL_API = 1;

const MARK = `${EXT_MARKER} local`;

/** @type {{ packages: object[], summary: { ok: number, skip: number, error: number } } | null} */
let state = null;

export function localExtRoot(home, env = process.env) {
  return path.join(msbRoot(home, env), 'local', 'ext');
}

export function getLocalExtSummary() {
  return state?.summary ? { ...state.summary } : { ok: 0, skip: 0, error: 0 };
}

export function formatLocalExtStatus(summary = getLocalExtSummary()) {
  const { ok = 0, skip = 0, error = 0 } = summary || {};
  if (ok === 0 && skip === 0 && error === 0) return null;
  return `local: ${ok} ok / ${skip} skip` + (error ? ` / ${error} error` : '');
}

/** Только для тестов: сброс кэша загрузки. */
export function resetLocalExtState() {
  state = null;
}

function compareId(a, b) {
  return String(a).localeCompare(String(b), 'en');
}

async function readManifest(dir) {
  const raw = await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error('manifest is not an object');
  const id = String(data.id || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new Error('invalid manifest.id');
  const version = String(data.version || '').trim() || '0';
  const msbApi = Number(data.msbApi);
  if (!Number.isFinite(msbApi) || msbApi < 1) throw new Error('invalid manifest.msbApi');
  const order = data.order == null ? null : Number(data.order);
  if (order != null && !Number.isFinite(order)) throw new Error('invalid manifest.order');
  return {
    id,
    version,
    msbApi,
    order,
    onPrepare: data.onPrepare ? String(data.onPrepare) : null,
    onCallback: data.onCallback ? String(data.onCallback) : null,
    onMessage: data.onMessage ? String(data.onMessage) : null,
  };
}

async function listPackageDirs(root) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
}

function resolveEntry(pkgDir, rel) {
  if (!rel) return null;
  const resolved = path.resolve(pkgDir, rel);
  if (!resolved.startsWith(pkgDir + path.sep) && resolved !== pkgDir) {
    throw new Error(`entry escapes package dir: ${rel}`);
  }
  return resolved;
}

async function importHook(fileUrl, hookName) {
  const mod = await import(fileUrl);
  if (typeof mod[hookName] === 'function') return mod[hookName];
  if (typeof mod.default === 'function') return mod.default;
  return null;
}

async function loadOnePackage(pkgDir, dirName, apiVersion, hooks) {
  const manifest = await readManifest(pkgDir);
  if (manifest.id !== dirName) {
    throw new Error(`manifest.id "${manifest.id}" != directory "${dirName}"`);
  }
  if (manifest.msbApi > apiVersion) {
    return { kind: 'skip', reason: `msbApi ${manifest.msbApi} > contract ${apiVersion}`, manifest };
  }
  const loaded = {
    id: manifest.id,
    version: manifest.version,
    msbApi: manifest.msbApi,
    order: manifest.order,
    dir: pkgDir,
    onPrepare: null,
    onCallback: null,
    onMessage: null,
  };
  for (const hookName of ['onPrepare', 'onCallback', 'onMessage']) {
    const rel = manifest[hookName];
    if (!rel) continue;
    const abs = resolveEntry(pkgDir, rel);
    const fn = await importHook(pathToFileURL(abs).href, hookName);
    if (typeof fn !== 'function') throw new Error(`${hookName} export missing in ${rel}`);
    loaded[hookName] = fn;
  }
  if (typeof hooks?.onPackageLoaded === 'function') {
    await hooks.onPackageLoaded({ id: loaded.id, version: loaded.version, dir: pkgDir });
  }
  return { kind: 'ok', package: loaded };
}

/**
 * Обнаружить пакеты, проверить msbApi, загрузить модули, вызвать onPrepare.
 * Нет каталога/пакетов → no-op. Повторный вызов возвращает кэш.
 */
export async function loadLocalExt({
  apiVersion = MSB_LOCAL_API,
  hooks = {},
  home,
  env = process.env,
  root,
  force = false,
} = {}) {
  if (state && !force) return state;

  const summary = { ok: 0, skip: 0, error: 0 };
  const packages = [];
  const extRoot = root || localExtRoot(home, env);

  let dirNames;
  try {
    dirNames = await listPackageDirs(extRoot);
  } catch (err) {
    console.error(`${MARK}: list failed:`, err?.message || err);
    state = { packages, summary, root: extRoot };
    return state;
  }

  const discovered = [];
  for (const name of dirNames) {
    const pkgDir = path.join(extRoot, name);
    try {
      const result = await loadOnePackage(pkgDir, name, apiVersion, hooks);
      if (result.kind === 'skip') {
        summary.skip += 1;
        console.error(`${MARK}: skip ${name}: ${result.reason}`);
        continue;
      }
      discovered.push(result.package);
    } catch (err) {
      summary.error += 1;
      console.error(`${MARK}: load ${name} failed:`, err?.message || err);
    }
  }

  discovered.sort((a, b) => {
    const ao = a.order == null ? Number.POSITIVE_INFINITY : a.order;
    const bo = b.order == null ? Number.POSITIVE_INFINITY : b.order;
    if (ao !== bo) return ao - bo;
    return compareId(a.id, b.id);
  });

  for (const pkg of discovered) {
    if (!pkg.onPrepare) {
      packages.push(pkg);
      summary.ok += 1;
      continue;
    }
    try {
      await pkg.onPrepare({
        apiVersion,
        id: pkg.id,
        version: pkg.version,
        dir: pkg.dir,
        hooks,
        log: (...args) => console.error(`${MARK}[${pkg.id}]`, ...args),
      });
      packages.push(pkg);
      summary.ok += 1;
    } catch (err) {
      summary.error += 1;
      console.error(`${MARK}: onPrepare ${pkg.id} failed:`, err?.message || err);
    }
  }

  state = { packages, summary, root: extRoot };
  const line = formatLocalExtStatus(summary);
  if (line) console.error(`${EXT_MARKER} ${line}`);
  return state;
}

/**
 * Прогнать onCallback загруженных пакетов по порядку.
 * Первый true поглощает событие (как handleCallback обвязки).
 */
export async function runLocalExtCallback(ctx = {}) {
  if (!state?.packages?.length) return false;
  for (const pkg of state.packages) {
    if (!pkg.onCallback) continue;
    try {
      const handled = await pkg.onCallback({
        ...ctx,
        apiVersion: MSB_LOCAL_API,
        id: pkg.id,
        version: pkg.version,
        dir: pkg.dir,
        log: (...args) => console.error(`${MARK}[${pkg.id}]`, ...args),
      });
      if (handled) return true;
    } catch (err) {
      console.error(`${MARK}: onCallback ${pkg.id} failed:`, err?.message || err);
    }
  }
  return false;
}
