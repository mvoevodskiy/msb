/** Old OA/vB/RW observation semantics; no service/helper/native CLI execution. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {hasOpenClawState,claudeOnly} from '../shared/engine-policy.mjs';
import {fixture} from './helpers/menu-fixture.mjs';
import {loadState,saveState} from '../src/state.mjs';import {statePath} from '../src/paths.mjs';
import {agentOptionsProbe} from './helpers/agent-options.mjs';
for(const fields of [{engine:'oc'},{ocModel:'oc-model'},{ocSessionId:'oc-id'},{ocSessionName:'oc-name'},{ocPrevSessionIds:['id']},{ocLiveModels:['model']}])test('skill policy: legacy OC presence '+Object.keys(fields)[0]+' defeats the old Claude-only preference',()=>{
 const env={HOME:'/fixture',JARVIS_CC_ONLY:'1'};assert.equal(hasOpenClawState(fields),true);assert.equal(claudeOnly(env,fields),false);
});
test('skill policy: absent/empty/wrong-type legacy fields do not invent installed OC context',()=>{
 for(const state of [undefined,{}, {engine:'cc',ocModel:' ',ocSessionId:12,ocPrevSessionIds:[],ocLiveModels:'text'}]){assert.equal(hasOpenClawState(state),false);assert.equal(claudeOnly({HOME:'/fixture',JARVIS_CC_ONLY:'1'},state),true);}
});
test('skill policy: observed OC remains eligible within the process and does not leak to another bot or write profile fields',async t=>{
 await fixture(t);process.env.JARVIS_CC_ONLY='1';await saveState({engine:'cc',ocModel:'old-oc'});const file=statePath(),before=await fs.readFile(file,'utf8');await loadState();assert.equal(await fs.readFile(file,'utf8'),before);await saveState({engine:'cc'});await loadState();assert.equal(claudeOnly(),false);process.env.MSB_BOT_ID='other-fixture-bot';assert.equal(claudeOnly(),true);
});
for(const scenario of ['skills-cc-only','skills-msb-cc-only','skills-oc-present','skills-oc-observed'])test('skill policy: actual runner captures '+scenario+' mirror eligibility',()=>{
 const out=agentOptionsProbe('claude','auto','opus','high','2.1.316',false,'',scenario);assert.equal(out.ok,true);assert.equal(out.skillInstall.mirrorOpenClaw,scenario.startsWith('skills-oc-'));
});
