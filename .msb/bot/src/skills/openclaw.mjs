/**
 * Old OC eligible JSON list; one owned readonly CLI, no engine/service/auth mutation.
 * [Catalog](./catalog.mjs), [views](../telegram/screens/openclaw-skills.mjs),
 * [production contract checks](../../tests/skills-openclaw.test.mjs).
 */
import {spawn} from 'node:child_process';
export function parseOpenClawSkills(text) {
  let parsed;try{parsed=JSON.parse(text);}catch{return [];}
  const rows=Array.isArray(parsed)?parsed:parsed?.skills ?? parsed?.eligible ?? parsed?.items;
  if(!Array.isArray(rows))return [];
  return rows.filter(row=>row && typeof row==='object').flatMap(row=>{
    const name=String(row.name ?? '').trim();
    return name?[{name,description:String(row.description ?? '').trim(),source:String(row.source ?? '').trim(),userInvocable:row.userInvocable!==false}]:[];
  });
}
function childEnvironment(env) {
  const clean={...env};
  for(const key of ['JARVIS_CC_ONLY','BOT_TOKEN','ANTHROPIC_API_KEY','IIA_ANTHROPIC_API_KEY','MSB_ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','SYNC_KEY','SYNC_URL'])delete clean[key];
  for(const key of Object.keys(clean))if((key.startsWith('GIT_') && key!=='GITHUB_TOKEN') || key.startsWith('NPM_CONFIG_'))delete clean[key];
  return clean;
}
export function readOpenClawSkills({env=process.env,signal,timeoutMs=12_000,cleanupGraceMs=5_000,maxBytes=4*1024*1024,spawnProcess=spawn}={}) {
  if(signal?.aborted)return Promise.resolve([]);
  return new Promise(resolve=>{
    let child;try{child=spawnProcess('openclaw',['skills','list','--json','--eligible'],{env:childEnvironment(env),detached:true,stdio:['ignore','pipe','ignore']});}catch{return resolve([]);}
    let text='',bytes=0,result=null,closed=false,leaderExited=false,resolved=false,timeout,termTimer,killTimer,forceTimer;
    function signalGroup(name) {
      if(closed || resolved || leaderExited || child.exitCode!=null || child.signalCode!=null)return;
      try{if(child.pid){process.kill(-child.pid,name);return;}}catch{}
      if(child.exitCode==null && child.signalCode==null)try{child.kill(name);}catch{}
    }
    function complete(code) {
      if(resolved)return;resolved=true;clearTimeout(timeout);clearTimeout(termTimer);clearTimeout(killTimer);clearTimeout(forceTimer);
      signal?.removeEventListener('abort',onAbort);resolve(result ?? (code===0?parseOpenClawSkills(text):[]));
    }
    function forceCleanup() {
      if(resolved)return;result=[];
      // Release only our observer; after leader exit the old PGID is not a safe ownership handle.
      for(const stream of [child.stdin,child.stdout,child.stderr])try{stream?.destroy();}catch{}
      child.unref?.();complete();
    }
    function cancel(name) {
      if(result!==null)return;result=[];clearTimeout(timeout);
      if(closed)return complete();
      signalGroup(name);if(closed)return complete();
      if(name!=='SIGTERM')termTimer=setTimeout(()=>signalGroup('SIGTERM'),1000);
      killTimer=setTimeout(()=>{signalGroup('SIGKILL');if(!closed && !resolved)forceTimer=setTimeout(forceCleanup,100);},cleanupGraceMs);
    }
    function onAbort(){cancel('SIGINT');}
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{if(result!==null)return;bytes+=Buffer.byteLength(chunk,'utf8');if(bytes>maxBytes)return cancel('SIGTERM');text+=chunk;});
    child.on('error',()=>{if(!child.pid)closed=true;cancel('SIGTERM');});
    child.on('exit',()=>{leaderExited=true;});
    child.on('close',code=>{closed=true;complete(code);});
    timeout=setTimeout(()=>cancel('SIGTERM'),timeoutMs);
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  });
}
