/**
 * Synthetic native executables used through the real core and provider shim.
 * [Launch](../mcp-launch.test.mjs) and [native removal](../mcp-native-remove.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const apifyA='apify_api_fixture_launch_a';
export const apifyB='apify_api_fixture_launch_b';
export const supadata='sd_fixture_launch';
const modelThread='0199a213-81c0-7800-8aa1-bbab2a035a53';
const shim=new URL('../../../../overlay/bot/ext/shim/run-turn.mjs',import.meta.url).href;

export async function nativeFixtures(f) {
  const log=path.join(f.home,'mcp-launch.jsonl');
  const collision=path.join(f.home,'collision');
  const hold=path.join(f.home,'hold-config-read');
  const readError=path.join(f.home,'error-config-read');
  const response=path.join(f.home,'model-response.json');
  const nativeClaude=path.join(f.home,'native-claude.mjs');
  const bin=path.join(f.home,'.local/bin');
  const configuration={log,collision,hold,readError,response,apifyA,apifyB,supadata,modelThread};
  const claudeSource=`import fs from 'node:fs';
const data=${JSON.stringify(configuration)};
const argv=process.argv.slice(2);
if(argv.includes('--version')){console.log('2.1.154 (Claude Code)');process.exit(0);}
fs.readFileSync(0,'utf8');
const index=argv.indexOf('--mcp-config'),file=index>=0?argv[index+1]:null;
const projection=file?fs.readFileSync(file,'utf8'):null;
fs.appendFileSync(data.log,JSON.stringify({kind:'claude',argv,file,projection,
  mode:file?fs.statSync(file).mode&0o777:null,
  correct:process.env.MSB_MCP_SUPADATA_TOKEN===data.supadata,
  hasDedicated:Boolean(process.env.MSB_MCP_SUPADATA_TOKEN),
  correctApify:process.env.MSB_MCP_APIFY_TOKEN===data.apifyB})+'\\n');
const reply=fs.existsSync(data.response)?JSON.parse(fs.readFileSync(data.response,'utf8')):{text:'fixture complete'};
const session_id='fixture-claude-session';
console.log(JSON.stringify({type:'system',subtype:'init',session_id,model:'claude-opus-4-8'}));
if(reply.assistant)console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:reply.text}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',session_id,is_error:Boolean(reply.error),result:reply.text,usage:{input_tokens:1,output_tokens:1}}));`;
  const codexSource=`import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
const data=${JSON.stringify(configuration)};
const argv=process.argv.slice(2);
function record(row){fs.appendFileSync(data.log,JSON.stringify(row)+'\\n');}
function presence(){
 return {apify:Boolean(process.env.MSB_MCP_APIFY_TOKEN),supadata:Boolean(process.env.MSB_MCP_SUPADATA_TOKEN)};
}
if(argv.at(-1)==='app-server'){
 createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.method==='initialize'){console.log(JSON.stringify({id:request.id,result:{}}));return;}
  if(request.method==='initialized')return;
  if(request.method==='thread/resume'){
   record({kind:'codex-compact',argv});
   console.log(JSON.stringify({id:request.id,result:{thread:{id:request.params.threadId}}}));
   return;
  }
  if(request.method==='thread/compact/start'){
   const {threadId}=request.params;
   console.log(JSON.stringify({id:request.id,result:{}}));
   console.log(JSON.stringify({method:'item/completed',params:{threadId,turnId:'turn-fixture',item:{type:'contextCompaction'}}}));
   console.log(JSON.stringify({method:'turn/completed',params:{threadId,turn:{id:'turn-fixture',status:'completed'}}}));
   return;
  }
  if(request.method!=='config/read')process.exit(3);
  const occupied=fs.existsSync(data.collision)?fs.readFileSync(data.collision,'utf8').trim():'';
  const config={mcp_servers:occupied?{[occupied]:{url:'https://native.invalid',http_headers:{Authorization:'fixture-native-only'}}}:{}};
  const file=path.resolve(process.cwd(),process.env.CODEX_HOME || path.join(process.env.HOME,'.codex'),'config.toml');
  const user={name:{type:'user',file},config};
  record({kind:'codex-read',layers:request.params.includeLayers,pid:process.pid,...presence()});
  if(!request.params.includeLayers && fs.existsSync(data.hold))return;
  if(fs.existsSync(data.readError)){console.log(JSON.stringify({id:request.id,error:{code:-32603,message:'fixture unreadable'}}));return;}
  console.log(JSON.stringify({id:request.id,result:{config,layers:[user]}}));
 });
}else if(argv[0]==='exec'){
 const prompt=fs.readFileSync(0,'utf8');
 const reply=fs.existsSync(data.response)?JSON.parse(fs.readFileSync(data.response,'utf8')):{text:'fixture complete'};
 const apify=process.env.MSB_BOT_ID==='other'?data.apifyB:data.apifyA;
 const index=argv.indexOf('--profile');
 const profileFile=index<0?null:path.join(process.env.CODEX_HOME,argv[index+1]+'.config.toml');
 const profile=profileFile?fs.readFileSync(profileFile,'utf8'):null;
 record({kind:'codex-exec',argv,prompt,profileFile,profile,profileMode:profileFile?fs.statSync(profileFile).mode&0o777:null,
  privateHandoffPresent:Boolean(process.env.MSB_TURN_MCP_CUSTOM),bot:process.env.MSB_BOT_ID,...presence(),
  correctApify:process.env.MSB_MCP_APIFY_TOKEN===apify,correctSupadata:process.env.MSB_MCP_SUPADATA_TOKEN===data.supadata});
 console.log(JSON.stringify({type:'thread.started',thread_id:data.modelThread}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:reply.text}}));
 console.log(JSON.stringify({type:reply.error?'turn.failed':'turn.completed',error:reply.error?{message:typeof reply.error==='string'?reply.error:'fixture returned error'}:undefined,usage:{input_tokens:1,output_tokens:1}}));
}else process.exit(4);`;
  await fs.writeFile(log,'',{mode:0o600});
  await fs.writeFile(nativeClaude,claudeSource,{mode:0o600});
  await fs.writeFile(path.join(bin,'claude'),'#!'+process.execPath+'\nawait import('+JSON.stringify(shim)+');\n',{mode:0o700});
  await fs.writeFile(path.join(bin,'codex'),'#!'+process.execPath+'\n'+codexSource,{mode:0o700});
  process.env.MSB_REAL_CLAUDE=nativeClaude;
  process.env.CLAUDE_CODE_OAUTH_TOKEN='fixture-claude-only';
  process.env.OPENAI_API_KEY='fixture-codex-only';
  delete process.env.CODEX_ACCESS_TOKEN;
  return {
    collision,hold,readError,
    async respond(text,{error=false,assistant=false}={}){await fs.writeFile(response,JSON.stringify({text,error,assistant}),{mode:0o600});},
    async trace(){return (await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);},
  };
}
