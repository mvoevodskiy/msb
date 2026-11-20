/** Actual bot -> agent runner -> native protocol double -> writer -> response/journal. No auth/network. */
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
const provider=process.argv[2],tmp=os.tmpdir();
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,{PATH:path.dirname(process.execPath),TMPDIR:tmp});
globalThis.fetch=()=>{throw Error('External network forbidden');};
let f;const calls=[],cleanup=[],answer='fixture-start\n[INSTALL_SKILL]{"name":"fixture-skill","description":"When reviewing","body":"# Review\\nUse the checklist."}[/INSTALL_SKILL]\nfixture-end';
cp.spawn=(command,args,options)=>{
 if(command!=='claude' || options.env.HOME!==f?.home)throw Error('Unexpected native process');
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
 const call={provider:options.env.MSB_TURN_PROVIDER,cwd:options.cwd,args,prompt:''};calls.push(call);
 child.stdin.on('data',chunk=>{call.prompt+=chunk;});
 child.stdin.on('finish',()=>queueMicrotask(()=>{
  const id=provider==='claude'?'fixture-existing-claude':'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
  child.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:id,model:'fixture-model',provider_id:provider})+'\n');
  child.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:id,result:answer,is_error:false})+'\n');
  child.stdout.end();child.stderr.end();child.emit('close',0,null);
 }));return child;
};syncBuiltinESMExports();
try{
 const {fixture}=await import('../helpers/menu-fixture.mjs'),{loadState,saveState}=await import('../../src/state.mjs'),{runAgentTurn}=await import('../../src/agent/turn.mjs');
 f=await fixture({after:fn=>cleanup.push(fn)},runAgentTurn,{overlay:false,claudeCliVersion:'2.1.316'});
 const {state}=await loadState();await saveState({...state,authMode:'subscription',hasSubscriptionAuth:true,extAuthBypass:provider==='claude'?undefined:provider,ccSessionId:provider==='claude'?'fixture-existing-claude':state.ccSessionId});
 await f.message('create fixture skill');const deadline=Date.now()+2500;
 while(![...f.edits,...f.messages].some(text=>text.includes('fixture-end'))){if(Date.now()>deadline)throw Error('Controlled bot turn failed to finish');await new Promise(r=>setTimeout(r,5));}
 await f.bot.stop();
 const root=path.join(f.home,provider==='codex'?'.agents':'.claude','skills'),file=path.join(root,'fixture-skill/SKILL.md');
 let content=null;try{content=await fs.readFile(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 const diary=await fs.readFile(path.join(process.env.MSB_RUNTIME_ROOT,'bots/default/chat-diary.jsonl'),'utf8');
 console.log('SKILL_INGRESS='+JSON.stringify({provider,home:f.home,workspace:f.workspace,calls,content,final:[...f.edits,...f.messages].filter(text=>text.includes('fixture-end')).at(-1),diary}));
}finally{for(const fn of cleanup.reverse())await fn();}
