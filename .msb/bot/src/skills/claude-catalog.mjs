/**
 * Captured base/project -> old Claude HOME/base/project metadata, without writes.
 * [Catalog](./catalog.mjs) dispatches providers; [views](../telegram/screens/skills.mjs) own UI.
 * [Old contract](../../tests/reference/parity-skills-contract.txt), [read checks](../../tests/skills-read.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {homeDir} from '../paths.mjs';
import {projectLocations,resolveProjectCwd} from '../projects/paths.mjs';

function metadata(body) {
  const front=body.match(/^---\n([\s\S]*?)\n---/);
  if(!front)return {};
  return {name:front[1].match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    description:front[1].match(/^description:\s*(.+)$/m)?.[1]?.trim(),
    disabled:/^disabled:\s*true$/m.test(front[1])};
}
async function scan(directory,root,source,rows) {
  let entries;
  try{entries=await fs.readdir(directory,{withFileTypes:true});}catch{return;}
  for(const entry of entries) {
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()){await scan(file,root,source,rows);continue;}
    if(entry.name!=='SKILL.md')continue;
    try {
      const body=await fs.readFile(file,'utf8'),meta=metadata(body),relative=path.relative(root,path.dirname(file));
      rows.push({providerId:'claude',name:meta.name || path.basename(path.dirname(file)),
        description:meta.description || body.split('\n').find(line=>line.startsWith('# '))?.slice(2) || '',
        path:relative,fullPath:file,root,source,type:relative.startsWith('_always')?'system':'user',
        size:Buffer.byteLength(body,'utf8'),disabled:meta.disabled || false});
    }catch{/* Old list skips an unreadable file, without changing it. */}
  }
}
export async function readClaudeSkills(state,env=process.env) {
  const {workspace}=projectLocations(env),base=path.join(workspace,'.claude','skills');
  let cwd;
  try{cwd=await resolveProjectCwd(state,env,workspace);}catch{/* Unavailable project must not hide global files. */}
  const project=cwd?path.join(cwd,'.claude','skills'):null,home=path.join(homeDir(env),'.claude','skills'),rows=[];
  if(home!==base && home!==project)await scan(home,home,'workspace',rows);
  await scan(base,base,'workspace',rows);
  if(project && project!==base)await scan(project,project,'project',rows);
  return rows;
}
