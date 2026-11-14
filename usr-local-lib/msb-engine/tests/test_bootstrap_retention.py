"""The bootstrap cleanup must keep old engine state and its lock.

Runs the real shell cleanup block with filesystem paths redirected to a private
fixture. It never executes systemctl or removes a real host path.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parents[3]


class BootstrapRetentionTest(unittest.TestCase):
    def test_cleanup_leaves_legacy_trash_and_lock(self):
        source = (REPOSITORY / 'bootstrap/install.sh').read_text()
        start = source.index('    # Снести хвосты Jarvis/base-pulse')
        end = source.index('    systemctl daemon-reload || true', start)
        cleanup = source[start:end]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            keep = [
                root / 'var/lib/jarvis-engine/root-trash/openclaw-example/secret',
                root / 'var/lib/jarvis-engine/openclaw.installed',
                root / 'run/jarvis-engine/lock',
            ]
            remove = root / 'usr/local/sbin/jarvis-engine'
            for file in [*keep, remove]:
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('synthetic fixture')
            shell = r'''
set -euo pipefail
MSB_HOME="$SANDBOX_ROOT/home/client/.msb"
systemctl() { return 0; }
rm() {
  local item
  local -a translated=()
  for item in "$@"; do
    case "$item" in
      -*) translated+=("$item") ;;
      "$SANDBOX_ROOT"/*) translated+=("$item") ;;
      /*) translated+=("$SANDBOX_ROOT$item") ;;
      *) printf 'unexpected path\n' >&2; return 1 ;;
    esac
  done
  command rm "${translated[@]}"
}
''' + cleanup
            result = subprocess.run(['bash', '-c', shell], text=True, capture_output=True,
                                    env={**os.environ, 'SANDBOX_ROOT': str(root)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(all(file.read_text() == 'synthetic fixture' for file in keep))
            self.assertFalse(remove.exists(), 'the fixture must exercise the cleanup block')


if __name__ == '__main__':
    unittest.main()
