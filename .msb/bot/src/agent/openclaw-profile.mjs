/**
 * Explicit native paths -> a physical OpenClaw profile owned by one bot.
 * [Turn](openclaw-turn.mjs) and [registry setup](../mcp/openclaw-setup.mjs)
 * share this identity. Existing unscoped ACP routing remains usable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {botRoot,homeDir} from '../paths.mjs';

export async function ownedOpenClawProfile(env=process.env){
  const directory=env.OPENCLAW_STATE_DIR,config=env.OPENCLAW_CONFIG_PATH;
  if(!directory || !config || !path.isAbsolute(directory) || !path.isAbsolute(config)
    || env.OPENCLAW_GATEWAY_URL || env.OPENCLAW_INCLUDE_ROOTS)return null;
  try{
    const root=botRoot(env);
    const [parent,physicalRoot,state,file]=await Promise.all([
      fs.realpath(path.dirname(root)),fs.realpath(root),fs.realpath(directory),fs.realpath(config),
    ]);
    if(physicalRoot!==path.join(parent,path.basename(root)) || !state.startsWith(physicalRoot+path.sep)
      || file!==path.join(state,'openclaw.json') || !(await fs.stat(file)).isFile())return null;
    return {state,file};
  }catch{return null;}
}

export function openClawProfileEnvironment(env,profile){
  return {...env,OPENCLAW_STATE_DIR:profile.state,OPENCLAW_CONFIG_PATH:profile.file};
}

/** Conventional one-user native paths are the established legacy scope. */
export async function legacyOpenClawProfile(env){
  const directory=env.OPENCLAW_STATE_DIR,config=env.OPENCLAW_CONFIG_PATH;
  if(!directory && !config && !env.OPENCLAW_HOME)return true;
  try{
    const home=await fs.realpath(homeDir(env));
    if(env.OPENCLAW_HOME && await fs.realpath(env.OPENCLAW_HOME)!==home)return false;
    if(!directory && !config)return true;
    const name=env.OPENCLAW_PROFILE || 'default';
    if(!/^[a-z0-9_-]+$/i.test(name))return false;
    const state=path.join(home,name==='default'?'.openclaw':'.openclaw-'+name);
    const file=path.join(state,'openclaw.json');
    return await fs.realpath(directory || state)===state && await fs.realpath(config || file)===file;
  }catch{return false;}
}

const word=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
export function scopedOpenClawCommand(profile){
  // acpx keys its queue owner by the command string, cwd and session name.
  // Child env alone does not separate two configured Gateways.
  return '/usr/bin/env '+word('OPENCLAW_STATE_DIR='+profile.state)+' '+word('OPENCLAW_CONFIG_PATH='+profile.file)+' openclaw acp';
}
