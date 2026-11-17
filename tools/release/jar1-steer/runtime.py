"""Fingerprint installed Node and the dependency versions required by the lock."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys


def runtime_info(lock_file, dependencies):
    lock = json.loads(Path(lock_file).read_text())
    dependencies = Path(dependencies).resolve()
    versions, differences = {}, []
    for name, item in lock['packages'].items():
        if not name: continue
        if not name.startswith('node_modules/') or '..' in Path(name).parts:
            raise ValueError('Unexpected package lock entry')
        package = dependencies / name.removeprefix('node_modules/') / 'package.json'
        value = json.loads(package.read_text()).get('version') if package.is_file() else None
        versions[name] = value
        if value is None and not item.get('optional'):
            differences.append(name + ': missing')
        elif value is not None and value != item.get('version'):
            differences.append(name + ': version mismatch')
    if differences:
        raise ValueError('; '.join(differences))
    node_path = shutil.which('node', path='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
    if not node_path: raise ValueError('Node executable missing')
    node_path = Path(node_path).resolve()
    node = subprocess.check_output([str(node_path), '--version'], text=True, timeout=15).strip()
    files = []
    for base, dirs, names in os.walk(dependencies, followlinks=False):
        dirs.sort(); names.sort()
        for name in list(dirs) + names:
            file = Path(base) / name
            relative = file.relative_to(dependencies).as_posix()
            st = file.lstat()
            if stat.S_ISLNK(st.st_mode):
                resolved = file.resolve()
                if not resolved.is_relative_to(dependencies):
                    raise ValueError('Dependency link escapes its root: ' + relative)
                files.append([relative, 'link', os.readlink(file)])
                if name in dirs: dirs.remove(name)
            elif stat.S_ISREG(st.st_mode):
                files.append([relative, 'file', hashlib.sha256(file.read_bytes()).hexdigest(), stat.S_IMODE(st.st_mode)])
            elif not stat.S_ISDIR(st.st_mode):
                raise ValueError('Unexpected dependency entry: ' + relative)
    return {'platform': sys.platform, 'machine': platform.machine(), 'python': platform.python_version(),
            'node': node, 'node_sha256': hashlib.sha256(node_path.read_bytes()).hexdigest(),
            'packages': len(versions), 'dependency_versions_sha256': hashlib.sha256(
                json.dumps(versions, sort_keys=True).encode()).hexdigest(),
            'dependency_tree_sha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()}
