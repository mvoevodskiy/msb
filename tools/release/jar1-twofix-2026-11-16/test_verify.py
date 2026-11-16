"""The scoped runner retains partial evidence and never treats a timeout as PASS."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

directory = Path(__file__).resolve().parent
sys.path.insert(0, str(directory))
spec = importlib.util.spec_from_file_location('release_verify', directory / 'verify.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class VerifyRunnerTest(unittest.TestCase):
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
