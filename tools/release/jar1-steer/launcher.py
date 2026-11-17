#!/usr/bin/env python3
"""Root-owned sealed entry point: snapshot bot netns, then run the verifier isolated."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

UNIT = 'msb-bot@default.service'

def bot_netns():
    fields = subprocess.run(['systemctl', 'show', UNIT, '-pMainPID', '-pActiveState'],
                            check=True, capture_output=True, text=True, timeout=15).stdout
    values = dict(line.split('=', 1) for line in fields.splitlines() if '=' in line)
    pid = int(values.get('MainPID', '0'))
    if pid <= 0 or values.get('ActiveState') != 'active': raise RuntimeError('Bot not active')
    inode = os.stat('/proc/self/ns/net').st_ino
    if os.stat(f'/proc/{pid}/ns/net').st_ino != inode: raise RuntimeError('Bot netns differs from launcher')
    return inode

def validate_stage(stage, manifest_sha):
    stage = Path(stage)
    if not stage.is_absolute() or stage.parent != Path('/var/tmp') or stage.is_symlink():
        raise RuntimeError('Unexpected stage')
    for p in (Path('/'), Path('/var'), Path('/var/tmp'), stage):
        st = p.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or (p != Path('/var/tmp') and st.st_mode & 0o022):
            raise RuntimeError('Untrusted stage directory')
    if not (Path('/var/tmp').lstat().st_mode & stat.S_ISVTX):
        raise RuntimeError('Untrusted stage parent without sticky bit')
    # stage and its executable inputs must be root owned and immutable by client
    for name in ('manifest.json', 'launcher.py', 'verify.py'):
        p = stage / name; st = p.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Untrusted launcher input')
    raw = (stage / 'manifest.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest_sha: raise RuntimeError('Manifest mismatch')
    manifest = json.loads(raw)
    for name in ('launcher', 'verify'):
        if hashlib.sha256((stage / (name + '.py')).read_bytes()).hexdigest() != manifest[name + '_sha256']:
            raise RuntimeError('Sealed operator code mismatch')
    if Path(__file__).resolve() != (stage / 'launcher.py').resolve(): raise RuntimeError('Wrong launcher')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True); parser.add_argument('--manifest-sha', required=True)
    parser.add_argument('--child-host-netns', type=int)
    args = parser.parse_args(); stage = Path(args.stage).absolute()
    if os.geteuid() != 0: raise RuntimeError('Root is required')
    validate_stage(stage, args.manifest_sha)
    if args.child_host_netns is None:
        host = bot_netns()
        result = subprocess.run(['unshare', '--net', '--mount', '--pid', '--fork', '--mount-proc',
            sys.executable, '-I', '-B', str(stage / 'launcher.py'), '--stage', str(stage),
            '--manifest-sha', args.manifest_sha, '--child-host-netns', str(host)], check=False)
        return result.returncode
    if args.child_host_netns <= 0 or os.stat('/proc/self/ns/net').st_ino == args.child_host_netns:
        raise RuntimeError('Network namespace not isolated')
    subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
    subprocess.run(['mount', '--make-rprivate', '/'], check=True)
    subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=755,size=4m', 'tmpfs', '/run'], check=True)
    subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=1777,size=256m', 'tmpfs', '/tmp'], check=True)
    os.umask(0o022)
    return subprocess.run(['runuser', '-u', 'client', '--', 'env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8',
        sys.executable, '-B', str(stage / 'verify.py'), '--stage', str(stage), '--home', str(stage / 'test-home'),
        '--dependencies', '/home/client/.msb/bot/node_modules', '--tmp-dir', '/tmp',
        '--host-netns-inode', str(args.child_host_netns)], cwd=stage / 'source', check=False).returncode

if __name__ == '__main__': sys.exit(main())
