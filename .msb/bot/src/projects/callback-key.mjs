/**
 * Project name references: preserve old short project:NAME, bound UTF-8/long names
 * and distinguish a directory named __default__ from the default-workspace action.
 * [Shared codec](../../shared/callback-ref.mjs), [contract](../../tests/reference/parity-projects-contract.txt),
 * [route checks](../../tests/projects.test.mjs). Resolve only against current directory names.
 */
import {nameReference,resolveNameReference} from '../../shared/callback-ref.mjs';
const OPTIONS = {marker:'p~', actionPrefix:'project:', reservedNames:['__default__']};
export function projectReference(name) { return nameReference(name, OPTIONS); }
export function resolveProjectReference(reference, names) { return resolveNameReference(reference, names, OPTIONS); }
