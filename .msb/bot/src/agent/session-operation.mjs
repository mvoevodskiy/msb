import { botRoot } from '../paths.mjs';

// Compaction and this bot's background runs must not modify the same session
// concurrently. Return null rather than changing or abandoning a due task.
const active = globalThis[Symbol.for('msb.agentSessionOperations')] ||= new Map();

export function trySessionOperation(env = process.env) {
  const key = botRoot(env);
  if (active.has(key)) return null;
  const token = {};
  active.set(key, token);
  return () => { if (active.get(key) === token) active.delete(key); };
}
