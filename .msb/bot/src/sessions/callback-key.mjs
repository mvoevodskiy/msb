/** Saved ID -> bounded old session: route. [Shared codec](../../shared/callback-ref.mjs).
 * Resolve against the current provider-owned [rows](./scope.mjs), never an index/native scan.
 * [UI checks](../../tests/sessions.test.mjs), [selector](./selection.mjs).
 */
import {nameReference,resolveNameReference} from '../../shared/callback-ref.mjs';
const OPTIONS={marker:'s~',actionPrefix:'session:'};
export const sessionReference=id=>nameReference(id,OPTIONS);
export const resolveSessionReference=(reference,ids)=>resolveNameReference(reference,ids,OPTIONS);
