/**
 * Core state + encoded IDs -> provider-owned CLI ledger rows, without I/O/migration.
 * [Ledger](./ledger.mjs), [selector](./selection.mjs) and [list](../telegram/screens/session-list.mjs)
 * share this identity contract.
 * Existing ownership shapes -> [first starts](../../shared/session-starts.mjs).
 * [Old contract](../../tests/reference/parity-sessions-contract.txt).
 */
import {isProviderSession,selectedSessionProvider} from '../../shared/session-starts.mjs';

export function historyProvider(state,env=process.env) {
  if(state.engine==='oc')return null;
  const provider=selectedSessionProvider(state);
  return env.JARVIS_CC_ONLY==='1' && provider!=='claude'?null:provider;
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
  const rows=state.sessionHistory.filter(entry=>entry && (entry.engine===undefined || entry.engine==='cc')
    && entryProvider(entry)===provider);
  const counts=new Map();for(const row of rows)counts.set(row.id,(counts.get(row.id)||0)+1);
  return rows.filter(row=>counts.get(row.id)===1).reverse();
}
