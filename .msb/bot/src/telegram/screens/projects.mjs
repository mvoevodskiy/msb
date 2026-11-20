/**
 * Old project list/form/success presentation only; directory lookup → [files](../../projects/files.mjs).
 * [Routes](../routes/projects.mjs), [commands](../project-commands.mjs), [form](../forms/projects.mjs).
 * [Old contract](../../../tests/reference/parity-projects-contract.txt), [checks](../../../tests/projects.test.mjs).
 */
import {InlineKeyboard} from 'grammy';
import {listProjectNames} from '../../projects/files.mjs';
import {projectReference} from '../../projects/callback-key.mjs';
import {escapeHtml} from '../edit.mjs';
export const PROJECT_PROMPT='Введи название проекта.\n\nЛатиницей, маленькими буквами, без пробелов. Можно цифры, дефис и подчёркивание.\nНапример: <code>youtube-asset</code>';
export const PROJECT_INVALID='❌ Так не подойдёт.\n\nЛатиницей, маленькими буквами, без пробелов. Можно цифры, дефис и подчёркивание.\nНапример: <code>youtube-asset</code>';
export function projectInputScreen() {
  return {text:PROJECT_PROMPT,keyboard:new InlineKeyboard().text('✖ Отмена','menu:cancel_newproject')};
}
export function projectCreatedText(name, {directory, engine} = {}) {
  const head=`✔ Проект <code>${escapeHtml(name)}</code> создан и активирован.${directory?`\n📂 <code>${escapeHtml(directory)}</code>`:''}`;
  // The current OpenClaw runner is absent; do not copy the old claim that it sees files.
  return engine==='oc' ? head : head+'\n\nПиши задачу — агент уже в нём.';
}
export async function projectsScreen(state = {}, page = 0, fromMenu = true, env = process.env) {
  const names=await listProjectNames(env),keyboard=new InlineKeyboard();
  if(!names.length) {
    keyboard.text('➕ Новый проект','menu:newproject');
    if(fromMenu)keyboard.row().text('« Назад','menu:back');
    return {text:'📁 Проектов пока нет.',keyboard};
  }
  const pages=Math.ceil(names.length/9),current=Math.max(0,Math.min(Number.isFinite(page)?Math.trunc(page):0,pages-1));
  const items=[state.activeProject?'  ~/workspace':'▸ ~/workspace — текущий',
    ...names.map(name=>name===state.activeProject?`▸ ${name} — текущий`:`  ${name}`)];
  keyboard.text(state.activeProject?'📂 ~/workspace':'📂 ~/workspace ✓','project:__default__').row();
  names.slice(current*9,(current+1)*9).forEach((name,i)=>{
    if(i&&i%3===0)keyboard.row();
    keyboard.text((name===state.activeProject?'✓ ':'')+name,'project:'+projectReference(name));
  });
  if(pages>1) {
    keyboard.row();
    if(current>0)keyboard.text('◀️','projects:page:'+(current-1));
    keyboard.text(`${current+1}/${pages}`,'noop');
    if(current<pages-1)keyboard.text('▶️','projects:page:'+(current+1));
  }
  keyboard.row().text('➕ Новый проект','menu:newproject').row()
    .text(fromMenu?'« Назад':'✖ Закрыть',fromMenu?'menu:back':'menu:close');
  return {text:`📁 <b>Проекты</b> (${names.length}):\n\n<code>${escapeHtml(items.join('\n'))}</code>\n\nПереключить: /project <i>название</i>`,keyboard};
}
