const EXT_ALLOWED_PREFIXES = ['bot/run.mjs', 'bot/ext/', 'bot/systemd/60-ext-entry.conf'];
const CORE_FORBIDDEN_PREFIXES = [
  'bot/run.mjs',
  'bot/ext/',
  'bot/systemd/60-ext-entry.conf',
  'bots/',
  'workspace/',
  '.env',
];

export function assertSafeRelPath(p) {
  if (!p || typeof p !== 'string') throw new Error('empty path');
  if (pathTraversal(p)) throw new Error(`path traversal: ${p}`);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new Error(`absolute path forbidden: ${p}`);
  return p.replace(/\\/g, '/');
}

function pathTraversal(p) {
  const norm = p.replace(/\\/g, '/');
  return norm.split('/').some((part) => part === '..');
}

export function assertChannelPaths(channel, files) {
  for (const f of files) {
    const p = assertSafeRelPath(f.path);
    if (channel === 'ext') {
      const ok = EXT_ALLOWED_PREFIXES.some((pref) => p === pref || p.startsWith(pref));
      if (!ok) throw new Error(`ext path not allowed: ${p}`);
    } else if (channel === 'core') {
      for (const bad of CORE_FORBIDDEN_PREFIXES) {
        if (p === bad || p.startsWith(bad)) throw new Error(`core path forbidden: ${p}`);
      }
    } else {
      throw new Error(`unknown channel: ${channel}`);
    }
  }
}

export { EXT_ALLOWED_PREFIXES, CORE_FORBIDDEN_PREFIXES };
