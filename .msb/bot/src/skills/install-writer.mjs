/**
 * Validated skill + captured native target -> backup and atomic per-file publication.
 * [Protocol](install-protocol.mjs), [processor](response-markers.mjs), [target](install-target.mjs).
 * Root symlinks are valid; escaping skill directories cannot redirect writes.
 * Path-based checks are not atomic containment against concurrent parent replacement;
 * primary/mirror have no joint transaction. [Filesystem checks](../../tests/skills-install-files.test.mjs).
 */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {formatSkillFile} from './install-protocol.mjs';
async function exists(file,io) {try{return await io.stat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function writeInstalledSkill(skill,target,{io=fs,signal}={}) {
  if(!target || !path.isAbsolute(target.home || '') || !['claude','codex','oc'].includes(target.providerId))throw Error('Unsupported native skill target');
  const roots=[path.join(target.home,target.providerId==='codex'?'.agents':'.claude','skills')];
  // Old optional-home stat errors skip only the mirror; backup/source errors stay strict.
  let mirror=false;
  if(target.providerId!=='codex' && target.mirrorOpenClaw)try{mirror=Boolean(await io.stat(path.join(target.home,'.openclaw')));}catch{}
  if(mirror)roots.push(path.join(target.home,'.openclaw','skills'));
  let replaced=false;const written=[],published=new Set(),body=formatSkillFile(skill);
  for(const root of roots) {
    signal?.throwIfAborted();await io.mkdir(root,{recursive:true});const resolvedRoot=await io.realpath(root);
    const directory=path.join(resolvedRoot,skill.name);await io.mkdir(directory,{recursive:true});const resolvedDirectory=await io.realpath(directory),relative=path.relative(resolvedRoot,resolvedDirectory);
    if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))throw Error('Skill directory escapes native root');
    const file=path.join(resolvedDirectory,'SKILL.md'),logicalFile=path.join(root,skill.name,'SKILL.md');
    if(published.has(file)){written.push(logicalFile);continue;}
    const previous=await exists(file,io),id=randomUUID(),temp=path.join(resolvedDirectory,'.SKILL.'+id+'.tmp'),backupTemp=path.join(resolvedDirectory,'.SKILL.'+id+'.backup');
    try {
      signal?.throwIfAborted();
      if(previous) {
        if(!previous.isFile())throw Error('Existing skill is not a file');
        await io.copyFile(file,backupTemp,constants.COPYFILE_EXCL);signal?.throwIfAborted();
        await io.rename(backupTemp,file+'.bak');signal?.throwIfAborted();
      }
      await io.writeFile(temp,body,{encoding:'utf8',flag:'wx',mode:0o666});
      if(previous)await io.chmod(temp,previous.mode & 0o777);
      signal?.throwIfAborted();await io.rename(temp,file);
      replaced ||= Boolean(previous);published.add(file);written.push(logicalFile);
    } finally {
      await Promise.allSettled([io.unlink(temp),io.unlink(backupTemp)]);
    }
  }
  return {written,replaced};
}
