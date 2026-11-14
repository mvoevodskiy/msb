"""Old 0.5.9 request intake contract on isolated files; never touches systemd."""
import os
from pathlib import Path
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ipc import _new_claim_dir, cleanup_claims, parse_request, take_request
from util import Refused, strict_json


class RequestIntakeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # On macOS /tmp is itself a symlink; production must not follow one.
        self.root = Path(os.path.realpath(self.temp.name))
        self.directory = self.root / 'engine'
        self.directory.mkdir(mode=0o700)
        self.slot = self.directory / 'request'
        self.uid = os.getuid()

    def consume(self, directory=None, uid=None):
        return take_request(str(directory or self.directory), self.uid if uid is None else uid)

    def assert_refused(self, result):
        self.assertIsInstance(result, Refused)
        self.assertEqual(result.code, 'BAD_REQUEST')

    def test_regular_request_is_consumed(self):
        self.slot.write_bytes(b'{"v":1}')
        self.assertEqual(self.consume(), b'{"v":1}')
        self.assertFalse(self.slot.exists())
        self.assertIsNone(self.consume())

    def test_refuses_a_symlink_in_directory_path(self):
        self.slot.write_bytes(b'secret')
        alias = self.root / 'alias'
        alias.symlink_to(self.directory, target_is_directory=True)
        self.assert_refused(self.consume(alias))
        self.assertTrue(self.slot.exists())

    def test_refuses_final_symlink_without_reading_target(self):
        target = self.root / 'target'
        target.write_bytes(b'secret')
        self.slot.symlink_to(target)
        self.assert_refused(self.consume())
        self.assertEqual(target.read_bytes(), b'secret')
        self.assertFalse(self.slot.is_symlink())

    def test_refuses_group_writable_request_directory(self):
        self.directory.chmod(0o720)
        self.slot.write_bytes(b'request')
        self.assert_refused(self.consume())
        self.assertEqual(self.slot.read_bytes(), b'request')

    def test_refuses_foreign_owner(self):
        self.slot.write_bytes(b'request')
        self.assert_refused(self.consume(uid=self.uid + 1))
        self.assertEqual(self.slot.read_bytes(), b'request')

    def test_refuses_an_unknown_owner(self):
        self.slot.write_bytes(b'request')
        self.assert_refused(take_request(str(self.directory), None))
        self.assertEqual(self.slot.read_bytes(), b'request')

    def test_refuses_persistent_hardlink(self):
        other = self.directory / 'another-name'
        other.write_bytes(b'request')
        os.link(other, self.slot)
        self.assert_refused(self.consume())
        self.assertEqual(other.read_bytes(), b'request')
        self.assertFalse(self.slot.exists())

    def test_accepts_publisher_link_when_temp_name_is_removed(self):
        other = self.directory / '.request.pending.tmp'
        other.write_bytes(b'request')
        os.link(other, self.slot)
        def publish_done():
            time.sleep(0.1)
            other.unlink()
        worker = threading.Thread(target=publish_done)
        worker.start()
        try:
            self.assertEqual(self.consume(), b'request')
        finally:
            worker.join()
        self.assertFalse(self.slot.exists())

    def test_refuses_fifo_without_waiting_for_writer(self):
        os.mkfifo(self.slot)
        self.assert_refused(self.consume())
        self.assertFalse(self.slot.exists())

    def test_refuses_unix_socket_without_connecting(self):
        sock = socket.socket(socket.AF_UNIX)
        self.addCleanup(sock.close)
        try:
            sock.bind(str(self.slot))
        except PermissionError:
            self.skipTest('sandbox does not permit binding a Unix socket')
        self.assert_refused(self.consume())
        self.assertFalse(self.slot.exists())

    def test_refuses_nonempty_request_directory_without_erasing_contents(self):
        self.slot.mkdir()
        (self.slot / 'keep').write_bytes(b'keep')
        self.assert_refused(self.consume())
        self.assertFalse(self.slot.exists())
        moved = list(self.directory.glob('.request.claim.*'))
        self.assertEqual(len(moved), 1)
        self.assertEqual((moved[0] / 'claimed' / 'keep').read_bytes(), b'keep')

    def test_quarantine_reports_owner_failure(self):
        self.slot.mkdir()
        (self.slot / 'keep').write_bytes(b'keep')
        with patch('ipc.os.fchown', side_effect=PermissionError('synthetic')):
            result = self.consume()
        self.assert_refused(result)
        self.assertEqual(result.detail['reason'], 'REQUEST_QUARANTINE_OWNER')
        self.assertEqual((self.directory / result.detail['quarantine'] / 'claimed' / 'keep').read_bytes(), b'keep')

    def test_fstat_failure_closes_private_directory(self):
        directory = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, directory)
        real_close = os.close
        with patch('ipc.os.fstat', side_effect=OSError('synthetic')), \
             patch('ipc.os.close', wraps=real_close) as close:
            with self.assertRaises(OSError):
                _new_claim_dir(directory)
        self.assertEqual(close.call_count, 1)
        with self.assertRaises(OSError):
            os.fstat(close.call_args.args[0])

    @unittest.skipUnless(os.geteuid() == 0, 'requires isolated root and distinct client UID')
    def test_cleanup_removes_only_private_abandoned_claims(self):
        client_uid = 54321
        os.chown(self.directory, client_uid, client_uid)
        abandoned = self.directory / ('.request.claim.' + 'a' * 24)
        abandoned.mkdir(mode=0o700)
        (abandoned / 'claimed').write_bytes(b'synthetic request')
        client_data = self.directory / ('.request.claim.' + 'b' * 24)
        client_data.mkdir(mode=0o700)
        (client_data / 'claimed').write_bytes(b'preserve')
        os.chown(client_data, client_uid, client_uid)
        unsafe = self.directory / ('.request.claim.' + 'c' * 24)
        unsafe.mkdir(mode=0o700)
        (unsafe / 'claimed').mkdir()
        (unsafe / 'claimed' / 'keep').write_bytes(b'preserve')
        target = self.root / 'outside'
        target.write_bytes(b'preserve')
        alias = self.directory / ('.request.claim.' + 'd' * 24)
        alias.symlink_to(target)
        cleanup_claims(str(self.directory), client_uid)
        self.assertFalse(abandoned.exists())
        self.assertEqual((client_data / 'claimed').read_bytes(), b'preserve')
        self.assertEqual((unsafe / 'claimed' / 'keep').read_bytes(), b'preserve')
        self.assertEqual(target.read_bytes(), b'preserve')
        self.assertTrue(alias.is_symlink())

    def test_limit_is_enforced_on_opened_file(self):
        self.slot.write_bytes(b'x' * 4096)
        self.assertEqual(len(self.consume()), 4096)
        self.slot.write_bytes(b'x' * 4097)
        self.assert_refused(self.consume())
        self.assertFalse(self.slot.exists())

    def test_next_request_is_not_removed_when_published_after_claim(self):
        self.slot.write_bytes(b'first')
        original_rename = os.rename
        published = []

        def rename_and_publish(src, dst, *args, **kwargs):
            result = original_rename(src, dst, *args, **kwargs)
            if src == 'request' and dst == 'claimed':
                self.slot.write_bytes(b'second')
                published.append(True)
            return result

        with patch('ipc.os.rename', side_effect=rename_and_publish):
            self.assertEqual(self.consume(), b'first')
        self.assertEqual(published, [True])
        self.assertEqual(self.slot.read_bytes(), b'second')
        self.assertEqual(self.consume(), b'second')

    def test_claim_reads_the_request_replaced_before_rename(self):
        self.slot.write_bytes(b'old')
        replacement = self.directory / 'replacement'
        previous = self.directory / 'previous'
        replacement.write_bytes(b'new')
        original_rename = os.rename

        def replace_then_claim(src, dst, *args, **kwargs):
            if src == 'request' and dst == 'claimed':
                original_rename(self.slot, previous)
                original_rename(replacement, self.slot)
            return original_rename(src, dst, *args, **kwargs)

        with patch('ipc.os.rename', side_effect=replace_then_claim):
            self.assertEqual(self.consume(), b'new')
        self.assertEqual(previous.read_bytes(), b'old')
        self.assertFalse(self.slot.exists())

    def test_refuses_duplicate_json_keys_at_any_depth(self):
        for payload in (b'{"v":1,"v":1}', b'{"model":{"mode":"none","mode":"login"}}'):
            with self.subTest(payload=payload), self.assertRaises(Refused):
                strict_json(payload, 'BAD_REQUEST')

    def test_parse_retains_current_id_and_bot_contract(self):
        parsed = parse_request(b'{"v":1,"id":"abcdefgh_123","action":"status","bot_id":"default"}')
        self.assertEqual(parsed['params'], {'bot_id': 'default'})
        with self.assertRaises(Refused):
            parse_request(b'{"v":true,"id":"abcdefgh","action":"status"}')

    @unittest.skipUnless(shutil.which('node'), 'node is required for the actual bot publisher')
    def test_actual_bot_publisher_reaches_consumer(self):
        repo = Path(__file__).resolve().parents[3]
        producer = repo / '.msb/bot/src/engines/request.mjs'
        source = '''
          const {pathToFileURL} = await import('node:url');
          const {submitRequest} = await import(pathToFileURL(process.argv[1]));
          const env = {HOME: process.argv[2], MSB_RUNTIME_ROOT: process.argv[2]};
          const result = await submitRequest('status', {bot_id: 'default'}, env);
          console.log(JSON.stringify(result));
        '''
        run = subprocess.run(['node', '--input-type=module', '-e', source,
                              str(producer), str(self.root)],
                             capture_output=True, text=True, check=True, timeout=10)
        sent = json.loads(run.stdout)
        received = parse_request(self.consume())
        self.assertEqual(sent['id'], received['id'])
        self.assertEqual(received['action'], 'status')
        self.assertEqual(received['params']['bot_id'], 'default')


if __name__ == '__main__':
    unittest.main()
