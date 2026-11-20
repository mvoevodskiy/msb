/**
 * Old OC grouped readonly list, not the CLI folder/card workflow.
 * [Native parser](../../skills/openclaw.mjs), [top view](./skills.mjs),
 * [old/protocol checks](../../../tests/skills-openclaw.test.mjs).
 */
import {escapeHtml} from '../edit.mjs';
const order=['📂 Твои навыки','📁 Проект','🗂 Установленные','📦 Встроенные','🧰 Дополнительные'];
function group(source) {
  if(source==='workspace')return order[0];
  for(const [index,name]of ['project','managed','bundled','extra'].entries())if(source.includes(name))return order[index+1];
  return source?'📦 '+source:'📦 Прочие';
}
function description(value) {
  let text='';
  for(const unit of value.toWellFormed()) {const escaped=escapeHtml(unit);if(text.length+escaped.length>90)break;text+=escaped;}
  return text;
}
export function formatOpenClawSkills(skills) {
  if(!skills.length)return '🧩 <b>Навыки агента</b>\n\nНе удалось получить список навыков от движка — попробуй позже.';
  const visible=skills.filter(row=>row.name.trim().toLowerCase()!=='system');
  if(!visible.length)return '🧩 <b>Навыки агента</b>\n\nПока пусто. Навыки появятся по мере настройки.';
  const groups=new Map();
  for(const row of visible){const name=group(row.source);if(!groups.has(name))groups.set(name,[]);groups.get(name).push(row);}
  const names=[...groups.keys()].sort((a,b)=>(order.indexOf(a)+1 || 99)-(order.indexOf(b)+1 || 99));
  const lines=['🧩 <b>Навыки агента</b>',`Доступно: <b>${visible.length}</b> · агент применяет сам; вручную — <code>/имя</code>`];
  for(const name of names) {
    lines.push('',`<b>${escapeHtml(name)}</b>`);
    for(const row of groups.get(name).sort((a,b)=>a.name.localeCompare(b.name)))lines.push(`[+] <code>${escapeHtml(row.name)}</code>${row.description?' — '+description(row.description):''}`);
  }
  return lines.join('\n');
}
