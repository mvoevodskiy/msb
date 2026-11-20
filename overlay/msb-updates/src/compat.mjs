/**
 * Совместимость ext ↔ core.
 * versions[] приоритетнее min.
 */
export function isCoreCompatible(installedCore, compatibleCore) {
  if (!compatibleCore) return true;
  if (!installedCore) return false;
  const versions = compatibleCore.versions;
  if (Array.isArray(versions) && versions.length) {
    return versions.includes(installedCore);
  }
  const min = compatibleCore.min;
  if (!min) return true;
  return compareCoreVersions(installedCore, min) >= 0;
}

/** >0 если a новее b; 0 равны; <0 если a старше */
export function compareCoreVersions(a, b) {
  if (a === b) return 0;
  const pa = parsePlatformLike(a);
  const pb = parsePlatformLike(b);
  if (pa && pb) {
    if (pa.major !== pb.major) return pa.major - pb.major;
    if (pa.build !== pb.build) return pa.build - pb.build;
    return pa.prefix.localeCompare(pb.prefix);
  }
  const sa = trySemver(a);
  const sb = trySemver(b);
  if (sa && sb) {
    for (let i = 0; i < 3; i++) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function parsePlatformLike(v) {
  // 2026-10-20-bg-web-oc-session.v27.178
  const m = String(v).match(/^(.*)\.v(\d+)\.(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], major: Number(m[2]), build: Number(m[3]) };
}

function trySemver(v) {
  const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function pickCompatibleExt(releases, installedCore) {
  const list = [...releases].sort((a, b) => String(b.version).localeCompare(String(a.version)));
  for (const rel of list) {
    if (isCoreCompatible(installedCore, rel.compatible_core)) return rel;
  }
  return null;
}
