/**
 * Stdio-only MCP server for [one saved Codex process](./saved-codex.mjs).
 * [Tool and path policy](./saved-workspace-tools.mjs) is fixed by the parent.
 */
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { savedWorkspaceTools } from './saved-workspace-tools.mjs';

const scope = JSON.parse(process.argv[2]);
const control = new AbortController();
let input;
function stop() {
  control.abort();
  input?.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const { tools, call } = await savedWorkspaceTools({ ...scope, signal: control.signal,
  beforeCommit: () => fs.writeFile(scope.fileCommitMarker, '', { flag: 'a', mode: 0o600 }) });
input = createInterface({ input: process.stdin });
if (control.signal.aborted) input.close();
const reply = (id, fields) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...fields }) + '\n');
for await (const line of input) {
  if (control.signal.aborted || line.length > 3 * 1024 * 1024) break;
  let request;
  try { request = JSON.parse(line); }
  catch { continue; }
  if (request?.id === undefined) continue;
  const { id, method, params } = request;
  if (method === 'initialize') {
    reply(id, { result: { protocolVersion: params?.protocolVersion,
      serverInfo: { name: 'msb-saved-workspace', version: '1' }, capabilities: { tools: {} } } });
  } else if (method === 'ping') reply(id, { result: {} });
  else if (method === 'tools/list') reply(id, { result: { tools } });
  else if (method === 'tools/call') {
    try {
      const text = await call(params?.name, params?.arguments);
      reply(id, { result: { content: [{ type: 'text', text }], isError: false } });
    } catch (error) {
      const text = error.code ? 'Не удалось выполнить файловую операцию.' : error.message;
      reply(id, { result: { content: [{ type: 'text', text }], isError: true } });
    }
  } else reply(id, { error: { code: -32601, message: 'Unknown method' } });
}
