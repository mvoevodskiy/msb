import { redact } from '../util.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createHetznerServer({
  token,
  name,
  publicKey,
  serverType,
  image,
  location,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  onServer,
}) {
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };

  async function api(method, pathname, body) {
    let res;
    try {
      res = await fetchImpl(`https://api.hetzner.cloud/v1${pathname}`, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw Object.assign(new Error(redact(err.message, [token])), { code: 'hoster_unreachable' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = redact(data?.error?.message || `hetzner ${res.status}`, [token]);
      throw Object.assign(new Error(message), {
        status: res.status,
        code: data?.error?.code || 'hoster_error',
      });
    }
    return data;
  }

  let keyId;
  try {
    const created = await api('POST', '/ssh_keys', {
      name: 'msb-updates-hub',
      public_key: publicKey,
    });
    keyId = created.ssh_key.id;
  } catch (err) {
    if (err.status !== 409 && err.status !== 422) throw err;
    const list = await api('GET', '/ssh_keys?per_page=50');
    const found = (list.ssh_keys || []).find((item) => String(item.public_key || '').trim() === publicKey.trim());
    if (!found) throw err;
    keyId = found.id;
  }

  const created = await api('POST', '/servers', {
    name,
    server_type: serverType,
    image,
    location,
    ssh_keys: [keyId],
    start_after_create: true,
  });
  let server = created.server;
  if (onServer) {
    await onServer({
      serverId: server.id,
      ipv4: server.public_net?.ipv4?.ip || null,
      name: server.name,
      status: server.status,
    });
  }

  for (let i = 0; i < 36 && server.status !== 'running'; i += 1) {
    await sleepImpl(5000);
    const got = await api('GET', `/servers/${server.id}`);
    server = got.server;
  }
  const ipv4 = server.public_net?.ipv4?.ip || null;
  if (!ipv4) throw Object.assign(new Error('no ipv4'), { code: 'no_ipv4' });
  return { serverId: server.id, ipv4, status: server.status, name: server.name };
}

export async function getHetznerServer({ token, serverId, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`https://api.hetzner.cloud/v1/servers/${serverId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(redact(data?.error?.message || `hetzner ${res.status}`, [token])), {
      status: res.status,
      code: data?.error?.code || 'hoster_error',
    });
  }
  const server = data.server;
  return {
    serverId: server.id,
    ipv4: server.public_net?.ipv4?.ip || null,
    status: server.status,
    name: server.name,
  };
}
