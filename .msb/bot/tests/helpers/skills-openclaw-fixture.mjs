/** Old OC list through production ingress and one owned executable; no auth/native service. */
import fs from 'node:fs/promises';import path from 'node:path';
import {fixture} from './menu-fixture.mjs';import {loadState,saveState} from '../../src/state.mjs';
export const OC_LOADING='⏳ Загружаю навыки…';
export const OC_UNAVAILABLE='🧩 <b>Навыки агента</b>\n\nНе удалось получить список навыков от движка — попробуй позже.';
export const OC_EMPTY='🧩 <b>Навыки агента</b>\n\nПока пусто. Навыки появятся по мере настройки.';
export async function openClawSkillsFixture(t,payload=[{name:'fixture',description:'Description',source:'workspace'}],mode='ok'){
 const f=await fixture(t,undefined,{overlay:false,nativeOpenClawSkills:true}),log=path.join(f.home,'oc-skills-calls.jsonl'),data=path.join(f.home,'oc-skills-payload'),release=path.join(f.home,'oc-skills-release'),bin=path.join(f.home,'oc-bin');
 await fs.mkdir(bin);await fs.writeFile(data,typeof payload==='string'?payload:JSON.stringify(payload));
 const code={log,data,release,mode,loading:OC_LOADING};
 await fs.writeFile(path.join(bin,'openclaw'),'#!'+process.execPath+'\n'+`import fs from'node:fs';const f=${JSON.stringify(code)};const argv=process.argv.slice(2);fs.appendFileSync(f.log,JSON.stringify({argv,cwd:process.cwd(),present:Object.fromEntries(['JARVIS_CC_ONLY','BOT_TOKEN','ANTHROPIC_API_KEY','IIA_ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','SYNC_KEY','SYNC_URL','GIT_DIR','NPM_CONFIG_PREFIX','GITHUB_TOKEN'].map(k=>[k,Object.hasOwn(process.env,k)]))})+'\\n');if(argv.join(' ')!=='skills list --json --eligible')process.exit(71);if(f.mode==='exit')process.exit(17);const done=()=>process.stdout.write(fs.readFileSync(f.data),()=>process.exit(0));if(f.mode==='hold'){const tick=setInterval(()=>{if(fs.existsSync(f.release)){clearInterval(tick);done();}},5);}else done();`,{mode:0o700});
 process.env.PATH=bin+path.delimiter+process.env.PATH;
 await saveState({...((await loadState()).state),engine:'oc',activeProject:'unavailable-cli-project'});
 return{...f,readCalls:async()=>{try{return(await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return[];throw e;}},release:()=>fs.writeFile(release,'release'),setPayload:value=>fs.writeFile(data,typeof value==='string'?value:JSON.stringify(value))};
}
export function visibleHtml(text){return text.replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
export function assertBalanced(assert,text){const stack=[];for(const m of text.matchAll(/<(\/?)(b|code|pre|i)>/g)){if(m[1])assert.equal(stack.pop(),m[2]);else stack.push(m[2]);}assert.deepEqual(stack,[]);}
