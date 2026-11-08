/**
 * Accepted native result -> old bounded per-bot description ledger; mutates only
 * the current [state transaction](../agent/session-result.mjs), never native files.
 * Identity -> [scope](./scope.mjs), display redaction -> [preview](../history/preview.mjs).
 * [Contract](../../tests/reference/parity-sessions-contract.txt), [runner checks](../../tests/session-ledger.test.mjs).
 */
import {isProviderSession} from '../../shared/session-starts.mjs';
import {historyPreview} from '../history/preview.mjs';
import {clipUtf16} from '../history/clip.mjs';
import {entryProvider} from './scope.mjs';

export function recordSessionMetadata(state,{id,providerId,project,prompt,now=Date.now()}) {
  if(!isProviderSession(id,providerId))return false;
  if(state.sessionHistory!==undefined && !Array.isArray(state.sessionHistory))return false;
  const rows=state.sessionHistory || [];
  const matches=rows.flatMap((row,i)=>row?.id===id && (row.engine===undefined || row.engine==='cc')
    && entryProvider(row)===providerId?[i]:[]);
  if(matches.length>1)return false; // Preserve ambiguous/corrupt data instead of choosing another project's row.
  const at=new Date(now).toISOString(),description=clipUtf16(historyPreview(typeof prompt==='string'?prompt:'[multimodal]'),200);
  const next=rows.slice(),index=matches[0];
  if(index!==undefined) {
    const old=rows[index];
    next[index]={...old,lastActivity:at,lastPrompt:description,
      messageCount:Number.isSafeInteger(old.messageCount)&&old.messageCount>=0?old.messageCount+1:old.messageCount,
      engine:old.engine || 'cc',providerId};
  } else next.push({id,startedAt:at,lastActivity:at,messageCount:1,firstPrompt:description,
    ...(project?{project}:{}),engine:'cc',providerId});
  state.sessionHistory=next.slice(-100);
  return true;
}
