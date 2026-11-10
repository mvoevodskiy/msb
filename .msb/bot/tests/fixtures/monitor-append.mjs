import { appendItems } from '../../src/monitor/store.mjs';

const env = { MSB_RUNTIME_ROOT: process.argv[2] };
process.stdout.write('READY\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
const added = await appendItems([{ id: 'shared-id', title: 'fixture', publishedAt: new Date().toISOString() }], env);
process.stdout.write(`ADDED:${added}\n`);
process.stdin.destroy();
