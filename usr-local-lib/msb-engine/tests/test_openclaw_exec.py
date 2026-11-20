"""Synthetic OS-user command transport; never runs systemd or a real provider."""
import json
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class OpenClawExecTest(unittest.TestCase):
    def setUp(self):
        import openclaw_exec as module
        self.module = module
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(os.path.realpath(self.temp.name))
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.report = self.root / 'report.json'
        self.runner = self.root / 'systemd-run'
        self.control = self.root / 'systemctl'
        self.runner.write_text(textwrap.dedent(f'''\
            #!{sys.executable}
            import json, os, sys, time
            data = sys.stdin.buffer.read()
            with open({str(self.report)!r}, 'w') as out:
                json.dump({{'args': sys.argv[1:], 'env': dict(os.environ),
                            'input': data.decode()}}, out)
            if b'SLOW-FIXTURE' in data: time.sleep(5)
            if b'LARGE-FIXTURE' in data: sys.stdout.write('x' * 20000)
            elif b'ECHO-FIXTURE' in data:
                sys.stdout.buffer.write(data)
                sys.stderr.buffer.write(data)
            else: sys.stdout.write('{{"ok":true}}')
            if '--check' in sys.argv: sys.exit(2)
        '''))
        self.control.write_text(textwrap.dedent(f'''\
            #!{sys.executable}
            import sys
            if 'show' in sys.argv: print('LoadState=loaded\\nActiveState=inactive')
        '''))
        self.runner.chmod(0o755)
        self.control.chmod(0o755)
        self.patches = [patch.object(module, 'STATE_DIR', str(self.state)),
                        patch.object(module, 'SYSTEMD_RUN', str(self.runner)),
                        patch.object(module, 'SYSTEMCTL', str(self.control)),
                        patch.object(module, 'uid_of', return_value=12345),
                        patch.object(module, 'gid_of', return_value=12346),
                        patch.object(module, 'STOP_WAIT_SEC', 0.15)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def run_command(self, args, **kwargs):
        return self.module.run_cli(args, uid=12345, gid=12346, home='/home/openclaw', **kwargs)

    def test_secret_goes_to_stdin_only_and_transient_runs_under_openclaw(self):
        secret = 'synthetic-only-secret'
        result = self.run_command(['models', 'auth', 'paste-api-key', '--provider', 'openai'],
                                  data=(secret + '\n').encode(), timeout=2)
        self.assertEqual(result, (0, b''))
        record = json.loads(self.report.read_text())
        self.assertEqual(record['input'], secret + '\n')
        self.assertNotIn(secret, json.dumps(record['args']))
        self.assertNotIn(secret, json.dumps(record['env']))
        self.assertIn('--uid=12345', record['args'])
        self.assertIn('--gid=12346', record['args'])
        self.assertIn('ProtectProc=invisible', record['args'])
        self.assertIn('PrivateTmp=yes', record['args'])
        self.assertFalse((self.state / 'oc-sandbox.pending').exists())

    def test_deadline_stops_transient_and_clears_only_after_confirmed_completion(self):
        from util import Refused
        with self.assertRaises(Refused) as caught:
            self.run_command(['models', 'auth', 'paste-api-key', '--provider', 'openai'],
                             data=b'SLOW-FIXTURE', timeout=0.5)
        self.assertEqual(caught.exception.detail['reason'], 'OC_COMMAND_TIMEOUT')
        self.assertFalse((self.state / 'oc-sandbox.pending').exists())

    def test_oversized_output_is_not_propagated(self):
        from util import Refused
        with self.assertRaises(Refused) as caught:
            self.run_command(['models', 'auth', 'paste-api-key', '--provider', 'openai'],
                             data=b'LARGE-FIXTURE', timeout=2, output_limit=1024)
        self.assertEqual(caught.exception.detail['reason'], 'OC_COMMAND_OUTPUT')
        self.assertNotIn('x' * 100, str(caught.exception.detail))

    def test_stdout_and_stderr_from_secret_command_do_not_reach_the_caller(self):
        secret = b'ECHO-FIXTURE-sensitive-value'
        code, output = self.run_command(['models', 'auth', 'paste-api-key', '--provider', 'openai'],
                                        data=secret, timeout=2)
        self.assertEqual((code, output), (0, b''))

    def test_nonzero_check_status_is_preserved_after_unit_stops(self):
        self.assertEqual(self.run_command(['models', 'status', '--check'], timeout=2), (2, b''))

    def test_unconfirmed_transient_is_recorded_and_blocks_next_command(self):
        from util import Refused
        self.control.write_text(f'#!{sys.executable}\nimport sys\nsys.exit(1)\n')
        with self.assertRaises(Refused) as caught:
            self.run_command(['models', 'auth', 'paste-api-key', '--provider', 'openai'],
                             data=b'SLOW-FIXTURE', timeout=0.5)
        self.assertEqual(caught.exception.detail['reason'], 'OC_SANDBOX_UNCERTAIN')
        self.assertTrue((self.state / 'oc-sandbox.pending').exists())
        previous_report = self.report.read_text()
        with self.assertRaises(Refused):
            self.run_command(['--version'], data=b'', timeout=1)
        self.assertEqual(self.report.read_text(), previous_report)

    def test_absent_unit_does_not_clear_a_possibly_queued_start_even_if_stop_succeeds(self):
        from util import Refused
        self.control.write_text(textwrap.dedent(f'''\
            #!{sys.executable}
            import sys
            if 'stop' in sys.argv: sys.exit(0)
            print('LoadState=not-found\\nActiveState=inactive')
        '''))
        with self.assertRaises(Refused) as caught:
            self.run_command(['models', 'auth', 'paste-api-key', '--provider', 'openai'],
                             data=b'SLOW-FIXTURE', timeout=0.5)
        self.assertEqual(caught.exception.detail['reason'], 'OC_SANDBOX_UNCERTAIN')
        self.assertTrue((self.state / 'oc-sandbox.pending').exists())

    def test_late_registration_is_stopped_before_pending_is_cleared(self):
        counter = self.root / 'shows'
        self.control.write_text(textwrap.dedent(f'''\
            #!{sys.executable}
            from pathlib import Path
            import sys
            counter = Path({str(counter)!r})
            if 'show' in sys.argv:
                n = int(counter.read_text()) + 1 if counter.exists() else 1
                counter.write_text(str(n))
                if n < 3: print('LoadState=not-found\\nActiveState=inactive')
                elif n == 3: print('LoadState=loaded\\nActiveState=active')
                else: print('LoadState=loaded\\nActiveState=inactive')
        '''))
        from util import Refused
        with patch.object(self.module, 'STOP_WAIT_SEC', 2), self.assertRaises(Refused) as caught:
            self.run_command(['models', 'auth', 'paste-api-key', '--provider', 'openai'],
                             data=b'SLOW-FIXTURE', timeout=0.5)
        self.assertEqual(caught.exception.detail['reason'], 'OC_COMMAND_TIMEOUT')
        self.assertGreaterEqual(int(counter.read_text()), 4)
        self.assertFalse((self.state / 'oc-sandbox.pending').exists())

    def test_root_identity_and_invalid_input_are_rejected_before_spawn(self):
        from util import Refused
        with self.assertRaises(Refused):
            self.module.run_cli(['--version'], uid=0, gid=0, home='/home/openclaw')
        with self.assertRaises(Refused):
            self.module.run_cli(['--version'], uid=12347, gid=12346, home='/home/openclaw')
        with self.assertRaises(Refused):
            self.run_command(['--version'], data=b'x' * 8193)
        with self.assertRaises(Refused):
            self.run_command(['models', 'set', 'secret; injected'], data=b'')
        with self.assertRaises(Refused):
            self.run_command(['models', 'set', 'sk-synthetic-key'], data=b'')
        with self.assertRaises(Refused):
            self.run_command(['config', 'get', 'agents.defaults.model', '--json'], data=b'')
        self.assertFalse(self.report.exists())

    def test_gateway_config_projection_excludes_all_but_the_expected_path(self):
        from util import Refused
        args = ['gateway', 'call', 'config.get', '--json']
        expected = '/home/openclaw/.openclaw/openclaw.json'
        raw = json.dumps({'path': expected, 'token': 'synthetic-secret',
                          'config': {'models': {'apiKey': 'synthetic-secret'}}}).encode()
        code, projected = self.module._project(args, 0, raw, '/home/openclaw')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(projected), {'path': expected})
        self.assertNotIn(b'synthetic-secret', projected)
        with self.assertRaises(Refused):
            self.module._project(args, 0, b'{"path":"/tmp/other"}', '/home/openclaw')


if __name__ == '__main__':
    unittest.main()
