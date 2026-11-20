"""Synthetic fstab compatibility; never accesses the host's /etc or mounts."""
import concurrent.futures
import importlib.util
import os
from pathlib import Path
import shlex
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'usr-local-lib/msb-fstab.py'
SOURCE = '/home/client/workspace'
TARGET = '/home/client/.msb/bots/demo/cwd'
OLD = f'{SOURCE}  {TARGET}  none  bind,nofail  0  0\n'
NEW = f'{SOURCE}  {TARGET}  none  bind,nofail,x-systemd.device-timeout=1s  0  0\n'


class FstabCompatibilityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.fstab = self.root / 'fstab'
        self.fstab.write_text('')
        self.fstab.chmod(0o640)

    def call(self, action, source=SOURCE, target=TARGET, *, check=True):
        result = subprocess.run([sys.executable, '-B', str(HELPER), action, str(self.fstab), source, target],
                                text=True, capture_output=True)
        if check: self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_old_new_whitespace_and_both_are_idempotent(self):
        variants = [OLD, NEW, OLD.replace('  ', '\t'), OLD + NEW]
        for text in variants:
            with self.subTest(text=text):
                self.fstab.write_text(text)
                before = self.fstab.read_bytes()
                self.assertEqual(self.call('ensure').stdout.strip(), 'existing')
                self.call('ensure')
                self.assertEqual(self.fstab.read_bytes(), before)

    def test_append_once_without_touching_other_entries(self):
        prefix = b'# admin comment\n/dev/mapper/root / ext4 defaults 0 1\n'
        self.fstab.write_bytes(prefix)
        self.assertEqual(self.call('ensure').stdout.strip(), 'added')
        self.call('ensure')
        self.assertEqual(self.fstab.read_bytes(), prefix + NEW.encode())
        self.assertEqual(self.fstab.stat().st_mode & 0o777, 0o640)

    def test_remove_both_old_and_new_preserves_unrelated_bytes(self):
        other = (b'# keep\n/home/client/workspace /home/client/.msb/bots/demo2/cwd none bind,nofail 0 0\n'
                 b'/home/client/workspace /home/client/.iia/bots/demo/cwd none bind,nofail 0 0\n'
                 b'/foreign /home/client/.msb/bots/other/cwd none bind,nofail 0 0\n'
                 b'/home/client/workspace /home/client/.msb/bots/other/cwd none bind,custom 0 0\n')
        self.fstab.write_bytes(other + OLD.encode() + NEW.encode())
        before = self.fstab.stat()
        self.assertEqual(self.call('remove').stdout.strip(), 'removed')
        self.assertEqual(self.fstab.read_bytes(), other)
        after = self.fstab.stat()
        self.assertEqual((after.st_uid, after.st_gid, after.st_mode & 0o777),
                         (before.st_uid, before.st_gid, before.st_mode & 0o777))
        self.assertEqual(self.call('remove').stdout.strip(), 'absent')

    def test_removing_the_only_line_succeeds(self):
        self.fstab.write_text(OLD)
        self.assertEqual(self.call('remove').stdout.strip(), 'removed')
        self.assertEqual(self.fstab.read_bytes(), b'')

    def test_conflicting_target_is_not_overwritten_or_duplicated(self):
        for row in (f'/foreign {TARGET} none bind,nofail 0 0\n',
                    f'{SOURCE} {TARGET} none bind,nofail,custom 0 0\n'):
            for contents in (row, OLD + row):
                for operation in ('check', 'ensure', 'remove'):
                    with self.subTest(row=row, operation=operation, mixed=contents != row):
                        self.fstab.write_text(contents)
                        result = self.call(operation, check=False)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(self.fstab.read_text(), contents)

    def test_concurrent_ensures_publish_one_entry(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.call('ensure'), range(6)))
        self.assertEqual(sum(result.stdout.strip() == 'added' for result in results), 1)
        self.assertEqual(self.fstab.read_text(), NEW)

    def test_atomic_write_failure_preserves_fstab(self):
        self.fstab.write_text(OLD)
        spec = importlib.util.spec_from_file_location('fixture_fstab', HELPER)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with patch.object(module.os, 'replace', side_effect=OSError('fixture failure')):
            with self.assertRaises(OSError):
                module.update('remove', self.fstab, SOURCE, TARGET)
        self.assertEqual(self.fstab.read_text(), OLD)
        self.assertFalse(list(self.root.glob('.msb-fstab-*')))

    def test_symlink_fstab_is_not_followed_or_replaced(self):
        self.fstab.unlink()
        victim = self.root / 'victim'; victim.write_text(OLD)
        self.fstab.symlink_to(victim)
        self.assertNotEqual(self.call('remove', check=False).returncode, 0)
        self.assertTrue(self.fstab.is_symlink())
        self.assertEqual(victim.read_text(), OLD)

    def test_spaces_use_fstab_escaping(self):
        source = '/home/client/my workspace'
        target = '/home/client/.msb/bots/demo/cwd folder'
        self.assertEqual(self.call('ensure', source, target).stdout.strip(), 'added')
        self.assertIn('my\\040workspace', self.fstab.read_text())
        self.assertEqual(self.call('ensure', source, target).stdout.strip(), 'existing')
        self.assertEqual(self.call('remove', source, target).stdout.strip(), 'removed')
        self.assertEqual(self.fstab.read_bytes(), b'')

    @unittest.skipUnless(hasattr(os, 'setxattr'), 'extended attributes require a supporting OS')
    def test_rewrite_preserves_extended_attributes(self):
        self.fstab.write_text(OLD)
        try: os.setxattr(self.fstab, 'user.msb-fixture', b'keep')
        except OSError as error: self.skipTest('fixture filesystem lacks xattr: ' + str(error))
        self.call('remove')
        self.assertEqual(os.getxattr(self.fstab, 'user.msb-fixture'), b'keep')

    def test_bot_remove_checks_conflict_before_stop_or_unmount(self):
        for script_path in (ROOT / 'usr-local-bin/bot-ctl.sh', ROOT / 'overlay/usr-local-bin/bot-ctl.sh'):
            with self.subTest(script=str(script_path)):
                script = script_path.read_text()
                start = script.index('remove_bot_instance() {')
                end = script.index('\n\nif [ "$ACTION" = "add" ]', start)
                block = script[start:end].replace('/etc/fstab', str(self.fstab))
                block = block.replace('/usr/bin/python3', shlex.quote(sys.executable))
                block = block.replace('/bin/systemctl', 'fake_systemctl')
                self.assertNotIn('/etc/fstab', block)
                bot_dir = self.root / 'bots/demo'; bot_dir.mkdir(parents=True, exist_ok=True)
                workspace = self.root / 'workspace'; workspace.mkdir(exist_ok=True)
                foreign = f'/foreign {bot_dir}/cwd none bind,nofail 0 0\n'
                self.fstab.write_text(foreign)
                marker = self.root / 'systemctl-called'
                prefix = '''set -euo pipefail
ensure_multibot_template() { :; }
fake_systemctl() { : > "$CALL_MARKER"; }
findmnt() { return 1; }
'''
                fragment = prefix + block + '\nremove_bot_instance demo\n'
                env = {**os.environ, 'BOTS_ROOT': str(self.root / 'bots'), 'WORKSPACE': str(workspace),
                       'FSTAB_HELPER': str(HELPER), 'CALL_MARKER': str(marker)}
                proc = subprocess.run(['bash', '-c', fragment], env=env, capture_output=True, text=True)
                self.assertNotEqual(proc.returncode, 0)
                self.assertFalse(marker.exists())
                self.assertTrue(bot_dir.is_dir())
                self.assertEqual(self.fstab.read_text(), foreign)

    @unittest.skipUnless(sys.platform.startswith('linux') and hasattr(os, 'setxattr'), 'Linux ACL required')
    def test_rewrite_preserves_posix_acl(self):
        self.fstab.write_text(OLD)
        # Linux posix_acl_xattr version 2: owner, named uid, group, mask, other.
        undefined = 0xffffffff
        acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *row) for row in (
            (1, 6, undefined), (2, 4, 54321), (4, 4, undefined), (16, 4, undefined), (32, 0, undefined)))
        try: os.setxattr(self.fstab, 'system.posix_acl_access', acl)
        except OSError as error: self.skipTest('fixture filesystem lacks POSIX ACL: ' + str(error))
        before = os.getxattr(self.fstab, 'system.posix_acl_access')
        self.call('remove')
        self.assertEqual(os.getxattr(self.fstab, 'system.posix_acl_access'), before)

    def test_bot_add_checks_conflict_before_token_consumption(self):
        for script_path in (ROOT / 'usr-local-bin/bot-ctl.sh', ROOT / 'overlay/usr-local-bin/bot-ctl.sh'):
            with self.subTest(script=str(script_path)):
                script = script_path.read_text(); start = script.index('add_bot_instance() {')
                end = script.index('\nremove_bot_instance() {', start)
                block = script[start:end].replace('/etc/fstab', str(self.fstab))
                block = block.replace('/usr/bin/python3', shlex.quote(sys.executable)).replace('/bin/systemctl', 'fake_systemctl')
                bot_dir = self.root / 'bots/demo'; workspace = self.root / 'workspace'; workspace.mkdir(exist_ok=True)
                conflict = f'/foreign {bot_dir}/cwd none bind,nofail 0 0\n'; self.fstab.write_text(conflict)
                token = self.root / 'synthetic-token'; token.write_text('BOT_TOKEN=fixture-only-value-long-enough\n')
                prefix = '''set -euo pipefail
ensure_multibot_template() { :; }
fake_systemctl() { exit 99; }
'''
                fragment = prefix + block + '\nadd_bot_instance demo "$TOKEN_FILE"\n'
                env = {**os.environ, 'BOTS_ROOT': str(self.root / 'bots'), 'WORKSPACE': str(workspace),
                       'FSTAB_HELPER': str(HELPER), 'TOKEN_FILE': str(token), 'CLIENT_USER': 'fixture'}
                proc = subprocess.run(['bash', '-c', fragment], env=env, capture_output=True, text=True)
                self.assertNotEqual(proc.returncode, 0)
                self.assertTrue(token.exists())
                self.assertFalse(bot_dir.exists())
                self.assertEqual(self.fstab.read_text(), conflict)

    def test_bootstrap_real_setup_block_recognises_old_line(self):
        source = (ROOT / 'bootstrap/install.sh').read_text()
        begin = source.index('setup_bots() {')
        end = source.index('\nwrite_bot_env() {', begin)
        block = source[begin:end]
        block = block.replace('/etc/fstab.d/msb-binds.conf', str(self.root / 'snip' / 'msb-binds.conf'))
        block = block.replace('/etc/fstab.d', str(self.root / 'snip'))
        block = block.replace('/etc/fstab', str(self.fstab))
        self.assertNotIn('/etc/fstab', block)
        home = self.root / 'profile'; workspace = self.root / 'workspace'; workspace.mkdir()
        target = home / 'bots/demo/cwd'
        legacy = f'{workspace}  {target}  none  bind,nofail  0  0\n'
        self.fstab.write_text(legacy)
        script = '''set -euo pipefail
run() { "$@"; }
findmnt() { return 0; }
write_bot_env() { :; }
chown() { :; }
log() { :; }
''' + block + '\nBOT_LIST=(demo)\nsetup_bots\nsetup_bots\n'
        env = {**os.environ, 'MSB_HOME': str(home), 'WORKSPACE': str(workspace),
               'SOURCE': str(ROOT), 'CLIENT_USER': 'fixture', 'DRY_RUN': '0'}
        proc = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.fstab.read_text(), legacy)

    def test_bootstrap_checks_conflict_before_mount(self):
        source = (ROOT / 'bootstrap/install.sh').read_text()
        begin = source.index('setup_bots() {'); end = source.index('\nwrite_bot_env() {', begin)
        block = source[begin:end].replace('/etc/fstab.d/msb-binds.conf', str(self.root / 'snip/msb-binds.conf'))
        block = block.replace('/etc/fstab.d', str(self.root / 'snip')).replace('/etc/fstab', str(self.fstab))
        self.assertNotIn('/etc/fstab', block)
        home = self.root / 'profile'; workspace = self.root / 'workspace'; workspace.mkdir()
        target = home / 'bots/demo/cwd'; marker = self.root / 'mount-called'
        conflict = f'/foreign {target} none bind,nofail 0 0\n'; self.fstab.write_text(conflict)
        script = '''set -euo pipefail
run() { "$@"; }
findmnt() { return 1; }
mount() { : > "$CALL_MARKER"; }
write_bot_env() { :; }
chown() { :; }
log() { :; }
''' + block + '\nBOT_LIST=(demo)\nsetup_bots\n'
        env = {**os.environ, 'MSB_HOME': str(home), 'WORKSPACE': str(workspace),
               'SOURCE': str(ROOT), 'CLIENT_USER': 'fixture', 'DRY_RUN': '0', 'CALL_MARKER': str(marker)}
        proc = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertEqual(self.fstab.read_text(), conflict)

    def test_both_bot_control_copies_use_helper_for_add_and_remove(self):
        scripts = [ROOT / 'usr-local-bin/bot-ctl.sh', ROOT / 'overlay/usr-local-bin/bot-ctl.sh']
        self.assertEqual(scripts[0].read_bytes(), scripts[1].read_bytes())
        for script_path in scripts:
            script = script_path.read_text()
            for function, boundary, action in (('add_bot_instance()', '  /bin/systemctl daemon-reload', 'ensure'),
                                                ('remove_bot_instance()', '  rm -rf "$bot_dir"', 'remove')):
                with self.subTest(script=script_path.name, action=action):
                    section = script[script.index(function):]
                    start = section.index('  cwd="${bot_dir}/cwd"')
                    end = section.index(boundary, start)
                    block = section[start:end].replace('/etc/fstab', str(self.fstab))
                    block = block.replace('/usr/bin/python3', shlex.quote(sys.executable))
                    self.assertNotIn('/etc/fstab', block)
                    bot_dir = self.root / 'bots/demo'; bot_dir.mkdir(parents=True, exist_ok=True)
                    workspace = self.root / 'workspace'; workspace.mkdir(exist_ok=True)
                    old = f'{workspace}  {bot_dir}/cwd  none  bind,nofail  0  0\n'
                    self.fstab.write_text(old)
                    legacy_function = ''
                    if 'fstab_line_for() {' in script:
                        start_fn = script.index('fstab_line_for() {')
                        legacy_function = script[start_fn:script.index('\n}', start_fn) + 2].replace(
                            '"/home/client/.msb"', shlex.quote(str(bot_dir.parent.parent))) + '\n'
                    fragment = '''set -euo pipefail
findmnt() { return 0; }
umount() { :; }
''' + legacy_function + 'bot_dir=' + shlex.quote(str(bot_dir)) + '\nWORKSPACE=' + shlex.quote(str(workspace)) + \
                        '\nFSTAB_HELPER=' + shlex.quote(str(HELPER)) + '\nid=demo\n' + block
                    proc = subprocess.run(['bash', '-c', fragment], capture_output=True, text=True)
                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    self.assertEqual(self.fstab.read_text(), old if action == 'ensure' else '')


if __name__ == '__main__':
    unittest.main()
