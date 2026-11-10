import fs from 'node:fs/promises';
import { setActive, setSession, storePath } from '../../store.mjs';

const home = process.env.HOME;
const env = { HOME:home, MSB_BOT_ID:'default' };
const file = storePath(env, home);
const role = process.argv[2];
if (role === 'slow-session') {
  const read = fs.readFile.bind(fs);
  let held = false;
  fs.readFile = async (target, ...args) => {
    const result = await read(target, ...args);
    if (String(target) === file && !held) {
      held = true;
      process.stdout.write('snapshot\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
    }
    return result;
  };
  await setSession('codex', 'fixture-native-session', env, home);
} else if (role === 'switch') {
  process.stdout.write('started\n');
  await setActive('claude', env, home);
} else throw new Error('unknown fixture');
process.stdout.write('done\n');
