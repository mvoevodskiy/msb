/**
 * Manual pinned0.166 smoke: exact writer -> actual skills/list, owned HOME only.
 * Run: node this-file /absolute/codex SOURCE_SHA; no login/model/thread/config API.
 * [Writer](../../src/skills/install-writer.mjs), [RPC](../../../../overlay/bot/ext/codex-skills-rpc.mjs), [contract](../reference/parity-skills-contract.txt).
 * Caller supplies network isolation; this fixture makes no claim about opaque CLI internals.
 */
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {writeInstalledSkill} from '../../src/skills/install-writer.mjs';
import {readCodexSkillList} from '../../../../overlay/bot/ext/codex-skills-rpc.mjs';
const [command,sourceCommit]=process.argv.slice(2);
if(!command || !path.isAbsolute(command) || !/^[0-9a-f]{40}$/.test(sourceCommit || ''))throw Error('Pass an absolute pinned binary and full source SHA');
const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'msb-native-skill-home-')));let result;
try{
 const env={HOME:home,CODEX_HOME:path.join(home,'.codex'),PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:path.join(home,'tmp'),XDG_CONFIG_HOME:path.join(home,'xdg-config'),XDG_CACHE_HOME:path.join(home,'xdg-cache'),XDG_DATA_HOME:path.join(home,'xdg-data'),XDG_RUNTIME_DIR:path.join(home,'xdg-runtime')};
 for(const directory of [env.CODEX_HOME,env.TMPDIR,env.XDG_RUNTIME_DIR])await fs.mkdir(directory,{recursive:true,mode:0o700});
 const version=execFileSync(command,['--version'],{env,encoding:'utf8',timeout:5000}).trim();if(version!=='codex-cli 0.166.0')throw Error('Pinned CLI mismatch: '+version);
 const cwd=path.join(home,'workspace');await fs.mkdir(cwd);execFileSync('git',['init','--quiet',cwd],{env});
 const cases=[{name:'normal-skill',description:'When reviewing code'},{name:'quoted-skill',description:'Use "quoted" words'},
  {name:'path-skill',description:String.raw`Use C:\Users\Documents when checking paths`},{name:'42',description:'Numeric name'},{name:'true',description:'Boolean-looking name'},
  {name:'multiline-skill',description:'  Use\nmultiple\tspaces  '},{name:'nul-skill',description:'Use\u0000 data'},
  {name:'c1-skill',description:'Use\u007f\u0085\u009f data'},{name:'unpaired-skill',description:'Use\ud800 data'},{name:'noncharacter-skill',description:'Use\ufffe\uffff data'},
 ].map(skill=>({...skill,body:'# Synthetic native skill\nOnly a metadata fixture.'}));
 for(const skill of cases)await writeInstalledSkill(skill,{providerId:'codex',home,mirrorOpenClaw:false});
 const reply=await readCodexSkillList({command,cwd,env});if(!reply.ok)throw Error('Native catalog failed: '+JSON.stringify(reply));
 const entry=reply.data.data.find(row=>row.cwd===cwd);if(!entry)throw Error('Owned cwd result missing');
 const own=(entry.skills || []).filter(row=>row.path?.startsWith(path.join(home,'.agents/skills')+path.sep));
 result={version,source_commit:sourceCommit,uid:process.getuid?.(),methods:['initialize','initialized','skills/list'],model_turns:0,owner_auth_or_config_used:false,owner_skill_files_read_or_written:false,
  cases:cases.map(expected=>{const metadata=own.filter(row=>row.name===expected.name).map(({name,description,scope,enabled})=>({name,description,scope,enabled})),description=expected.description.trim().replace(/\s+/g,' ').toWellFormed();return{name:expected.name,found:metadata.length===1,description_matches:metadata.length===1 && metadata[0].description===description,metadata};}),
  errors:(entry.errors || []).filter(row=>JSON.stringify(row).includes(home)).map(row=>JSON.parse(JSON.stringify(row).split(home).join('$OWN_HOME')))};
}finally{await fs.rm(home,{recursive:true,force:true});}
try{await fs.stat(home);throw Error('Owned HOME cleanup failed');}catch(error){if(error.code!=='ENOENT')throw error;}
result.temporary_home_removed=true;result.passed=result.cases.every(row=>row.found && row.description_matches) && result.errors.length===0;
console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
