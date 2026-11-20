"""Synthetic-only session checks; no network or real user profile."""
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import profile_backup
from profile_backup import assert_active_session_matches

ID = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'


class SessionCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.home, self.backup = base / 'client', base / 'backup'
        profile = self.home / '.msb/bots/default'
        self.sessions = self.home / '.codex/sessions/fixture'
        for folder in (profile, self.sessions, self.home / 'workspace'):
            folder.mkdir(parents=True)
        (profile / '.env').write_text('synthetic')
        self.state = profile / 'state.json'
        self.state.write_text(json.dumps({'extAuthBypass': 'codex', 'ccSessionId': 'ext:codex:' + ID}))
        (self.home / '.codex/auth.json').write_text('{}')
        (self.home / '.codex/config.toml').write_text('')
        self.rollout = self.sessions / 'fixture.jsonl'
        self.write_rollout(self.rollout, ID)
        self.db = self.home / '.codex/state_5.sqlite'
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute('CREATE TABLE threads (id TEXT, rollout_path TEXT)')
            conn.execute('INSERT INTO threads VALUES (?, ?)', (ID, str(self.rollout)))
        for name in ('thread_history_1.sqlite', 'goals_1.sqlite', 'memories_1.sqlite'):
            with closing(sqlite3.connect(self.home / '.codex' / name)) as conn, conn:
                conn.execute('CREATE TABLE fixture (value TEXT)')
        profile_backup.backup_profile(self.home, self.backup, check_writers=lambda _: None)

    @staticmethod
    def write_rollout(path, session):
        path.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': session}}) + '\n')

    def check(self):
        return assert_active_session_matches(self.home, self.backup)

    def fails(self):
        with self.assertRaisesRegex(RuntimeError, '^Active Codex session verification failed$'):
            self.check()

    def test_matching_session_and_sealed_backup(self):
        self.assertIsNone(self.check())

    def test_changed_id_with_other_valid_live_session(self):
        other = self.sessions / 'other.jsonl'
        self.write_rollout(other, OTHER)
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute('INSERT INTO threads VALUES (?, ?)', (OTHER, str(other)))
        self.state.write_text(json.dumps({'extAuthBypass': 'codex', 'ccSessionId': 'ext:codex:' + OTHER}))
        self.fails()

    def test_changed_rollout_path_with_valid_header(self):
        other = self.sessions / 'moved.jsonl'
        self.write_rollout(other, ID)
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute('UPDATE threads SET rollout_path=? WHERE id=?', (str(other), ID))
        self.fails()

    def test_corrupt_backup_and_missing_seal(self):
        marker = self.backup / 'COMPLETE.json'
        sealed = marker.read_bytes()
        marker.unlink()
        self.fails()
        marker.write_bytes(sealed)
        (self.backup / 'data/.codex/config.toml').write_text('changed')
        self.fails()

    def test_committed_wal_is_visible_without_altering_db_or_wal(self):
        conn = sqlite3.connect(self.db)
        try:
            self.assertEqual(conn.execute('PRAGMA journal_mode=WAL').fetchone()[0], 'wal')
            conn.execute('PRAGMA wal_autocheckpoint=0')
            other = self.sessions / 'wal-moved.jsonl'
            self.write_rollout(other, ID)
            conn.execute('UPDATE threads SET rollout_path=? WHERE id=?', (str(other), ID))
            conn.commit()
            wal = Path(str(self.db) + '-wal')
            self.assertGreater(wal.stat().st_size, 0)
            before = self.db.read_bytes(), wal.read_bytes()
            self.fails()
            self.assertEqual((self.db.read_bytes(), wal.read_bytes()), before)
            conn.execute('UPDATE threads SET rollout_path=? WHERE id=?', (str(self.rollout), ID))
            conn.commit()
            self.assertIsNone(self.check())
        finally:
            conn.close()


if __name__ == '__main__':
    unittest.main()
