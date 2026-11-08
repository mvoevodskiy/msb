/** Reachable old skills views through production command/callbacks and an owned HOME. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './helpers/menu-fixture.mjs';
import {loadState,saveState} from '../src/state.mjs';
import {readEnvMap} from '../src/env/store.mjs';
const TOP='🧩 <b>Навыки</b>\n\nИнструкции и правила, которые расширяют возможности агента.\n⠀';
const ADD='🧩 <b>Добавить навык</b>\n\nСкажи агенту что нужно — он создаст навык:\n&gt; <code>создай навык для код-ревью</code>\n&gt; <code>добавь навык для анализа данных</code>\n⠀';
const FOLDER='<b>📂 workspace</b>\n\nДоступны агенту всегда, в любом проекте.\n\n';
const state=async()=>(await loadState()).state;
async function setup(t,runTurn){const f=await fixture(t,runTurn,{overlay:false});await saveState({...await state(),extAuthBypass:'claude',ccSessionId:'claude-skills-fixture'});return f;}
async function skill(root,relative,body){const dir=path.join(root,'.claude/skills',relative);await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'SKILL.md');await fs.writeFile(file,body);return file;}
const text=f=>{assert.equal(typeof f.edits.at(-1),'string','The actual old skills callback must render a view');return f.edits.at(-1);};
const buttons=f=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat()||[];
const find=(f,label)=>{const b=buttons(f).find(x=>x.text===label);assert.ok(b,'The old visible action must exist: '+label);return b.callback_data;};
const escaped=v=>v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function open(f,label){await f.callback(find(f,label));}
async function project(f,name='alpha'){const dir=path.join(path.dirname(f.workspace),'projects',name);await fs.mkdir(dir,{recursive:true});await saveState({...await state(),activeProject:name});return dir;}

test('skills: empty /skills restores the old top text and workspace/Back, without a new create form',async t=>{
 const f=await setup(t),before=await state();await f.message('/skills');assert.equal(f.messages.at(-1),TOP);
 assert.deepEqual(f.messageOptions.at(-1).reply_markup.inline_keyboard,[[{text:'📂 workspace (0)',callback_data:'skills:folder:workspace'}],[{text:'« Назад',callback_data:'skills:back-menu'}]]);assert.deepEqual(await state(),before);
});
test('skills: empty menu and command render the same old top view',async t=>{
 const f=await setup(t);await f.message('/skills');const opts=f.messageOptions.at(-1);await f.callback('menu:skills');assert.equal(text(f),TOP);assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard,opts.reply_markup.inline_keyboard);
});
test('skills: HOME and base count disabled entries, hide exact system name and retain an _always skill with another name',async t=>{
 const f=await setup(t);await skill(f.home,'home','---\nname: HomeSkill\n---\nHome');await skill(f.home,'paused','---\nname: Paused\ndisabled: true\n---\nPause');await skill(f.workspace,'hidden','---\nname: system\n---\nHidden');await skill(f.workspace,'_always/visible','---\nname: AlwaysVisible\n---\nAlways');
 await f.callback('menu:skills');assert.equal(find(f,'📂 workspace (3)'),'skills:folder:workspace');await open(f,'📂 workspace (3)');const s=text(f);assert.ok(s.startsWith(FOLDER));for(const name of ['🧠 HomeSkill','⏸ Paused','🧠 AlwaysVisible'])assert.ok(s.includes(name));assert.equal(s.includes('system'),false);assert.deepEqual(buttons(f).slice(0,3).map(b=>b.text).sort(),['⏸ Paused','🧠 AlwaysVisible','🧠 HomeSkill'].sort());
});
test('skills: active project has its own populated folder, names are escaped and state is not changed',async t=>{
 const f=await setup(t),dir=await project(f,'a<b');await skill(dir,'one','# Project <&>');const before=await state();await f.callback('menu:skills');assert.ok(find(f,'📂 a<b (1)'));await open(f,'📂 a<b (1)');assert.equal(text(f),'<b>📂 a&lt;b</b>\n\nДоступны агенту когда этот проект активен.\n\n🧠 one\n⠀');assert.deepEqual(await state(),before);
});
test('skills: an empty selected project does not create an extra folder button',async t=>{
 const f=await setup(t);await project(f);await f.callback('menu:skills');assert.deepEqual(buttons(f).map(b=>b.callback_data),['skills:folder:workspace','skills:back-menu']);
});
test('skills: coincident HOME and base roots are scanned only once',async t=>{
 const f=await setup(t);process.env.MSB_WORKSPACE_DIR=f.home;await skill(f.home,'one','Only one');await f.callback('menu:skills');assert.ok(find(f,'📂 workspace (1)'));await open(f,'📂 workspace (1)');assert.equal(buttons(f).filter(b=>b.callback_data.startsWith('skills:view:')).length,1);
});
test('skills: empty folder restores Нет навыков plus old Add and Back routes',async t=>{
 const f=await setup(t);await f.callback('skills:folder:workspace');assert.equal(text(f),FOLDER+'<i>Нет навыков</i>\n⠀');assert.deepEqual(buttons(f),[{text:'➕ Добавить',callback_data:'skills:add:workspace'},{text:'« Назад',callback_data:'skills:back'}]);
});
test('skills: exact SKILL.md discovery is recursive and does not open sibling files',async t=>{
 const f=await setup(t);await skill(f.workspace,'outer/nested','---\nname: Nested\n---\nNested');const ignored=path.join(f.workspace,'.claude/skills/outer/README.md');await fs.writeFile(ignored,'Do not open');const read=fs.readFile.bind(fs);fs.readFile=async(file,...args)=>{assert.notEqual(String(file),ignored);return read(file,...args);};t.after(()=>{fs.readFile=read;});await f.callback('skills:folder:workspace');assert.ok(text(f).includes('🧠 Nested'));assert.equal(buttons(f).filter(b=>b.callback_data.startsWith('skills:view:')).length,1);
});
test('skills: missing or unreadable roots are skipped without hiding another readable root',async t=>{
 const f=await setup(t);await skill(f.home,'good','---\nname: Good\n---\nGood');const unreadable=path.join(f.workspace,'.claude/skills');await fs.mkdir(unreadable,{recursive:true});const read=fs.readdir.bind(fs);fs.readdir=async(file,...args)=>{if(String(file)===unreadable)throw Object.assign(Error('fixture root unreadable'),{code:'EACCES'});return read(file,...args);};t.after(()=>{fs.readdir=read;});await f.callback('menu:skills');assert.ok(find(f,'📂 workspace (1)'));await open(f,'📂 workspace (1)');assert.ok(text(f).includes('🧠 Good'));
});
test('skills: unreadable skill metadata is skipped, while valid neighbors remain',async t=>{
 const f=await setup(t),bad=await skill(f.workspace,'bad','Bad');await skill(f.workspace,'good','Good');const read=fs.readFile.bind(fs);fs.readFile=async(file,...args)=>{if(String(file)===bad)throw Object.assign(Error('fixture metadata unreadable'),{code:'EACCES'});return read(file,...args);};t.after(()=>{fs.readFile=read;});await f.callback('skills:folder:workspace');assert.ok(text(f).includes('🧠 good'));assert.equal(text(f).includes('🧠 bad'),false);
});
test('skills: a directory symlink is not recursively followed by the old Claude reader',async t=>{
 const f=await setup(t);await skill(path.join(f.home,'other'),'linked','Linked');await fs.mkdir(path.join(f.workspace,'.claude/skills'),{recursive:true});await fs.symlink(path.join(f.home,'other/.claude/skills/linked'),path.join(f.workspace,'.claude/skills/link'));await f.callback('menu:skills');assert.ok(find(f,'📂 workspace (0)'));
});
test('skills: a readable SKILL.md symlink retains the old file behavior',async t=>{
 const f=await setup(t),external=path.join(f.home,'controlled-skill.md');await fs.writeFile(external,'---\nname: FileLink\n---\nControlled');const dir=path.join(f.workspace,'.claude/skills/file-link');await fs.mkdir(dir,{recursive:true});await fs.symlink(external,path.join(dir,'SKILL.md'));await f.callback('skills:folder:workspace');await open(f,'🧠 FileLink');await open(f,'📄 Содержимое');assert.ok(text(f).includes('Controlled'));assert.equal(await fs.readFile(external,'utf8'),'---\nname: FileLink\n---\nControlled');
});
test('skills: frontmatter keeps the old simple quoted strings and exact disabled flag; heading is description fallback',async t=>{
 const f=await setup(t);await skill(f.workspace,'simple','---\nname: "Quoted"\ndisabled: false\n---\n# Heading fallback');await f.callback('skills:folder:workspace');await open(f,'🧠 "Quoted"');assert.ok(text(f).startsWith('<b>🧠 "Quoted"</b>\n\nHeading fallback\n\n'));assert.equal(text(f).includes('Расположение: workspace'),true);
});
test('skills: malformed frontmatter falls back to directory name and first heading, not a new YAML interpretation',async t=>{
 const f=await setup(t);await skill(f.workspace,'fallback','not frontmatter\nname: NotMetadata\n# Heading\nText');await f.callback('skills:folder:workspace');await open(f,'🧠 fallback');assert.ok(text(f).startsWith('<b>🧠 fallback</b>\n\nHeading\n\n'));
});
test('skills: CRLF frontmatter retains old non-YAML fallback behavior',async t=>{
 const f=await setup(t);await skill(f.workspace,'crlf','---\r\nname: NotMetadata\r\ndisabled: true\r\n---\r\n# Body heading\nBody');await f.callback('skills:folder:workspace');await open(f,'🧠 crlf');assert.ok(text(f).startsWith('<b>🧠 crlf</b>\n\nBody heading\n\n'));
});
test('skills: quoted disabled true is not the old exact boolean flag',async t=>{
 const f=await setup(t);await skill(f.workspace,'quoted-flag','---\nname: QuotedFlag\ndisabled: "true"\n---\nBody');await f.callback('skills:folder:workspace');assert.ok(find(f,'🧠 QuotedFlag'));assert.equal(buttons(f).some(b=>b.text==='⏸ QuotedFlag'),false);
});
test('skills: a SKILL.md directly in the root is selectable even with an empty relative directory',async t=>{
 const f=await setup(t);await skill(f.workspace,'','---\nname: RootSkill\n---\nRoot body');await f.callback('skills:folder:workspace');await open(f,'🧠 RootSkill');await open(f,'📄 Содержимое');assert.ok(text(f).includes('Root body'));
});
test('skills: card uses escaped metadata, full UTF8 byte size and only the old Content/Back actions',async t=>{
 const f=await setup(t),body='---\nname: A<&>\ndescription: Описание <&>\n---\nПривет 🌍';await skill(f.workspace,'card',body);await f.callback('skills:folder:workspace');await open(f,'🧠 A<&>');assert.equal(text(f),'<b>🧠 A&lt;&amp;&gt;</b>\n\nОписание &lt;&amp;&gt;\n\nРасположение: workspace\nРазмер: '+(Buffer.byteLength(body)/1024).toFixed(1)+' KB\n⠀');assert.deepEqual(buttons(f).map(b=>[b.text,b.callback_data.startsWith('skills:content:')?'<own content>':b.callback_data]),[['📄 Содержимое','<own content>'],['« Назад','skills:folder:workspace']]);
});
test('skills: content is the actual full file with HTML escaping and returns to the same card',async t=>{
 const f=await setup(t),body='---\nname: Content\n---\n<test>& "quoted"';await skill(f.workspace,'content',body);await f.callback('skills:folder:workspace');await open(f,'🧠 Content');const card=text(f);await open(f,'📄 Содержимое');assert.equal(text(f),'<b>📄 Content</b>\n\n<pre>'+escaped(body)+'</pre>');await open(f,'« Назад');assert.equal(text(f),card);
});
test('skills: long file content retains the old 3500-unit limit and truncation caption',async t=>{
 const f=await setup(t);await skill(f.workspace,'long','x'.repeat(3501));await f.callback('skills:folder:workspace');await open(f,'🧠 long');await open(f,'📄 Содержимое');assert.equal(text(f),'<b>📄 long</b>\n\n<pre>'+'x'.repeat(3500)+'\n\n[...усечено]</pre>');
});
test('skills: display clipping keeps Unicode well-formed in both the old 30-unit label and 3500-unit content',async t=>{
 const f=await setup(t),name='a'.repeat(26)+'🧪',body='---\nname: '+name+'\n---\n'+'🧠'.repeat(1900);await skill(f.workspace,'unicode',body);await f.callback('skills:folder:workspace');const b=buttons(f).find(b=>b.callback_data.startsWith('skills:view:'));assert.ok(b);assert.ok(b.text.length<=30);assert.equal(b.text.isWellFormed(),true);await f.callback(b.callback_data);await open(f,'📄 Содержимое');assert.equal(text(f).isWellFormed(),true);assert.equal(text(f).includes('�'),false);
});
for(const action of ['view','content'])test('skills: unknown '+action+' cannot read a guessed path and keeps the old missing view',async t=>{
 const f=await setup(t),before=await state();await f.callback('skills:'+action+':../../not-a-skill');assert.equal(text(f),'⚠️ Навык не найден');assert.deepEqual(buttons(f),[{text:'« Назад',callback_data:'skills:back'}]);assert.deepEqual(await state(),before);
});
test('skills: a content read failure after successful discovery gets the old bounded error and Back',async t=>{
 const f=await setup(t),file=await skill(f.workspace,'racy','Racy');await f.callback('skills:folder:workspace');await open(f,'🧠 racy');const action=find(f,'📄 Содержимое'),read=fs.readFile.bind(fs);let calls=0;fs.readFile=async(p,...args)=>{if(String(p)===file&&++calls===2)throw Error('fixture content <&>');return read(p,...args);};t.after(()=>{fs.readFile=read;});await f.callback(action);assert.equal(text(f),'❌ fixture content &lt;&amp;&gt;');assert.deepEqual(buttons(f),[{text:'« Назад',callback_data:'skills:back'}]);
});
test('skills: Add restores the old advice, examples and folder Back without opening a new input form or writing files',async t=>{
 let turns=0;const f=await setup(t,async()=>{turns++;return{ok:true,text:'unexpected model turn'};});const before=await state();await f.callback('skills:add:project');assert.equal(text(f),ADD);assert.deepEqual(buttons(f),[{text:'« Назад',callback_data:'skills:folder:project'}]);assert.deepEqual(await state(),before);assert.equal(await fs.access(path.join(f.home,'.claude/skills')).then(()=>true,()=>false),false);assert.equal(turns,0);
});
test('skills: folder Back and top Back use the original navigation actions',async t=>{
 const f=await setup(t);await f.callback('skills:folder:workspace');await open(f,'« Назад');assert.equal(text(f),TOP);assert.equal(find(f,'« Назад'),'skills:back-menu');await open(f,'« Назад');assert.ok(buttons(f).some(b=>b.callback_data==='menu:skills'));
});
test('skills: duplicate HOME/base/project relative paths select the clicked file, never the first root match',async t=>{
 const f=await setup(t),dir=await project(f);await skill(f.home,'review','---\nname: HomeReview\n---\nBODY_HOME');await skill(f.workspace,'review','---\nname: BaseReview\n---\nBODY_BASE');await skill(dir,'review','---\nname: ProjectReview\n---\nBODY_PROJECT');await f.callback('skills:folder:project');await open(f,'🧠 ProjectReview');assert.ok(text(f).includes('Расположение: проект'));await open(f,'📄 Содержимое');assert.ok(text(f).includes('BODY_PROJECT'));assert.equal(text(f).includes('BODY_HOME'),false);await f.callback('skills:folder:workspace');const home=find(f,'🧠 HomeReview'),base=find(f,'🧠 BaseReview');assert.notEqual(home,base);await f.callback(base);await open(f,'📄 Содержимое');assert.ok(text(f).includes('BODY_BASE'));
});
test('skills: long UTF8 relative paths have working view and content callbacks within64bytes',async t=>{
 const f=await setup(t),relative=['nested','я'.repeat(30),'deep','x'.repeat(45)].join('/');await skill(f.workspace,relative,'---\nname: LongPath\n---\nLONG_PATH_BODY');await f.callback('skills:folder:workspace');const view=find(f,'🧠 LongPath');assert.ok(Buffer.byteLength(view)<=64);await f.callback(view);const content=find(f,'📄 Содержимое');assert.ok(Buffer.byteLength(content)<=64);await f.callback(content);assert.ok(text(f).includes('LONG_PATH_BODY'));
});
test('skills: an old project callback cannot silently read the same relative path of a newly selected project',async t=>{
 const f=await setup(t),alpha=await project(f);await skill(alpha,'review','---\nname: Alpha\n---\nALPHA_BODY');await f.callback('skills:folder:project');const old=find(f,'🧠 Alpha');const beta=await project(f,'beta');await skill(beta,'review','---\nname: Beta\n---\nBETA_BODY');const before=await state();await f.callback(old);assert.equal(text(f),'⚠️ Навык не найден');assert.deepEqual(await state(),before);
});
test('skills: list/folder/card/content/Add preserve an existing env input instead of consuming its next value',async t=>{
 const f=await setup(t);await skill(f.workspace,'pending','Pending');await f.callback('settings:env:quick:CUSTOM_SKILLS_FORM');await f.callback('menu:skills');await open(f,'📂 workspace (1)');await open(f,'🧠 pending');await open(f,'📄 Содержимое');await f.callback('skills:add:workspace');assert.equal(text(f),ADD);await f.message('fixture-value');await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});assert.equal((await readEnvMap()).map.get('CUSTOM_SKILLS_FORM'),'fixture-value');
});
test('skills: unauthorized commands/callbacks cannot inspect file contents or change owner state',async t=>{
 const f=await setup(t),file=await skill(f.workspace,'private','PRIVATE_CONTROLLED_BODY'),before=await state(),read=fs.readFile.bind(fs);let calls=0;fs.readFile=async(p,...args)=>{if(String(p)===file)calls++;return read(p,...args);};t.after(()=>{fs.readFile=read;});await f.message('/skills',43);for(const action of ['menu:skills','skills:folder:workspace','skills:view:private','skills:content:private','skills:add:workspace','skills:back-menu'])await f.callback(action,43);assert.equal(calls,0);assert.equal(f.edits.length,0);assert.equal(f.messages.length,0);assert.deepEqual(await state(),before);
});
test('skills: the complete read flow keeps native ID/provider/store and source file bytes intact',async t=>{
 const f=await setup(t),body='---\nname: Stable\n---\nRead only',file=await skill(f.workspace,'stable',body),before=await state(),store=await fs.readFile(f.storeFile,'utf8');await f.callback('menu:skills');await open(f,'📂 workspace (1)');await open(f,'🧠 Stable');await open(f,'📄 Содержимое');await open(f,'« Назад');assert.deepEqual(await state(),before);assert.equal(await fs.readFile(f.storeFile,'utf8'),store);assert.equal(await fs.readFile(file,'utf8'),body);
});
test('skills: unreachable old create/toggle/delete handlers do not add buttons or new mutation workflows',async t=>{
 const f=await setup(t),file=await skill(f.workspace,'stable','Stable'),before=await state();for(const data of ['skills:create','skills:enable:stable','skills:disable:stable','skills:delete:stable','skills:confirm-delete:stable'])await f.callback(data);assert.equal(await fs.readFile(file,'utf8'),'Stable');assert.deepEqual(await state(),before);assert.equal(f.edits.length,0);
});
