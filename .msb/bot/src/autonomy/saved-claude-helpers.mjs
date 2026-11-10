/**
 * Old version gate and default roles for saved Claude prompts.
 * [Runner](./prompt-turn.mjs) passes these to the isolated launch.
 * [Registration](./prompt-registration.mjs) shares the version gate.
 * [Native child checks](../../tests/fixtures/claude-saved-helper-loopback.mjs).
 */
import { readClaudeVersion } from '../agent/claude-version.mjs';
import { compareCliVersion } from '../agent/models.mjs';

export const savedClaudeHelperRoles = {
  researcher: {
    description: 'Read-only explorer: searches and reads files/web to answer a question. Never edits.',
    prompt: 'You are a read-only research subagent. Explore the codebase and the web to answer the task. Do NOT modify anything. Return a terse, factual summary with the key findings and exact file paths — no preamble.',
  },
  worker: {
    description: 'General-purpose worker that carries out a delegated task end-to-end.',
    prompt: 'You are a general-purpose subagent. Carry out the delegated task end-to-end, then report concisely what you did and any important result. Keep changes minimal and focused.',
  },
};

export async function savedClaudeHelpersSupported(env = process.env) {
  return (compareCliVersion(await readClaudeVersion(env).catch(() => undefined), '2.1.172') ?? -1) >= 0;
}
