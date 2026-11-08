/** Persisted project state → real runner argv/cwd/prompt, fake native child only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseClaudeArgv} from '../../../overlay/bot/ext/adapters/parse-args.mjs';
import {agentOptionsProbe} from './helpers/agent-options.mjs';
const probe=(provider,scenario)=>agentOptionsProbe(provider,'auto','opus','high','2.1.316',false,'',scenario);
for(const provider of ['claude','codex']) {
 test(`project execution: saved ${provider} project reaches the actual child cwd after restart`,()=>{
  const out=probe(provider,'project-selected');assert.equal(out.ok,true);assert.equal(out.calls.length,1);
  assert.equal(out.calls[0].provider,provider);assert.equal(out.calls[0].cwd,out.project);
  assert.equal(parseClaudeArgv(out.calls[0].args).resume,out.stateBefore.ccSessionId);
  assert.equal(out.state.activeProject,'alpha');
 });
 test(`project execution control: default ${provider} retains base cwd and owner context`,()=>{
  const out=probe(provider,'project-default');assert.equal(out.ok,true);assert.equal(out.calls[0].cwd,out.workspace);
  const p=out.calls[0].nativePrompt;
  for(const s of ['fixture-global-soul','fixture-global-user','fixture-global-memory','fixture-global-rules'])assert.ok(p.includes(s));
  assert.equal(p.includes('fixture-local-soul-must-not-replace-owner'),false);
 });
 test(`project execution: ${provider} project-local task/memory/knowledge supplements global owner files`,()=>{
  const out=probe(provider,'project-selected');assert.equal(out.ok,true);const p=out.calls[0].nativePrompt;
  for(const s of ['fixture-global-soul','fixture-global-user','fixture-global-memory','fixture-global-rules','fixture-project-task','fixture-project-index','fixture-project-daily'])assert.ok(p.includes(s),s);
  assert.equal(p.includes('fixture-local-soul-must-not-replace-owner'),false);
 });
 test(`project execution: missing ${provider} project cannot silently run in the default workspace`,()=>{
  const out=probe(provider,'project-missing');assert.equal(out.ok,false);assert.equal(out.error,'PROJECT_NOT_FOUND');assert.deepEqual(out.calls,[]);
  assert.equal(out.state.activeProject,'alpha');assert.equal(out.state.ccSessionId,out.stateBefore.ccSessionId);
  assert.equal(out.state.pendingCcSessionStarts,undefined);
 });
}
