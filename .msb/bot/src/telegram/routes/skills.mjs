/**
 * Old skills callbacks -> captured read catalog -> original views. No forms/file writes.
 * [Reader/dispatch](../../skills/catalog.mjs), [views](../screens/skills.mjs),
 * [production checks](../../../tests/skills-read.test.mjs). Installer is a separate turn stage.
 */
import fs from 'node:fs/promises';
import {skillCatalog} from '../../skills/catalog.mjs';
import {resolveSkillReference} from '../../skills/reference.mjs';
import {skillsTopScreen,skillsFolderScreen,skillCardScreen,skillContentScreen,missingSkillScreen,skillReadErrorScreen,skillAddScreen} from '../screens/skills.mjs';
import {hubScreen} from '../screens/hub.mjs';
import {UNHANDLED} from './shared.mjs';
/** Read-only views can outlive the polling handler; Add/Back-menu stay immediate. */
export const isSkillReadCallback=data=>data==='menu:skills' || data==='skills:back'
  || data==='skills:folder:workspace' || data==='skills:folder:project'
  || data.startsWith('skills:view:') || data.startsWith('skills:content:');
export async function handleSkillRoute({data,state,show,bot,msgId,signal}) {
  if(data!=='menu:skills' && !data.startsWith('skills:'))return UNHANDLED;
  if(data!=='menu:skills' && !msgId)return;
  if(data==='skills:back-menu')return show(hubScreen());
  if(data==='skills:add:workspace' || data==='skills:add:project')return show(skillAddScreen(data.slice(11)));
  const top=data==='menu:skills' || data==='skills:back';
  const folder=data==='skills:folder:workspace' || data==='skills:folder:project';
  const view=data.startsWith('skills:view:'),content=data.startsWith('skills:content:');
  if(!top && !folder && !view && !content)return UNHANDLED;
  const catalog=await skillCatalog(state,{readProvider:bot[Symbol.for('msb.skillsProvider')],signal});
  if(top)return show(skillsTopScreen(catalog,state));
  if(folder)return show(skillsFolderScreen(catalog,state,data.slice(14)));
  const row=catalog.ok?resolveSkillReference(data.slice(content?15:12),catalog.entries):null;
  if(!row)return show(missingSkillScreen());
  if(view)return show(skillCardScreen(row,catalog.entries));
  let body;
  try{body=await fs.readFile(row.fullPath,'utf8');}catch(error){return show(skillReadErrorScreen(error));}
  return show(skillContentScreen(row,catalog.entries,body));
}
