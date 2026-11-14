"""Operator gate uses synthetic unit results and a private advisory lock."""
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import legacy_gate
import legacy_adoption
import openclaw_service
import cli
from util import Refused


class LegacyGateTest(unittest.TestCase):
    def reply(self, unit, *, active='inactive', file_state='disabled'):
        return types.SimpleNamespace(returncode=0, stdout=f'LoadState=loaded\nActiveState={active}\nUnitFileState={file_state}\n')

    def test_only_inactive_disabled_old_units_pass(self):
        def query(args):
            return types.SimpleNamespace(returncode=0, stdout='') if args[0] == 'list-units' else self.reply(args[1])
        with patch.object(legacy_gate, '_query', side_effect=query):
            legacy_gate.assert_quiet()

    def test_active_unknown_enabled_watchers_and_sandboxes_refuse(self):
        for kind in ('active-service', 'enabled-watcher', 'unknown', 'sandbox'):
            def query(args):
                if args[0] == 'list-units':
                    return types.SimpleNamespace(returncode=0, stdout='jarvis-engine-oc-1.service\n' if kind == 'sandbox' else '')
                unit = args[1]
                if kind == 'active-service' and unit == legacy_gate.SERVICES[0]:
                    return self.reply(unit, active='active')
                if kind == 'enabled-watcher' and unit == legacy_gate.WATCHERS[0]:
                    return self.reply(unit, file_state='enabled')
                if kind == 'unknown' and unit == legacy_gate.SERVICES[0]:
                    return types.SimpleNamespace(returncode=1, stdout='')
                return self.reply(unit)
            with self.subTest(kind=kind), patch.object(legacy_gate, '_query', side_effect=query):
                with self.assertRaises(Refused):
                    legacy_gate.assert_quiet()

    def test_missing_units_are_allowed_but_unavailable_systemd_is_not(self):
        def query(args):
            return types.SimpleNamespace(returncode=0, stdout='' if args[0] == 'list-units' else 'LoadState=not-found\n')
        with patch.object(legacy_gate, '_query', side_effect=query):
            legacy_gate.assert_quiet()
        with patch.object(legacy_gate.subprocess, 'run', side_effect=OSError('synthetic')):
            with self.assertRaises(Refused):
                legacy_gate.assert_quiet()
        bad = types.SimpleNamespace(returncode=1, stdout='LoadState=not-found\n')
        with patch.object(legacy_gate, '_query', return_value=bad):
            with self.assertRaises(Refused):
                legacy_gate.assert_quiet()

    def test_existing_lock_is_required_exclusive_and_nofollow(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(os.path.realpath(temp))
            lock = root / 'lock'
            with self.assertRaises(Refused):
                legacy_gate.acquire_old_lock(str(root))
            lock.write_bytes(b'')
            lock.chmod(0o600)
            first = legacy_gate.acquire_old_lock(str(root))
            try:
                with self.assertRaises(Refused) as refused:
                    legacy_gate.acquire_old_lock(str(root))
                self.assertEqual(refused.exception.code, 'BUSY')
            finally:
                os.close(first)
            lock.unlink()
            target = root / 'other'
            target.write_bytes(b'preserve')
            lock.symlink_to(target)
            with self.assertRaises(Refused):
                legacy_gate.acquire_old_lock(str(root))
            self.assertEqual(target.read_bytes(), b'preserve')

    def test_untrusted_lock_directory_is_never_used(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(os.path.realpath(temp))
            (root / 'lock').touch(mode=0o600)
            root.chmod(0o777)
            with self.assertRaises(Refused):
                legacy_gate.acquire_old_lock(str(root))

    def test_cli_rechecks_old_units_after_lock_and_closes_both_on_refusal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(os.path.realpath(temp))
            marker = root / 'marker'
            marker.touch()
            new_fd = os.open(root / 'new-lock', os.O_RDWR | os.O_CREAT, 0o600)
            old_fd = os.open(root / 'old-lock', os.O_RDWR | os.O_CREAT, 0o600)
            with patch.object(cli, 'LEGACY_OC_MARKER', str(marker)), patch.object(cli, 'need_root'), \
                 patch.object(cli, 'locked', return_value=new_fd), \
                 patch.object(legacy_gate, 'assert_quiet', side_effect=[None, Refused('NOT_AVAILABLE')]) as quiet, \
                 patch.object(legacy_gate, 'acquire_old_lock', return_value=old_fd), \
                 patch.object(legacy_adoption, 'adopt') as adopt:
                with self.assertRaises(Refused):
                    cli.cmd_adopt_legacy([])
            self.assertEqual(quiet.call_count, 2)
            adopt.assert_not_called()
            for fd in (new_fd, old_fd):
                with self.assertRaises(OSError):
                    os.fstat(fd)

    def test_cli_runs_only_explicit_adoption_after_both_gates(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(os.path.realpath(temp))
            marker = root / 'marker'
            marker.touch()
            new_fd = os.open(root / 'new-lock', os.O_RDWR | os.O_CREAT, 0o600)
            old_fd = os.open(root / 'old-lock', os.O_RDWR | os.O_CREAT, 0o600)
            target = {'unit': 'openclaw-gateway.service', 'scope': 'user'}
            with patch.object(cli, 'LEGACY_OC_MARKER', str(marker)), patch.object(cli, 'need_root'), \
                 patch.object(cli, 'locked', return_value=new_fd), patch.object(cli, 'uid_of', return_value=1234), \
                 patch.object(legacy_gate, 'assert_quiet') as quiet, \
                 patch.object(legacy_gate, 'acquire_old_lock', return_value=old_fd), \
                 patch.object(openclaw_service, 'discover', return_value=target), \
                 patch.object(legacy_adoption, 'adopt', return_value='adopted') as adopt, \
                 patch.object(cli, 'log') as log:
                self.assertEqual(cli.cmd_adopt_legacy([]), 0)
            self.assertEqual(quiet.call_count, 2)
            adopt.assert_called_once_with('/var/lib/jarvis-engine', cli.STATE_DIR, cli.OC_HOME, target, 1234)
            log.assert_called_once_with('legacy facts: adopted')

    def test_cli_does_not_report_absent_when_an_interrupted_adoption_lost_its_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(os.path.realpath(temp))
            pending = root / 'pending'
            pending.touch()
            new_fd = os.open(root / 'new-lock', os.O_RDWR | os.O_CREAT, 0o600)
            with patch.object(cli, 'LEGACY_OC_MARKER', str(root / 'missing')), \
                 patch.object(cli, 'LEGACY_ADOPTION_PENDING', str(pending)), \
                 patch.object(cli, 'need_root'), patch.object(cli, 'locked', return_value=new_fd):
                with self.assertRaises(Refused) as refused:
                    cli.cmd_adopt_legacy([])
            self.assertEqual(refused.exception.detail['reason'], 'ADOPTION_SOURCE_MISSING')
            self.assertTrue(pending.exists())


if __name__ == '__main__':
    unittest.main()
