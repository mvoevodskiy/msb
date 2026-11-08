/**
 * Old list/selection text, escaped only after fitting visible Telegram content.
 * [Keyboard](./session-list.mjs) retains page10/actions; [Unicode clip](../../history/clip.mjs).
 * [Contract](../../../tests/reference/parity-sessions-contract.txt), [size checks](../../../tests/session-list-size.test.mjs).
 */
import {historyPreview} from '../../history/preview.mjs';
import {clipUtf16} from '../../history/clip.mjs';
import {escapeHtml} from '../edit.mjs';
const normalized=value=>typeof value==='string'?historyPreview(value).toWellFormed().replace(/\s+/g,' ').trim():'';
function short(text,limit) {
  return text.length>limit?clipUtf16(text,Math.max(0,limit-1)).trimEnd()+'…':text;
}
function relativeTime(value,now) {
  const age=now-Date.parse(value);if(!Number.isFinite(age))return '—';
  if(age<60000)return 'только что';
  if(age<3600000)return Math.floor(age/60000)+' мин назад';
  if(age<86400000)return Math.floor(age/3600000)+' ч назад';
  return Math.floor(age/86400000)+' дн назад';
}
export function sessionListText(rows,currentId,{offset,page,pages,total,now}) {
  const data=rows.map(row=>{
    const first=normalized(row.firstPrompt),last=normalized(row.lastPrompt);
    return {first:first || 'без описания',last:last && last!==first?last:'',
      project:row.project?String(row.project).toWellFormed():null,current:row.id===currentId,
      time:relativeTime(row.lastActivity,now),count:Number.isSafeInteger(row.messageCount)&&row.messageCount>=0?row.messageCount:'—'};
  });
  const title=`Сессии (${total})${pages>1?' — стр. '+(page+1):''}:`;
  const lines=(budget,escape)=>data.map((row,i)=>{
    const continuation=row.last?`\n   ↳ остановились на: «${escape(short(row.last,Math.min(120,budget)))}»`:'';
    return `${offset+i+1}. ${escape(short(row.first,Math.min(200,budget)))}${row.current?' ← текущая':''}${continuation}\n   ${row.project?'['+escape(short(row.project,budget))+']':'[workspace]'} · ${row.time} · ${row.count} сообщ.`;
  }).reverse().join('\n\n');
  // Count visible UTF16, not escaped HTML bytes. Keep the ordinary old layout;
  // only an overflowing page reduces caption budgets. All metadata/buttons stay.
  const visibleLength=budget=>(`📋 ${title}\n\n`+lines(budget,value=>value)).length;
  let budget=Infinity;
  if(visibleLength(budget)>4096) {
    let low=16,high=Math.max(200,...data.map(row=>row.project?.length || 0));
    while(low<high){const mid=Math.ceil((low+high)/2);if(visibleLength(mid)<=4096)low=mid;else high=mid-1;}
    budget=low;
  }
  return `📋 <b>Сессии</b> (${total})${pages>1?' — стр. '+(page+1):''}:\n\n`+lines(budget,escapeHtml);
}
export function selectedSessionText(row) {
  const label=typeof row.firstPrompt==='string'&&row.firstPrompt?clipUtf16(historyPreview(row.firstPrompt),200):row.id.slice(0,8)+'...';
  return `✔ Переключился: ${escapeHtml(label)}${row.project?' ['+escapeHtml(row.project)+']':''}`;
}
