/**
 * Stdio skills/list via [shared read transport](./codex-app-read.mjs).
 * [Provider mapping](./codex-skills.mjs), [protocol checks](./tests/codex-skills-rpc.test.mjs).
 * Native 0.166 schema: [tracked proof](../../../.msb/bot/tests/reference/skills-native-0.166-protocol.json).
 */
import {readCodexAppServer} from './codex-app-read.mjs';

export function readCodexSkillList(options) {
  return readCodexAppServer('skills/list',options);
}
