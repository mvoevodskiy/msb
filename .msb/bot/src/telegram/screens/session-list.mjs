/**
 * Old CLI ledger presentation only: pages/number buttons/labels, no native reads.
 * [Wrapper](./sessions.mjs) chooses scope; [routes](../routes/sessions.mjs) select IDs.
 * [Contract](../../../tests/reference/parity-sessions-contract.txt), [checks](../../../tests/sessions.test.mjs).
 */
import {InlineKeyboard} from 'grammy';
import {historyPreview} from '../../history/preview.mjs';
import {sessionReference} from '../../sessions/callback-key.mjs';
import {escapeHtml} from '../edit.mjs';
export const EMPTY_SESSIONS='Нет сохранённых сессий. Напиши что-нибудь, чтобы начать первую.';
const short=(value,limit)=>{
  const text=typeof value==='string'?historyPreview(value).replace(/\s+/g,' ').trim():'';
  return text.length>limit?text.slice(0,Math.max(1,limit-1)).trimEnd()+'…':text;
};
function relativeTime(value,now) {
  const age=now-Date.parse(value);if(!Number.isFinite(age))return '—';
  if(age<60000)return 'только что';
  if(age<3600000)return Math.floor(age/60000)+' мин назад';
  if(age<86400000)return Math.floor(age/3600000)+' ч назад';
  return Math.floor(age/86400000)+' дн назад';
}
export function sessionListScreen(entries,currentId,page=0,{fromMenu=true,now=Date.now()}={}) {
  if(!entries.length)return {text:EMPTY_SESSIONS,keyboard:fromMenu?new InlineKeyboard().text('« Назад','menu:back'):undefined};
  const pages=Math.max(1,Math.ceil(entries.length/10)),current=Math.max(0,Math.min(Number.isFinite(page)?Math.trunc(page):0,pages-1));
  const offset=current*10,rows=entries.slice(offset,offset+10),keyboard=new InlineKeyboard();
  const textRows=rows.map((row,i)=>{
    const first=short(row.firstPrompt,200) || 'без описания',last=short(row.lastPrompt,120);
    const continuation=last && short(row.lastPrompt,1000)!==short(row.firstPrompt,1000)?`\n   ↳ остановились на: «${escapeHtml(last)}»`:'';
    const count=Number.isSafeInteger(row.messageCount)&&row.messageCount>=0?row.messageCount:'—';
    return `${offset+i+1}. ${escapeHtml(first)}${row.id===currentId?' ← текущая':''}${continuation}\n   ${row.project?`[${escapeHtml(row.project)}]`:'[workspace]'} · ${relativeTime(row.lastActivity,now)} · ${count} сообщ.`;
  });
  rows.forEach((row,i)=>{if(i&&i%5===0)keyboard.row();keyboard.text(`${offset+i+1}${row.id===currentId?' ✓':''}`,'session:'+sessionReference(row.id));});
  if(pages>1){
    keyboard.row();if(current>0)keyboard.text(`« ${(current-1)*10+1}-${current*10}`,'sessions:page:'+(current-1));
    if(current<pages-1)keyboard.text(`${(current+1)*10+1}-${Math.min((current+2)*10,entries.length)} »`,'sessions:page:'+(current+1));
  }
  keyboard.row().text('« Назад','menu:back');
  return {text:`📋 <b>Сессии</b> (${entries.length})${pages>1?' — стр. '+(current+1):''}:\n\n${textRows.reverse().join('\n\n')}`,keyboard,disablePreview:true};
}
export function selectedSessionText(row) {
  const label=typeof row.firstPrompt==='string'&&row.firstPrompt?historyPreview(row.firstPrompt).slice(0,200):row.id.slice(0,8)+'...';
  return `✔ Переключился: ${escapeHtml(label)}${row.project?' ['+escapeHtml(row.project)+']':''}`;
}
