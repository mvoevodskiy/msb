/**
 * Stable Codex server key for an enrollment owned by one bot. The user-facing
 * service name stays separate from the native table key and tool namespace.
 * [Launch](../../../overlay/bot/ext/codex-mcp-launch.mjs), [catalog](../src/mcp/managed.mjs),
 * [native race regression](../tests/reference/mcp-native-0.166-transport.mjs).
 */
import {createHash} from 'node:crypto';
import profile from './profile.cjs';

export function codexManagedMcpName(name,env=process.env) {
  const scope=JSON.stringify([profile.resolveProfile(env).root,profile.botId(env),name]);
  const id=createHash('sha256').update(scope).digest('hex').slice(0,20);
  return 'msb_'+id+'_'+name;
}
