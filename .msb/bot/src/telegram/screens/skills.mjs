/**
 * Read-only catalog -> old top/folder/card/content/advice views; no metadata writes.
 * [OC grouped view](./openclaw-skills.mjs), [catalog](../../skills/catalog.mjs), [identity](../../skills/reference.mjs),
 * [route](../routes/skills.mjs), [production UI checks](../../../tests/skills-read.test.mjs).
 */
import {InlineKeyboard} from 'grammy';
import {escapeHtml} from '../edit.mjs';
import {clipUtf16} from '../../history/clip.mjs';
import {skillCatalog} from '../../skills/catalog.mjs';
import {skillReference} from '../../skills/reference.mjs';
import {formatOpenClawSkills} from './openclaw-skills.mjs';
const visible=entries=>entries.filter(row=>row.name!=='system');
export function skillsUnavailableScreen() {
  return {text:'🧩 <b>Навыки агента</b>\n\nНе удалось получить список навыков от движка — попробуй позже.',
    keyboard:new InlineKeyboard().text('« Назад','skills:back-menu')};
}
export function skillsTopScreen(catalog,state) {
  if(catalog.kind==='oc')return {text:formatOpenClawSkills(catalog.skills || []),keyboard:new InlineKeyboard().text('« Назад','skills:back-menu')};
  if(!catalog.ok)return skillsUnavailableScreen();
  const rows=visible(catalog.entries),workspace=rows.filter(row=>row.source==='workspace'),project=rows.filter(row=>row.source==='project');
  const keyboard=new InlineKeyboard().text(`📂 workspace (${workspace.length})`,'skills:folder:workspace').row();
  if(project.length)keyboard.text(`📂 ${state.activeProject || 'project'} (${project.length})`,'skills:folder:project').row();
  return {text:'🧩 <b>Навыки</b>\n\nИнструкции и правила, которые расширяют возможности агента.\n⠀',
    keyboard:keyboard.text('« Назад','skills:back-menu')};
}
export async function skillsScreen(state={},env=process.env,options={}) {
  return skillsTopScreen(await skillCatalog(state,{...options,env}),state);
}
export function skillsFolderScreen(catalog,state,source) {
  if(!catalog.ok)return skillsUnavailableScreen();
  const rows=visible(catalog.entries).filter(row=>row.source===source),project=source==='project';
  let text=project?`<b>📂 ${escapeHtml(state.activeProject || 'project')}</b>\n\nДоступны агенту когда этот проект активен.\n\n`
    :`<b>📂 workspace</b>\n\n${rows.some(row=>row.availability==='workspace')?'Доступны агенту в текущем workspace.':'Доступны агенту всегда, в любом проекте.'}\n\n`;
  const keyboard=new InlineKeyboard();
  for(const row of rows) {
    const title=`${row.disabled?'⏸':'🧠'} ${row.name}`;
    text+=escapeHtml(title)+'\n';
    keyboard.text(clipUtf16(title,30),'skills:view:'+skillReference(row,catalog.entries)).row();
  }
  if(!rows.length)text+='<i>Нет навыков</i>\n';
  return {text:text+'⠀',keyboard:keyboard.text('➕ Добавить','skills:add:'+source).row().text('« Назад','skills:back')};
}
export function skillCardScreen(row,entries) {
  let text=`<b>🧠 ${escapeHtml(row.name)}</b>\n\n`;
  if(row.description)text+=escapeHtml(row.description)+'\n\n';
  text+=`Расположение: ${row.source==='project'?'проект':'workspace'}\nРазмер: ${(row.size/1024).toFixed(1)} KB\n⠀`;
  return {text,keyboard:new InlineKeyboard().text('📄 Содержимое','skills:content:'+skillReference(row,entries)).row()
    .text('« Назад','skills:folder:'+row.source)};
}
export function skillContentScreen(row,entries,body) {
  const content=body.length>3500?clipUtf16(body,3500)+'\n\n[...усечено]':body;
  return {text:`<b>📄 ${escapeHtml(row.name)}</b>\n\n<pre>${escapeHtml(content)}</pre>`,
    keyboard:new InlineKeyboard().text('« Назад','skills:view:'+skillReference(row,entries))};
}
export function missingSkillScreen() {return {text:'⚠️ Навык не найден',keyboard:new InlineKeyboard().text('« Назад','skills:back')};}
export function skillReadErrorScreen(error) {return {text:'❌ '+escapeHtml(clipUtf16(String(error?.message || error),100)),keyboard:new InlineKeyboard().text('« Назад','skills:back')};}
export function skillAddScreen(source) {
  return {text:'🧩 <b>Добавить навык</b>\n\nСкажи агенту что нужно — он создаст навык:\n&gt; <code>создай навык для код-ревью</code>\n&gt; <code>добавь навык для анализа данных</code>\n⠀',
    keyboard:new InlineKeyboard().text('« Назад','skills:folder:'+source)};
}
