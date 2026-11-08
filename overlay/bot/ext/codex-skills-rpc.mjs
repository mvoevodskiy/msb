/**
 * Stdio initialize -> skills/list -> close; never account/login/thread/turn/config writes.
 * [Provider mapping](./codex-skills.mjs), [protocol checks](./tests/codex-skills-rpc.test.mjs).
 * Native 0.166 schema: [tracked proof](../../../.msb/bot/tests/reference/skills-native-0.166-protocol.json).
 */
import {spawn} from 'node:child_process';
export function readCodexSkillList({command,cwd,env=process.env,signal,timeoutMs=12_000,maxBytes=4*1024*1024,spawnProcess=spawn}) {
  if(signal?.aborted)return Promise.resolve({ok:false,aborted:true});
  return new Promise(resolve=>{
    let child;
    try{child=spawnProcess(command,['app-server'],{cwd,env,detached:true,stdio:['pipe','pipe','ignore']});}
    catch{return resolve({ok:false,error:'spawn'});}
    let phase='init',buffer='',bytes=0,result=null,closed=false,resolved=false,timeout,termTimer,killTimer;
    function signalGroup(name) {
      if(closed)return;
      try{if(child.pid){process.kill(-child.pid,name);return;}}catch{/* Fall back only to the still-live leader. */}
      if(child.exitCode==null && child.signalCode==null)try{child.kill(name);}catch{}
    }
    function complete() {
      if(resolved)return;resolved=true;clearTimeout(timeout);clearTimeout(termTimer);clearTimeout(killTimer);
      signal?.removeEventListener('abort',onAbort);resolve(result || {ok:false,error:'closed'});
    }
    function finish(value) {
      if(result)return;result=value;clearTimeout(timeout);
      if(closed)return complete();
      try{child.stdin.end();}catch{}
      if(closed)return complete();
      if(value.aborted)signalGroup('SIGINT');
      if(closed)return complete();
      termTimer=setTimeout(()=>signalGroup('SIGTERM'),1000);
      killTimer=setTimeout(()=>signalGroup('SIGKILL'),5000);
    }
    function onAbort(){finish({ok:false,aborted:true});}
    function send(message) {if(!result)try{child.stdin.write(JSON.stringify(message)+'\n');}catch{finish({ok:false,error:'stdin'});}}
    child.stdin.on('error',()=>finish({ok:false,error:'stdin'}));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      if(result)return;bytes+=Buffer.byteLength(chunk,'utf8');
      if(bytes>maxBytes)return finish({ok:false,error:'output_limit'});
      buffer+=chunk;let nl;
      while(!result && (nl=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);let msg;
        try{msg=JSON.parse(line);}catch{continue;}
        if(!msg || typeof msg!=='object' || Array.isArray(msg))continue;
        // A read cannot answer an approval, credential or tool request from the server.
        if(typeof msg.method==='string' && msg.id!==undefined)return finish({ok:false,error:'server_request'});
        if(msg.id===1 && phase==='init') {
          if(msg.error || !msg.result || typeof msg.result!=='object' || Array.isArray(msg.result))return finish({ok:false,error:'initialize'});
          phase='list';send({method:'initialized'});send({id:2,method:'skills/list',params:{cwds:[cwd],forceReload:true}});
        }else if(msg.id===2 && phase==='list') {
          if(msg.error || !msg.result)return finish({ok:false,error:'list'});
          finish({ok:true,data:msg.result});
        }
      }
    });
    child.on('error',()=>{if(!child.pid)closed=true;finish({ok:false,error:'spawn'});});
    child.on('close',()=>{closed=true;complete();});
    timeout=setTimeout(()=>finish({ok:false,error:'timeout'}),timeoutMs);
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
    else send({id:1,method:'initialize',params:{clientInfo:{name:'msb_skills',version:'1'}}});
  });
}
