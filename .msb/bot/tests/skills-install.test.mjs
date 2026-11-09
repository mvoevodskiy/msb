/** Old reachable model marker -> real worker/file/processed reply; synthetic model and private HOME only. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {installFixture,payload,block,installed,invalid,failed,skillPath,installIngressProbe} from './helpers/skills-install-fixture.mjs';
import {loadState,saveState} from '../src/state.mjs';
import {agentOptionsProbe} from './helpers/agent-options.mjs';
const write=async(file,text)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);};
for(const provider of ['claude','codex'])test('skill install: '+provider+' writes its own native user skill then reports the old exact success',async t=>{
 const f=await installFixture(t,{provider}),other=skillPath(f.home,provider==='claude'?'codex':'claude');
 await f.run();assert.equal(await f.exists(skillPath(f.home,provider)),true);assert.equal(await f.exists(other),false);assert.equal(await f.exists(skillPath(f.home,'oc')),false);
 assert.equal(await fs.readFile(skillPath(f.home,provider),'utf8'),'---\nname: fixture-skill\ndescription: "When reviewing"\n---\n\n# Review\nUse the checklist.\n');assert.ok(f.final().includes(installed()));assert.equal(f.final().includes('INSTALL_SKILL'),false);
});
test('skill install: trims and normalizes the old payload, including quoted description and literal dollar replacement text',async t=>{
 const data={name:'  MiXeD-Skill  ',description:'  Use  \n "quotes"  ',body:'  # Body\n$& and $1  '},f=await installFixture(t,{text:block(data)});await f.run();
 assert.equal(await f.exists(skillPath(f.home,'codex','mixed-skill')),true);assert.equal(await fs.readFile(skillPath(f.home,'codex','mixed-skill'),'utf8'),'---\nname: mixed-skill\ndescription: "Use \\"quotes\\""\n---\n\n# Body\n$& and $1\n');assert.ok(f.final().includes(installed('mixed-skill')));
});
for(const [label,value]of [['invalid json','{oops'],['array',[]],['short name',{...payload,name:'a'}],['long name',{...payload,name:'a'.repeat(50)}],['traversal',{...payload,name:'../escape'}],['empty description',{...payload,description:' '}],['long description',{...payload,description:'d'.repeat(201)}],['empty body',{...payload,body:' '}],['long body',{...payload,body:'b'.repeat(60001)}]])test('skill install: '+label+' gives the old invalid-payload response with no native writes',async t=>{
 const f=await installFixture(t,{text:block(value)});await f.run();assert.ok(f.final().includes(invalid));assert.equal(f.final().includes('INSTALL_SKILL'),false);assert.equal(await f.exists(path.join(f.home,'.agents')),false);assert.equal(await f.exists(path.join(f.home,'.claude')),false);
});
test('skill install: only the first complete marker is executed, and all later complete markers are removed',async t=>{
 const f=await installFixture(t,{text:block(payload)+'\nBetween\n'+block({...payload,name:'second-skill'})});await f.run();assert.equal(await f.exists(skillPath(f.home)),true);assert.equal(await f.exists(skillPath(f.home,'codex','second-skill')),false);assert.ok(f.final().includes('Between'));assert.equal(f.final().includes('INSTALL_SKILL'),false);
});
test('skill install: an invalid first marker does not execute a later valid block',async t=>{
 const f=await installFixture(t,{text:block('{bad')+'\n'+block(payload)});await f.run();assert.ok(f.final().includes(invalid));assert.equal(await f.exists(skillPath(f.home)),false);assert.equal(f.final().includes('INSTALL_SKILL'),false);
});
test('skill install: disabled flag strips complete blocks and preserves surrounding answer without files or success',async t=>{
 const f=await installFixture(t);process.env.SKILL_INSTALL_ENABLED='0';await f.run();assert.equal(await f.exists(skillPath(f.home)),false);assert.equal(f.final().includes('INSTALL_SKILL'),false);assert.equal(f.final().includes('Поставил навык'),false);assert.ok(f.final().startsWith('fixture-start\n\nfixture-end'));
});
test('skill install: updating an existing file creates the exact previous .bak before replacement',async t=>{
 const f=await installFixture(t),file=skillPath(f.home);await write(file,'previous fixture skill');await f.run();assert.equal(await f.exists(file+'.bak'),true);assert.equal(await fs.readFile(file+'.bak','utf8'),'previous fixture skill');assert.ok((await fs.readFile(file,'utf8')).includes('name: fixture-skill'));assert.ok(f.final().includes(installed(payload.name,true)));
});
test('skill install: a backup failure preserves the old file and returns the old write-failure text',async t=>{
 const f=await installFixture(t),file=skillPath(f.home);await write(file,'must survive');await fs.mkdir(file+'.bak');await f.run();assert.equal(await fs.readFile(file,'utf8'),'must survive');assert.ok(f.final().includes(failed));assert.equal(f.final().includes('Обновил навык'),false);
});
test('skill install: a write failure is explicit and cannot be claimed as installed',async t=>{
 const f=await installFixture(t);await fs.writeFile(path.join(f.home,'.agents'),'fixture blocking file');await f.run();assert.ok(f.final().includes(failed));assert.equal(f.final().includes('Поставил навык'),false);assert.equal(await fs.readFile(path.join(f.home,'.agents'),'utf8'),'fixture blocking file');
});
test('skill install: Claude mirrors to an existing OpenClaw home with the old two-engine result',async t=>{
 const f=await installFixture(t,{provider:'claude'});await fs.mkdir(path.join(f.home,'.openclaw'));await f.run();for(const provider of ['claude','oc'])assert.equal(await f.exists(skillPath(f.home,provider)),true);assert.equal(await f.exists(skillPath(f.home,'codex')),false);assert.ok(f.final().includes(installed(payload.name,false,true)));
});
test('skill install: pinned Claude-only mode does not create an OpenClaw mirror',async t=>{
 const f=await installFixture(t,{provider:'claude'});process.env.JARVIS_CC_ONLY='1';await fs.mkdir(path.join(f.home,'.openclaw'));await f.run();assert.equal(await f.exists(skillPath(f.home,'claude')),true);assert.equal(await f.exists(skillPath(f.home,'oc')),false);assert.ok(f.final().includes(installed()));
});
test('skill install: Codex never mirrors into Claude or OpenClaw even when those native homes exist',async t=>{
 const f=await installFixture(t);await fs.mkdir(path.join(f.home,'.openclaw'));await fs.mkdir(path.join(f.home,'.claude'));await f.run();assert.equal(await f.exists(skillPath(f.home)),true);for(const provider of ['claude','oc'])assert.equal(await f.exists(skillPath(f.home,provider)),false);
});
test('skill install: a provider change during the model call cannot redirect the captured target',async t=>{
 const f=await installFixture(t,{beforeReturn:async()=>{const {state}=await loadState();await saveState({...state,extAuthBypass:'claude'});}});await f.run();assert.equal((await loadState()).state.extAuthBypass,'claude');assert.equal(await f.exists(skillPath(f.home,'codex')),true);assert.equal(await f.exists(skillPath(f.home,'claude')),false);
});
test('skill install: project Add advice still installs in the native user scope and does not edit project context',async t=>{
 const f=await installFixture(t),project=path.join(f.home,'project');await fs.mkdir(project);await fs.writeFile(path.join(project,'AGENTS.md'),'unchanged project context');const {state}=await loadState();await saveState({...state,activeProject:'alpha'});await f.callback('skills:add:project');await f.run();assert.equal(await f.exists(skillPath(f.home)),true);assert.equal(await fs.readFile(path.join(project,'AGENTS.md'),'utf8'),'unchanged project context');assert.equal(await f.exists(path.join(project,'.agents')),false);
});
test('skill install: a completed partial error still processes the returned model text',async t=>{
 const f=await installFixture(t,{ok:false});await f.run();assert.equal(await f.exists(skillPath(f.home)),true);assert.ok(f.final().includes(installed()));
});
test('skill install: aborted output cannot write skills or publish a success',async t=>{
 const f=await installFixture(t,{aborted:true});await f.run();assert.equal(await f.exists(skillPath(f.home)),false);assert.equal([...f.messages,...f.edits].some(text=>text.includes('Поставил навык')),false);assert.ok(f.edits.includes('Моя остановочка ✋🏽⛔️'));
});
test('skill install: processed result appears before the old plan buttons and in history, not raw marker JSON',async t=>{
 const f=await installFixture(t,{text:block(payload)+'\n[КНОПКИ: plan]'});await f.run();assert.equal(await f.exists(skillPath(f.home)),true);assert.ok(f.messages.at(-1).includes(installed()));assert.equal(f.messageOptions.at(-1).reply_markup.inline_keyboard[0][0].callback_data,'plan:approve');
 const diary=await fs.readFile(path.join(process.env.MSB_RUNTIME_ROOT,'bots/default/chat-diary.jsonl'),'utf8');assert.equal(diary.includes('INSTALL_SKILL'),false);assert.ok(diary.includes('Поставил навык'));
});
test('skill install: unsupported native providers cannot fabricate success or write a foreign engine',async t=>{
 const f=await installFixture(t,{provider:'qwen'});await f.run();assert.ok(f.final().includes(failed));for(const name of ['.agents','.claude','.openclaw'])assert.equal(await f.exists(path.join(f.home,name)),false);
});
for(const provider of ['claude','codex'])test('skill install prompt: actual '+provider+' runner carries marker schema and captures the native user target',()=>{
 const out=agentOptionsProbe(provider,'auto','opus','high','2.1.316',false,'','skills-enabled');assert.ok(out.calls[0].nativePrompt.includes('[INSTALL_SKILL]'));assert.ok(out.calls[0].nativePrompt.includes('Успех словами НЕ обещай до результата'));assert.deepEqual(out.skillInstall,{providerId:provider,home:out.workspace,mirrorOpenClaw:true});assert.ok(out.calls[0].nativePrompt.includes('[ADD_MCP]'));
});


test('skill install: infrastructure exception text is an error notice and never executes model-looking markers',async t=>{
 const f=await installFixture(t,{throwError:true});await f.run();assert.equal(await f.exists(skillPath(f.home)),false);assert.equal(f.final().includes('Поставил навык'),false);assert.ok(f.final().includes('❌ Ошибка:'));
});

for(const provider of ['claude','codex'])test('skill install prompt: actual '+provider+' target stays captured when the stored provider changes before completion',()=>{
 const out=agentOptionsProbe(provider,'auto','opus','high','2.1.316',false,'','skills-race');assert.equal(out.state.extAuthBypass,provider==='codex'?'claude':'codex');assert.deepEqual(out.skillInstall,{providerId:provider,home:out.workspace,mirrorOpenClaw:true});
});
for(const name of ['a1','a'.repeat(49)])test('skill install: old inclusive name/description/body bounds accept '+name.length+'-unit name',async t=>{
 const data={name,description:'d'.repeat(200),body:'🧠'.repeat(30000)},f=await installFixture(t,{text:block(data)});await f.run();const file=skillPath(f.home,'codex',name);assert.equal(await f.exists(file),true);assert.ok((await fs.readFile(file,'utf8')).endsWith(data.body+'\n'));assert.ok(f.final().includes(installed(name)));
});
test('skill install: incomplete markers remain literal text and never create a file',async t=>{
 const f=await installFixture(t,{text:'[INSTALL_SKILL]{"name":"fixture-skill"}'});await f.run();assert.equal(await f.exists(skillPath(f.home)),false);assert.ok(f.final().includes('[INSTALL_SKILL]'));assert.equal(f.final().includes('Поставил навык'),false);
});


test('skill install: mirror failure reports failure after a successful primary write without claiming a joint transaction',async t=>{
 const f=await installFixture(t,{provider:'claude'});await fs.mkdir(path.join(f.home,'.openclaw'));await fs.writeFile(path.join(f.home,'.openclaw/skills'),'blocking mirror root');await f.run();assert.equal(await f.exists(skillPath(f.home,'claude')),true);assert.ok(f.final().includes(failed));assert.equal(f.final().includes('на обоих движках'),false);
});


test('skill install: successful OC final text retains the old Claude primary and existing OpenClaw mirror',async t=>{
 const f=await installFixture(t,{provider:'oc'});await fs.mkdir(path.join(f.home,'.openclaw'));await f.run();for(const provider of ['claude','oc'])assert.equal(await f.exists(skillPath(f.home,provider)),true);assert.equal(await f.exists(skillPath(f.home,'codex')),false);assert.ok(f.final().includes(installed(payload.name,false,true)));
});
test('skill install: OC partial-error output cannot execute the old success-only marker workflow',async t=>{
 const f=await installFixture(t,{provider:'oc',ok:false});await f.run();for(const name of ['.agents','.claude','.openclaw'])assert.equal(await f.exists(path.join(f.home,name)),false);assert.equal(f.final().includes('Поставил навык'),false);
});

for(const provider of ['claude','codex'])test('skill install: complete actual '+provider+' bot/runner/finalizer chain writes the returned marker and journals its processed result',()=>{
 const out=installIngressProbe(provider);assert.equal(out.calls.length,1);assert.equal(out.calls[0].provider,provider);assert.equal(out.calls[0].cwd,out.workspace);assert.ok(out.calls[0].args.join(' ').includes('[INSTALL_SKILL]'));assert.ok(out.content?.includes('name: fixture-skill'));assert.ok(out.content?.includes('# Review\nUse the checklist.'));assert.ok(out.final.includes(installed()));assert.equal(out.final.includes('INSTALL_SKILL'),false);assert.ok(out.diary.includes('Поставил навык'));assert.equal(out.diary.includes('INSTALL_SKILL'),false);
});


test('skill install: a plan-looking marker inside installed skill body does not create an approval card',async t=>{
 const data={...payload,body:'Instructions containing [КНОПКИ: plan] as data.'},f=await installFixture(t,{text:block(data)});await f.run();assert.equal(await f.exists(skillPath(f.home)),true);assert.ok(f.final().includes(installed()));assert.equal(f.messageOptions.some(options=>options.reply_markup),false);assert.equal(f.editOptions.some(options=>options.reply_markup),false);
});


for(const [label,description,expected]of [
 ['backslash',String.raw`Use C:\Users\Documents when checking paths`,String.raw`description: "Use C:\\Users\\Documents when checking paths"`],
 ['null-control','Use\u0000 data',String.raw`description: "Use\u0000 data"`],
 ['c1-control','Use\u007f data',String.raw`description: "Use\u007f data"`],
 ['unpaired-unicode','Use\ud800 data','description: "Use� data"'],
])test('skill install: native-compatible YAML keeps '+label+' description after writing the old accepted payload',async t=>{
 const f=await installFixture(t,{text:block({...payload,description})});await f.run();const file=skillPath(f.home);assert.equal(await f.exists(file),true);assert.ok((await fs.readFile(file,'utf8')).includes(expected+'\n'));assert.ok(f.final().includes(installed()));
});


for (const provider of ['codex', 'claude']) {
  test('skill install: '+provider+' handles an NEL-only description using its native contract', async t => {
    const f = await installFixture(t, {provider, text: block({...payload, description: '\u0085'})});
    await f.run();
    const file = skillPath(f.home, provider);
    if (provider === 'codex') {
      assert.equal(await f.exists(file), false, 'Codex cannot load a description that becomes empty');
      assert.ok(f.final().includes(invalid));
    } else {
      assert.ok((await fs.readFile(file, 'utf8')).includes(String.raw`description: "\u0085"`));
      assert.ok(f.final().includes(installed()));
    }
  });
}
