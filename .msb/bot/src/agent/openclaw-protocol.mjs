/**
 * Strict ACP stream -> result, progress and named-session identity.
 * [Runner](openclaw-turn.mjs), [old protocol](../../tests/reference/parity-openclaw-turn-contract.txt).
 */
export function openClawFrames(onStatus) {
  const result={text:'',toolsUsed:[],toolCount:0,context:null};
  function line(raw){
    let frame;
    try{frame=JSON.parse(raw);}catch{return;}
    if(frame?.error){
      result.failed=true;
      result.errorCode=frame.error.data?.acpxCode;
      return;
    }
    if(typeof frame?.acpxSessionId==='string' && frame.acpxSessionId)result.sessionId=frame.acpxSessionId;
    if(frame?.id!=null && typeof frame.result?.stopReason==='string')result.stopReason=frame.result.stopReason;
    if(frame?.id!=null && typeof frame.result?.sessionId==='string' && frame.result.sessionId)result.sessionId=frame.result.sessionId;
    if(frame?.method!=='session/update')return;
    const {sessionId,update}=frame.params ?? {};
    if(typeof sessionId==='string' && sessionId && !result.frameSessionId)result.frameSessionId=sessionId;
    switch(update?.sessionUpdate){
      case 'agent_message_chunk':
        if(update.content?.type==='text' && typeof update.content.text==='string'){
          result.text+=update.content.text;
          onStatus?.({kind:'text',preview:update.content.text.slice(0,80)});
        }
        break;
      case 'agent_thought_chunk':
        onStatus?.({kind:'thinking'});
        break;
      case 'tool_call': {
        const name=String(update.kind ?? update.title ?? 'tool');
        if(!result.toolsUsed.includes(name))result.toolsUsed.push(name);
        result.toolCount++;
        onStatus?.({kind:'tool',name});
        break;
      }
      case 'usage_update':
        if(Number.isSafeInteger(update.used) && update.used>=0 && Number.isSafeInteger(update.size) && update.size>0)
          result.context={contextTokens:update.used,contextWindow:update.size};
        break;
    }
  }
  return {result,line};
}
