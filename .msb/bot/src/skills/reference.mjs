/**
 * Catalog identity -> bounded stateless callback; duplicate relative paths cannot alias roots.
 * [Shared codec](../../shared/callback-ref.mjs), [routes](../telegram/routes/skills.mjs),
 * [identity/Unicode checks](../../tests/skills-read.test.mjs).
 */
import {nameReference,resolveNameReference} from '../../shared/callback-ref.mjs';
const options={marker:'k~',actionPrefix:'skills:content:',maxLiteralChars:0};
const key=row=>JSON.stringify([row.providerId,row.source,row.root || row.fullPath,row.path]);
export function skillReference(row) {
  // Every newly rendered action binds its provider/root, even when the relative path is short.
  return nameReference(key(row),options);
}
export function resolveSkillReference(reference,entries) {
  if(reference.startsWith(options.marker)) {
    const id=resolveNameReference(reference,entries.map(key),options);
    const matches=entries.filter(row=>key(row)===id);
    return matches.length===1?matches[0]:null;
  }
  // Historical literals carry no provider/root identity. Resolve only one known Claude row.
  const matches=entries.filter(row=>row.providerId==='claude' && row.path===reference);
  return matches.length===1?matches[0]:null;
}
