/**
 * Shared command/callback read options and the old OC typing/loading presentation.
 * [Command](./bot.mjs), [route](./routes/skills.mjs), [catalog](../skills/catalog.mjs).
 * [UI checks](../../tests/skills-openclaw.test.mjs); no loading-edit fallback message.
 */
import {currentCallbackRender,callbackTransportSignal} from '../../shared/callback-renders.mjs';
export const skillReadOptions=(bot,signal)=>({readProvider:bot[Symbol.for('msb.skillsProvider')],readOpenClaw:bot[Symbol.for('msb.openClawSkillsReader')],signal});
export async function prepareSkillRead(bot,state,{chatId,msgId,signal}={}) {
  const scope=currentCallbackRender(bot,chatId);
  const current=()=>!signal?.aborted && (!scope || scope.isCurrent());
  if(!current())return false;
  if(state.engine==='oc') {
    try{await bot.api.sendChatAction(chatId,'typing',{},scope?callbackTransportSignal(scope):undefined);}catch{}
    if(msgId && current()) {
      const edit=()=>bot.api.editMessageText(chatId,msgId,'⏳ Загружаю навыки…',{parse_mode:'HTML'},scope?callbackTransportSignal(scope):undefined);
      try{await(scope?scope.render(edit):edit());}catch{/* Old loading edit is best effort; do not send an extra loading message. */}
    }
  }
  return current();
}
