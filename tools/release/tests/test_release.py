"""Meaningful release boundaries: reproducibility, drift, secrets and exact code rollback."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
import build
from manifest import digest, inventory, plan, validate_release, verify_plan, validate_test_snapshot
from transaction import backup_code, install_code, restore_code


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='release-tests-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        for source in build.SINGLE:
            p = self.repo / source
            p.parent.mkdir(parents=True, exist_ok=True)
            if source.endswith('/jar1.json'):
                p.write_text('{"profile":"jar1"}\n')
            elif source.endswith('package-lock.json'):
                p.write_text('{"packages":{}}\n')
            elif source.endswith('package.json'):
                p.write_text('{"type":"module"}\n')
            else:
                p.write_text('// fixture entry\n')
        self.write('.msb/bot/src/main.mjs', 'export const fixture = 1;\n')
        self.write('.msb/bot/shared/profile.cjs', 'exports.fixture = true;\n')
        self.write('overlay/bot/ext/shim/bin/claude', '#!/bin/sh\nexit 0\n', 0o755)
        self.write('.msb/bot/tests/example.test.mjs', '// fixture test\n')
        self.write('overlay/bot/ext/tests/example.test.mjs', '// fixture test\n')
        self.write('.msb/bot/vendor/deobfuscated.js', '// inert reference\n')
        self.write('tools/release/build.py', (TOOLS / 'build.py').read_text())
        self.write('tools/release/verify.py', '# fixture operator\n')
        (self.repo / 'overlay/bot/shared').symlink_to('../../.msb/bot/shared')
        self.write('.msb/bots/default/.env', 'TOKEN=fixture-only-never-package\n')
        self.write('workspace/MEMORY.md', 'fixture user data\n')
        self.commit = self.commit_all()

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
            '-C', str(self.repo), *args], stderr=subprocess.DEVNULL).decode().strip()

    def write(self, name, body, mode=0o644):
        p = self.repo / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
        p.chmod(mode)

    def commit_all(self):
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
        return self.git('rev-parse', 'HEAD')

    def export(self, name='artifact', ref='HEAD'):
        stage = self.root / name
        build.build(self.repo, ref, stage)
        return stage

    def test_same_commit_reproduces_identical_runtime_and_source_bytes(self):
        a, b = self.export('a'), self.export('b')
        self.assertEqual((a / 'release.json').read_bytes(), (b / 'release.json').read_bytes())
        release, expected = validate_release(a)
        self.assertEqual(release['source_commit'], self.commit)
        self.assertEqual(inventory(a / 'runtime'), inventory(b / 'runtime'))
        for row in release['files']:
            self.assertEqual((self.repo / row['source']).read_bytes(), (a / 'runtime' / row['target']).read_bytes())
        self.assertEqual((a / 'runtime/bot/ext/shim/bin/claude').stat().st_mode & 0o777, 0o755)
        self.assertTrue((a / 'checks/source/overlay/bot/shared').is_symlink())
        self.assertEqual(len(list((a / 'runtime').rglob('profile.cjs'))), 1)
        self.assertFalse(any(p.name in ['.env', 'MEMORY.md', 'auth.json'] for p in (a / 'runtime').rglob('*')))
        self.assertFalse(any('/tests/' in x for x in expected))
        self.assertFalse((a / 'checks/source/.msb/bot/vendor/deobfuscated.js').exists())

    def test_dirty_head_is_not_silently_exported(self):
        self.write('.msb/bot/src/main.mjs', 'changed without a commit\n')
        with self.assertRaisesRegex(ValueError, 'Commit the intended changes'):
            self.export()

    def test_exporter_itself_must_belong_to_selected_commit(self):
        self.write('tools/release/build.py', '# another exporter\n')
        self.commit_all()
        with self.assertRaisesRegex(ValueError, 'exporter stored'):
            self.export()

    def test_runtime_symlink_or_hidden_data_is_rejected(self):
        (self.repo / '.msb/bot/src/escape.mjs').symlink_to('/etc/passwd')
        self.commit_all()
        with self.assertRaisesRegex(ValueError, 'Unexpected source symlink'):
            self.export('bad-link')
        (self.repo / '.msb/bot/src/escape.mjs').unlink()
        self.write('.msb/bot/src/.env', 'SECRET=fixture-only\n')
        self.commit_all()
        with self.assertRaisesRegex(ValueError, 'Hidden data'):
            self.export('bad-data')

    def test_artifact_and_live_drift_are_rejected_before_install(self):
        stage = self.export()
        live = self.root / 'live'
        shutil.copytree(stage / 'runtime', live)
        value = plan(stage, live)
        (live / 'bot/src/main.mjs').write_text('owner changed code\n')
        with self.assertRaisesRegex(ValueError, 'Live code changed'):
            verify_plan(stage, live, value)
        (stage / 'runtime/bot/src/main.mjs').write_text('tampered artifact\n')
        with self.assertRaisesRegex(ValueError, 'Artifact drift'):
            validate_release(stage)

    def test_install_and_rollback_restore_code_not_newer_profile_data(self):
        stage = self.export()
        live = self.root / 'live'
        (live / 'bot/src').mkdir(parents=True)
        (live / 'bot/src/main.mjs').write_text('old main\n')
        (live / 'bot/src/obsolete.mjs').write_text('old obsolete\n')
        (live / 'bots/default').mkdir(parents=True)
        state = live / 'bots/default/state.json'
        state.write_text('{"session":"before"}\n')
        (live / '.env').write_text('SECRET=fixture-only\n')
        value = plan(stage, live)
        before = inventory(live)
        backup = self.root / 'backup'
        owner = backup_code(live, backup, value)
        install_code(stage, live, value, owner, os.getuid(), os.getgid())
        self.assertEqual(inventory(live), value['after'])
        self.assertFalse((live / 'bot/src/obsolete.mjs').exists())
        state.write_text('{"session":"newer-user-session"}\n')
        restore_code(live, backup)
        self.assertEqual(inventory(live), before)
        self.assertEqual(state.read_text(), '{"session":"newer-user-session"}\n')
        self.assertEqual((live / '.env').read_text(), 'SECRET=fixture-only\n')
        self.assertFalse((live / 'bot/release.json').exists())

    def test_symlink_in_live_parent_cannot_redirect_install(self):
        stage = self.export()
        live = self.root / 'live'
        (live / 'bot').mkdir(parents=True)
        (live / 'bot/src').symlink_to(self.repo / '.msb/bot/src', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Symlinked managed'):
            plan(stage, live)

    def test_profile_paths_cannot_be_added_to_manifest(self):
        stage = self.export()
        release = json.loads((stage / 'release.json').read_text())
        release['files'][0]['target'] = 'bots/default/state.json'
        body = json.dumps(release)
        (stage / 'release.json').write_text(body)
        (stage / 'runtime/bot/release.json').write_text(body)
        with self.assertRaisesRegex(ValueError, 'Outside release boundary'):
            validate_release(stage)

    def test_test_snapshot_is_anchored_and_cannot_drop_or_rewrite_cases(self):
        stage = self.export()
        release, _ = validate_release(stage)
        validate_test_snapshot(stage, release)
        case = stage / 'checks/source/.msb/bot/tests/example.test.mjs'
        case.write_text('// false green replacement\n')
        with self.assertRaisesRegex(ValueError, 'Test source drift'):
            validate_test_snapshot(stage, release)
        case.unlink()
        with self.assertRaisesRegex(ValueError, 'Test source drift'):
            validate_test_snapshot(stage, release)
        (stage / 'checks/source-inventory.json').write_text('[]')
        with self.assertRaisesRegex(ValueError, 'Test inventory differs'):
            validate_test_snapshot(stage, release)

    def test_executable_mode_is_part_of_artifact_and_live_identity(self):
        stage = self.export()
        live = self.root / 'live'
        shutil.copytree(stage / 'runtime', live)
        shim = live / 'bot/ext/shim/bin/claude'
        shim.chmod(0o644)
        value = plan(stage, live)
        self.assertIn('bot/ext/shim/bin/claude', value['changes'])
        owner = backup_code(live, self.root / 'backup', value)
        install_code(stage, live, value, owner, os.getuid(), os.getgid())
        self.assertEqual(shim.stat().st_mode & 0o777, 0o755)
        restore_code(live, self.root / 'backup')
        self.assertEqual(shim.stat().st_mode & 0o777, 0o644)
        (stage / 'runtime/bot/ext/shim/bin/claude').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'Artifact drift'):
            validate_release(stage)

    def test_corrupt_late_backup_is_rejected_before_any_live_mutation(self):
        stage = self.export()
        live = self.root / 'live'
        (live / 'bot/src').mkdir(parents=True)
        (live / 'bot/src/a.mjs').write_text('old a\n')
        (live / 'bot/src/z.mjs').write_text('old z\n')
        value = plan(stage, live)
        backup = self.root / 'backup'
        owner = backup_code(live, backup, value)
        install_code(stage, live, value, owner, os.getuid(), os.getgid())
        before = inventory(live)
        (backup / 'code/bot/src/z.mjs').write_text('corrupted backup\n')
        with self.assertRaisesRegex(ValueError, 'Backup corrupt'):
            restore_code(live, backup)
        self.assertEqual(inventory(live), before)

    def test_mac_verification_cannot_satisfy_linux_deployment_gate(self):
        import deploy
        stage = self.export()
        release, _ = validate_release(stage)
        report = {'source_commit': release['source_commit'], 'release_sha256': digest(stage / 'release.json'),
                  'passed': True, 'environment': {'platform': 'darwin'}, 'checks': []}
        (stage / 'checks/results').mkdir()
        (stage / 'checks/results/verification.json').write_text(json.dumps(report))
        with self.assertRaisesRegex(RuntimeError, 'verification on Linux'):
            deploy.verify_checks(stage, release)

    def test_live_node_and_dependencies_must_match_verified_linux_environment(self):
        import deploy
        from unittest.mock import patch
        stage = self.export()
        release, _ = validate_release(stage)
        report = {'environment': {'node': 'v22.23.4', 'dependencies': {'versions_sha256': 'tested'}}}
        with patch.object(deploy, 'command', return_value='v24.0.0'):
            with self.assertRaisesRegex(RuntimeError, 'Node differs'):
                deploy.check_external_runtime(stage, release, report)
        with patch.object(deploy, 'command', return_value='v22.23.4'), patch.object(deploy, 'dependency_check', return_value={'versions_sha256': 'changed'}):
            with self.assertRaisesRegex(RuntimeError, 'dependencies differ'):
                deploy.check_external_runtime(stage, release, report)


if __name__ == '__main__':
    unittest.main()
