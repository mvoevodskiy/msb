"""Synthetic tests of private profile snapshots; no real account or service."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('profile_backup', Path(__file__).with_name('profile_backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class ProfileBackupTests(unittest.TestCase):
    def make_home(self, root):
        home = Path(root).resolve() / 'client'
        profile = home / '.msb/bots/default'
        sessions = home / '.codex/sessions/2026/11/16'
        workspace = home / 'workspace'
        for directory in (profile, sessions, workspace, home / '.msb/monitor'):
            directory.mkdir(parents=True, exist_ok=True)
        session_id = '11111111-1111-4111-8111-111111111111'
        (profile / 'state.json').write_text(json.dumps({'extAuthBypass': 'codex', 'ccSessionId': session_id}))
        (home / '.codex/auth.json').write_text('{"fixture":true}')
        (home / '.codex/config.toml').write_text('model = "fixture"\n')
        (profile / '.env').write_text('FAKE_KEY=fixture\n')
        (profile / 'state.json.lock.sqlite').write_bytes(b'')
        (profile / 'CLAUDE.md').symlink_to('state.json')
        rollout = sessions / 'rollout-fixture.jsonl'
        rollout.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': session_id}}) + '\n')
        (home / '.msb/monitor/config.json').write_text('{"fixture":true}\n')
        (workspace / 'SOUL.md').write_text('fixture identity\n')
        db = home / '.codex/state_5.sqlite'
        with sqlite3.connect(db) as conn:
            conn.execute('CREATE TABLE rows (x TEXT)')
            conn.execute('INSERT INTO rows VALUES (?)', ('synthetic',))
            conn.execute('CREATE TABLE threads (id TEXT, rollout_path TEXT)')
            conn.execute('INSERT INTO threads VALUES (?, ?)', (session_id, str(rollout)))
        conn.close()
        for name in ('thread_history_1.sqlite', 'goals_1.sqlite', 'memories_1.sqlite'):
            with sqlite3.connect(home / '.codex' / name) as conn:
                conn.execute('CREATE TABLE fixture (value TEXT)')
            conn.close()
        return home

    def test_closed_snapshot_copies_files_sqlite_and_records_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self.make_home(tmp)
            dest = Path(tmp).resolve() / 'private'
            result = backup.backup_profile(home, dest, check_writers=lambda _home: None)
            manifest = json.loads((dest / 'manifest.json').read_text())
            self.assertGreater(result['files'], 0)
            self.assertEqual(os.stat(dest).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(dest / 'manifest.json').st_mode & 0o777, 0o600)
            self.assertEqual((dest / 'data/.msb/bots/default/state.json').read_bytes(),
                             (home / '.msb/bots/default/state.json').read_bytes())
            self.assertEqual(manifest['.msb/bots/default/CLAUDE.md']['type'], 'symlink')
            self.assertEqual(manifest['.msb/bots/default/CLAUDE.md']['target'], 'state.json')
            self.assertFalse((dest / 'data/.msb/bots/default/CLAUDE.md').exists())
            self.assertEqual(manifest['.msb/bots/default/state.json.lock.sqlite']['type'], 'excluded-lock')
            with sqlite3.connect(dest / 'data/.codex/state_5.sqlite') as conn:
                self.assertEqual(conn.execute('SELECT x FROM rows').fetchall(), [('synthetic',)])
            conn.close()
            self.assertTrue((dest / 'COMPLETE.json').is_file())
            backup.verify_copy(dest, home, backup.active_session(home, home), require_complete=True)

    def test_profile_change_during_copy_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self.make_home(tmp)
            real = backup.copy_regular
            changed = False
            def mutate(src, dest, expected):
                nonlocal changed
                result = real(src, dest, expected)
                if not changed:
                    changed = True
                    (home / 'workspace/SOUL.md').write_text('changed fixture\n')
                return result
            with patch.object(backup, 'copy_regular', side_effect=mutate):
                with self.assertRaisesRegex(RuntimeError, 'changed'):
                    backup.backup_profile(home, Path(tmp).resolve() / 'private', check_writers=lambda _home: None)

    def test_corrupt_sqlite_cannot_produce_verified_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self.make_home(tmp)
            (home / '.codex/state_5.sqlite').write_bytes(b'not sqlite')
            with self.assertRaises(sqlite3.DatabaseError):
                backup.backup_profile(home, Path(tmp).resolve() / 'private', check_writers=lambda _home: None)

    def test_writer_detector_rejects_writable_and_allows_readonly_fd(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self.make_home(tmp)
            proc = Path(tmp).resolve() / 'proc/987654'
            (proc / 'fd').mkdir(parents=True)
            (proc / 'fdinfo').mkdir()
            (proc / 'fd/3').symlink_to(home / '.msb/bots/default/state.json')
            (proc / 'fdinfo/3').write_text('flags:\t0100001\n')
            with self.assertRaisesRegex(RuntimeError, 'writable profile'):
                backup.no_open_writers(home, Path(tmp).resolve() / 'proc')
            (proc / 'fdinfo/3').write_text('flags:\t0100000\n')
            backup.no_open_writers(home, Path(tmp).resolve() / 'proc')

    def test_unknown_profile_root_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self.make_home(tmp)
            import shutil
            shutil.rmtree(home / '.msb/bots/default')
            (home / '.msb/bots/default').symlink_to('/nonexistent-fixture')
            with self.assertRaisesRegex(RuntimeError, 'Unexpected profile root'):
                backup.backup_profile(home, Path(tmp).resolve() / 'private', check_writers=lambda _home: None)


    def test_required_session_and_index_must_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self.make_home(tmp)
            with sqlite3.connect(home / '.codex/state_5.sqlite') as con:
                con.execute('DELETE FROM threads')
            con.close()
            with self.assertRaisesRegex(RuntimeError, 'not unique'):
                backup.backup_profile(home, Path(tmp).resolve() / 'private', check_writers=lambda _home: None)
            self.assertFalse((Path(tmp).resolve() / 'private/COMPLETE.json').exists())

    def test_uncaptured_symlink_target_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self.make_home(tmp)
            outside = Path(tmp).resolve() / 'other'; outside.write_text('fixture')
            (home / '.msb/bots/default/other').symlink_to(outside)
            with self.assertRaisesRegex(RuntimeError, 'outside'):
                backup.backup_profile(home, Path(tmp).resolve() / 'private', check_writers=lambda _home: None)

    def test_incomplete_or_tampered_snapshot_cannot_verify(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self.make_home(tmp); dest = Path(tmp).resolve() / 'private'
            backup.backup_profile(home, dest, check_writers=lambda _home: None)
            session = backup.active_session(home, home)
            (dest / 'data/workspace/SOUL.md').write_text('tampered fixture')
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                backup.verify_copy(dest, home, session, require_complete=True)
            (dest / 'COMPLETE.json').unlink()
            with self.assertRaises(FileNotFoundError):
                backup.verify_copy(dest, home, session, require_complete=True)

    def test_untrusted_backup_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self.make_home(tmp); parent = Path(tmp).resolve() / 'public'
            parent.mkdir(mode=0o755)
            with self.assertRaisesRegex(RuntimeError, 'not private'):
                backup.backup_profile(home, parent / 'profile', check_writers=lambda _home: None)


    def test_synthetic_copy_can_reconstruct_profile_and_active_session(self):
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve(); home = self.make_home(tmp); dest = base / 'private'
            backup.backup_profile(home, dest, check_writers=lambda _home: None)
            manifest = json.loads((dest / 'manifest.json').read_text())
            restored = base / 'restored'; restored.mkdir()
            for rel, entry in sorted(manifest.items()):
                if not entry or entry['type'] != 'directory': continue
                (restored / rel).mkdir(parents=True, exist_ok=True)
                (restored / rel).chmod(entry['mode'])
            for rel, entry in sorted(manifest.items()):
                if not entry or not entry.get('backup_sha256'): continue
                target = restored / rel; target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(dest / 'data' / rel, target); target.chmod(entry['mode'])
            for rel, entry in sorted(manifest.items()):
                if not entry or entry['type'] != 'symlink': continue
                target = restored / rel; target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(entry['target'])
            self.assertEqual(backup.active_session(home, restored), backup.active_session(home, home))
            self.assertEqual((restored / '.msb/bots/default/CLAUDE.md').read_bytes(),
                             (home / '.msb/bots/default/state.json').read_bytes())
            self.assertEqual((restored / 'workspace/SOUL.md').read_bytes(),
                             (home / 'workspace/SOUL.md').read_bytes())
            with sqlite3.connect(restored / '.codex/state_5.sqlite') as con:
                self.assertEqual(con.execute('PRAGMA quick_check').fetchone(), ('ok',))
            con.close()


    def test_empty_truncated_or_wrong_native_session_header_is_rejected(self):
        for content in ('', '{"type":', json.dumps({'type': 'session_meta', 'payload': {'id': 'wrong'}}) + '\n'):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as tmp:
                home = self.make_home(tmp)
                rollout = next((home / '.codex/sessions').rglob('rollout-fixture.jsonl'))
                rollout.write_text(content)
                with self.assertRaisesRegex(RuntimeError, 'header invalid'):
                    backup.backup_profile(home, Path(tmp).resolve() / 'private', check_writers=lambda _home: None)


    def test_stable_sqlite_wal_is_copied_without_discarding_committed_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve(); home = self.make_home(tmp); db = home / '.codex/state_5.sqlite'
            con = sqlite3.connect(db)
            try:
                con.execute('PRAGMA journal_mode=WAL')
                con.execute('PRAGMA wal_autocheckpoint=0')
                con.execute('INSERT INTO rows VALUES (?)', ('wal-fixture',)); con.commit()
                self.assertGreater(Path(str(db) + '-wal').stat().st_size, 0)
                dest = base / 'private'
                backup.backup_profile(home, dest, check_writers=lambda _home: None)
                copied = sqlite3.connect(dest / 'data/.codex/state_5.sqlite')
                try: self.assertIn(('wal-fixture',), copied.execute('SELECT x FROM rows').fetchall())
                finally: copied.close()
            finally: con.close()

    def test_backup_does_not_modify_protected_sqlite_sidecars(self):
        # A stopped process can leave committed WAL and SHM files behind. A
        # backup must include that transaction without changing the live tree:
        # deploy.Host.protected compares it around backup before publishing code.
        deploy_spec = importlib.util.spec_from_file_location('profile_backup_deploy', Path(__file__).with_name('deploy.py'))
        deploy = importlib.util.module_from_spec(deploy_spec); deploy_spec.loader.exec_module(deploy)
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve(); home = self.make_home(tmp)
            db = home / '.msb/bots/default/projects/fixture/project.sqlite'
            db.parent.mkdir(parents=True)
            script = ("import os,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                      "c.execute('PRAGMA journal_mode=WAL'); c.execute('PRAGMA wal_autocheckpoint=0'); "
                      "c.execute('CREATE TABLE items(value TEXT)'); "
                      "c.execute(\"INSERT INTO items VALUES ('synthetic')\"); c.commit(); os._exit(0)")
            subprocess.run([sys.executable, '-c', script, str(db)], check=True)
            wal, shm = Path(str(db) + '-wal'), Path(str(db) + '-shm')
            self.assertGreater(wal.stat().st_size, 0)
            self.assertTrue(shm.is_file())
            host = deploy.Host(home); before = host.protected(); dest = base / 'private'
            backup.backup_profile(home, dest, check_writers=lambda _home: None)
            self.assertEqual(host.protected(), before, 'Backup must not mutate protected data or SQLite sidecars')
            self.assertFalse(list(dest.rglob('.sqlite-input-*')), 'Temporary SQLite inputs must be removed')
            copied = sqlite3.connect(dest / 'data' / db.relative_to(home))
            try:
                self.assertEqual(copied.execute('PRAGMA quick_check').fetchone(), ('ok',))
                self.assertEqual(copied.execute('SELECT value FROM items').fetchall(), [('synthetic',)])
            finally: copied.close()

    def test_hot_rollback_journal_fails_closed_without_recovering_live_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve(); db = base / 'fixture.sqlite'; dest = base / 'copy.sqlite'
            con = sqlite3.connect(db)
            try:
                con.execute('PRAGMA journal_mode=DELETE')
                con.execute('CREATE TABLE records(value TEXT)')
                con.executemany('INSERT INTO records VALUES (?)', [('old-' + str(i) + 'x' * 2000,) for i in range(1500)])
                con.commit()
            finally: con.close()
            script = ("import os,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                      "c.execute('PRAGMA journal_mode=DELETE'); c.execute('PRAGMA synchronous=FULL'); "
                      "c.execute('PRAGMA cache_size=10'); c.execute('PRAGMA cache_spill=ON'); "
                      "c.execute('BEGIN IMMEDIATE'); c.execute(\"UPDATE records SET value='new'\"); os._exit(0)")
            subprocess.run([sys.executable, '-c', script, str(db)], check=True)
            journal = Path(str(db) + '-journal')
            self.assertGreater(journal.stat().st_size, 0)
            before = (backup.fingerprint(db), backup.fingerprint(journal))
            with self.assertRaises(sqlite3.DatabaseError):
                backup.copy_sqlite(db, dest, backup.facts(db))
            self.assertEqual((backup.fingerprint(db), backup.fingerprint(journal)), before)
            self.assertFalse(list(base.rglob('.sqlite-input-*')))

    def test_sqlite_sidecar_creation_is_allowed_but_user_file_changes_are_not(self):
        before = {'dir': {'type':'directory', 'mode': 0o700, 'mtime_ns': 1, 'ctime_ns': 1},
                  'dir/db.sqlite': {'type':'file', 'size': 10}, 'dir/db.sqlite-wal': None,
                  'dir/db.sqlite-shm': None, 'dir/data': {'type':'file', 'size': 2}}
        after = dict(before)
        after['dir'] = {**before['dir'], 'mtime_ns': 2, 'ctime_ns': 2}
        after['dir/db.sqlite-wal'] = {'type':'file', 'size': 0}
        after['dir/db.sqlite-shm'] = {'type':'file', 'size': 32768}
        self.assertTrue(backup.inventories_match(before, after, {'dir/db.sqlite'}))
        after['dir/db.sqlite-wal'] = after['dir/db.sqlite-shm'] = None
        self.assertTrue(backup.inventories_match(before, after, {'dir/db.sqlite'}))
        after['dir/data'] = {'type':'file', 'size': 3}
        self.assertFalse(backup.inventories_match(before, after, {'dir/db.sqlite'}))

    def test_changed_nonempty_sqlite_wal_cannot_be_published(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve(); home = self.make_home(tmp); dest = base / 'private'
            original = backup.sqlite_journal_state
            calls = 0
            def simulate_change(*args):
                nonlocal calls
                value = original(*args); calls += 1
                if calls == 2: value['.codex/state_5.sqlite-wal'] = (7, 'changed-fixture')
                return value
            with patch.object(backup, 'sqlite_journal_state', side_effect=simulate_change):
                with self.assertRaisesRegex(RuntimeError, 'journal changed'):
                    backup.backup_profile(home, dest, check_writers=lambda _home: None)
            self.assertFalse((dest / 'COMPLETE.json').exists())


if __name__ == '__main__':
    unittest.main()
