/**
 * Genuine Claude stream event → old rateLimitInfo in the selected bot state.
 * [Turn](./turn.mjs) owns stream/provider provenance; [autonomy](../autonomy/subscription-gate.mjs)
 * and the existing Pult collector consume the saved window.
 * [CLI stream regression](../../tests/claude-quota-stream.test.mjs).
 */
import { selectedSessionProvider } from '../../shared/session-starts.mjs';
import { NO_STATE_WRITE, updateState } from '../state.mjs';

export function readClaudeQuotaEvent(event, now = Date.now()) {
  const info = event?.rate_limit_info;
  if (!Number.isFinite(info?.resetsAt) || !Number.isFinite(new Date(info.resetsAt * 1000).getTime())) return;
  return {
    resetsAt: info.resetsAt,
    rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown',
    ...(Number.isFinite(info.utilization) ? { utilization: info.utilization } : {}),
    isUsingOverage: info.isUsingOverage === true,
    status: typeof info.status === 'string' ? info.status : 'unknown',
    ...(Number.isFinite(info.overageResetsAt) ? { overageResetsAt: info.overageResetsAt } : {}),
    lastUpdatedAt: Math.floor(now / 1000),
  };
}

export function saveClaudeQuota(quota, snapshot, env, signal) {
  return updateState(state => {
    if (signal?.aborted || (state.engine !== undefined && state.engine !== 'cc') ||
        selectedSessionProvider(state) !== 'claude' || state.authMode !== snapshot.authMode ||
        state.hasSubscriptionAuth !== snapshot.hasSubscriptionAuth ||
        state.rateLimitInfo?.lastUpdatedAt > quota.lastUpdatedAt) return NO_STATE_WRITE;
    state.rateLimitInfo = quota;
    return state;
  }, env);
}
