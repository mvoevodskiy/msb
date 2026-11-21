"""Closed, verified snapshot of the active bot profile and Codex session data.

Called only after the bot is stopped. [Deployment](deploy.py) owns code rollback;
this snapshot never restores user data automatically. [Checks](test_profile_backup.py).
"""
import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import stat
import tempfile
import time
from urllib.parse import quote

ROOTS = ('.msb/bots/default', '.msb/autonomy', '.msb/monitor', '.codex/sessions')
FILES = ('.msb/.env', '.codex/auth.json', '.codex/config.toml',
         'workspace/SOUL.md', 'workspace/USER.md', 'workspace/MEMORY.md',
         'workspace/MISSION.md', 'workspace/GOALS.md', 'workspace/PROJECTS.md',
         'workspace/PREFERENCES.md', 'workspace/LEARNED.md', 'workspace/AGENTS.md',
         'workspace/CLAUDE.md', 'workspace/.iia-bootstrapped')
DATABASES = ('.codex/state_5.sqlite', '.codex/thread_history_1.sqlite',
             '.codex/goals_1.sqlite', '.codex/memories_1.sqlite')


def fingerprint(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def facts(path):
    st = path.lstat()
    return {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size,
            'mtime_ns': st.st_mtime_ns, 'ctime_ns': st.st_ctime_ns,
            'uid': st.st_uid, 'gid': st.st_gid, 'mode': stat.S_IMODE(st.st_mode)}


def snapshot_inventory(home):
    home = Path(home)
    items = {}
    def add(path):
        rel = path.relative_to(home).as_posix()
        try: st = path.lstat()
        except FileNotFoundError:
            items[rel] = None
            return
        if stat.S_ISLNK(st.st_mode):
            items[rel] = {'type': 'symlink', 'target': os.readlink(path), **facts(path)}
        elif stat.S_ISREG(st.st_mode):
            items[rel] = {'type': 'file', **facts(path)}
        elif stat.S_ISDIR(st.st_mode):
            items[rel] = {'type': 'directory', **facts(path)}
        else: raise RuntimeError('Unsupported profile entry')
    for rel in ROOTS:
        root = home / rel
        add(root)
        if root.is_symlink(): raise RuntimeError('Unexpected profile root')
        if not root.exists(): continue
        if not root.is_dir(): raise RuntimeError('Unexpected profile root')
        for base, directories, names in os.walk(root, followlinks=False):
            directories.sort(); names.sort()
            for name in directories + names:
                entry = Path(base) / name
                add(entry)
            directories[:] = [name for name in directories if not (Path(base) / name).is_symlink()]
    for rel in FILES + DATABASES: add(home / rel)
    for rel in DATABASES:
        for suffix in ('-wal', '-shm', '-journal'): add(home / (rel + suffix))
    return items


def no_open_writers(home, proc=Path('/proc')):
    """Reject currently open writable FDs under the profile; no cmdlines are read."""
    home = Path(home)
    protected = [str(home / rel) for rel in ROOTS]
    protected += [str(home / rel) for rel in FILES + DATABASES]
    protected += [str(home / rel) + suffix for rel in DATABASES for suffix in ('-wal', '-shm', '-journal')]
    for process in Path(proc).iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid(): continue
        fdroot = process / 'fd'
        try: entries = list(fdroot.iterdir())
        except (FileNotFoundError, ProcessLookupError): continue
        except PermissionError as exc: raise RuntimeError('Cannot inspect open profile writers') from exc
        for fd in entries:
            try: target = os.readlink(fd).removesuffix(' (deleted)')
            except (FileNotFoundError, ProcessLookupError): continue
            except PermissionError as exc: raise RuntimeError('Cannot inspect open profile writers') from exc
            if not any(target == p or target.startswith(p + '/') for p in protected): continue
            try:
                fields = (process / 'fdinfo' / fd.name).read_text().splitlines()
                flags = next(int(row.split(':', 1)[1].strip(), 8) for row in fields if row.startswith('flags:'))
            except (FileNotFoundError, ProcessLookupError): continue
            except (PermissionError, StopIteration, ValueError) as exc:
                raise RuntimeError('Cannot inspect profile descriptor') from exc
            if flags & os.O_ACCMODE != os.O_RDONLY:
                raise RuntimeError('A separate process has a writable profile descriptor')


def copy_regular(source, dest, expected):
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_dev != expected['dev'] or before.st_ino != expected['ino']:
            raise RuntimeError('Profile source changed')
        h = hashlib.sha256()
        with os.fdopen(fd, 'rb', closefd=False) as src, dest.open('xb') as dst:
            os.fchmod(dst.fileno(), 0o600)
            for data in iter(lambda: src.read(1024 * 1024), b''):
                h.update(data); dst.write(data)
            dst.flush(); os.fsync(dst.fileno())
        after = os.fstat(fd)
        for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns'):
            if getattr(before, key) != getattr(after, key): raise RuntimeError('Profile source changed while copying')
    finally: os.close(fd)
    if facts(source) != {k: expected[k] for k in ('dev','ino','size','mtime_ns','ctime_ns','uid','gid','mode')}:
        raise RuntimeError('Profile source changed after copying')
    if fingerprint(dest) != h.hexdigest(): raise RuntimeError('Profile copy failed verification')
    return h.hexdigest()


def copy_sqlite(source, dest, expected, timeout=30):
    """Back up a stable DB and journal using private input copies, not live SHM.

    The outer backup guards against writers and rechecks the source inventory
    and durable journal. SQLite may rewrite its SHM even in read-only mode, so
    it must reconstruct that coordination file beside the temporary copy.
    """
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='.sqlite-input-', dir=dest.parent) as tmp:
        staged = Path(tmp) / source.name
        copy_regular(source, staged, expected)
        for suffix in ('-wal', '-journal'):
            sidecar = Path(str(source) + suffix)
            try: sidecar_facts = facts(sidecar)
            except FileNotFoundError: continue
            copy_regular(sidecar, Path(str(staged) + suffix), sidecar_facts)
        # The staged directory is private and writable, allowing SQLite to
        # rebuild its wal-index without changing a sidecar in the live profile.
        # Keep read-only mode: a hot rollback journal must fail closed rather
        # than recover and potentially follow an external super-journal path.
        uri = 'file:' + quote(str(staged), safe='/') + '?mode=ro'
        deadline = time.monotonic() + timeout
        src = sqlite3.connect(uri, uri=True, timeout=2)
        try:
            dst = sqlite3.connect(dest)
            try:
                os.chmod(dest, 0o600)
                def progress(_status, _remaining, _total):
                    if time.monotonic() > deadline: raise TimeoutError('SQLite backup timed out')
                src.backup(dst, pages=128, progress=progress, sleep=0.05)
                # The private copy must stand alone even when the source uses WAL.
                if dst.execute('PRAGMA journal_mode=DELETE').fetchone()[0].lower() != 'delete':
                    raise RuntimeError('Could not seal SQLite snapshot')
            finally: dst.close()
        finally: src.close()
    check = sqlite3.connect('file:' + quote(str(dest), safe='/') + '?mode=ro', uri=True)
    try:
        if check.execute('PRAGMA quick_check').fetchall() != [('ok',)]: raise RuntimeError('SQLite snapshot failed integrity check')
    finally: check.close()
    if facts(source) != {k: expected[k] for k in ('dev','ino','size','mtime_ns','ctime_ns','uid','gid','mode')}:
        raise RuntimeError('SQLite source changed while copying')
    with dest.open('rb') as stream: os.fsync(stream.fileno())
    return fingerprint(dest)



def validate_inventory(home, inventory):
    required = ('.msb/bots/default/state.json', '.msb/bots/default/.env',
                '.codex/auth.json', '.codex/config.toml', *DATABASES)
    for rel in required:
        item = inventory.get(rel)
        if not item or item['type'] != 'file': raise RuntimeError('Required profile entry missing')
    for rel in ('.msb/bots/default', '.codex/sessions'):
        item = inventory.get(rel)
        if not item or item['type'] != 'directory': raise RuntimeError('Required profile directory missing')
    for rel, item in inventory.items():
        if not item or item['type'] != 'symlink': continue
        link = home / rel
        try:
            target = link.resolve(strict=True)
            target_rel = target.relative_to(home).as_posix()
        except (FileNotFoundError, ValueError, RuntimeError) as exc:
            raise RuntimeError('Profile symlink target is absent or outside home') from exc
        captured = inventory.get(target_rel)
        if not captured or captured['type'] not in ('file', 'directory'):
            raise RuntimeError('Profile symlink target is outside snapshot')


def active_session(home, root):
    state = json.loads((root / '.msb/bots/default/state.json').read_text())
    if state.get('extAuthBypass') != 'codex': raise RuntimeError('Codex is not the active provider')
    match = re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
                      str(state.get('ccSessionId') or ''), re.I)
    if not match: raise RuntimeError('Active Codex session is absent')
    session_id = match.group(0)
    db = root / '.codex/state_5.sqlite'
    con = sqlite3.connect('file:' + quote(str(db), safe='/') + '?mode=ro', uri=True)
    try:
        rows = con.execute('SELECT rollout_path FROM threads WHERE id=?', (session_id,)).fetchall()
    finally: con.close()
    if len(rows) != 1: raise RuntimeError('Active Codex session is not unique in native index')
    try:
        rollout = Path(rows[0][0])
        rel = rollout.relative_to(home)
        rel.relative_to('.codex/sessions')
    except (ValueError, TypeError): raise RuntimeError('Native session is outside snapshot')
    file = root / rel
    if file.is_symlink() or not file.is_file(): raise RuntimeError('Native session rollout missing')
    try:
        with file.open('rb') as stream: header = stream.readline(8 * 1024 * 1024)
        if not header.endswith(b'\n'): raise ValueError('Incomplete header')
        meta = json.loads(header)
        if meta.get('type') != 'session_meta' or meta.get('payload', {}).get('id') != session_id:
            raise ValueError('Mismatched session')
    except (ValueError, UnicodeError, AttributeError) as exc:
        raise RuntimeError('Native session header invalid') from exc
    return session_id, rel.as_posix()


def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def verify_copy(destination, home, expected_session, require_complete=False):
    record = destination / 'manifest.json'
    if require_complete:
        marker = json.loads((destination / 'COMPLETE.json').read_text())
        if marker != {'manifest_sha256': fingerprint(record)}: raise RuntimeError('Profile marker mismatch')
    manifest = json.loads(record.read_text())
    data = destination / 'data'
    expected = {rel for rel, entry in manifest.items() if entry and entry.get('backup_sha256')}
    actual = {p.relative_to(data).as_posix() for p in data.rglob('*') if p.is_file()} if data.exists() else set()
    if actual != expected: raise RuntimeError('Unexpected profile backup contents')
    for rel in expected:
        file = data / rel
        if file.is_symlink() or fingerprint(file) != manifest[rel]['backup_sha256']:
            raise RuntimeError('Profile backup changed after publication')
        if manifest[rel]['sqlite']:
            check = sqlite3.connect('file:' + quote(str(file), safe='/') + '?mode=ro', uri=True)
            try:
                if check.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                    raise RuntimeError('SQLite snapshot failed integrity check')
            finally: check.close()
    if active_session(home, data) != expected_session: raise RuntimeError('Copied active session does not match')
    return len(expected)


def database_names(inventory):
    return set(DATABASES) | {rel for rel, entry in inventory.items()
        if entry and entry.get('type') == 'file' and rel.endswith(('.sqlite', '.db'))
        and not rel.endswith('.lock.sqlite')}


def sqlite_journal_state(home, databases):
    """Compare durable WAL/journal bytes; absent and empty sidecars are equivalent."""
    result = {}
    for rel in sorted(databases):
        for suffix in ('-wal', '-journal'):
            path = home / (rel + suffix)
            try: fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            except FileNotFoundError:
                result[rel + suffix] = None
                continue
            try:
                first = os.fstat(fd)
                if not stat.S_ISREG(first.st_mode): raise RuntimeError('Unexpected SQLite journal')
                digest = hashlib.sha256()
                with os.fdopen(fd, 'rb', closefd=False) as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
                last = os.fstat(fd)
                if any(getattr(first, key) != getattr(last, key) for key in
                       ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
                    raise RuntimeError('SQLite journal changed while reading')
                result[rel + suffix] = (first.st_size, digest.hexdigest()) if first.st_size else None
            finally: os.close(fd)
    return result


def inventories_match(before, after, databases):
    sidecars = {rel + suffix for rel in databases for suffix in ('-wal', '-shm', '-journal')}
    # A sidecar may appear and disappear entirely between inventories.
    # Still compare all directory members and their contents below.
    changed_dirs = {str(Path(rel).parent) for rel in databases}
    if (set(before) - sidecars) != (set(after) - sidecars): return False
    for rel in set(before) - sidecars:
        left, right = before[rel], after[rel]
        if rel in changed_dirs and left and right and left.get('type') == right.get('type') == 'directory':
            left = {k: v for k, v in left.items() if k not in ('mtime_ns', 'ctime_ns')}
            right = {k: v for k, v in right.items() if k not in ('mtime_ns', 'ctime_ns')}
        if left != right: return False
    return True

def backup_profile(home, destination, check_writers=no_open_writers):
    home, destination = Path(home).resolve(), Path(destination).absolute()
    parent = destination.parent
    if parent.resolve() != parent or not parent.is_dir() or parent.is_symlink():
        raise RuntimeError('Unsafe profile backup parent')
    info = parent.stat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError('Profile backup parent is not private')
    if destination.exists() or destination.is_symlink(): raise RuntimeError('Profile backup already exists')
    check_writers(home)
    before = snapshot_inventory(home)
    validate_inventory(home, before)
    databases = database_names(before)
    journals = sqlite_journal_state(home, databases)
    session = active_session(home, home)
    destination.mkdir(mode=0o700)
    manifest = {}
    for rel, entry in sorted(before.items()):
        if entry is None or entry['type'] != 'file':
            manifest[rel] = entry
            continue
        # Locks/sidecars are runtime coordination, never restored as user data.
        if rel.endswith(('.lock.sqlite', '-wal', '-shm', '-journal')):
            manifest[rel] = {'type': 'excluded-lock'}
            continue
        source = home / rel
        if source.resolve() != source.absolute(): raise RuntimeError('Symlink in profile source path')
        output = destination / 'data' / rel
        database = rel in DATABASES or rel.endswith(('.sqlite', '.db'))
        digest = copy_sqlite(source, output, entry) if database else copy_regular(source, output, entry)
        manifest[rel] = {**entry, 'backup_sha256': digest, 'sqlite': database}
    check_writers(home)
    after = snapshot_inventory(home)
    if not inventories_match(before, after, databases) or sqlite_journal_state(home, databases) != journals:
        raise RuntimeError('Profile inventory or SQLite journal changed during backup')
    record = destination / 'manifest.json'
    with record.open('x') as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(json.dumps(manifest, sort_keys=True, indent=2) + '\n'); f.flush(); os.fsync(f.fileno())
    count = verify_copy(destination, home, session)
    for directory in sorted((p for p in destination.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        os.chmod(directory, 0o700)
        sync_dir(directory)
    sync_dir(destination)
    marker = destination / 'COMPLETE.json'
    with marker.open('x') as f:
        os.fchmod(f.fileno(), 0o600)
        json.dump({'manifest_sha256': fingerprint(record)}, f)
        f.write('\n'); f.flush(); os.fsync(f.fileno())
    sync_dir(destination)
    sync_dir(destination.parent)
    verify_copy(destination, home, session, require_complete=True)
    return {'entries': len(manifest), 'files': count}


def assert_active_session_matches(home, backup_profile_dir):
    """Raise a sanitized RuntimeError unless sealed backup and live session match."""
    try:
        home = Path(home).resolve(strict=True)
        backup = Path(backup_profile_dir).resolve(strict=True)
        saved = active_session(home, backup / 'data')
        verify_copy(backup, home, saved, require_complete=True)
        live = active_session(home, home)
        if live != saved:
            raise ValueError('session mismatch')
    except Exception:
        raise RuntimeError('Active Codex session verification failed') from None
