/**
 * Legacy OC-presence/Claude-only eligibility; process-memory observation scoped per bot.
 * [State reader](../src/state.mjs) observes persisted legacy fields; [skill target](../src/skills/install-target.mjs) consumes the policy.
 * No engine service/config mutation. Old OA/vB/RW70–114; [checks](../tests/skills-install-policy.test.mjs).
 */
import path from 'node:path';
import profile from './profile.cjs';
const observed=new Set();
const scope=env=>path.join(profile.resolveProfile(env).root,'bots',profile.botId(env));
export function hasOpenClawState(state) {
  if(!state)return false;
  if(state.engine==='oc')return true;
  if(['ocModel','ocSessionId','ocSessionName'].some(key=>typeof state[key]==='string' && state[key].trim()))return true;
  return ['ocPrevSessionIds','ocLiveModels'].some(key=>Array.isArray(state[key]) && state[key].length>0);
}
export function observeOpenClawState(state,env=process.env) {if(hasOpenClawState(state))observed.add(scope(env));}
export function claudeOnly(env=process.env,state) {
  if((env.MSB_CC_ONLY || env.JARVIS_CC_ONLY)!=='1' || hasOpenClawState(state))return false;
  return !(env===process.env && observed.has(scope(env)));
}
