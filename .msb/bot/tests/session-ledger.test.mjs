/** Old tE metadata through the actual runner and provider fences, fake CLI only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const fixture=fileURLToPath(new URL('./fixtures/session-ledger.mjs',import.meta.url));
function run(provider,scenario){
 const out=spawnSync(process.execPath,[fixture,provider,scenario],{env:{PATH:path.dirname(process.execPath),TMPDIR:os.tmpdir()},encoding:'utf8',timeout:9000});assert.equal(out.status,0,out.stderr);
 const line=out.stdout.split('\n').find(s=>s.startsWith('SESSION_LEDGER='));assert.ok(line,out.stdout);const r=JSON.parse(line.slice('SESSION_LEDGER='.length));
 assert.equal(r.calls.length,['throws','pre-spawn-abort'].includes(scenario)?0:['repeat','update-order','completion-order'].includes(scenario)?2:1);
 if(['first','repeat','autonomy','tool-only','redaction','bounded','unicode','update-order','limit'].includes(scenario)){
  assert.equal(r.ok,true,'The fixture must reach a successful production engine result before checking metadata');
  assert.equal(r.state.ccSessionId,scenario==='limit'?r.newId:r.id);
 }
 if(scenario==='provider-away'){assert.equal(r.ok,true);assert.equal(r.state.parkedCcSessions.codex,r.id);}
 if(scenario.startsWith('error-')||scenario.startsWith('abort-'))assert.equal(r.ok,false);
 return r;
}
function entry(r){assert.ok(Array.isArray(r.state.sessionHistory),'A resolved owned native turn must be indexed in the bot ledger');const row=r.state.sessionHistory.find(v=>v.id===r.id);assert.ok(row,'The actual native ID must be selectable, not a fabricated timestamp');return row;}
for(const provider of ['claude','codex']){
 test('session ledger: first '+provider+' turn records captured project, provider and bounded first description',()=>{
  const r=run(provider,'first'),row=entry(r);assert.equal(r.ok,true);assert.equal(row.project,'alpha');assert.equal(row.engine,'cc');assert.equal(row.providerId,provider);assert.equal(row.firstPrompt,'fixture first prompt');assert.equal(row.messageCount,1);
  assert.ok(Number.isFinite(Date.parse(row.startedAt)));assert.equal(row.startedAt,row.lastActivity);assert.equal(row.lastPrompt,undefined);assert.equal(r.state.ccSessionId,r.id);assert.equal(r.calls[0].cwd,r.project);
 });
 test('session ledger: resumed '+provider+' updates activity/count/last prompt without replacing first metadata',()=>{
  const r=run(provider,'repeat'),row=entry(r);assert.equal(row.firstPrompt,'fixture first prompt');assert.equal(row.lastPrompt,'fixture latest prompt');assert.equal(row.messageCount,2);assert.equal(r.state.sessionHistory.length,1);assert.ok(Date.parse(row.lastActivity)>=Date.parse(row.startedAt));
 });
 for(const scenario of ['autonomy','tool-only'])test('session ledger: '+provider+' '+scenario+' returned engine pass is counted',()=>{
  const r=run(provider,scenario),row=entry(r);assert.equal(r.ok,true);assert.equal(row.messageCount,1);assert.equal(row.firstPrompt,'fixture first prompt');
 });
 for(const scenario of ['error-existing','abort-existing'])test('session ledger: '+provider+' '+scenario+' preserves the known ID and counts the owned returned attempt',()=>{
  const r=run(provider,scenario),row=entry(r);assert.equal(r.ok,false);assert.equal(r.state.ccSessionId,r.initial.ccSessionId);assert.equal(row.messageCount,4);assert.equal(row.firstPrompt,r.initial.sessionHistory[0].firstPrompt);assert.equal(row.lastPrompt,'fixture first prompt');
 });
}
test('session ledger: cap100 evicts only the oldest metadata row, not the new accepted conversation',()=>{
 const r=run('codex','limit');assert.equal(r.state.sessionHistory.length,100);assert.equal(r.state.sessionHistory[0].id,r.secondOldId);assert.equal(r.state.sessionHistory.at(-1).id,r.newId);assert.equal(r.state.sessionHistory.at(-1).messageCount,1);
});
test('session ledger: updating a retained older ID does not reorder rows or overwrite its first metadata',()=>{
 const r=run('codex','update-order'),row=entry(r);assert.deepEqual(r.state.sessionHistory.map(v=>v.id),r.initial.sessionHistory.map(v=>v.id));assert.equal(row.startedAt,r.initial.sessionHistory[0].startedAt);assert.equal(row.project,r.initial.sessionHistory[0].project);assert.equal(row.firstPrompt,r.initial.sessionHistory[0].firstPrompt);assert.equal(row.messageCount,5);assert.deepEqual(r.state.sessionHistory[1],r.initial.sessionHistory[1]);
});
test('session ledger: existing journal redaction is retained before storing user-facing metadata',()=>{
 const r=run('codex','redaction'),row=entry(r);assert.equal(row.firstPrompt.includes('sk-session-fixture-secret'),false);assert.ok(row.firstPrompt.includes('[скрыто]'));
});
test('session ledger: stored prompt descriptions retain the old200 character bound',()=>{
 const r=run('codex','bounded'),row=entry(r);assert.equal(row.firstPrompt.length,200);
});
test('session ledger: an accepted late first result parked after a provider switch retains its captured provider/project',()=>{
 const r=run('codex','provider-away'),row=entry(r);assert.equal(row.providerId,'codex');assert.equal(row.project,'alpha');assert.equal(r.state.extAuthBypass,'claude');assert.equal(r.state.ccSessionId,undefined);assert.equal(r.state.parkedCcSessions.codex,r.id);
});
for(const scenario of ['foreign','sentinel','throws','no-id-first'])test('session ledger control: '+scenario+' cannot create a selectable ID beyond ownership fences',()=>{
 const r=run('codex',scenario);assert.equal(r.state.sessionHistory,undefined);assert.equal(r.state.pendingCcSessionStarts,undefined);
 if(scenario==='project-reset')assert.equal(r.state.activeProject,'beta');
 if(scenario==='throws'){assert.equal(r.error,'PROJECT_NOT_FOUND');assert.deepEqual(r.calls,[]);}
 assert.equal(r.state.fixturePreserved,true);
});

for(const scenario of ['foreign-existing','sentinel-existing'])test('session ledger control: '+scenario+' cannot replace the known provider ID or metadata',()=>{
 const r=run('codex',scenario);assert.equal(r.state.ccSessionId,r.initial.ccSessionId);assert.deepEqual(r.state.sessionHistory,r.initial.sessionHistory);assert.equal(r.state.sessionEpoch,r.initial.sessionEpoch);
});

for(const scenario of ['sentinel-first','sentinel-existing'])test('session ledger control: Claude '+scenario+' cannot persist a raw service placeholder as a native ID',()=>{
 const r=run('claude',scenario);assert.equal(r.state.ccSessionId,r.initial.ccSessionId);assert.deepEqual(r.state.sessionHistory,r.initial.sessionHistory);
});

test('session ledger:200 character description storage cannot split a surrogate pair',()=>{
 const r=run('codex','unicode'),row=entry(r);assert.equal(r.ok,true);assert.ok(row.firstPrompt.length<=200);assert.equal(row.firstPrompt.isWellFormed(),true);assert.equal(row.firstPrompt.includes('�'),false);
});

for(const provider of ['claude','codex'])for(const scenario of ['error-first','abort-first','reset','project-reset'])test('session ledger fidelity: '+provider+' '+scenario+' retains a returned observed ID for explicit history, without active resurrection',()=>{
 const r=run(provider,scenario),row=entry(r);assert.equal(row.project,'alpha');assert.equal(row.providerId,provider);assert.equal(row.messageCount,1);assert.equal(row.firstPrompt,'fixture first prompt');
 assert.equal(r.state.ccSessionId,undefined);assert.equal(r.state.parkedCcSessions,undefined);assert.equal(r.state.pendingCcSessionStarts,undefined);assert.equal(r.state.lastCcUsage,undefined);
 if(scenario==='project-reset')assert.equal(r.state.activeProject,'beta');
});
test('session ledger fidelity: a returned launched error may count the already known carried resume ID',()=>{
 const r=run('codex','carried-error'),row=entry(r);assert.equal(r.ok,false);assert.equal(r.calls.length,1);assert.equal(r.state.ccSessionId,r.initial.ccSessionId);assert.equal(row.messageCount,4);assert.equal(row.lastPrompt,'fixture first prompt');
});
test('session ledger fidelity: pre-spawn abort must not count a carried input ID as an executed engine pass',()=>{
 const r=run('codex','pre-spawn-abort');assert.equal(r.ok,false);assert.deepEqual(r.calls,[]);assert.equal(r.state.ccSessionId,r.initial.ccSessionId);assert.deepEqual(r.state.sessionHistory,r.initial.sessionHistory);
});
test('session ledger fidelity: same-ID returned passes keep the old completion order, including both counts',()=>{
 const r=run('codex','completion-order'),row=entry(r),newer=r.completionAfterNewer.sessionHistory.find(v=>v.id===r.id);
 assert.equal(newer.messageCount,4);assert.equal(newer.lastPrompt,'fixture newer prompt');assert.equal(row.messageCount,5);assert.equal(row.lastPrompt,'fixture older prompt');assert.equal(row.firstPrompt,r.initial.sessionHistory[0].firstPrompt);assert.equal(r.state.ccSessionId,r.initial.ccSessionId);
});
