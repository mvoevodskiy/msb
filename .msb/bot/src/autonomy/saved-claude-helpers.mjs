/**
 * Old version gate, default roles and [saved team](./prompt-team.mjs) IDs for Claude.
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

const transliteration = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function savedClaudeTeamRoster(team) {
  const roster = new Map();
  for (const { name, brief } of team) {
    const base = [...name.toLowerCase()].map(char => transliteration[char] ?? char).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'role';
    let id = base;
    for (let suffix = 2; roster.has(id); suffix++) id = base + '-' + suffix;
    roster.set(id, {
      description: name + ': ' + brief,
      prompt: 'Ты ' + name + ' в команде фоновой задачи. Твоя роль: ' + brief +
        '. Делай только порученное, отвечай кратко и по фактам, с путями к файлам и цифрами. Ничего не отправляй наружу и задач не заводи.',
    });
  }
  return roster;
}

export async function savedClaudeHelpersSupported(env = process.env) {
  return (compareCliVersion(await readClaudeVersion(env).catch(() => undefined), '2.1.172') ?? -1) >= 0;
}
