import hashlib
import importlib.util
import json
import os
import sqlite3
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result); return result

build = load('attachment_build_test', HERE / 'build.py')
deploy = load('attachment_deploy_test', HERE / 'deploy.py')
audit = load('attachment_audit_test', HERE.parent / 'jar1-audit-2026-11-20/deploy.py')
profile = load('attachment_profile_test', HERE / 'profile.py')
launcher = load('attachment_launcher_test', HERE / 'launcher.py')

class GuardTests(unittest.TestCase):
    def test_reused_stage_guard_checks_the_actual_launcher(self):
        base = load('attachment_launcher_base_test', HERE.parent / 'jar1-audit-2026-11-20/launcher.py')
        seen = []
        base.validate_stage = lambda stage, digest: seen.append((Path(base.__file__).resolve(), stage, digest))
        launcher.validate_stage(base, Path('/var/tmp/synthetic-release'), 'test-digest')
        self.assertEqual(seen, [(HERE / 'launcher.py', Path('/var/tmp/synthetic-release'), 'test-digest')])

    def proof(self):
        manifest = {'source_commit': 'a'*40, 'source_archive_sha256': 'b'*64}
        proof = {'passed': True, 'scope': 'jar1-attachment-delivery-v1', 'manifest_sha256': 'c'*64,
          'source_commit': manifest['source_commit'], 'source_archive_sha256': manifest['source_archive_sha256'],
          'environment': {'platform': 'linux', 'node': 'v22.14.0', 'node_sha256': 'd'*64},
          'native_identity': {'host_netns_inode': 1, 'test_netns_inode': 2, 'wrapper_sha256': 'e'*64, 'binary_sha256': 'f'*64},
          'checks': [{'suite': n, 'exit_code': 0, 'passed': count, 'skipped': 0, 'cancelled': 0}
                     for n, count in {'media':12, 'response':12, 'plan':10, 'history':7, 'release':6}.items()]}
        return proof, manifest

    def test_exact_focused_report_accepted(self):
        proof, manifest = self.proof()
        deploy.valid_report(proof, manifest, 'c'*64)

    def test_missing_or_skipped_suite_rejected(self):
        proof, manifest = self.proof(); proof['checks'].pop()
        with self.assertRaises(RuntimeError): deploy.valid_report(proof, manifest, 'c'*64)
        proof, manifest = self.proof(); proof['checks'][0]['skipped'] = 1
        with self.assertRaises(RuntimeError): deploy.valid_report(proof, manifest, 'c'*64)
        proof, manifest = self.proof(); proof['native_identity']['test_netns_inode'] = 1
        with self.assertRaises(RuntimeError): deploy.valid_report(proof, manifest, 'c'*64)

    def test_prior_identity_and_overlay(self):
        rows = [{'root':'bot', 'relative':f'item-{i}', 'sha256':f'{i:064x}'} for i in range(347)]
        updates = [{'root':'bot', 'relative':f'item-{i}', 'after_sha256':'a'*64} for i in range(6)]
        prior = {'source_commit': build.PRIOR_COMMIT, 'baseline_inventory': rows, 'files': updates,
                 'support_files': [{'path':f'/fake/{i}', 'sha256':'b'*64} for i in range(6)]}
        raw = json.dumps(prior).encode(); original = build.PRIOR_SHA
        try:
            build.PRIOR_SHA = hashlib.sha256(raw).hexdigest()
            inventory, support = build.prior_inventory(raw)
            self.assertEqual(len(inventory), 347); self.assertEqual(len(support), 6)
            self.assertEqual(inventory[0]['sha256'], 'a'*64)
            with self.assertRaises(ValueError): build.prior_inventory(raw + b' ')
        finally: build.PRIOR_SHA = original

    def test_partial_exchange_rollback_restores_original_inodes(self):
        with tempfile.TemporaryDirectory(prefix='attachment-atomic-') as directory:
            root = Path(directory).resolve() / 'live'; prepared_dir = Path(directory).resolve() / 'prepared'
            root.mkdir(); prepared_dir.mkdir(); records = []
            for index in range(2):
                live, prepared = root / f'{index}.mjs', prepared_dir / f'{index}.new'
                old, new = f'old-{index}'.encode(), f'new-{index}'.encode()
                live.write_bytes(old); prepared.write_bytes(new)
                os.chmod(live, 0o600); os.chmod(prepared, 0o600)
                owner = audit.info(live); before = live.stat(); after = prepared.stat()
                records.append((live, prepared, old, new, owner,
                    {'dev': before.st_dev, 'ino': before.st_ino}, {'dev': after.st_dev, 'ino': after.st_ino}))
            live, prepared, old, new, owner, before, after = records[0]
            audit.atomic_write(root, live.name, new, owner, create=False, prepared=prepared,
                               before_identity=before, after_identity=after)
            self.assertEqual(live.read_bytes(), new)
            for live, prepared, old, new, owner, before, after in reversed(records):
                audit.restore_existing(root, live.name, prepared, owner, before, after, hashlib.sha256(new).hexdigest())
                self.assertEqual(live.read_bytes(), old)
                self.assertEqual((live.stat().st_dev, live.stat().st_ino), (before['dev'], before['ino']))


class ProfileScopeTests(unittest.TestCase):
    def fixture(self, root):
        home = root / 'home'; home.mkdir()
        bot = home / '.msb/bots/default'; bot.mkdir(parents=True)
        codex = home / '.codex'; codex.mkdir()
        identity = '0199a213-81c0-7800-8aa1-bbab2a035a53'
        state = bot / 'state.json'
        state.write_text(json.dumps({'extAuthBypass': 'codex', 'ccSessionId': 'ext:codex:' + identity}))
        for name in (bot / '.env', bot / 'ext-providers.json', home / '.msb/.env',
                     codex / 'auth.json', codex / 'config.toml'):
            name.write_text('synthetic fixture')
        rollout = codex / 'sessions/2026/11' / ('rollout-2026-11-20-' + identity + '.jsonl')
        rollout.parent.mkdir(parents=True)
        rollout.write_text(json.dumps({'type':'session_meta', 'payload':{'id':identity}}) + '\n' + 'synthetic turn\n')
        con = sqlite3.connect(codex / 'state_5.sqlite')
        con.execute('CREATE TABLE threads (id TEXT, rollout_path TEXT)')
        con.execute('INSERT INTO threads VALUES (?, ?)', (identity, str(rollout)))
        con.commit(); con.close()
        project = bot / 'projects/atoll/cache.sqlite'; project.parent.mkdir(parents=True)
        project.write_bytes(b'project-data')
        return home, state, project, rollout

    def fresh_audit(self):
        return load('attachment_private_backup_test', HERE.parent / 'jar1-audit-2026-11-20/profile_backup.py')

    def test_backup_ignores_writable_project_and_unrelated_data(self):
        with tempfile.TemporaryDirectory(prefix='attachment-profile-') as folder:
            root = Path(folder).resolve(); home, state, project, rollout = self.fixture(root)
            fakeproc = root / 'proc'; fd = fakeproc / '123/fd'; fd.mkdir(parents=True)
            (fakeproc / '123/fdinfo').mkdir(); (fd / '10').symlink_to(project)
            (fakeproc / '123/fdinfo/10').write_text('flags:\t0100002\n')
            audit_profile = profile.configured(self.fresh_audit(), audit, home)
            backup = root / 'profile'
            audit_profile.backup_profile(home, backup,
                check_writers=lambda h: audit_profile.no_open_writers(h, proc=fakeproc))
            copied = {p.relative_to(backup / 'data').as_posix() for p in (backup / 'data').rglob('*') if p.is_file()}
            self.assertEqual(copied, set(profile.STATIC) | {profile.INDEX, rollout.relative_to(home).as_posix()})
            self.assertFalse(any('projects/' in item for item in copied))
            audit_profile.assert_active_session_matches(home, backup)
            before = profile.protected(home, audit); project.write_bytes(b'independently-updated')
            self.assertEqual(before, profile.protected(home, audit))

    def test_protected_state_and_authorization_changes_are_detected(self):
        with tempfile.TemporaryDirectory(prefix='attachment-profile-') as folder:
            root = Path(folder).resolve(); home, state, project, rollout = self.fixture(root)
            before = profile.protected(home, audit)
            state.write_text(state.read_text().replace('}', ', "changed": true}'))
            self.assertNotEqual(before, profile.protected(home, audit))
            before = profile.protected(home, audit)
            (home / '.codex/auth.json').write_text('modified fixture')
            self.assertNotEqual(before, profile.protected(home, audit))

if __name__ == '__main__': unittest.main()
