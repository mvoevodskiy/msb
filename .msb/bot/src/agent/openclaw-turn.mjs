/**
 * One ordinary OpenClaw turn through the legacy named acpx route.
 * [Dispatch](turn.mjs), [child lifetime](openclaw-read.mjs), [stream](openclaw-protocol.mjs),
 * [state reset](../sessions/selection.mjs) and [ingress checks](../../tests/openclaw-turn.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {runOpenClawCommand} from './openclaw-read.mjs';
import {openClawFrames} from './openclaw-protocol.mjs';
import {ownedOpenClawProfile,legacyOpenClawProfile,openClawProfileEnvironment,scopedOpenClawCommand} from './openclaw-profile.mjs';
import {clearOpenClawSession} from '../sessions/openclaw.mjs';
import {NO_STATE_WRITE,updateState} from '../state.mjs';

const timeoutMs=30*60_000;
const newName=()=>'oc-'+randomBytes(8).toString('hex');
const aborted=()=>({ok:false,error:'aborted',text:'Остановлено.'});
const failed=(text='Не удалось завершить ход OpenClaw. Попробуй ещё раз.')=>({ok:false,error:'engine_oc',text});

function acpxArgs({cwd,profile},strict=true){
  const scope=profile?['--agent',scopedOpenClawCommand(profile)]:['openclaw'];
  return ['--format','json',...(strict?['--json-strict']:[]),'--cwd',cwd,...scope];
}

async function createSession(name,legacy,options){
  const {result,line}=openClawFrames();
  const outcome=await runOpenClawCommand([...acpxArgs(options,false),'sessions','new','--name',name,
    ...(legacy?['--resume-session',legacy]:[])],{...options,onLine:line});
  return outcome?.code===0 && !result.failed && result.sessionId?result.sessionId:null;
}

async function promptSession(name,file,options,onStatus){
  const {result,line}=openClawFrames(onStatus);
  const base=acpxArgs(options);
  let started=false,cancellation;
  const cancel=()=>{
    if(started)cancellation=runOpenClawCommand([...base,'cancel','-s',name],{...options,signal:undefined,timeoutMs:3000});
  };
  options.signal?.addEventListener('abort',cancel,{once:true});
  try{
    const outcome=await runOpenClawCommand([...base,'prompt','-s',name,'--file',file],
      {...options,onLine:line,onStart:()=>{started=true;}});
    return {...result,code:outcome?.code};
  }finally{
    options.signal?.removeEventListener('abort',cancel);
    await cancellation;
  }
}

async function saveSession(snapshot,env,name,result,profile,signal){
  if(!result.sessionId)return;
  await updateState(async state=>{
    if(profile && (await ownedOpenClawProfile(env))?.file!==profile.file)return NO_STATE_WRITE;
    if(signal?.aborted || state.engine!=='oc' || state.activeProject!==snapshot.activeProject
      || (state.sessionEpoch || 0)!==(snapshot.sessionEpoch || 0)
      || state.ocSessionName!==snapshot.ocSessionName || state.ocSessionId!==snapshot.ocSessionId
      || state.ocSessionProfile!==snapshot.ocSessionProfile)return NO_STATE_WRITE;
    if(state.ocSessionName!==name && state.ocSessionId)clearOpenClawSession(state);
    state.ocSessionName=name;
    state.ocSessionId=result.sessionId;
    if(profile)state.ocSessionProfile=profile.file;
    if(result.frameSessionId)state.ocFrameSessionId=result.frameSessionId;
    return state;
  },env,{signal});
}

export async function runOpenClawTurn({state,prompt,systemPrompt,cwd,env,signal,onStatus}){
  if(signal?.aborted)return aborted();
  const profile=await ownedOpenClawProfile(env);
  if(!profile && (state.ocSessionProfile || !await legacyOpenClawProfile(env))){
    return failed('Профиль OpenClaw изменился или недоступен. Проверь настройки движка.');
  }
  const childEnv=profile?openClawProfileEnvironment(env,profile):env;
  const options={command:'acpx',cwd,env:{...childEnv,CI:'1'},signal,timeoutMs,profile};
  const sameScope=state.ocSessionProfile===profile?.file;
  const previousName=sameScope?state.ocSessionName:undefined;
  const previousId=sameScope?state.ocSessionId:undefined;
  let name=previousName,id=previousId,directory;
  try{
    if(!name){
      name=newName();
      id=await createSession(name,id,options);
      if(!id && previousId && !signal?.aborted){
        name=newName();
        id=await createSession(name,null,options);
      }
      if(!id)return signal?.aborted?aborted():failed();
    }
    if(signal?.aborted)return aborted();
    directory=await fs.mkdtemp(path.join(os.tmpdir(),'msb-oc-turn-'));
    const file=path.join(directory,'prompt.txt');
    await fs.writeFile(file,[systemPrompt,prompt].filter(Boolean).join('\n\n---\n\n'),{mode:0o600});
    onStatus?.({kind:'provider',providerId:'openclaw'});
    let result=await promptSession(name,file,options,onStatus);
    // Missing named session is safe to retry only before any returned model work.
    if(!signal?.aborted && previousName && (result.errorCode==='NO_SESSION' || result.code===4)
      && !result.text && !result.toolCount){
      name=newName();
      id=await createSession(name,null,options);
      if(!id)return signal?.aborted?aborted():failed();
      result=await promptSession(name,file,options,onStatus);
    }
    if(signal?.aborted || result.stopReason==='cancelled')return aborted();
    const text=result.text.trim();
    if(result.code!==0 || result.failed || !result.stopReason)return failed(text || undefined);
    result.sessionId ||= id;
    result.providerId='openclaw';
    try{await saveSession(state,env,name,result,profile,signal);}
    catch(error){if(!signal?.aborted)throw error;}
    if(signal?.aborted)return aborted();
    return {ok:true,text:text || '(пустой ответ)',result,openClawProfile:profile?.file ?? null};
  }finally{
    if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});
  }
}
