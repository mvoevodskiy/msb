/** Real overlay -> fake installed Codex stdio; own skill files/log only, no auth or model. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './menu-fixture.mjs';
import {loadState,saveState} from '../../src/state.mjs';
export async function codexSkillsFixture(t,mode='ok'){
 const f=await fixture(t),log=path.join(f.home,'native-skills-rpc.jsonl'),release=path.join(f.home,'native-skills-release');
 const project=path.join(f.home,'projects/alpha');await fs.mkdir(project,{recursive:true});
 const metadata=async(base,relative,name,scope,enabled=true)=>{const file=path.join(base,relative,'SKILL.md');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'---\nname: '+name+'\ndescription: Native description '+name+'\n---\nNATIVE_BODY_'+name);return{name,description:'Native description '+name,path:file,scope,enabled};};
 const user=await metadata(f.home,'.agents/skills/codex-user','codex-user','user'),system=await metadata(f.home,'.codex/skills/.system/creator','skill-creator','system'),disabled=await metadata(f.home,'.agents/skills/codex-paused','codex-paused','user',false);
 const baseRepo=await metadata(f.workspace,'.agents/skills/codex-base','codex-base','repo'),projectRepo=await metadata(project,'.agents/skills/codex-project','codex-project','repo');
 const foreign=path.join(f.workspace,'.claude/skills/claude-only/SKILL.md');await fs.mkdir(path.dirname(foreign),{recursive:true});await fs.writeFile(foreign,'---\nname: claude-only\n---\nCLAUDE_BODY_MUST_NOT_BE_CODEX');
 const native={mode,log,release,workspace:f.workspace,project,user,system,disabled,baseRepo,projectRepo};
 const bin=path.join(f.home,'.local/bin/codex');await fs.mkdir(path.dirname(bin),{recursive:true});
 await fs.writeFile(bin,'#!'+process.execPath+'\n'+`import fs from 'node:fs';import{createInterface}from'node:readline';const f=${JSON.stringify(native)};if(process.argv[2]==='--version'){console.log('codex-cli 0.166.0');process.exit(0);}if(process.argv.slice(2).join(' ')!=='app-server')process.exit(7);let init=false,ready=false;const rl=createInterface({input:process.stdin});rl.on('line',async line=>{const q=JSON.parse(line);fs.appendFileSync(f.log,JSON.stringify(q)+'\\n');if(q.method==='initialize'){init=true;console.log(JSON.stringify({id:q.id,result:{userAgent:'fixture'}}));}else if(q.method==='initialized'){ready=init;}else if(q.method==='skills/list'&&ready){if(f.mode==='error'){console.log(JSON.stringify({id:q.id,error:{code:-32603,message:'fixture-only-error'}}));return;}if(f.mode==='hold')while(!fs.existsSync(f.release))await new Promise(r=>setTimeout(r,5));const cwd=q.params.cwds[0],repo=cwd===f.project?f.projectRepo:f.baseRepo;console.log(JSON.stringify({id:q.id,result:{data:[{cwd:f.mode==='wrong-cwd'?f.workspace+'/other':cwd,skills:[repo,f.user,f.system,f.disabled],errors:[]}]}}));}else process.exit(8);});`,{mode:0o700});
 const readCalls=async()=>{try{return(await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return[];throw e;}};
 return{...f,project,native,readCalls,release:()=>fs.writeFile(release,'released'),selectProject:async()=>saveState({...((await loadState()).state),activeProject:'alpha'})};
}
