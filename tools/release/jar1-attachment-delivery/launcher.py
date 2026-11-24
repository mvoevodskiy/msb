#!/usr/bin/env python3
"""Root-owned proof launcher; network, HOME and PID isolation use the audit guard."""
import argparse
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import subprocess
import sys
sys.dont_write_bytecode = True


def load(path):
    spec = importlib.util.spec_from_file_location('attachment_launcher_base', path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result); return result


def validate_stage(base, stage, manifest_sha):
    # The reused guard checks __file__ against the actual entry point.  Its
    # module is loaded under another filename; bind that check to this launcher.
    base.__file__ = __file__
    base.validate_stage(stage, manifest_sha)


def main():
    p = argparse.ArgumentParser(); p.add_argument('--stage', required=True); p.add_argument('--manifest-sha', required=True)
    p.add_argument('--child-host-netns', type=int); a = p.parse_args(); stage = Path(a.stage).absolute()
    if os.geteuid() != 0 or socket.gethostname() != 'VM-422100': raise RuntimeError('Expected root on JAR1')
    if stage.parent != Path('/var/tmp') or stage.is_symlink(): raise RuntimeError('Unexpected stage')
    raw = (stage / 'manifest.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != a.manifest_sha: raise RuntimeError('Manifest mismatch')
    manifest = json.loads(raw)
    tools = ('launcher_base.py', 'deploy_base.py', 'runtime.py', 'profile_backup.py', 'build.py', 'profile.py')
    if 'source_guard_sha256' in manifest:
        tools += ('source_guard.py',)
    for name in tools:
        path = stage / name; st = path.lstat()
        if path.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022 or not path.is_file() or \
           hashlib.sha256(path.read_bytes()).hexdigest() != manifest[name.removesuffix('.py') + '_sha256']:
            raise RuntimeError('Untrusted release tool')
    base = load(stage / 'launcher_base.py'); validate_stage(base, stage, a.manifest_sha)
    allowed_links = {'source/.msb/bot/node_modules': '/home/client/.msb/bot/node_modules',
        'source/overlay/bot/node_modules': '/home/client/.msb/bot/node_modules',
        'source/overlay/bot/shared': '../../.msb/bot/shared'}
    for path in stage.rglob('*'):
        st = path.lstat()
        if stat.S_ISLNK(st.st_mode):
            if st.st_uid != 0 or allowed_links.get(path.relative_to(stage).as_posix()) != os.readlink(path):
                raise RuntimeError('Untrusted stage symlink')
        elif st.st_uid != 0 or st.st_mode & 0o022 or not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
            raise RuntimeError('Unsealed stage')
    if a.child_host_netns is None:
        host = base.bot_netns()
        cmd = ['unshare', '--net', '--mount', '--pid', '--fork', '--mount-proc',
            sys.executable, '-I', '-B', str(stage / 'launcher.py'), '--stage', str(stage),
            '--manifest-sha', a.manifest_sha, '--child-host-netns', str(host)]
        run = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=1200)
        if run.returncode:
            raise RuntimeError('Isolated verification failed; no proof created. ' + run.stderr[-3000:])
        proof = json.loads(run.stdout)
        if not proof.get('passed') or proof.get('manifest_sha256') != a.manifest_sha or \
           proof.get('scope') != manifest.get('scope') or proof.get('source_commit') != manifest['source_commit']:
            raise RuntimeError('Isolated verification proof mismatch')
        proof_path = stage / 'proof.json'
        data = (json.dumps(proof, sort_keys=True, indent=2) + '\n').encode()
        fd = os.open(proof_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try: os.write(fd, data); os.fsync(fd)
        finally: os.close(fd)
        rootfd = os.open(stage, os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW)
        try: os.fsync(rootfd)
        finally: os.close(rootfd)
        print(json.dumps({'proof_sha256': hashlib.sha256(data).hexdigest(), 'scope': proof['scope']}))
        return 0
    if a.child_host_netns <= 0 or os.stat('/proc/self/ns/net').st_ino == a.child_host_netns:
        raise RuntimeError('Network namespace not isolated')
    subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
    subprocess.run(['mount', '--make-rprivate', '/'], check=True)
    subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=755,size=4m', 'tmpfs', '/run'], check=True)
    subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=1777,size=256m', 'tmpfs', '/tmp'], check=True)
    # Hide the real client HOME while retaining only read-only code dependencies
    # and the CLI executable required to fingerprint the live runtime.
    for name, source in (('deps', '/home/client/.msb/bot/node_modules'),
                         ('tools', '/home/client/.msb/ext-tools')):
        target = Path('/tmp') / ('attachment-' + name); target.mkdir(mode=0o755)
        subprocess.run(['mount', '--bind', source, str(target)], check=True)
        subprocess.run(['mount', '-o', 'remount,bind,ro', str(target)], check=True)
    subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=755,size=4m', 'tmpfs', '/home/client'], check=True)
    for name, target in (('deps', '/home/client/.msb/bot/node_modules'),
                         ('tools', '/home/client/.msb/ext-tools')):
        Path(target).mkdir(mode=0o755, parents=True)
        subprocess.run(['mount', '--bind', '/tmp/attachment-' + name, target], check=True)
        subprocess.run(['mount', '-o', 'remount,bind,ro', target], check=True)
    home = Path('/tmp/msb-attachment-home'); home.mkdir(mode=0o700)
    os.chown(home, pwd.getpwnam('client').pw_uid, grp.getgrnam('client').gr_gid)
    os.umask(0o022)
    return base.run_reaping(['runuser', '-u', 'client', '--', 'env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8',
        sys.executable, '-B', str(stage / 'verify.py'), '--stage', str(stage), '--home', str(home),
        '--dependencies', '/home/client/.msb/bot/node_modules', '--tmp-dir', '/tmp',
        '--host-netns-inode', str(a.child_host_netns)], cwd=stage / 'source')

if __name__ == '__main__': sys.exit(main())
