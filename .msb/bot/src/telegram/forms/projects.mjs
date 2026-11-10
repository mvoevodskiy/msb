/**
 * Old project-name form → validated scaffold → one [selection](../../projects/selection.mjs).
 * Input ownership remains in [PendingInputs](../pending-input.mjs); voice never consumes it.
 * [Routes](../routes/projects.mjs), [presentation](../screens/projects.mjs), [checks](../../../tests/projects.test.mjs).
 */
import {createProjectFiles} from '../../projects/files.mjs';
import {selectProject} from '../../projects/selection.mjs';
import {PROJECT_INVALID,projectCreatedText} from '../screens/projects.mjs';

export function cancelProjectInput(pending, chatId) {
  if(pending.get(chatId)==='new-project')pending.delete(chatId);
}
export async function handleProjectNameInput({ctx,text,pending,chatId}) {
  const name=text.trim().toLowerCase();
  if(!/^[a-z0-9_-]{1,40}$/.test(name)) { await ctx.reply(PROJECT_INVALID,{parse_mode:'HTML'});return; }
  pending.delete(chatId);
  try {
    await createProjectFiles(name);
    const state=await selectProject(name);
    await ctx.reply(projectCreatedText(name,{engine:state.engine}),{parse_mode:'HTML'});
  } catch(error) { await ctx.reply('❌ Ошибка: '+String(error.message)); }
}
