/**
 * Old CLI ledger presentation only: pages/number buttons/labels, no native reads.
 * [Wrapper](./sessions.mjs) chooses scope; [routes](../routes/sessions.mjs) select IDs.
 * [Contract](../../../tests/reference/parity-sessions-contract.txt), [checks](../../../tests/sessions.test.mjs).
 */
import {InlineKeyboard} from 'grammy';
import {sessionReference} from '../../sessions/callback-key.mjs';
import {sessionListText} from './session-list-text.mjs';
export {selectedSessionText} from './session-list-text.mjs';
export const EMPTY_SESSIONS='Нет сохранённых сессий. Напиши что-нибудь, чтобы начать первую.';
export function sessionListScreen(entries,currentId,page=0,{fromMenu=true,now=Date.now()}={}) {
  if(!entries.length)return {text:EMPTY_SESSIONS,keyboard:fromMenu?new InlineKeyboard().text('« Назад','menu:back'):undefined};
  const pages=Math.max(1,Math.ceil(entries.length/10)),current=Math.max(0,Math.min(Number.isFinite(page)?Math.trunc(page):0,pages-1));
  const offset=current*10,rows=entries.slice(offset,offset+10),keyboard=new InlineKeyboard();
  rows.forEach((row,i)=>{if(i&&i%5===0)keyboard.row();keyboard.text(`${offset+i+1}${row.id===currentId?' ✓':''}`,'session:'+sessionReference(row.id));});
  if(pages>1){
    keyboard.row();if(current>0)keyboard.text(`« ${(current-1)*10+1}-${current*10}`,'sessions:page:'+(current-1));
    if(current<pages-1)keyboard.text(`${(current+1)*10+1}-${Math.min((current+2)*10,entries.length)} »`,'sessions:page:'+(current+1));
  }
  keyboard.row().text('« Назад','menu:back');
  return {text:sessionListText(rows,currentId,{offset,page:current,pages,total:entries.length,now}),keyboard,disablePreview:true};
}
