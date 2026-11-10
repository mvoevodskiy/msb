/**
 * Project directories/scaffold only; no current-session or auth decisions.
 * [Paths](./paths.mjs) owns base/root validation; [selection](./selection.mjs) activates.
 * Old /projects/menu create: [contract](../../tests/reference/parity-projects-contract.txt).
 * [Production checks](../../tests/projects.test.mjs). No shell interpolation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {projectLocations,projectPath,resolveProjectDirectory} from './paths.mjs';

export async function listProjectNames(env = process.env) {
  try {
    return (await fs.readdir(projectLocations(env).root, {withFileTypes:true}))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch (error) {
    if (['ENOENT','ENOTDIR'].includes(error?.code)) return [];
    throw error;
  }
}
export async function createProjectFiles(name, env = process.env) {
  const directory = projectPath(name, env);
  await fs.mkdir(projectLocations(env).root, {recursive:true});
  try { await fs.mkdir(directory); }
  catch(error) { if(error?.code!=='EEXIST')throw error;await resolveProjectDirectory(name,env); }
  await fs.mkdir(path.join(directory, 'memory'), {recursive:true});
  await fs.mkdir(path.join(directory, 'knowledge'), {recursive:true});
  // Old git init did not gate success. Await its bounded completion for cleanup,
  // but keep a usable project folder when Git is unavailable; no repo-health claim.
  const gitExists=await fs.lstat(path.join(directory,'.git')).then(()=>true,error=>{if(error?.code==='ENOENT')return false;throw error;});
  if(!gitExists) {
    const childEnv={...env};
    for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'])delete childEnv[key];
    await new Promise(resolve => execFile('git', ['init', directory],
      {cwd:directory, env:childEnv, timeout:5000}, () => resolve()));
  }
  return directory;
}
