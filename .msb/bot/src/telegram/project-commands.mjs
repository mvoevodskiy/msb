/**
 * Old /projects and /project commands, sharing [selection](../projects/selection.mjs)
 * and [scaffold](../projects/files.mjs) with menu actions; no separate CLI/session path.
 * Registered-command priority stays with [createBot](./bot.mjs).
 * [Contract](../../tests/reference/parity-projects-contract.txt), [checks](../../tests/projects.test.mjs).
 */
import {loadState} from '../state.mjs';
import {projectPath} from '../projects/paths.mjs';
import {createProjectFiles} from '../projects/files.mjs';
import {selectProject} from '../projects/selection.mjs';
import {projectsScreen,projectCreatedText} from './screens/projects.mjs';
import {cancelProjectInput} from './forms/projects.mjs';
import {escapeHtml} from './edit.mjs';

export function registerProjectCommands(bot,pending) {
  bot.command('projects',async ctx=>{
    const {state}=await loadState();const view=await projectsScreen(state,0,false);
    await ctx.reply(view.text,{parse_mode:'HTML',reply_markup:view.keyboard});
  });
  bot.command('project',async ctx=>{
    const raw=ctx.match?.trim() || '';
    if(!raw) {
      const {state}=await loadState();
      const text=state.activeProject?`📍 Активный проект: <code>${escapeHtml(state.activeProject)}</code>\n📂 <code>${escapeHtml(projectPath(state.activeProject))}</code>`
        :'📍 Работаю в <code>~/workspace</code> (по умолчанию)\n\nПереключить: /project <i>название</i>';
      await ctx.reply(text,{parse_mode:'HTML'});return;
    }
    if(raw.startsWith('new ')) {
      const name=raw.slice(4).trim().replace(/[^a-zA-Z0-9_-]/g,'');
      if(!name){await ctx.reply('❌ Название проекта — только латиница, цифры, - и _');return;}
      try {
        const directory=await createProjectFiles(name);const state=await selectProject(name);cancelProjectInput(pending,ctx.chat.id);
        await ctx.reply(projectCreatedText(name,{directory,engine:state.engine}),{parse_mode:'HTML'});
      } catch(error){await ctx.reply('❌ Ошибка: '+String(error.message));}
      return;
    }
    const name=raw.replace(/[^a-zA-Z0-9_-]/g,'');
    if(name==='home'||name==='default') {
      await selectProject(undefined);cancelProjectInput(pending,ctx.chat.id);
      await ctx.reply('📍 Переключился на <code>~/workspace</code>',{parse_mode:'HTML'});return;
    }
    try {
      await selectProject(name);cancelProjectInput(pending,ctx.chat.id);
      await ctx.reply(`📍 Переключился на проект <code>${escapeHtml(name)}</code>\n📂 <code>${escapeHtml(projectPath(name))}</code>`,{parse_mode:'HTML'});
    } catch {await ctx.reply(`❌ Проект <code>${escapeHtml(name)}</code> не найден.\n\nСоздать: /project new ${escapeHtml(name)}`,{parse_mode:'HTML'});}
  });
}
