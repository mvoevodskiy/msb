/**
 * Core state + encoded IDs -> provider-owned CLI ledger rows, without I/O/migration.
 * [Ledger](./ledger.mjs), selector and Telegram list share this identity contract.
 * Existing ownership shapes -> [first starts](../../shared/session-starts.mjs).
 * [Old contract](../../tests/reference/parity-sessions-contract.txt).
 */
import {isProviderSession,selectedSessionProvider} from '../../shared/session-starts.mjs';

export function historyProvider(state,env=process.env) {
  if(state.engine==='oc')return null;
  return env.JARVIS_CC_ONLY==='1'?'claude':selectedSessionProvider(state);
}
export function entryProvider(entry) {
  if(!entry || typeof entry!=='object' || typeof entry.id!=='string')return null;
  const implied=/^ext:([a-z]+):/.exec(entry.id)?.[1] || 'claude';
  if(entry.providerId!==undefined && entry.providerId!==implied)return null;
  return isProviderSession(entry.id,implied)?implied:null;
}
export function cliSessionEntries(state,env=process.env) {
  const provider=historyProvider(state,env);
  if(!provider || !Array.isArray(state.sessionHistory))return [];
  return state.sessionHistory.filter(entry=>entry && (entry.engine===undefined || entry.engine==='cc')
    && entryProvider(entry)===provider).slice().reverse();
}
