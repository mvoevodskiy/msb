#!/usr/bin/env node
import { loadConfig } from '../src/config.mjs';
import { createAuthStore } from '../src/store/auth.mjs';

const [,, cmd, ...rest] = process.argv;
const config = loadConfig();
const auth = createAuthStore(config.dataDir);
await auth.init();

function opt(name) {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? null : rest[i + 1];
}

if (cmd === 'issue') {
  const tg = opt('tg');
  const kind = opt('kind') || 'install_box';
  const scopes = (opt('scopes') || 'core:read,ext:read').split(',').map((s) => s.trim());
  if (!tg) {
    console.error('tokens.mjs issue --tg ID --kind install_box|installer_session|admin_publish --scopes a,b');
    process.exit(2);
  }
  if (kind === 'admin_publish' && !scopes.includes('core:publish')) {
    scopes.push('core:publish', 'ext:publish');
  }
  const { token, meta } = await auth.issueToken({
    tgUserId: tg,
    kind,
    scopes,
  });
  console.log(JSON.stringify({ token, meta }, null, 2));
} else if (cmd === 'list') {
  const tg = opt('tg');
  console.log(JSON.stringify(await auth.listTokens(tg), null, 2));
} else if (cmd === 'revoke') {
  console.log(JSON.stringify(await auth.revoke(opt('token-id')), null, 2));
} else if (cmd === 'web-link') {
  const tg = opt('tg');
  const link = await auth.createWebLink({ tgUserId: tg });
  console.log(JSON.stringify({
    ...link,
    url: `${config.baseUrl}/?t=${encodeURIComponent(link.token)}`,
  }, null, 2));
} else {
  console.error('commands: issue | list | revoke | web-link');
  process.exit(2);
}
