#!/usr/bin/env python3
"""Package only immutable release inputs, not test output or local dependency links."""
import argparse
from pathlib import Path
import tarfile
from manifest import validate_release, validate_test_snapshot


def pack(stage, output):
    stage, output = Path(stage).resolve(), Path(output).resolve()
    release, _ = validate_release(stage)
    validate_test_snapshot(stage, release)
    if output.is_relative_to(stage) or output.exists():
        raise ValueError('Archive must be a new path outside the stage')
    roots = ['runtime', 'ops', 'release.json', 'checks/source', 'checks/source-inventory.json']
    with tarfile.open(output, 'w:gz', dereference=False) as archive:
        def safe(info):
            if 'node_modules' in Path(info.name).parts or '__pycache__' in Path(info.name).parts:
                return None
            info.uid = info.gid = 0
            info.uname = info.gname = 'root'
            return info
        for root in roots:
            archive.add(stage / root, arcname=root, filter=safe)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    pack(args.stage, args.output)
