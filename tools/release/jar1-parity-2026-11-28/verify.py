#!/usr/bin/env python3
"""Verify the selected fixes inside the accepted JAR1 proof launcher."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True

REQUIRED_CORE = tuple('.msb/bot/tests/' + name + '.test.mjs' for name in (
    'forwarded-photos', 'monitor-digest-delivery', 'monitor-telegram-posts',
    'monitor-telegram-repair', 'notification-settings', 'pause-reminder-notice',
    'response-delivery',
))


def load(stage, name):
    spec = importlib.util.spec_from_file_location('parity_' + name, stage / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_artifact(stage, manifest, builder):
    if (manifest.get('schema'), manifest.get('scope'), manifest.get('base_commit'),
            manifest.get('prior_sha256')) != (1, builder.SCOPE, builder.BASE_COMMIT, builder.BASE_MANIFEST):
        raise ValueError('Unexpected parity release identity')
    baseline, support = builder.installed_inventory((stage / 'prior.json').read_bytes())
    if manifest.get('baseline_inventory') != baseline or manifest.get('support_files') != support:
        raise ValueError('Unexpected installed inventory')
    before = {(row['root'], row['relative']): row['sha256'] for row in baseline}
    expected = []
    for name in builder.FILES:
        source = builder.source_path('bot', name)
        after = builder.sha((stage / 'payload/bot' / name).read_bytes())
        expected.append({'root': 'bot', 'relative': name, 'source': source,
                         'before_sha256': before.get(('bot', name)), 'after_sha256': after})
    if manifest.get('files') != expected:
        raise ValueError('Unexpected selected payload')
    for name, source in builder.TOOLS.items():
        content = (stage / name).read_bytes()
        if (builder.sha(content) != manifest.get(name.removesuffix('.py') + '_sha256')
                or content != (stage / 'source' / source).read_bytes()):
            raise ValueError('Operator tool differs from archived source')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True, type=Path)
    parser.add_argument('--home', required=True)
    parser.add_argument('--tmp-dir', required=True)
    parser.add_argument('--host-netns-inode', type=int, required=True)
    parser.add_argument('--dependencies', required=True)
    args = parser.parse_args()
    try:
        stage = args.stage.resolve()
        manifest = json.loads((stage / 'manifest.json').read_bytes())
        builder = load(stage, 'build')
        verify_artifact(stage, manifest, builder)
        ux = load(stage, 'verify_ux')
    except (KeyError, OSError, ValueError) as error:
        parser.exit(1, f'Parity artifact preflight failed ({type(error).__name__})\n')
    try:
        proof = ux.verify(stage, args.home, args.tmp_dir, args.host_netns_inode, args.dependencies,
                          scope=builder.SCOPE, required_core=REQUIRED_CORE,
                          extra_release_suite=builder.ROOT)
        verify_artifact(stage, manifest, builder)
    except ux.VerificationError as error:
        parser.exit(1, str(error) + '\n')
    except Exception as error:
        parser.exit(1, f'Parity verification failed ({type(error).__name__})\n')
    print(json.dumps(proof), flush=True)


if __name__ == '__main__':
    main()
