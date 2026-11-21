#!/usr/bin/env python3
"""Use the existing guarded Pult transaction with the cache-breakdown file set."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat

FILES = ('src/collector/sources/codex-usage-data.ts', 'src/collector/sources/codex-usage.ts',
         'src/shared/types.ts', 'src/ui/view-bot-usage.js', 'src/ui/app.css')


def trusted_file(stage, name):
    fd = os.open(stage / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Untrusted operator input')
        with os.fdopen(fd, 'rb', closefd=False) as stream: return stream.read()
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--stage', required=True)
    parser.add_argument('--manifest-sha', required=True)
    args, _ = parser.parse_known_args()
    stage = Path(args.stage).absolute()
    st = stage.lstat()
    if os.geteuid() != 0 or stage.parent != Path('/var/tmp') or stage.is_symlink() or \
       not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022 or \
       Path(__file__).resolve(strict=True) != stage / 'pult-deploy.py':
        raise RuntimeError('Unexpected Pult deployment context')
    manifest_data = trusted_file(stage, 'manifest.json')
    if hashlib.sha256(manifest_data).hexdigest() != args.manifest_sha: raise RuntimeError('Manifest mismatch')
    manifest = json.loads(manifest_data)
    if hashlib.sha256(trusted_file(stage, 'pult_base.py')).hexdigest() != manifest['pult_base_sha256']:
        raise RuntimeError('Pult transaction changed')
    spec = importlib.util.spec_from_file_location('cache_pult_transaction', stage / 'pult_base.py')
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    base.FILES = FILES
    # The shared operator validates the public entry point and manifest hashes.
    base.__file__ = str(stage / 'pult-deploy.py')
    base.main()


if __name__ == '__main__': main()
