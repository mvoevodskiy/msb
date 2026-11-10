/** Project/provider transition races through actual handlers and session placement. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseClaudeArgv} from '../../../overlay/bot/ext/adapters/parse-args.mjs';
const fixture=fileURLToPath(new URL('./fixtures/project-races.mjs',import.meta.url));
function run(scenario){
 const out=spawnSync(process.execPath,[fixture,scenario],{env:{PATH:path.dirname(process.execPath),TMPDIR:os.tmpdir(),...(process.env.FIXTURE_PROJECT_SOURCE_ROOT?{FIXTURE_PROJECT_SOURCE_ROOT:process.env.FIXTURE_PROJECT_SOURCE_ROOT}:{})},encoding:'utf8',timeout:12000});
 assert.equal(out.status,0,out.stderr);const line=out.stdout.split('\n').find(s=>s.startsWith('PROJECT_RACE='));assert.ok(line,out.stdout);return JSON.parse(line.slice(13));
}
for(const scenario of ['preparing','existing'])test('project race: '+scenario+' turn keeps old cwd and cannot restore its conversation after selection',()=>{
 const r=run(scenario);assert.equal(r.calls.length,2);
 assert.equal(r.calls[0].cwd,r.alpha);assert.equal(r.calls[0].actualCwd,r.realAlpha);
 assert.equal(r.calls[1].cwd,r.beta);assert.equal(r.calls[1].actualCwd,r.realBeta);
 assert.ok(r.calls[0].systemPrompt.includes('fixture-alpha-task'));assert.equal(r.calls[0].systemPrompt.includes('fixture-beta-task'),false);
 assert.ok(r.calls[1].systemPrompt.includes('fixture-beta-task'));assert.ok(r.calls[1].systemPrompt.includes('fixture-owner-race-soul'));
 assert.equal(r.afterProject.activeProject,'beta');assert.equal(r.afterProject.ccSessionId,undefined);assert.equal(r.afterProject.pendingCcSessionStarts,undefined);
 assert.equal(r.afterOld.ccSessionId,undefined);assert.equal(r.afterOld.parkedCcSessions,undefined);assert.equal(r.oldContextCleared,true);
 if(scenario==='existing')assert.equal(parseClaudeArgv(r.calls[0].args).resume,r.old);
 assert.equal(parseClaudeArgv(r.calls[1].args).resume,null);assert.equal(r.state.ccSessionId,r.next);
 assert.equal(r.profilePreserved,true);assert.equal(r.providerStorePreserved,true);
});
test('project race: late ID-less provider A cannot return after project reset, or erase new provider B reservation',()=>{
 const r=run('first-provider');assert.equal(r.afterProject.activeProject,'beta');assert.equal(r.afterProject.pendingCcSessionStarts,undefined);
 assert.equal(r.newReservationSurvived,true);assert.equal(r.afterOld.parkedCcSessions,undefined);assert.equal(r.afterOld.ccSessionId,undefined);
 assert.equal(r.state.extAuthBypass,'codex');assert.equal(r.state.ccSessionId,undefined);assert.equal(r.state.parkedCcSessions.claude,'fixture-claude-beta');
 assert.equal(r.calls[0].actualCwd,r.realAlpha);assert.equal(r.calls[1].actualCwd,r.realBeta);assert.equal(r.profilePreserved,true);assert.equal(r.providerStorePreserved,true);
});
