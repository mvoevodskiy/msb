/** Independent producer fixture; synthetic HOME only, no helper/actions/native CLI. */
import { submitRequest } from '../../src/engines/client.mjs';
process.send({ type: 'ready' });
process.once('message', async () => {
  try {
    const { id } = await submitRequest('status', { bot_id: 'default' }, process.env, { publishTimeoutMs: 5_000, pollMs: 5 });
    process.send({ type: 'published', id }, () => process.disconnect());
  } catch (err) { process.send({ type: 'error', code: err.code }, () => process.disconnect());process.exitCode = 1; }
});
