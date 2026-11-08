/** Saved-row selection -> actual next core argv/cwd and late-result ownership. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseClaudeArgv} from '../../../overlay/bot/ext/adapters/parse-args.mjs';
const fixture=fileURLToPath(new URL('./fixtures/session-resume.mjs',import.meta.url));
function run(provider,scenario){
 const out=spawnSync(process.execPath,[fixture,provider,scenario],{env:{PATH:path.dirname(process.execPath),TMPDIR:os.tmpdir(),...(process.env.FIXTURE_SESSION_SOURCE_ROOT?{FIXTURE_SESSION_SOURCE_ROOT:process.env.FIXTURE_SESSION_SOURCE_ROOT}:{})},encoding:'utf8',timeout:12000});assert.equal(out.status,0,out.stderr);
 const line=out.stdout.split('\n').find(s=>s.startsWith('SESSION_RESUME='));assert.ok(line,out.stdout);const r=JSON.parse(line.slice('SESSION_RESUME='.length));assert.equal(r.calls.length,scenario==='resume'?1:2,'No extra model call may hide behind resume/selection');return r;
}
for(const provider of ['claude','codex'])for(const scenario of ['resume','preparing','existing','same-id','same-first'])test('session resume '+provider+': '+scenario+' uses the selected conversation and captured project without a late ledger overwrite',()=>{
 const r=run(provider,scenario),same=['same-id','same-first'].includes(scenario),last=r.calls.at(-1),project=same?'alpha':'beta';
 assert.equal(r.afterSelect.ccSessionId,r.target.id);assert.equal(r.afterSelect.activeProject,project);assert.equal(r.afterSelect.sessionEpoch,1);assert.equal(r.afterSelect.lastCcUsage,undefined);
 assert.equal(parseClaudeArgv(last.args).resume,r.target.id);assert.equal(last.cwd,same?r.alpha:r.beta);assert.equal(last.actualCwd,same?r.realAlpha:r.realBeta);assert.equal(last.provider,provider);
 assert.ok(last.systemPrompt.includes('fixture-owner-soul'));assert.ok(last.systemPrompt.includes('fixture-task-'+project));assert.equal(last.systemPrompt.includes('fixture-task-'+(same?'beta':'alpha')),false);
 assert.equal(r.state.ccSessionId,r.target.id);const chosen=r.state.sessionHistory.find(row=>row.id===r.target.id);assert.ok(chosen);assert.equal(chosen.messageCount,r.target.messageCount+1);assert.equal(chosen.firstPrompt,r.target.firstPrompt);
 if(scenario!=='resume'){
  assert.equal(r.calls[0].cwd,r.alpha);assert.equal(r.calls[0].actualCwd,r.realAlpha);assert.ok(r.calls[0].systemPrompt.includes('fixture-task-alpha'));
  assert.equal(r.afterOld.ccSessionId,r.target.id);assert.equal(r.afterOld.lastCcUsage,undefined);assert.equal(r.afterOld.sessionEpoch,1);
  assert.deepEqual(r.afterOld.sessionHistory,r.initial.sessionHistory,'Late result cannot change the selected ledger');
  if(provider==='codex'){assert.equal(r.oldContextMeasured,true);assert.equal(r.oldContextCleared,true);}
 }
 if(same){assert.equal(r.afterSelect.parkedCcSessions[r.foreignProvider],r.foreign);assert.equal(r.afterSelect.pendingCcSessionStarts[r.foreignProvider],'fixture-other-token');}
 else{assert.equal(r.afterSelect.parkedCcSessions,undefined);assert.equal(r.afterSelect.pendingCcSessionStarts,undefined);}
 assert.equal(r.profilePreserved,true);assert.equal(r.providerStorePreserved,true);
});
test('session resume: ID-less Codex -> Claude history/project -> new Claude first -> late Codex cannot return or delete the newer reservation',()=>{
 const r=run('codex','provider-first');assert.equal(r.afterSelect.activeProject,'beta');assert.equal(r.afterSelect.ccSessionId,r.target.id);assert.equal(r.afterSelect.pendingCcSessionStarts,undefined);
 assert.equal(r.newReservationSurvived,true);assert.equal(r.afterOld.ccSessionId,undefined);assert.equal(r.afterOld.parkedCcSessions,undefined);assert.deepEqual(r.afterOld.sessionHistory,r.initial.sessionHistory);
 assert.equal(r.oldContextMeasured,true);assert.equal(r.oldContextCleared,true);assert.equal(r.state.extAuthBypass,'codex');assert.equal(r.state.ccSessionId,undefined);assert.equal(r.state.parkedCcSessions.claude,r.next);
 assert.equal(r.state.sessionHistory.some(row=>row.id===r.old),false);const next=r.state.sessionHistory.find(row=>row.id===r.next);assert.equal(next.providerId,'claude');assert.equal(next.project,'beta');assert.equal(next.messageCount,1);
 assert.equal(r.calls[0].actualCwd,r.realAlpha);assert.equal(r.calls[1].actualCwd,r.realBeta);assert.equal(parseClaudeArgv(r.calls[1].args).resume,null);assert.equal(r.profilePreserved,true);assert.equal(r.providerStorePreserved,true);
});
