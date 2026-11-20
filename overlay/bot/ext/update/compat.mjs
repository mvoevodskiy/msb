export function isCoreCompatible(installedCore, compatibleCore) {
  if (!compatibleCore) return true;
  if (!installedCore) return false;
  if (Array.isArray(compatibleCore.versions) && compatibleCore.versions.length) {
    return compatibleCore.versions.includes(installedCore);
  }
  if (!compatibleCore.min) return true;
  return compareCoreVersions(installedCore, compatibleCore.min) >= 0;
}

export function compareCoreVersions(a, b) {
  if (a === b) return 0;
  const pa = String(a).match(/^(.*)\.v(\d+)\.(\d+)$/);
  const pb = String(b).match(/^(.*)\.v(\d+)\.(\d+)$/);
  if (pa && pb) {
    const dMaj = Number(pa[2]) - Number(pb[2]);
    if (dMaj) return dMaj;
    const dBuild = Number(pa[3]) - Number(pb[3]);
    if (dBuild) return dBuild;
    return pa[1].localeCompare(pb[1]);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
