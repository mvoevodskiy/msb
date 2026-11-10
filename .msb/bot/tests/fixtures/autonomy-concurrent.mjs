// Independent process writer; parent supplies a synthetic HOME/root and start gate.
import { once } from 'node:events';
import { addTask } from '../../src/autonomy/store.mjs';
process.stdout.write('READY\n');
await once(process.stdin, 'data');
for (let i=0;i<4;i++) await addTask({id:`${process.argv[2]}-${i}`,prompt:'synthetic concurrent addition'});
process.stdout.write('DONE\n');
process.stdin.destroy();
