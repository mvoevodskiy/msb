/**
 * Old sessions callbacks -> provider-owned row selection or pure list rendering.
 * [Selector](../../sessions/selection.mjs), [screen](../screens/session-list.mjs),
 * [contract](../../../tests/reference/parity-sessions-contract.txt), [checks](../../../tests/sessions.test.mjs).
 * Preserve old pending input ownership on list/page/select; unknown IDs are no-op.
 */
import {sessionsScreen} from '../screens/sessions.mjs';
import {hubScreen} from '../screens/hub.mjs';
import {selectedSessionText} from '../screens/session-list.mjs';
import {selectSavedSession,resetCliConversation} from '../../sessions/selection.mjs';
import {escapeHtml} from '../edit.mjs';
import {UNHANDLED} from './shared.mjs';

export async function handleSessionRoute({data,state,show,ctx,bot,chatId,msgId}) {
  if(data==='menu:sessions')return show(await sessionsScreen(state));
  if(data==='menu:newtask') {
    const next=await resetCliConversation();
    if(next.engine==='oc'){await bot.api.sendMessage(chatId,'Новая сессия. Пиши задачу.');return show(hubScreen());}
    return show({text:'🆕 Новая сессия. Предыдущая сохранена — найдёшь в /sessions.\n\nПиши.'});
  }
  if(data.startsWith('sessions:page:')) {
    const page=parseInt(data.slice(14),10);if(!msgId || !Number.isFinite(page) || state.engine==='oc')return;
    return show(await sessionsScreen(state,process.env,page));
  }
  if(!data.startsWith('session:'))return UNHANDLED;
  let row;
  try {row=await selectSavedSession(data.slice(8));}
  catch(error){
    const text=error?.code==='PROJECT_NOT_FOUND'?`❌ ${escapeHtml(error.message)}`
      :'❌ Не удалось открыть сохранённую сессию. Текущая беседа не изменена.';
    await ctx.reply(text,{parse_mode:'HTML'});return;
  }
  // Persistence already succeeded. A Telegram failure must not be reported as
  // unchanged state; keep it outside the selection-error boundary.
  if(row)return show({text:selectedSessionText(row)});
}
