import path from 'node:path';

export function storePaths(dataDir) {
  return {
    root: dataDir,
    channels: path.join(dataDir, 'channels'),
    blobs: path.join(dataDir, 'blobs'),
    auth: path.join(dataDir, 'auth'),
    tokens: path.join(dataDir, 'auth', 'tokens'),
    users: path.join(dataDir, 'auth', 'users'),
    webLinks: path.join(dataDir, 'auth', 'web-links'),
    intents: path.join(dataDir, 'intents'),
    ssh: path.join(dataDir, 'ssh'),
    sshPrivate: path.join(dataDir, 'ssh', 'hub_install'),
    sshPublic: path.join(dataDir, 'ssh', 'hub_install.pub'),
  };
}

export function channelDir(dataDir, channel) {
  return path.join(dataDir, 'channels', channel);
}

export function releaseDir(dataDir, channel, version) {
  return path.join(channelDir(dataDir, channel), 'releases', version);
}

export function channelIndexPath(dataDir, channel) {
  return path.join(channelDir(dataDir, channel), 'index.json');
}

export function blobPath(dataDir, sha256) {
  return path.join(dataDir, 'blobs', sha256.slice(0, 2), sha256);
}
