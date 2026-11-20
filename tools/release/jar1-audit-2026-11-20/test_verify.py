"""The scoped runner retains partial evidence and never treats a timeout as PASS."""
import importlib.util
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

directory = Path(__file__).resolve().parent
sys.path.insert(0, str(directory))
spec = importlib.util.spec_from_file_location('release_verify', directory / 'verify.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class VerifyRunnerTest(unittest.TestCase):
    def test_intro_selection_fences_the_reviewed_unrelated_case(self):
        excluded = re.compile(r'open[\s_-]*claw|native.?oc|\boc\b|🦞|gateway', re.I)
        omitted = 'a seeded workspace does not introduce Claude or OpenClaw as Codex'
        with tempfile.TemporaryDirectory() as tmp:
            bootstrap, first = Path(tmp) / 'bootstrap.mjs', Path(tmp) / 'first.mjs'
            bootstrap.write_text("test('" + omitted + "', () => { const state = 'oc'; });\n" +
                                 "test('safe first start', () => {});\n")
            first.write_text("test('fresh Codex setup', () => {});\n")
            args = verify.intro_selection(bootstrap, first, excluded)
            self.assertIn('--test-skip-pattern=^' + omitted + '$', args)
            bootstrap.write_text(bootstrap.read_text() + "test('unexpected OC case', () => {});\n")
            with self.assertRaisesRegex(ValueError, 'exclusions changed'):
                verify.intro_selection(bootstrap, first, excluded)
            bootstrap.write_text("test('safe only', () => {});\n")
            with self.assertRaisesRegex(ValueError, 'exclusions changed'):
                verify.intro_selection(bootstrap, first, excluded)

    def test_network_gate_rejects_nonloopback_before_starting_cli(self):
        with patch.object(verify.socket, 'if_nameindex', return_value=[(1, 'lo'), (2, 'eth0')]), \
             patch.object(verify.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'loopback-only'):
                verify.native_preflight('/tmp', {'HOME': '/tmp/synthetic'}, 10)
            run.assert_not_called()

    def test_same_network_inode_is_rejected_even_with_only_loopback(self):
        with patch.object(verify.socket, 'if_nameindex', return_value=[(1, 'lo')]), \
             patch.object(verify.os, 'stat', return_value=SimpleNamespace(st_ino=10)), \
             patch.object(verify.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'separate network namespace'):
                verify.native_preflight('/tmp', {'HOME': '/tmp/synthetic'}, 10)
            run.assert_not_called()

    def test_preflight_rejects_wrong_version_and_binary_replacement(self):
        env = {'HOME': '/tmp/synthetic', 'PATH': '/usr/bin:/bin'}
        first = {'wrapper_sha256': 'a' * 64, 'binary_sha256': 'b' * 64}
        changed = {**first, 'binary_sha256': 'c' * 64}
        with patch.object(verify.socket, 'if_nameindex', return_value=[(1, 'lo')]), \
             patch.object(verify.os, 'stat', return_value=SimpleNamespace(st_ino=11)), \
             patch.object(verify, 'cli_fingerprint', side_effect=[first, changed]), \
             patch.object(verify.subprocess, 'run', return_value=SimpleNamespace(stdout='codex-cli 0.166.0')):
            with self.assertRaisesRegex(RuntimeError, 'files changed'):
                verify.native_preflight('/tmp', env, 10)
        with patch.object(verify.socket, 'if_nameindex', return_value=[(1, 'lo')]), \
             patch.object(verify.os, 'stat', return_value=SimpleNamespace(st_ino=11)), \
             patch.object(verify, 'cli_fingerprint', return_value=first), \
             patch.object(verify.subprocess, 'run', return_value=SimpleNamespace(stdout='codex-cli 0.169.0')):
            with self.assertRaisesRegex(RuntimeError, 'version mismatch'):
                verify.native_preflight('/tmp', env, 10)

    def test_preflight_records_both_inodes_and_hashes(self):
        env = {'HOME': '/tmp/synthetic', 'PATH': '/usr/bin:/bin'}
        hashes = {'wrapper_sha256': 'a' * 64, 'binary_sha256': 'b' * 64}
        with patch.object(verify.socket, 'if_nameindex', return_value=[(1, 'lo')]), \
             patch.object(verify.os, 'stat', return_value=SimpleNamespace(st_ino=11)), \
             patch.object(verify, 'cli_fingerprint', return_value=hashes), \
             patch.object(verify.subprocess, 'run', return_value=SimpleNamespace(stdout='codex-cli 0.166.0')) as run:
            proof = verify.native_preflight('/tmp', env, 10)
            self.assertEqual(proof['host_netns_inode'], 10)
            self.assertEqual(proof['test_netns_inode'], 11)
            self.assertEqual(proof['binary_sha256'], 'b' * 64)
            self.assertEqual(run.call_args.kwargs['env'], env)

    def test_timeout_retains_partial_log_and_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'test.log'
            with self.assertRaises(TimeoutError):
                verify.run_command([sys.executable, '-u', '-c',
                    'import time; print("fixture-start", flush=True); time.sleep(5)'],
                    tmp, {'PATH': os.defpath}, log, 0.2)
            self.assertIn('fixture-start', log.read_text())
            self.assertIn('exceeded its time limit', log.read_text())

    def test_success_returns_real_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, output = verify.run_command([sys.executable, '-c', 'print("fixture-pass")'],
                tmp, {'PATH': os.defpath}, Path(tmp) / 'test.log', 5)
            self.assertEqual(code, 0)
            self.assertIn('fixture-pass', output)


if __name__ == '__main__':
    unittest.main()
