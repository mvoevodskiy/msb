#!/usr/bin/env python3
"""Targeted AG1 verification with a masked HOME and isolated network namespace."""

import argparse
import grp
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import signal
import socket
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import contract
import stage as stage_checks
import transaction


def runtime_module(stage):
    spec = importlib.util.spec_from_file_location('ag1_runtime', stage / 'runtime.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def host_process():
    fields = transaction.P.unit_properties(contract.UNIT, 'MainPID', 'ActiveState')
    pid = int(fields.get('MainPID', '0'))
    if fields.get('ActiveState') != 'active' or pid <= 0:
        raise RuntimeError('AG1 bot is not active')
    net = os.stat('/proc/self/ns/net').st_ino
    if os.stat(f'/proc/{pid}/ns/net').st_ino != net:
        raise RuntimeError('AG1 bot network namespace differs from launcher')
    return pid, net


def runtime_identity(stage, pid):
    info = runtime_module(stage).runtime_info(stage / 'source/.msb/bot/package-lock.json',
                                              contract.DEPENDENCIES)
    if info['node'] != 'v22.23.5':
        raise RuntimeError('AG1 Node version changed')
    process_node = contract.sha_bytes((Path('/proc') / str(pid) / 'exe').read_bytes())
    if process_node != info['node_sha256']:
        raise RuntimeError('Test Node does not match the running bot')
    return info


def run_reaping(argv, cwd):
    """Act as namespace PID 1 and reap fixture descendants until the test exits."""
    child = subprocess.Popen(argv, cwd=cwd)
    while True:
        try:
            pid, status = os.waitpid(-1, 0)
        except InterruptedError:
            continue
        if pid == child.pid:
            child.returncode = os.waitstatus_to_exitcode(status)
            return child.returncode


def child(stage, host_net):
    if os.stat('/proc/self/ns/net').st_ino == host_net:
        raise RuntimeError('Test network namespace is not isolated')
    subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
    if [name for _, name in socket.if_nameindex()] != ['lo']:
        raise RuntimeError('Unexpected network interfaces in test namespace')
    subprocess.run(['mount', '--make-rprivate', '/'], check=True)
    subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=755,size=4m', 'tmpfs', '/run'], check=True)
    subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=1777,size=256m', 'tmpfs', '/tmp'], check=True)
    deps = contract.ISOLATED_DEPENDENCIES
    deps.parent.mkdir(mode=0o755)
    deps.mkdir(mode=0o755)
    subprocess.run(['mount', '--bind', str(contract.DEPENDENCIES), str(deps)], check=True)
    subprocess.run(['mount', '-o', 'remount,bind,ro', str(deps)], check=True)
    # Hide the real user's auth, state and workspace even from accidentally
    # hard-coded /home/client paths; the bind-mounted dependencies remain readable.
    subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=755,size=4m', 'tmpfs', '/home/client'], check=True)
    home = Path('/tmp/ag1-home')
    home.mkdir(mode=0o700)
    os.chown(home, pwd.getpwnam(contract.OWNER).pw_uid, grp.getgrnam(contract.OWNER).gr_gid)
    prefix = ['runuser', '-u', contract.OWNER, '--', 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
              'LANG=C.UTF-8', 'HOME=' + str(home), 'TMPDIR=/tmp', 'MSB_TEST_CODEX_TRANSPORT=exec']
    print('AG1_OPERATOR_TESTS_BEGIN', flush=True)
    result = run_reaping(prefix + [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', str(stage),
                                  '-p', 'test_*.py', '-v'], stage / 'source')
    if result: return result
    print('AG1_OPERATOR_TESTS_END', flush=True)
    print('AG1_TARGETED_TESTS_BEGIN', flush=True)
    result = run_reaping(prefix + ['node', '--test', '--test-concurrency=1', *contract.TESTS], stage / 'source')
    if result: return result
    print('AG1_TARGETED_TESTS_END', flush=True)
    return 0


def parse_tap(output):
    try:
        operator_output = output.split('AG1_OPERATOR_TESTS_BEGIN\n', 1)[1].split('AG1_OPERATOR_TESTS_END\n', 1)[0]
        output = output.split('AG1_TARGETED_TESTS_BEGIN\n', 1)[1].split('AG1_TARGETED_TESTS_END\n', 1)[0]
    except IndexError as exc:
        raise RuntimeError('Isolated test boundaries are missing') from exc
    expected = r'^Ran ' + str(contract.OPERATOR_TEST_COUNT) + r' tests? in '
    if not re.search(expected, operator_output, re.MULTILINE) or \
       not re.search(r'^OK\s*$', operator_output, re.MULTILINE):
        raise RuntimeError('Operator recovery tests did not fully pass')
    for name in contract.REQUIRED_CASES:
        if name not in output:
            raise RuntimeError('Required test did not run: ' + name)
    values = {}
    for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
        matches = re.findall(r'^# ' + key + r'\s+(\d+)\s*$', output, re.MULTILINE)
        if len(matches) != 1: raise RuntimeError('Ambiguous test summary: ' + key)
        values[key] = int(matches[0])
    if values['tests'] <= 0 or values['pass'] != values['tests'] or any(
        values[key] for key in ('fail', 'cancelled', 'skipped', 'todo')):
        raise RuntimeError('Targeted test suite did not fully pass')
    values['operator_pass'] = contract.OPERATOR_TEST_COUNT
    return values


def verify(stage, manifest_sha):
    stage_checks.verify_host()
    manifest = stage_checks.validate(stage, manifest_sha)
    stage_checks.check_live_inventory(contract.BOT, manifest, after=False)
    pid, host_net = host_process()
    runtime = runtime_identity(stage, pid)
    argv = ['unshare', '--net', '--mount', '--pid', '--fork', '--mount-proc',
            sys.executable, '-I', '-B', str(stage / 'verify.py'), '--stage', str(stage),
            '--manifest-sha', manifest_sha, '--child-host-netns', str(host_net)]
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            start_new_session=True)
    try:
        output, _ = proc.communicate(timeout=420)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        raise RuntimeError('Isolated targeted test timed out')
    if proc.returncode:
        raise RuntimeError('Isolated targeted test failed:\n' + output[-6000:])
    counts = parse_tap(output)
    stage_checks.validate(stage, manifest_sha)
    stage_checks.check_live_inventory(contract.BOT, manifest, after=False)
    current_pid, current_net = host_process()
    if current_pid != pid or current_net != host_net or runtime_identity(stage, pid) != runtime:
        raise RuntimeError('AG1 service or dependencies changed during testing')
    proof = {'format': 'ag1-targeted-v1', 'passed': True, 'host': contract.HOST,
             'source_commit': manifest['source_commit'], 'manifest_sha256': manifest_sha,
             'tests': list(contract.TESTS), 'counts': counts, 'codex_transport': 'exec',
             'isolation': 'network namespace, masked /home/client, synthetic HOME',
             'host_netns_inode': host_net, 'bot_pid': pid, 'runtime': runtime,
             'scope': 'targeted only; OpenClaw scenarios excluded; not the full suite'}
    path = stage / 'verification.json'
    transaction.write_file(path, (json.dumps(proof, sort_keys=True, indent=2) + '\n').encode())
    transaction.P.sync_dir(stage)
    print('targeted tests passed:', counts['pass'])
    print('verification sha256:', stage_checks.checked_file(path))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--manifest-sha', required=True)
    parser.add_argument('--child-host-netns', type=int)
    args = parser.parse_args()
    stage = Path(args.stage).absolute()
    if args.child_host_netns is not None:
        if os.geteuid() != 0: raise RuntimeError('Root is required')
        stage_checks.validate(stage, args.manifest_sha)
        return child(stage, args.child_host_netns)
    verify(stage, args.manifest_sha)
    return 0


if __name__ == '__main__':
    sys.exit(main())
