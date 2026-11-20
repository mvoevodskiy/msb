/**
 * Owned native peer for [first-start ingress](../codex-first-start.test.mjs).
 * Implements only its login, exec summary and resumed app-server messages;
 * all profile writes, traces and model output stay in that test's temporary HOME.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');

const argv = process.argv.slice(2);
const home = process.env.HOME;
const profile = process.env.CODEX_HOME;
if (profile !== path.join(home, 'native-codex')) throw Error('Unexpected Codex profile');
const auth = path.join(profile, 'auth.json');
const trace = value => fs.appendFileSync(path.join(home, 'codex-trace.jsonl'), JSON.stringify({
  ...value, profile, cwd: process.cwd(),
}) + '\n');
const emit = value => console.log(JSON.stringify(value));
const introduction = '0299a213-81c0-7800-8aa1-bbab2a035a53';

if (argv.join(' ') === 'login --device-auth') {
  trace({ kind: 'device-login' });
  console.log('Visit https://auth.openai.com/codex/device\nCode: A7QD-XP402');
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt' }), { mode: 0o600 });
} else if (argv.join(' ') === 'login status') {
  trace({ kind: 'login-status' });
  if (!fs.existsSync(auth)) throw Error('Fixture login has not completed');
  console.log('Logged in using ChatGPT');
} else if (argv[0] === 'exec') {
  runExec().catch(error => { console.error(error); process.exitCode = 1; });
} else if (argv[0] === 'app-server' || argv.at(-1) === 'app-server') {
  runAppServer();
} else {
  throw Error('Unexpected Codex command');
}

async function runExec() {
  if (process.cwd() !== path.join(home, 'workspace')) throw Error('Unexpected introduction workspace');
  process.stdin.setEncoding('utf8');
  let prompt = '';
  for await (const part of process.stdin) prompt += part;
  const resumed = argv.includes('resume') ? argv[argv.indexOf('resume') + 1] : null;
  const sandbox = argv[argv.indexOf('--sandbox') + 1];
  trace({ kind: 'exec', prompt, resumed, sandbox });
  let response;
  if (prompt.includes('Верни только один JSON-объект строго вида')) {
    response = JSON.stringify({ version: 1, save: true, user: ['Имя: Марина'], memory: ['Предпочитает краткие ответы'] });
  } else if (prompt.includes('Я Марина, занимаюсь каталогом растений.')) {
    fs.writeFileSync('memory/intro-note.md', 'Марина ведёт каталог растений.\n');
    const released = path.join(home, 'release-first');
    for (let attempt = 0; !fs.existsSync(released); attempt++) {
      if (attempt === 1000) throw Error('Test did not release the first turn');
      await delay(10);
    }
    response = 'Как удобнее оформлять ответы?';
  } else if (prompt.includes('Предпочитаю краткие ответы. Заверши знакомство.')) {
    fs.appendFileSync('SOUL.md', '\n## Рабочие правила\nОтвечай кратко.\n');
    response = 'Знакомство завершено.';
  } else {
    throw Error('Unexpected introduction input');
  }
  emit({ type: 'thread.started', thread_id: resumed || introduction });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: response } });
  emit({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } });
}

function runAppServer() {
  let threadId;
  const turnId = 'first-start-ordinary-turn';
  createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') return emit({ id, result: {} });
    if (method === 'initialized') return;
    if (method === 'config/read') return emit({ id, result: { config: { mcp_servers: {} } } });
    if (method === 'thread/resume') {
      threadId = params.threadId;
      return emit({ id, result: { thread: { id: threadId } } });
    }
    if (method !== 'turn/start' || !threadId || params.threadId !== threadId) throw Error('Expected resumed foreground turn');
    const prompt = params.input.map(part => part.text).join('');
    trace({ kind: 'app-turn', prompt, resumed: threadId });
    emit({ id, result: { turn: { id: turnId } } });
    emit({ method: 'item/completed', params: { threadId, turnId,
      item: { id: 'ordinary-reply', type: 'agentMessage', text: 'Обычная задача обработана.' },
    } });
    emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  });
}
