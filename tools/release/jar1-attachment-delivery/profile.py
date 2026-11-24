"""Narrow bot profile guard: no projects, unrelated sessions, or Atoll databases.

The legacy backup implementation supplies atomic copies and SQLite/WAL validation;
this module supplies a closed set of bot-owned files and exactly one active rollout.
No user contents or session identity are returned to stdout.
"""
import json
import os
from pathlib import Path
import re
import stat

STATIC = ('.msb/bots/default/state.json', '.msb/bots/default/.env',
          '.msb/bots/default/ext-providers.json', '.msb/.env',
          '.codex/auth.json', '.codex/config.toml')
REQUIRED = set(STATIC) - {'.msb/.env'}
INDEX = '.codex/state_5.sqlite'


def find_active(home, base):
    """Select exactly one ordinary rollout via active state and its header."""
    try:
        home = Path(home).resolve(strict=True)
        state_file = base.safe_file(home, STATIC[0])
        state = json.loads(state_file.read_text())
        if state.get('extAuthBypass') != 'codex': raise ValueError('inactive provider')
        found = re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
                          str(state.get('ccSessionId') or ''), re.I)
        if not found: raise ValueError('no session')
        identity = found.group(0).lower()
        root = home / '.codex/sessions'
        if root.is_symlink() or not root.is_dir(): raise ValueError('invalid sessions root')
        candidates = []
        for directory, dirs, names in os.walk(root, followlinks=False):
            dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
            for name in names:
                if name.lower().endswith('-' + identity + '.jsonl'):
                    candidates.append(Path(directory) / name)
        if len(candidates) != 1: raise ValueError('ambiguous session')
        relative = candidates[0].relative_to(home).as_posix()
        target = base.safe_file(home, relative)
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode): raise ValueError('invalid rollout')
            with os.fdopen(fd, 'rb', closefd=False) as stream: first = stream.readline(8 * 1024 * 1024)
        finally: os.close(fd)
        if not first.endswith(b'\n'): raise ValueError('invalid header')
        meta = json.loads(first)
        if meta.get('type') != 'session_meta' or str(meta.get('payload', {}).get('id', '')).lower() != identity:
            raise ValueError('session mismatch')
        return identity, relative
    except Exception:
        raise RuntimeError('Active Codex session cannot be verified') from None


def protected(home, base):
    """Hash only the explicit scope; missing optional files are represented."""
    home = Path(home).resolve(strict=True)
    _, rollout = find_active(home, base)
    result = {}
    paths = (*STATIC, INDEX, INDEX + '-wal', INDEX + '-journal', rollout)
    required = REQUIRED | {INDEX, rollout}
    for relative in paths:
        target = base.safe_file(home, relative, allow_absent=relative not in required)
        result[relative] = base.info(target) if os.path.lexists(target) else None
    return result


def configured(audit, base, home):
    """Constrain the reusable backup code without changing its other users."""
    home = Path(home).resolve(strict=True)
    _, rollout = find_active(home, base)
    audit.ROOTS = ()
    audit.FILES = (*STATIC, rollout)
    audit.DATABASES = (INDEX,)
    original = audit.active_session
    def active_session(original_home, root):
        if Path(root).resolve() == Path(original_home).resolve():
            return find_active(original_home, base)
        return original(original_home, root)
    def validate_inventory(original_home, inventory):
        for rel in REQUIRED | {INDEX, rollout}:
            item = inventory.get(rel)
            if not item or item.get('type') != 'file': raise RuntimeError('Required bot profile entry missing')
        for rel, item in inventory.items():
            if item and item.get('type') == 'symlink': raise RuntimeError('Unexpected profile symlink')
            if item and item.get('type') == 'file': base.safe_file(original_home, rel)
    audit.active_session = active_session
    audit.validate_inventory = validate_inventory
    return audit
