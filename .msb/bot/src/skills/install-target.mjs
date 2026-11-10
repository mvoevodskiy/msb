/**
 * Turn-start state/env -> native user target, independent of later menu selection.
 * [Runner](../agent/turn.mjs), [marker processor](response-markers.mjs), [old OC eligibility](../../shared/engine-policy.mjs).
 * No filesystem/config writes. [Producer/ingress checks](../../tests/skills-install.test.mjs).
 */
import {homeDir} from '../paths.mjs';
import {selectedSessionProvider} from '../../shared/session-starts.mjs';
import {claudeOnly} from '../../shared/engine-policy.mjs';
export function captureSkillInstallTarget(state,env=process.env) {
  return Object.freeze({providerId:state.engine==='oc'?'oc':selectedSessionProvider(state),home:homeDir(env),mirrorOpenClaw:!claudeOnly(env,state)});
}
