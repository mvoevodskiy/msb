/** Owned HOME + production Telegram worker; model output/target are a controlled lower-layer double. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fixture} from './menu-fixture.mjs';
import {loadState,saveState} from '../../src/state.mjs';
export const payload={name:'fixture-skill',description:'When reviewing',body:'# Review\nUse the checklist.'};
export const block=value=>'[INSTALL_SKILL]'+(typeof value==='string'?value:JSON.stringify(value))+'[/INSTALL_SKILL]';
export const installed=(name=payload.name,update=false,mirror=false)=>(update?'Обновил навык':'Поставил навык')+' «'+name+'»'+(mirror?' на обоих движках':'')+'. Заработает со следующего сообщения.';
export const invalid='Не понял описание навыка — назови имя латиницей, короткое описание и текст навыка.';
export const failed='Не получилось сохранить навык — попробуй ещё раз.';
export const skillPath=(home,provider='codex',name=payload.name)=>path.join(home,provider==='codex'?'.agents':provider==='claude'?'.claude':'.openclaw','skills',name,'SKILL.md');
export async function installFixture(t,{provider='codex',text=block(payload),beforeReturn,ok=true,aborted=false,throwError=false}={}) {
 let f,calls=0;const returned='fixture-start\n'+text+'\nfixture-end';
 f=await fixture(t,async({onStatus,signal})=>{
  calls++;const skillInstall={providerId:provider,home:f.home,mirrorOpenClaw:process.env.JARVIS_CC_ONLY!=='1'};
  onStatus?.({kind:'provider',providerId:provider});await beforeReturn?.(f,signal);
  if(throwError)throw Error(returned);
  return{ok,error:aborted?'aborted':undefined,text:returned,skillInstall,result:{providerId:provider}};
 },{overlay:false});
 delete process.env.SKILL_INSTALL_ENABLED;
 await saveState({...((await loadState()).state),engine:'cc',authMode:'subscription',hasSubscriptionAuth:true,...(provider==='claude'?{extAuthBypass:undefined}:{extAuthBypass:provider})});
 return{...f,get calls(){return calls;},async run(){
  await f.message('create fixture skill');const deadline=Date.now()+2500;
  while(![...f.edits,...f.messages].some(value=>value.includes('fixture-end') || value==='Моя остановочка ✋🏽⛔️')){assert.ok(Date.now()<deadline,'The controlled turn must finish its response');await new Promise(r=>setTimeout(r,5));}
  await f.bot.stop();
 },final:()=>[...f.edits,...f.messages].filter(value=>value.includes('fixture-end')).at(-1)||'',
 async exists(file){try{await fs.stat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}};
}
