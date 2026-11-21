"""Offline simulations of the two-root code-only installer and its rollback."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('engine_release_deploy', Path(__file__).with_name('deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
H = lambda data: hashlib.sha256(data).hexdigest()


class FakeHost:
    def __init__(self, failure=None):
        self.running, self.frozen, self.guarded, self.failure = True, False, False, failure
        self.calls = []
        self.changed_profile = False

    def fail_once(self, label):
        if self.failure == label:
            self.failure = None
            raise RuntimeError('injected ' + label)

    def system_idle(self):
        self.fail_once('system-busy')

    def trusted_admin_directories(self):
        pass

    def marker_absent(self):
        self.fail_once('marker-present')

    def pending_status(self):
        self.fail_once('pending-invalid')
        return None

    def runtime_identity(self, _stage):
        self.fail_once('runtime-drift')
        return {'fixture': 'same-runtime', 'node_sha256': 'fixture-node'}

    def support_inventory(self, _entries):
        self.fail_once('support-drift')

    def network_inode(self, bot=True):
        return 10

    def bot_node_sha(self):
        self.fail_once('node-drift')
        return 'fixture-node'

    def bot_idle(self, frozen=False):
        if not self.running or (frozen and not self.frozen): raise RuntimeError('bot not idle')

    def call(self, action):
        self.calls.append(action)
        if action == 'freeze': self.frozen = True
        elif action == 'thaw': self.frozen = False
        elif action == 'stop': self.running = False
        elif action == 'mask': self.guarded = True
        elif action == 'unmask': self.guarded = False
        elif action == 'start':
            if self.guarded: raise RuntimeError('guarded bot cannot start')
            self.running = True
        else: raise AssertionError(action)
        self.fail_once(action)

    def thaw_if_needed(self):
        self.frozen = False

    def bot_active(self):
        return self.running

    def bot_stopped(self):
        if self.running: raise RuntimeError('not stopped')

    def guard_startup(self):
        if self.guarded: raise RuntimeError('already guarded')
        self.call('mask')

    def ensure_guard_startup(self):
        if not self.guarded: self.guard_startup()

    def unguard_startup(self):
        if self.guarded: self.call('unmask')

    def protected(self):
        if self.failure == 'profile-drift' and not self.running:
            self.failure = None
            self.changed_profile = True
        return {'profile': 'new' if self.changed_profile else 'original'}

    def backup_profile(self, destination):
        self.fail_once('profile-backup')
        destination.mkdir(mode=0o700)

    def verify_active_session(self, _destination):
        self.fail_once('active-session')

    def ready(self):
        self.fail_once('ready')
        if not self.running: raise RuntimeError('not running')
        if self.failure == 'profile-after-ready':
            self.failure = None
            self.changed_profile = True
        if getattr(self, 'on_ready', None):
            self.on_ready()


@contextmanager
def fixture(failure=None):
    with tempfile.TemporaryDirectory(prefix='engine-release-sim-') as tmp:
        root = Path(tmp).resolve()
        stage, backup = root / 'stage', root / 'backup'
        stage.mkdir()
        (stage / 'test-home/results').mkdir(parents=True)
        roots = {key: root / key for key in deploy.ALLOWED}
        for value in roots.values(): value.mkdir()
        anchor = roots['bot'] / deploy.ANCHOR['bot']
        anchor.parent.mkdir(parents=True, exist_ok=True)
        anchor.write_bytes(b'bot-anchor'); anchor.chmod(0o664)
        admin = roots['bin'] / 'bot-ctl.sh'
        admin.write_bytes(b'fixture-admin'); admin.chmod(0o755)
        entries = []
        for kind, name in deploy.RELEASE_ORDER:
            added = (kind, name) in deploy.ADDED
            old, new = ('old:' + kind + '/' + name).encode(), ('new:' + kind + '/' + name).encode()
            live = roots[kind] / name
            live.parent.mkdir(parents=True, exist_ok=True)
            if not added:
                live.write_bytes(old); live.chmod(0o664)
            target = stage / 'payload' / kind / name
            target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(new)
            entries.append({'root': kind, 'relative': name, 'source': kind + '/' + name,
                            'before_sha256': None if added else H(old), 'after_sha256': H(new)})
        for name in ('source.tar.gz', 'verify.py', 'deploy.py', 'runtime.py', 'profile_backup.py', 'launcher.py'):
            (stage / name).write_bytes(name.encode())
        manifest = {'source_commit': 'a' * 40, 'source_archive_sha256': deploy.digest(stage / 'source.tar.gz'),
                    'verify_sha256': deploy.digest(stage / 'verify.py'), 'launcher_sha256': deploy.digest(stage / 'launcher.py'), 'deploy_sha256': deploy.digest(stage / 'deploy.py'),
                    'runtime_sha256': deploy.digest(stage / 'runtime.py'),
                    'profile_backup_sha256': deploy.digest(stage / 'profile_backup.py'),
                    'files': entries, 'support_files': [], 'baseline_inventory': [
                        {'root': row['root'], 'relative': row['relative'], 'sha256': row['before_sha256']}
                        for row in entries if row['before_sha256'] is not None] + [
                            {'root': 'bot', 'relative': deploy.ANCHOR['bot'], 'sha256': H(b'bot-anchor')}]}
        (stage / 'manifest.json').write_text(json.dumps(manifest))
        manifest_sha = deploy.digest(stage / 'manifest.json')
        names = {'node-0', 'node-1', 'node-2', 'node-3', 'service-labels', 'bot-status-view',
                 'steer-targeted', 'steer-native-isolated', 'intro-safe', 'audit-targeted', 'scheduler-safe', 'legacy-timer-conversation-safe', 'backlog-targeted', 'recurring-safe', 'menu-safe', 'test_bot_off_marker', 'test_ipc_reference',
                 'test_private_state', 'test_pult_routing', 'test_client_markers', 'fstab-compat'}
        names.update('syntax-' + row['relative'].replace('/', '_') for row in entries)
        report = {'native_isolated_verification': {'interfaces': ['lo'], 'cli_path': '/home/client/.msb/ext-tools/bin/codex', 'cli_version': 'codex-cli 0.166.0', 'host_netns_inode': 10, 'test_netns_inode': 11, 'wrapper_sha256': 'a' * 64, 'binary_sha256': 'b' * 64}, 'passed': True, 'manifest_sha256': manifest_sha, 'source_commit': 'a' * 40,
                  'source_archive_sha256': manifest['source_archive_sha256'],
                  'environment': {'fixture': 'same-runtime', 'node_sha256': 'fixture-node'},
                  'checks': [{'suite': name, 'exit_code': 0,
                              'tests': 95 if name == 'steer-targeted' else 43 if name == 'intro-safe' else 133 if name == 'audit-targeted' else 19 if name == 'scheduler-safe' else 16 if name == 'fstab-compat' else 9 if name == 'test_client_markers' else 3 if name == 'service-labels' else
                                       23 if name == 'legacy-timer-conversation-safe' else 291 if name == 'backlog-targeted' else 8 if name == 'recurring-safe' else 10 if name == 'menu-safe' else 9 if name == 'test_bot_off_marker' else 1,
                              'passed': 95 if name == 'steer-targeted' else 43 if name == 'intro-safe' else 133 if name == 'audit-targeted' else 19 if name == 'scheduler-safe' else 15 if name == 'fstab-compat' else 0 if name == 'test_client_markers' else 3 if name == 'service-labels' else
                                        23 if name == 'legacy-timer-conversation-safe' else 291 if name == 'backlog-targeted' else 8 if name == 'recurring-safe' else 10 if name == 'menu-safe' else 9 if name == 'test_bot_off_marker' else 1,
                              'skipped': 9 if name == 'test_client_markers' else 1 if name == 'fstab-compat' else 0} for name in names]}
        next(row for row in report['checks'] if row['suite'] == 'fstab-compat')['skipped_cases'] = ['test_rewrite_preserves_posix_acl']
        report_path = stage / 'test-home/results/verification.json'
        report_path.write_text(json.dumps(report))
        host = FakeHost(failure)
        release = deploy.Deployment(stage, backup, roots, host, manifest_sha, deploy.digest(report_path))
        with patch.object(deploy, 'bot_owner', return_value=(os.geteuid(), os.getegid(), 0o664)), \
             patch.object(deploy, 'cli_fingerprint', return_value={'wrapper_sha256': 'a' * 64, 'binary_sha256': 'b' * 64}):
            yield release, host, roots, entries, report_path


class DeploymentTest(unittest.TestCase):
    def test_codex_cache_focused_report_accepts_exact_suites(self):
        with fixture() as (release, host, roots, _, report_path):
            manifest_path = release.stage / 'manifest.json'
            manifest = json.loads(manifest_path.read_text())
            manifest['base_commit'] = deploy.FOCUSED_CACHE_BASE
            manifest['pult_files'] = [{'root': 'pult', 'relative': name} for name in deploy.FOCUSED_CACHE_PULT]
            manifest_path.write_text(json.dumps(manifest))
            report = json.loads(report_path.read_text())
            report['manifest_sha256'] = deploy.digest(manifest_path)
            report['verification_scope'] = 'codex-cache-focused-v1'
            counts = {'usage-collector': 20, 'usage-ui': 13, 'usage-native': 1,
                'usage-release': 6, 'usage-stop': 1, 'composite-session': 8,
                'composite-resume': 15, 'composite-intro': 1, 'composite-background': 11,
                'composite-claude': 1}
            report['checks'] = [{'suite': name, 'exit_code': 0, 'passed': count}
                                for name, count in counts.items()]
            report_path.write_text(json.dumps(report))
            with patch.object(deploy, 'FOCUSED_CACHE_BOT', frozenset(row['relative'] for row in manifest['files'])):
                checked = deploy.Deployment(release.stage, release.backup, roots, host,
                    deploy.digest(manifest_path), deploy.digest(report_path))
            self.assertEqual(checked.environment, report['environment'])
            self.assertEqual(host.calls, [])

    def test_codex_cache_focused_report_rejects_missing_suite(self):
        with fixture() as (release, host, roots, _, report_path):
            manifest_path = release.stage / 'manifest.json'
            manifest = json.loads(manifest_path.read_text())
            manifest['base_commit'] = deploy.FOCUSED_CACHE_BASE
            manifest['pult_files'] = [{'root': 'pult', 'relative': name} for name in deploy.FOCUSED_CACHE_PULT]
            manifest_path.write_text(json.dumps(manifest))
            report = json.loads(report_path.read_text())
            report['manifest_sha256'] = deploy.digest(manifest_path)
            report['verification_scope'] = 'codex-cache-focused-v1'
            counts = {'usage-collector': 20, 'usage-ui': 13, 'usage-native': 1,
                'usage-release': 6, 'usage-stop': 1, 'composite-session': 8,
                'composite-resume': 15, 'composite-intro': 1, 'composite-background': 11,
                'composite-claude': 1}
            report['checks'] = [{'suite': name, 'exit_code': 0, 'passed': count}
                                for name, count in counts.items() if name != 'composite-claude']
            report_path.write_text(json.dumps(report))
            with patch.object(deploy, 'FOCUSED_CACHE_BOT', frozenset(row['relative'] for row in manifest['files'])):
                with self.assertRaisesRegex(ValueError, 'Focused Codex cache verification'):
                    deploy.Deployment(release.stage, release.backup, roots, host,
                        deploy.digest(manifest_path), deploy.digest(report_path))
            self.assertEqual(host.calls, [])

    def test_incomplete_new_audit_suites_cannot_authorize_release(self):
        for suite, passed in (('intro-safe', 42), ('audit-targeted', 132), ('scheduler-safe', 18)):
            with self.subTest(suite=suite), fixture() as (release, host, roots, _entries, report_path):
                report = json.loads(report_path.read_text())
                row = next(item for item in report['checks'] if item['suite'] == suite)
                row.update(passed=passed, skipped=1)
                report_path.write_text(json.dumps(report))
                with self.assertRaisesRegex(ValueError, 'Audited regression verification'):
                    deploy.Deployment(release.stage, release.backup, roots, host,
                                      deploy.digest(release.stage / 'manifest.json'), deploy.digest(report_path))
                self.assertTrue(host.running)

    def test_incomplete_steer_journal_suite_cannot_authorize_release(self):
        with fixture() as (release, host, roots, _entries, report_path):
            report = json.loads(report_path.read_text())
            row = next(item for item in report['checks'] if item['suite'] == 'steer-targeted')
            row.update(passed=94, skipped=1)
            report_path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, 'journal verification'):
                deploy.Deployment(release.stage, release.backup, roots, host,
                                  deploy.digest(release.stage / 'manifest.json'), deploy.digest(report_path))
            self.assertTrue(host.running)

    def test_failed_active_session_check_rolls_back_before_reporting_success(self):
        with fixture('active-session') as (release, host, roots, entries, _):
            with self.assertRaisesRegex(RuntimeError, 'active-session'):
                release.apply()
            self.assertTrue(host.running)
            self.assertFalse(host.guarded)
            self.assert_code(roots, entries, 'before')

    def test_persistently_invalid_active_session_keeps_recovery_guarded(self):
        with fixture() as (release, host, roots, entries, _):
            with patch.object(host, 'verify_active_session', side_effect=RuntimeError('session invalid')):
                with self.assertRaisesRegex(RuntimeError, 'session invalid'):
                    release.apply()
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)
            self.assert_code(roots, entries, 'before')

    def test_native_identity_failure_after_thaw_never_stops_or_restarts_bot(self):
        with fixture() as (release, host, roots, entries, _):
            check = release.check_native_identity
            calls = 0
            def fail_after_thaw(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 2:
                    self.assertEqual(host.calls, ['freeze', 'thaw'])
                    raise RuntimeError('injected native identity drift')
                return check(*args, **kwargs)
            with patch.object(release, 'check_native_identity', side_effect=fail_after_thaw):
                with self.assertRaisesRegex(RuntimeError, 'native identity drift'):
                    release.apply()
            self.assertEqual(calls, 2)
            self.assertEqual(host.calls, ['freeze', 'thaw'])
            self.assertTrue(host.running)
            self.assertFalse(host.frozen)
            self.assertFalse(host.guarded)
            self.assertFalse((release.backup / 'guard.pending').exists())
            self.assert_code(roots, entries, 'before')

    def test_publication_and_reverse_rollback_order(self):
        with fixture() as (release, host, roots, entries, _):
            writes, restores = [], []
            real_write, real_restore, real_remove = deploy.atomic_write, deploy.restore_existing, deploy.remove_created
            def write(root, relative, *args, **kwargs):
                writes.append((Path(root).name, relative))
                return real_write(root, relative, *args, **kwargs)
            def restore(root, relative, *args, **kwargs):
                restores.append((Path(root).name, relative))
                return real_restore(root, relative, *args, **kwargs)
            def remove(root, relative, *args, **kwargs):
                restores.append((Path(root).name, relative))
                return real_remove(root, relative, *args, **kwargs)
            with patch.object(deploy, 'atomic_write', side_effect=write):
                release.apply()
            with patch.object(deploy, 'restore_existing', side_effect=restore), \
                 patch.object(deploy, 'remove_created', side_effect=remove):
                release.rollback()
            self.assertEqual(writes, deploy.RELEASE_ORDER)
            self.assertEqual(restores, list(reversed(deploy.RELEASE_ORDER)))
            self.assert_code(roots, entries, 'before')

    def test_changed_admin_mode_after_preflight_rejects_backup(self):
        with fixture() as (release, _host, roots, _entries, _):
            (roots['bin'] / 'bot-ctl.sh').chmod(0o777)
            with self.assertRaisesRegex(RuntimeError, 'administrative script owner'):
                release.check()

    def test_privileged_backup_metadata_is_checked_before_restore(self):
        with fixture() as (release, _host, _roots, _entries, _):
            record = release.save_backup()
            item = next(item for item in record['files'] if item['before_sha256'] is None)
            item['owner']['mode'] = 0o777
            with self.assertRaisesRegex(RuntimeError, 'Invalid new bot file ownership'):
                release.restore(record)

    def test_rollback_refuses_reordered_backup_before_writes(self):
        with fixture() as (release, _host, roots, entries, _):
            record = release.save_backup()
            record['files'].reverse()
            with self.assertRaisesRegex(RuntimeError, 'Unsafe rollback order'):
                release.restore(record)
            self.assert_code(roots, entries, 'before')

    def test_admin_process_scan_rejects_running_control_and_helper(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = Path(tmp); (proc / '123').mkdir()
            cmdline = proc / '123/cmdline'
            for command in (b'/usr/local/bin/bot-ctl.sh', b'./bot-ctl.sh', b'/usr/local/lib/msb-fstab.py', b'./msb-fstab.py'):
                cmdline.write_bytes(b'/bin/bash\0' + command + b'\0')
                with self.assertRaisesRegex(RuntimeError, 'administrative'):
                    deploy.Host().admin_idle(proc)
            cmdline.write_bytes(b'/usr/bin/python3\0other.py\0')
            deploy.Host().admin_idle(proc)

    def test_profile_change_after_start_is_not_silently_accepted(self):
        with fixture('profile-after-ready') as (release, host, roots, entries, _):
            with self.assertRaisesRegex(RuntimeError, 'Protected data changed'):
                release.apply()
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)
            self.assert_code(roots, entries, 'before')

    def test_profile_change_after_manual_rollback_start_remains_guarded(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            host.failure = 'profile-after-ready'
            with self.assertRaisesRegex(RuntimeError, 'Protected data changed'):
                release.rollback()
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)
            self.assert_code(roots, entries, 'before')

    def test_profile_change_after_automatic_rollback_start_remains_guarded(self):
        with fixture('profile-after-ready') as (release, host, roots, entries, _):
            with patch.object(deploy, 'atomic_write', side_effect=OSError('synthetic write failure')):
                with self.assertRaisesRegex(RuntimeError, 'Protected data changed'):
                    release.apply()
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)
            self.assert_code(roots, entries, 'before')

    def test_prewrite_independent_code_drift_is_not_restarted(self):
        with fixture() as (release, host, roots, entries, _):
            original = release.check_inventory
            changed = False
            def check(*, after=False):
                nonlocal changed
                if not host.running and not changed:
                    changed = True
                    (roots['bot'] / deploy.ANCHOR['bot']).write_bytes(b'independent-code')
                return original(after=after)
            with patch.object(release, 'check_inventory', side_effect=check):
                with self.assertRaisesRegex(RuntimeError, 'Installed code differs'):
                    release.apply()
            self.assertTrue(changed)
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)
            self.assertEqual((roots['bot'] / deploy.ANCHOR['bot']).read_bytes(), b'independent-code')
            self.assert_code(roots, entries, 'before')

    def test_failed_manual_recovery_guard_still_attempts_stop(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            host.failure = 'profile-after-ready'
            with patch.object(host, 'ensure_guard_startup', side_effect=OSError('independent override')):
                with self.assertRaisesRegex(RuntimeError, 'Rollback restart guard failed'):
                    release.rollback()
            self.assertFalse(host.running, 'Stop is attempted even when masking failed.')
            self.assert_code(roots, entries, 'after')

    def test_prewrite_recovery_detects_code_changed_during_restart(self):
        with fixture('stop') as (release, host, roots, entries, _):
            anchor = roots['bot'] / deploy.ANCHOR['bot']
            host.on_ready = lambda: anchor.write_bytes(b'independent-after-ready')
            with self.assertRaisesRegex(RuntimeError, 'Installed code differs'):
                release.apply()
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)
            self.assertEqual(anchor.read_bytes(), b'independent-after-ready')
            self.assert_code(roots, entries, 'before')

    def test_manual_recovery_rechecks_code_after_restart(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            anchor = roots['bot'] / deploy.ANCHOR['bot']
            host.on_ready = lambda: anchor.write_bytes(b'independent-after-ready')
            ensure = host.ensure_guard_startup
            calls = 0
            def fail_once():
                nonlocal calls
                calls += 1
                if calls == 1: raise OSError('synthetic interruption before restore')
                return ensure()
            with patch.object(host, 'ensure_guard_startup', side_effect=fail_once):
                with self.assertRaisesRegex(RuntimeError, 'Rollback restart failed'):
                    release.rollback()
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)
            self.assertEqual(anchor.read_bytes(), b'independent-after-ready')
            self.assert_code(roots, entries, 'after')

    def assert_code(self, roots, entries, which):
        for item in entries:
            file = roots[item['root']] / item['relative']
            if which == 'before' and item['before_sha256'] is None:
                self.assertFalse(os.path.lexists(file))
                continue
            self.assertEqual(deploy.digest(file), item[which + '_sha256'])
            self.assertEqual(file.stat().st_mode & 0o777, 0o664)

    def test_success_preserves_modes_and_backups_every_file(self):
        with fixture() as (release, host, roots, entries, _):
            outcome = release.apply()
            self.assertEqual(outcome['files'], len(entries))
            self.assertEqual(host.calls, ['freeze', 'thaw', 'stop', 'mask', 'unmask', 'start'])
            self.assertTrue(host.running)
            self.assertFalse(host.frozen)
            self.assertFalse(host.guarded)
            self.assert_code(roots, entries, 'after')
            for item in entries:
                if item['before_sha256'] is not None:
                    self.assertEqual(deploy.digest(release.backup / 'code' / item['root'] / item['relative']), item['before_sha256'])

    def test_restart_intent_is_durable_before_stop_until_ready(self):
        with fixture() as (release, host, _, _, _):
            call, ready = host.call, host.ready

            def checked_call(action):
                if action == 'stop': self.assertTrue((release.backup / 'guard.pending').is_file())
                return call(action)

            def checked_ready():
                self.assertTrue((release.backup / 'guard.pending').is_file())
                return ready()

            host.call, host.ready = checked_call, checked_ready
            release.apply()
            self.assertFalse((release.backup / 'guard.pending').exists())

    def test_interruption_after_unmask_before_start_keeps_restart_intent(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            release.record_guard(restart_after=True)
            host.running = False
            host.guarded = False
            release.rollback()
            self.assertTrue(host.running)
            self.assertFalse((release.backup / 'guard.pending').exists())
            self.assert_code(roots, entries, 'before')

    def test_interruption_while_frozen_can_be_thawed_and_rolled_back(self):
        with fixture() as (release, host, roots, entries, _):
            release.check(); release.save_backup(); release.record_guard(restart_after=True)
            host.frozen = True
            release.rollback()
            self.assertFalse(host.frozen)
            self.assertTrue(host.running)
            self.assert_code(roots, entries, 'before')

    def test_guard_is_published_only_after_complete_write(self):
        with fixture() as (release, _host, _roots, _entries, _):
            release.save_backup()
            with patch.object(deploy.os, 'link', side_effect=OSError('fixture')):
                with self.assertRaises(OSError): release.record_guard()
            self.assertFalse((release.backup / 'guard.pending').exists())
            self.assertFalse(any(p.name.startswith('.guard-') for p in release.backup.iterdir()))

    def test_restart_between_stop_and_mask_is_detected_before_writes(self):
        with fixture() as (release, host, roots, entries, _):
            original = host.guard_startup
            def competing_start():
                original(); host.running = True
            host.guard_startup = competing_start
            with self.assertRaises(RuntimeError): release.apply()
            self.assert_code(roots, entries, 'before')

    def test_restart_during_automatic_rollback_is_detected_before_restore(self):
        with fixture() as (release, host, _roots, _entries, _):
            original_guard, original_write = host.ensure_guard_startup, deploy.atomic_write
            def competing_start():
                original_guard(); host.running = True
            def fail_after_write(*args, **kwargs):
                original_write(*args, **kwargs)
                raise OSError('fixture after publication')
            host.ensure_guard_startup = competing_start
            with patch.object(deploy, 'atomic_write', side_effect=fail_after_write), \
                 patch.object(release, 'restore', wraps=release.restore) as restore:
                with self.assertRaisesRegex(RuntimeError, 'rollback failed'):
                    release.apply()
                restore.assert_not_called()
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)
            self.assertTrue((release.backup / 'guard.pending').exists())

    def test_preflight_and_service_failures_leave_original_code(self):
        for failure in ('system-busy', 'marker-present', 'pending-invalid', 'runtime-drift', 'support-drift', 'node-drift', 'freeze', 'thaw', 'stop', 'mask', 'unmask', 'start', 'ready', 'profile-drift', 'profile-backup'):
            with self.subTest(failure=failure), fixture(failure) as (release, host, roots, entries, _):
                with self.assertRaises(RuntimeError): release.apply()
                self.assert_code(roots, entries, 'before')
                self.assertTrue(host.running)
                self.assertFalse(host.frozen)
                self.assertFalse(host.guarded)

    def test_each_failed_write_before_and_after_publication_rolls_back(self):
        real = deploy.atomic_write
        for index in range(sum(map(len, deploy.ALLOWED.values()))):
            for after in (False, True):
                with self.subTest(index=index, after=after), fixture() as (release, host, roots, entries, _):
                    count = 0
                    failed = False

                    def inject(*args, **kwargs):
                        nonlocal count, failed
                        count += 1
                        if count == index + 1 and not failed:
                            failed = True
                            if after: real(*args, **kwargs)
                            raise OSError('synthetic write failure')
                        return real(*args, **kwargs)

                    with patch.object(deploy, 'atomic_write', side_effect=inject):
                        with self.assertRaises(OSError): release.apply()
                    self.assert_code(roots, entries, 'before')
                    self.assertTrue(host.running)
                    self.assertFalse(host.frozen)

    def test_baseline_drift_and_symlink_block_before_stopping(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink), fixture() as (release, host, roots, entries, _):
                item = next(row for row in entries if row['before_sha256'] is not None)
                target = roots[item['root']] / item['relative']
                if symlink:
                    target.unlink()
                    target.symlink_to(roots[item['root']] / 'other')
                else:
                    target.write_bytes(b'changed elsewhere')
                with self.assertRaises((ValueError, RuntimeError)): release.apply()
                self.assertEqual(host.calls, [])
                self.assertTrue(host.running)

    def test_preexisting_new_target_is_never_overwritten(self):
        with fixture() as (release, host, roots, entries, _):
            item = next(row for row in entries if row['before_sha256'] is None)
            target = roots[item['root']] / item['relative']
            target.write_bytes(b'independent code')
            with self.assertRaises((RuntimeError, ValueError)): release.apply()
            self.assertEqual(target.read_bytes(), b'independent code')
            self.assertEqual(host.calls, [])

    def test_new_target_created_during_publication_is_not_overwritten(self):
        with fixture() as (release, _host, roots, entries, _):
            item = next(row for row in entries if row['before_sha256'] is None)
            target = roots[item['root']] / item['relative']
            record = release.save_backup()
            saved = next(row for row in record['files'] if row['relative'] == item['relative'] and row['root'] == item['root'])
            prepared = release.backup / 'prepared' / deploy.item_key(item)
            candidate = (release.stage / 'payload' / item['root'] / item['relative']).read_bytes()
            original = deploy.os.link

            def race(source, destination, **kwargs):
                fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=kwargs['dst_dir_fd'])
                try: os.write(fd, b'independent code')
                finally: os.close(fd)
                return original(source, destination, **kwargs)

            with patch.object(deploy.os, 'link', side_effect=race):
                with self.assertRaises(FileExistsError):
                    deploy.atomic_write(roots[item['root']], item['relative'], candidate, saved['owner'],
                        create=True, prepared=prepared, before_identity=None, after_identity=saved['after_identity'])
            self.assertEqual(target.read_bytes(), b'independent code')

    def test_independent_replacement_at_exchange_is_quarantined(self):
        with fixture() as (release, host, _roots, _entries, _):
            original = deploy.rename_atomic
            raced = False

            def race(source_fd, source, target_fd, target, *, exchange=False):
                nonlocal raced
                if exchange and not raced:
                    raced = True
                    fd = os.open('fixture-race', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o664, dir_fd=target_fd)
                    try: os.write(fd, b'independent replacement')
                    finally: os.close(fd)
                    os.replace('fixture-race', target, src_dir_fd=target_fd, dst_dir_fd=target_fd)
                return original(source_fd, source, target_fd, target, exchange=exchange)

            with patch.object(deploy, 'rename_atomic', side_effect=race):
                with self.assertRaisesRegex(RuntimeError, 'rollback failed'):
                    release.apply()
            self.assertTrue(raced)
            self.assertTrue(any(p.read_bytes() == b'independent replacement' for p in (release.backup / 'prepared').iterdir()))
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)
            self.assertTrue((release.backup / 'guard.pending').exists())

    def test_independent_replacement_during_added_file_rollback_is_quarantined(self):
        with fixture() as (release, host, _roots, _entries, _):
            release.apply()
            original = deploy.rename_atomic
            raced = False

            def race(source_fd, source, target_fd, target, *, exchange=False):
                nonlocal raced
                if not exchange and not raced:
                    raced = True
                    fd = os.open('fixture-race', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644, dir_fd=source_fd)
                    try: os.write(fd, b'independent replacement')
                    finally: os.close(fd)
                    os.replace('fixture-race', source, src_dir_fd=source_fd, dst_dir_fd=source_fd)
                return original(source_fd, source, target_fd, target, exchange=exchange)

            with patch.object(deploy, 'rename_atomic', side_effect=race):
                with self.assertRaisesRegex(RuntimeError, 'protected quarantine'):
                    release.rollback()
            self.assertTrue(raced)
            self.assertTrue(any(p.read_bytes() == b'independent replacement' for p in (release.backup / 'quarantine').iterdir()))
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)

    def test_interruption_after_exchange_can_restore_the_original_inode(self):
        with fixture() as (release, host, roots, entries, _):
            release.check()
            record = release.save_backup()
            release.record_guard(restart_after=True)
            host.running, host.guarded = False, True
            item = next(row for row in record['files'] if row['before_sha256'] is not None)
            payload = (release.stage / 'payload' / item['root'] / item['relative']).read_bytes()
            deploy.atomic_write(roots[item['root']], item['relative'], payload, item['owner'], create=False,
                prepared=release.backup / 'prepared' / deploy.item_key(item),
                before_identity=item['before_identity'], after_identity=item['after_identity'])
            release.rollback()
            self.assertTrue(host.running)
            self.assert_code(roots, entries, 'before')

    def test_interruption_after_quarantining_added_file_can_resume_rollback(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            record = json.loads((release.backup / 'metadata.json').read_text())
            release.record_guard(restart_after=True)
            host.running, host.guarded = False, True
            item = next(row for row in record['files'] if row['before_sha256'] is None)
            deploy.remove_created(roots[item['root']], item['relative'], release.backup / 'quarantine' / deploy.item_key(item),
                item['owner'], item['after_identity'], item['after_sha256'])
            release.rollback()
            self.assertTrue(host.running)
            self.assert_code(roots, entries, 'before')

    def test_rollback_refuses_an_independently_changed_new_file(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            item = next(row for row in entries if row['before_sha256'] is None)
            target = roots[item['root']] / item['relative']
            target.write_bytes(b'independent code')
            with self.assertRaisesRegex(RuntimeError, 'independently changed'):
                release.rollback()
            self.assertEqual(target.read_bytes(), b'independent code')
            self.assertTrue(host.running)

    def test_missing_check_rejects_report_before_deploy(self):
        with fixture() as (release, host, roots, _, report_path):
            report = json.loads(report_path.read_text())
            report['checks'].pop()
            report_path.write_text(json.dumps(report))
            with self.assertRaises(ValueError):
                deploy.Deployment(release.stage, release.backup, roots, host,
                                  deploy.digest(release.stage / 'manifest.json'), deploy.digest(report_path))
            self.assertEqual(host.calls, [])

    def test_fstab_report_allows_only_documented_acl_skip(self):
        with fixture() as (release, host, roots, _, report_path):
            report = json.loads(report_path.read_text())
            next(row for row in report['checks'] if row['suite'] == 'fstab-compat')['skipped_cases'] = ['test_rewrite_preserves_extended_attributes']
            report_path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, 'fstab compatibility'):
                deploy.Deployment(release.stage, release.backup, roots, host,
                    deploy.digest(release.stage / 'manifest.json'), deploy.digest(report_path))
            self.assertEqual(host.calls, [])

    def test_focused_check_with_no_passes_rejects_report(self):
        with fixture() as (release, host, roots, _, report_path):
            report = json.loads(report_path.read_text())
            next(row for row in report['checks'] if row['suite'] == 'bot-status-view')['passed'] = 0
            report_path.write_text(json.dumps(report))
            with self.assertRaises(ValueError):
                deploy.Deployment(release.stage, release.backup, roots, host,
                                  deploy.digest(release.stage / 'manifest.json'), deploy.digest(report_path))
            self.assertEqual(host.calls, [])

    def test_recurring_and_backlog_counts_must_be_exact(self):
        for suite, count in (('recurring-safe', 7), ('backlog-targeted', 290)):
            with self.subTest(suite=suite), fixture() as (release, host, roots, _, report_path):
                report = json.loads(report_path.read_text())
                next(row for row in report['checks'] if row['suite'] == suite)['passed'] = count
                report_path.write_text(json.dumps(report))
                with self.assertRaises(ValueError):
                    deploy.Deployment(release.stage, release.backup, roots, host,
                                      deploy.digest(release.stage / 'manifest.json'), deploy.digest(report_path))
                self.assertEqual(host.calls, [])

    def test_distinct_uid_skips_are_explicit_and_exact(self):
        with fixture() as (release, host, roots, _, report_path):
            report = json.loads(report_path.read_text())
            next(row for row in report['checks'] if row['suite'] == 'test_client_markers')['skipped'] = 6
            report_path.write_text(json.dumps(report))
            with self.assertRaises(ValueError):
                deploy.Deployment(release.stage, release.backup, roots, host,
                                  deploy.digest(release.stage / 'manifest.json'), deploy.digest(report_path))
            self.assertEqual(host.calls, [])

    def test_corrupt_backup_is_detected_before_rollback_writes(self):
        with fixture() as (release, _host, roots, entries, _):
            record = release.save_backup()
            damaged = next(row for row in entries if row['before_sha256'] is not None)
            (release.backup / 'code' / damaged['root'] / damaged['relative']).write_bytes(b'corrupt')
            with self.assertRaises(RuntimeError): release.restore(record)
            self.assert_code(roots, entries, 'before')
    def test_independent_code_change_is_not_overwritten_during_rollback(self):
        with fixture() as (release, host, roots, entries, _):
            real = deploy.atomic_write
            item = next(row for row in entries if row['before_sha256'] is not None)
            changed = roots[item['root']] / item['relative']
            calls = 0

            def drift(*args, **kwargs):
                nonlocal calls
                calls += 1
                real(*args, **kwargs)
                if calls == 1:
                    changed.write_bytes(b'independently changed')
                    raise OSError('synthetic failure after unrelated change')

            with patch.object(deploy, 'atomic_write', side_effect=drift):
                with self.assertRaisesRegex(RuntimeError, 'rollback failed'):
                    release.apply()
            self.assertEqual(changed.read_bytes(), b'independently changed')
            self.assertFalse(host.running, 'mixed code must not be started')
            self.assertTrue(host.guarded)
            self.assertTrue((release.backup / 'guard.pending').exists())

    def test_manual_rollback_restores_both_roots_and_restarts(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            result = release.rollback()
            self.assertEqual(result['restored'], len(entries))
            self.assert_code(roots, entries, 'before')
            self.assertTrue(host.running)

    def test_interrupted_manual_rollback_stays_stopped_and_can_resume(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            real = deploy.restore_existing
            calls = 0

            def fail_second(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 2: raise OSError('synthetic rollback failure')
                return real(*args, **kwargs)

            with patch.object(deploy, 'restore_existing', side_effect=fail_second):
                with self.assertRaises(OSError): release.rollback()
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)
            release.rollback()
            self.assertTrue(host.running)
            self.assert_code(roots, entries, 'before')

    def test_late_change_during_rollback_blocks_restart(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            real = deploy.restore_existing
            restored = []
            def change_first_on_second(root, relative, *args):
                real(root, relative, *args)
                restored.append(Path(root) / relative)
                if len(restored) == 2: restored[0].write_bytes(b'independent late write')
            with patch.object(deploy, 'restore_existing', side_effect=change_first_on_second):
                with self.assertRaisesRegex(RuntimeError, 'independently changed'):
                    release.rollback()
            self.assertEqual(restored[0].read_bytes(), b'independent late write')
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)

    def test_change_after_ready_restores_guard_and_stops_bot(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            item = next(row for row in entries if row['before_sha256'] is not None)
            target = roots[item['root']] / item['relative']
            original_ready = host.ready
            def changed_ready():
                original_ready(); target.write_bytes(b'independent after startup')
            host.ready = changed_ready
            with self.assertRaisesRegex(RuntimeError, 'independently changed'):
                release.rollback()
            self.assertEqual(target.read_bytes(), b'independent after startup')
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)

    def test_apply_detects_code_change_after_ready_and_preserves_it(self):
        with fixture() as (release, host, roots, entries, _):
            item = next(row for row in entries if row['before_sha256'] is not None)
            target = roots[item['root']] / item['relative']
            original_ready = host.ready
            def changed_ready():
                original_ready(); target.write_bytes(b'independent after startup')
            host.ready = changed_ready
            with self.assertRaisesRegex(RuntimeError, 'rollback failed'):
                release.apply()
            self.assertEqual(target.read_bytes(), b'independent after startup')
            self.assertFalse(host.running)
            self.assertTrue(host.guarded)

    def test_guard_precedes_a_failing_stop_after_rollback_startup(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            item = next(row for row in entries if row['before_sha256'] is not None)
            target = roots[item['root']] / item['relative']
            ready, call = host.ready, host.call
            stops = 0
            def changed_ready():
                ready(); target.write_bytes(b'independent after startup')
            def failing_stop(action):
                nonlocal stops
                if action == 'stop':
                    stops += 1
                    if stops == 2: raise RuntimeError('second stop failed')
                return call(action)
            host.ready, host.call = changed_ready, failing_stop
            with self.assertRaisesRegex(RuntimeError, 'second stop failed'):
                release.rollback()
            self.assertTrue(host.guarded)
            self.assertTrue((release.backup / 'guard.pending').exists())
            self.assertEqual(target.read_bytes(), b'independent after startup')

    def test_manual_rollback_preserves_intentionally_stopped_bot(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            host.running = False
            result = release.rollback()
            self.assertEqual(result['polling'], 'unchanged-inactive')
            self.assertFalse(host.running)
            self.assertFalse(host.guarded)
            self.assert_code(roots, entries, 'before')

    def test_rollback_reinstates_guard_if_interrupted_before_mask(self):
        with fixture() as (release, host, roots, entries, _):
            release.save_backup()
            (release.backup / 'guard.pending').write_text('{"restart_after": true}\n')
            (release.backup / 'guard.pending').chmod(0o600)
            host.running = False
            self.assertFalse(host.guarded)
            release.rollback()
            self.assertIn('mask', host.calls)
            self.assertLess(host.calls.index('mask'), host.calls.index('unmask'))
            self.assertTrue(host.running)
            self.assertFalse(host.guarded)
            self.assert_code(roots, entries, 'before')


class PendingRequestTest(unittest.TestCase):
    def test_only_unchanged_read_only_status_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            engine = home / '.msb/engine'
            engine.mkdir(parents=True)
            request = engine / 'request'
            host = deploy.Host(home)
            with patch.object(deploy.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid())):
                self.assertIsNone(host.pending_status())
                body = b'{"v":1,"id":"fixture123","action":"status","bot_id":"default"}'
                request.write_bytes(body)
                self.assertEqual(host.pending_status()['sha256'], H(body))
                self.assertEqual(request.read_bytes(), body)
                for bad in (b'{"v":1,"id":"fixture123","action":"reload-pult"}',
                            b'{"v":true,"id":"fixture123","action":"status"}',
                            b'{"v":1,"id":"fixture123","action":"status","action":"status"}',
                            b'{"v":1,"id":"../oops","action":"status"}'):
                    request.write_bytes(bad)
                    with self.assertRaises(RuntimeError): host.pending_status()
                    self.assertEqual(request.read_bytes(), bad)

    def test_fifo_is_rejected_without_waiting_for_a_writer(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            engine = home / '.msb/engine'; engine.mkdir(parents=True)
            os.mkfifo(engine / 'request')
            with patch.object(deploy.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid())):
                with self.assertRaises(RuntimeError): deploy.Host(home).pending_status()

    def test_existing_pause_and_untrusted_lock_block_without_modification(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            engine = home / '.msb/engine'; engine.mkdir(parents=True)
            host = deploy.Host(home)
            with patch.object(deploy.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid())):
                host.marker_absent()
                marker = engine / 'sleep.default'; marker.write_bytes(b'fixture')
                with self.assertRaises(RuntimeError): host.marker_absent()
                self.assertEqual(marker.read_bytes(), b'fixture')
                marker.unlink()
                lock = engine / 'sleep.default.lock.sqlite'; lock.touch(mode=0o600)
                host.marker_absent()
                self.assertEqual(lock.read_bytes(), b'')
                lock.write_bytes(b'not-the-expected-empty-lock')
                with self.assertRaises(RuntimeError): host.marker_absent()
                lock.unlink()
                lock.symlink_to(marker)
                with self.assertRaises(RuntimeError): host.marker_absent()
                lock.unlink()
                lock.touch(mode=0o600)
                lock.chmod(0o644)
                with self.assertRaises(RuntimeError): host.marker_absent()
                lock.chmod(0o600)
                hardlink = engine / 'linked-lock'; os.link(lock, hardlink)
                with self.assertRaises(RuntimeError): host.marker_absent()
                hardlink.unlink()
                sidecar = engine / 'sleep.default.lock.sqlite-journal'; sidecar.touch()
                with self.assertRaises(RuntimeError): host.marker_absent()


    def test_missing_native_isolated_check_blocks_even_passing_report(self):
        with fixture() as (release, host, roots, entries, report_path):
            report = json.loads(report_path.read_text()); report['native_isolated_verification'] = False
            report_path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, 'native steer verification'):
                deploy.Deployment(release.stage, release.backup, roots, host,
                                  deploy.digest(release.stage / 'manifest.json'), deploy.digest(report_path))
            self.assertTrue(host.running)

    def test_native_gate_rejects_other_interfaces_and_skipped_result(self):
        with fixture() as (release, host, roots, entries, report_path):
            original = json.loads(report_path.read_text())
            for change in ('interface', 'skip'):
                report = json.loads(json.dumps(original))
                if change == 'interface': report['native_isolated_verification']['interfaces'].append('eth0')
                else:
                    native = next(x for x in report['checks'] if x['suite'] == 'steer-native-isolated')
                    native.update(passed=0, skipped=1)
                report_path.write_text(json.dumps(report))
                with self.assertRaises(ValueError):
                    deploy.Deployment(release.stage, release.backup, roots, host,
                                      deploy.digest(release.stage / 'manifest.json'), deploy.digest(report_path))

    def test_different_native_hash_rejected_with_same_version(self):
        with fixture() as (release, host, roots, entries, report):
            with patch.object(deploy, 'cli_fingerprint', return_value={'wrapper_sha256': 'a' * 64, 'binary_sha256': 'c' * 64}):
                with self.assertRaisesRegex(RuntimeError, 'Codex executable changed'):
                    release.check()
            self.assertTrue(host.running)

    def test_service_network_change_rejected(self):
        with fixture() as (release, host, roots, entries, report):
            with patch.object(host, 'network_inode', return_value=12):
                with self.assertRaisesRegex(RuntimeError, 'network namespace changed'):
                    release.check()
            self.assertTrue(host.running)

    def test_altered_sealed_launcher_rejected(self):
        with fixture() as (release, host, roots, entries, report):
            (release.stage / 'launcher.py').write_text('tampered')
            with self.assertRaisesRegex(ValueError, 'Operator code changed'):
                deploy.Deployment(release.stage, release.backup, roots, host,
                                  deploy.digest(release.stage / 'manifest.json'), deploy.digest(report))

    def test_install_and_rollback_all_bot_files(self):
        with fixture() as (release, host, roots, entries, _):
            result = release.apply()
            self.assertEqual(result['files'], 19)
            for row in entries:
                path = roots['bot'] / row['relative']
                self.assertEqual(deploy.digest(path), row['after_sha256'])
                if row['before_sha256'] is None:
                    self.assertEqual((path.stat().st_uid, path.stat().st_gid, path.stat().st_mode & 0o777),
                                     (os.geteuid(), os.getegid(), 0o664))
            release.rollback()
            for row in entries:
                path = roots['bot'] / row['relative']
                if row['before_sha256'] is None: self.assertFalse(path.exists())
                else: self.assertEqual(deploy.digest(path), row['before_sha256'])

    def test_inbox_is_existing_and_is_restored_with_its_metadata(self):
        key = ('bot', 'src/telegram/inbox.mjs')
        self.assertIn(key, deploy.RELEASE_ORDER)
        self.assertNotIn(key, deploy.ADDED)
        self.assertEqual(len(deploy.RELEASE_ORDER), 19)
        self.assertEqual(deploy.ADDED, {('bot', 'src/autonomy/run-journal.mjs')})
        self.assertLess(deploy.RELEASE_ORDER.index(key), deploy.RELEASE_ORDER.index(('bot', 'src/telegram/bot.mjs')))
        with fixture() as (release, host, roots, entries, _):
            row = next(item for item in entries if (item['root'], item['relative']) == key)
            self.assertIsNotNone(row['before_sha256'])
            live = roots['bot'] / row['relative']
            before = deploy.info(live)
            release.apply()
            self.assertEqual(deploy.digest(live), row['after_sha256'])
            self.assertEqual(deploy.digest(release.backup / 'code' / 'bot' / row['relative']), row['before_sha256'])
            release.rollback()
            self.assertEqual(deploy.info(live), before)

    def test_inbox_drift_stops_before_service_is_stopped(self):
        with fixture() as (release, host, roots, entries, _):
            live = roots['bot'] / 'src/telegram/inbox.mjs'
            live.write_text('independent change')
            with self.assertRaises(RuntimeError): release.apply()
            self.assertTrue(host.running)
            self.assertEqual(live.read_text(), 'independent change')

    def test_new_path_drift_is_rejected_before_stop(self):
        with fixture() as (release, host, roots, entries, _):
            row = next(row for row in entries if row['before_sha256'] is None)
            (roots['bot'] / row['relative']).write_text('external')
            with self.assertRaises(RuntimeError): release.apply()
            self.assertTrue(host.running)

    def test_changed_new_file_is_not_deleted_during_rollback(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            row = next(row for row in entries if row['before_sha256'] is None)
            path = roots['bot'] / row['relative']; path.write_text('independent')
            with self.assertRaises(RuntimeError): release.rollback()
            self.assertEqual(path.read_text(), 'independent')

    def test_changed_new_owner_is_not_silently_removed(self):
        with fixture() as (release, host, roots, entries, _):
            release.apply()
            row = next(row for row in entries if row['before_sha256'] is None)
            path = roots['bot'] / row['relative']; path.chmod(0o600)
            with self.assertRaises(RuntimeError): release.rollback()
            self.assertTrue(path.exists())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_anchor_owner_mismatch_blocks_install(self):
        with fixture() as (release, host, roots, entries, _):
            (roots['bot'] / deploy.ANCHOR['bot']).chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'anchor ownership'): release.apply()
            self.assertTrue(host.running)


if __name__ == '__main__':
    unittest.main()
