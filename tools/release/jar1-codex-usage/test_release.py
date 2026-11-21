"""Focused checks for source binding and interrupted Pult code recovery."""
import hashlib
import base64
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
OLD = HERE.parent / 'jar1-audit-2026-11-20' / 'deploy.py'


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class ReleaseTests(unittest.TestCase):
    def test_recovery_refuses_to_replace_code_if_collector_did_not_stop(self):
        pult = module('pult_usage_stop_test', HERE / 'pult-deploy.py')
        def command(*args):
            if 'ActiveState' in args: return 'active'
            if 'MainPID' in args: return '123'
            return ''
        with patch.object(pult, 'command', side_effect=command), \
             self.assertRaisesRegex(RuntimeError, 'did not stop'):
            pult.stop_collector()

    def test_payload_cannot_differ_from_tested_pult_source(self):
        verify = module('usage_verify_test', HERE / 'verify.py')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / 'source'; composite = root / 'composite'
            (source / '.msb/pult/src').mkdir(parents=True)
            (root / 'payload/pult/src').mkdir(parents=True)
            (source / '.msb/pult/src/a.ts').write_text('tested')
            (root / 'payload/pult/src/a.ts').write_text('different')
            digest = hashlib.sha256(b'different').hexdigest()
            manifest = {'files': [], 'pult_files': [{'source': '.msb/pult/src/a.ts',
                        'relative': 'src/a.ts', 'after_sha256': digest}]}
            with self.assertRaisesRegex(RuntimeError, 'Tested Pult source differs'):
                verify.verify_payload_source(root, source, composite, manifest)

    def test_binary_must_match_the_pinned_package_even_with_a_changed_manifest(self):
        verify = module('usage_verify_binary_test', HERE / 'verify.py')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with tarfile.open(root / 'ccusage.tgz', 'w:gz') as archive:
                member = tarfile.TarInfo('package/bin/ccusage'); member.size = len(b'original')
                archive.addfile(member, io.BytesIO(b'original'))
            (root / 'ccusage').write_bytes(b'different')
            pinned = base64.b64encode(hashlib.sha512((root / 'ccusage.tgz').read_bytes()).digest()).decode()
            manifest = {'ccusage_archive_sha512': pinned, 'ccusage_binary_sha256': hashlib.sha256(b'different').hexdigest()}
            with patch.object(verify, 'CCUSAGE_SHA512', pinned), self.assertRaisesRegex(RuntimeError, 'does not match'):
                verify.verify_dependency(root, manifest)

    def test_partial_pult_publication_restores_existing_and_unpublished_files(self):
        pult = module('pult_usage_deploy_test', HERE / 'pult-deploy.py')
        base = module('pult_usage_base_test', OLD)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); live = root / 'live'; stage = root / 'stage'; backup = root / 'backup'
            for folder in (live / 'src', stage / 'payload/pult/src', backup): folder.mkdir(parents=True)
            (live / 'src/existing.js').write_text('old')
            (stage / 'payload/pult/src/existing.js').write_text('new')
            (stage / 'payload/pult/src/added.js').write_text('added')
            digest = lambda data: hashlib.sha256(data.encode()).hexdigest()
            files = [{'root': 'pult', 'relative': 'src/existing.js', 'before_sha256': digest('old'), 'after_sha256': digest('new')},
                     {'root': 'pult', 'relative': 'src/added.js', 'before_sha256': None, 'after_sha256': digest('added')}]
            manifest = {'source_commit': 'fixture', 'pult_files': files}
            owner = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
            with patch.object(pult, 'PULT', live), patch.object(pult.pwd, 'getpwnam', return_value=owner):
                record = pult.prepare(stage, manifest, base, backup / 'pult')
                item = record['files'][0]
                base.atomic_write(live, item['relative'], b'new', item['owner'], create=False,
                    prepared=backup / 'pult/prepared' / base.item_key(item),
                    before_identity=item['before_identity'], after_identity=item['after_identity'])
                self.assertEqual((live / 'src/existing.js').read_text(), 'new')
                pult.restore(base, backup / 'pult', record)
                self.assertEqual((live / 'src/existing.js').read_text(), 'old')
                self.assertFalse((live / 'src/added.js').exists())


if __name__ == '__main__': unittest.main()
