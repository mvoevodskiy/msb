/**
 * Old ATA/Dy role: bounded env key reference, shared by list/confirmation/routes.
 * Pure codec → [shared](../../shared/callback-ref.mjs). Current key names resolve refs after restart; no values, registry or file writes.
 * [Screens](../telegram/screens/settings.mjs), [routes](../telegram/routes/settings.mjs),
 * [contract](../../tests/reference/parity-env-callback-contract.txt),
 * [production checks](../../tests/env-callbacks.test.mjs).
 */
import {nameReference,resolveNameReference} from '../../shared/callback-ref.mjs';
const OPTIONS = {marker:'k~', actionPrefix:'settings:env:confirm-delete:', maxLiteralChars:30};
export function envKeyReference(key) { return nameReference(key, OPTIONS); }
export function resolveEnvKeyReference(reference, keys) { return resolveNameReference(reference, keys, OPTIONS); }
