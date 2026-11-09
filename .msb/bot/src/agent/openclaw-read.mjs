/**
 * Bounded stdout from one owned, readonly OpenClaw command. No service or auth writes.
 * Callers: [skills](../skills/openclaw.mjs), [MCP](../mcp/openclaw.mjs).
 * [Ownership and environment checks](../../tests/openclaw-skills-reader.test.mjs).
 */
import {spawn} from 'node:child_process';
function childEnvironment(env) {
  const clean={...env};
  for(const key of ['JARVIS_CC_ONLY','BOT_TOKEN','ANTHROPIC_API_KEY','IIA_ANTHROPIC_API_KEY','MSB_ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','SYNC_KEY','SYNC_URL'])delete clean[key];
  for(const key of Object.keys(clean))if((key.startsWith('GIT_') && key!=='GITHUB_TOKEN') || key.startsWith('NPM_CONFIG_'))delete clean[key];
  return clean;
}
export function readOpenClawOutput(args,{env=process.env,signal,timeoutMs=12_000,cleanupGraceMs=5_000,maxBytes=4*1024*1024,spawnProcess=spawn}={}) {
  if(signal?.aborted)return Promise.resolve(null);
  return new Promise(resolve=>{
    let child;try{child=spawnProcess('openclaw',args,{env:childEnvironment(env),detached:true,stdio:['ignore','pipe','ignore']});}catch{return resolve(null);}
    let text='',bytes=0,stopped=false,closed=false,leaderExited=false,resolved=false,timeout,termTimer,killTimer,forceTimer;
    function signalGroup(name) {
      if(closed || resolved || leaderExited || child.exitCode!=null || child.signalCode!=null)return;
      try{if(child.pid){process.kill(-child.pid,name);return;}}catch{}
      if(child.exitCode==null && child.signalCode==null)try{child.kill(name);}catch{}
    }
    function complete(code) {
      if(resolved)return;resolved=true;clearTimeout(timeout);clearTimeout(termTimer);clearTimeout(killTimer);clearTimeout(forceTimer);
      signal?.removeEventListener('abort',onAbort);resolve(!stopped && code===0 ? text : null);
    }
    function forceCleanup() {
      if(resolved)return;stopped=true;
      // Release only our observer; after leader exit the old PGID is not a safe ownership handle.
      for(const stream of [child.stdin,child.stdout,child.stderr])try{stream?.destroy();}catch{}
      child.unref?.();complete();
    }
    function cancel(name) {
      if(stopped)return;stopped=true;clearTimeout(timeout);
      if(closed)return complete();
      signalGroup(name);if(closed)return complete();
      if(name!=='SIGTERM')termTimer=setTimeout(()=>signalGroup('SIGTERM'),1000);
      killTimer=setTimeout(()=>{signalGroup('SIGKILL');if(!closed && !resolved)forceTimer=setTimeout(forceCleanup,100);},cleanupGraceMs);
    }
    function onAbort(){cancel('SIGINT');}
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{if(stopped)return;bytes+=Buffer.byteLength(chunk,'utf8');if(bytes>maxBytes)return cancel('SIGTERM');text+=chunk;});
    child.on('error',()=>{if(!child.pid)closed=true;cancel('SIGTERM');});
    child.on('exit',()=>{leaderExited=true;});
    child.on('close',code=>{closed=true;complete(code);});
    timeout=setTimeout(()=>cancel('SIGTERM'),timeoutMs);
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  });
}
