/**
 * Old menu/project/page callbacks → existing form or one validated selection path.
 * [Renderer](../screens/projects.mjs), [files](../../projects/files.mjs), [selection](../../projects/selection.mjs).
 * [Contract](../../../tests/reference/parity-projects-contract.txt), [checks](../../../tests/projects.test.mjs).
 */
import {listProjectNames} from '../../projects/files.mjs';
import {resolveProjectReference} from '../../projects/callback-key.mjs';
import {selectProject} from '../../projects/selection.mjs';
import {projectsScreen,projectInputScreen} from '../screens/projects.mjs';
import {cancelProjectInput} from '../forms/projects.mjs';
import {escapeHtml} from '../edit.mjs';
import {UNHANDLED} from './shared.mjs';

export async function handleProjectRoute({data,state,show,pending,chatId,msgId,ctx,bot}) {
  if(data==='menu:projects')return show(await projectsScreen(state));
  if(data==='menu:newproject') {
    pending.set(chatId,'new-project');
    const draft={promptMessageId:msgId};pending.advance(chatId,'new-project',draft);
    draft.delivery=show(projectInputScreen());
    const sent=await draft.delivery;
    if(pending.payload(chatId)===draft)draft.promptMessageId=sent?.message_id || msgId;
    else if(sent?.message_id&&sent.message_id!==msgId)await bot.api.deleteMessage(chatId,sent.message_id).catch(()=>{});
    return;
  }
  if(data==='menu:cancel_newproject') {
    if(pending.get(chatId)!=='new-project')return;
    const draft=pending.payload(chatId);await draft?.delivery?.catch(()=>{});
    if(pending.payload(chatId)!==draft || (draft?.promptMessageId && draft.promptMessageId!==msgId))return;
    cancelProjectInput(pending,chatId);
    if(msgId)await bot.api.deleteMessage(chatId,msgId).catch(()=>{});
    return;
  }
  if(data.startsWith('projects:page:'))return show(await projectsScreen(state,parseInt(data.slice(14),10),true));
  if(data==='noop')return;
  if(!data.startsWith('project:'))return UNHANDLED;
  const reference=data.slice(8);
  let name;
  if(reference!=='__default__') {
    name=resolveProjectReference(reference,reference.startsWith('p~')?await listProjectNames():[]);
    if(name===null)return; // Unknown opaque references cannot redraw/cancel a newer form.
  }
  try {
    await selectProject(name);
    cancelProjectInput(pending,chatId);
    return show({text:name===undefined?'📂 Переключился на базовый workspace (<code>~/workspace</code>)':`📍 Переключился на проект <code>${escapeHtml(name)}</code>`});
  } catch { await ctx.reply(`❌ Проект <code>${escapeHtml(name)}</code> не найден.`,{parse_mode:'HTML'}); }
}
