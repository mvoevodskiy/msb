"""Exercise guarded recovery across synthetic service and exchange failures."""

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('ag1_release_deploy', HERE / 'deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class FakeHost:
    def __init__(self, failure=None):
        self.running, self.frozen, self.guarded = True, False, False
        self.failure = failure
        self.pid = 101

    def fail(self, name):
        if self.failure == name:
            self.failure = None
            raise RuntimeError('simulated ' + name)

    def call(self, name):
        if name == 'freeze': self.frozen = True
        elif name == 'thaw': self.frozen = False
        elif name == 'stop': self.running = False
        elif name == 'start':
            if self.guarded: raise RuntimeError('starting masked bot')
            self.running = True
            self.pid += 1
        else: raise AssertionError(name)
        self.fail(name)

    def bot_idle(self, frozen=False):
        if not self.running or (frozen and not self.frozen): raise RuntimeError('not idle')

    def guard_startup(self):
        self.guarded = True
        self.fail('guard')

    def ensure_guard_startup(self):
        self.guarded = True

    def unguard_startup(self):
        self.guarded = False
        self.fail('unguard')

    def thaw_if_needed(self):
        self.frozen = False

    def bot_active(self):
        return self.running

    def bot_stopped(self):
        if self.running: raise RuntimeError('not stopped')


class DeployRecoveryTests(unittest.TestCase):
    def test_masked_host_recovery_requires_the_expected_guard(self):
        with patch.object(deploy.os, 'geteuid', return_value=0), \
             patch.object(deploy.socket, 'gethostname', return_value=deploy.contract.HOST), \
             patch.object(deploy.P, 'unit_properties', return_value={'UnitFileState': 'masked'}), \
             patch.object(deploy.P, 'command', return_value=''), \
             patch.object(Path, 'is_symlink', return_value=True), \
             patch.object(deploy.os, 'readlink', return_value='/dev/null'):
            deploy.host_identity(allow_masked=True)
            with patch.object(deploy.os, 'readlink', return_value='/unexpected'):
                with self.assertRaisesRegex(RuntimeError, 'expected guard'):
                    deploy.host_identity(allow_masked=True)

    def run_case(self, failure):
        with tempfile.TemporaryDirectory(prefix='ag1-deploy-') as tmp:
            base = Path(tmp).resolve()
            live, stage, backup_root = (base / value for value in ('bot', 'stage', 'backups'))
            live.mkdir(); stage.mkdir(); backup_root.mkdir()
            rows = []
            for number in range(3):
                relative = f'src/telegram/{number}.mjs'
                old, new = f'old-{number}'.encode(), f'new-{number}'.encode()
                file, payload = live / relative, stage / 'payload' / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                payload.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(old); file.chmod(0o664)
                payload.write_bytes(new)
                rows.append({'relative': relative, 'before_sha256': deploy.contract.sha_bytes(old),
                             'after_sha256': deploy.contract.sha_bytes(new)})
            manifest = {'files': rows, 'source_commit': 'a' * 40}
            host = FakeHost(failure if failure != 'partial' else None)
            def props(_unit, *_fields):
                return {'MainPID': str(host.pid if host.running else 0),
                        'FreezerState': 'frozen' if host.frozen else 'running'}
            def inventory(_root, _manifest, *, after):
                for row in rows:
                    value = deploy.contract.sha_bytes((live / row['relative']).read_bytes())
                    allowed = (row['before_sha256'], row['after_sha256']) if after is None else \
                              (row['after_sha256'] if after else row['before_sha256'],)
                    if value not in allowed: raise RuntimeError('synthetic drift')
            def read_backup(path, *_args):
                return json.loads((path / 'metadata.json').read_text())
            real_atomic = deploy.P.atomic_write
            count = 0
            def atomic(*args, **kwargs):
                nonlocal count
                real_atomic(*args, **kwargs)
                count += 1
                if failure == 'partial' and count == 2:
                    raise OSError('simulated failure after exchange')
            patches = (
                patch.object(deploy.contract, 'BOT', live),
                patch.object(deploy.contract, 'BACKUPS', backup_root),
                patch.object(deploy.P, 'Host', return_value=host),
                patch.object(deploy.P, 'unit_properties', side_effect=props),
                patch.object(deploy.P, 'atomic_write', side_effect=atomic),
                patch.object(deploy, 'private_backup_root', return_value=backup_root),
                patch.object(deploy, 'current_matches_proof', return_value=host.pid),
                patch.object(deploy, 'check_code_processes'),
                patch.object(deploy, 'host_identity'),
                patch.object(deploy, 'validate_backup', side_effect=read_backup),
                patch.object(deploy, 'ready', return_value=host.pid + 1),
                patch.object(deploy.stage_checks, 'validate'),
                patch.object(deploy.stage_checks, 'check_live_inventory', side_effect=inventory),
                patch.object(deploy.protected, 'snapshot', return_value={'synthetic': b'unchanged'}),
                patch.object(deploy.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid())),
                patch.object(deploy.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=os.getgid())),
            )
            from contextlib import ExitStack
            with ExitStack() as stack:
                for item in patches: stack.enter_context(item)
                with self.assertRaisesRegex(RuntimeError, 'previous code restored'):
                    deploy.apply(stage, manifest, 'b' * 64, {})
            self.assertTrue(host.running)
            self.assertFalse(host.frozen)
            self.assertFalse(host.guarded)
            for number, row in enumerate(rows):
                self.assertEqual((live / row['relative']).read_bytes(), f'old-{number}'.encode())
            backups = list(backup_root.iterdir())
            self.assertEqual(len(backups), 1)
            self.assertFalse((backups[0] / 'guard.pending').exists())

    def test_failures_during_guarded_transitions_restore_the_old_code(self):
        for failure in ('freeze', 'guard', 'thaw', 'stop', 'partial', 'unguard', 'start'):
            with self.subTest(failure=failure):
                self.run_case(failure)


if __name__ == '__main__':
    unittest.main()
