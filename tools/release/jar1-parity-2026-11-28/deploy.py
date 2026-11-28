#!/usr/bin/env python3
"""Install or restore a proven code-only release for both JAR1 bot instances."""
import argparse
import fcntl
import hashlib
from importlib.util import module_from_spec, spec_from_file_location
import json
import os
from pathlib import Path
import signal
import socket
import stat
import sys

sys.dont_write_bytecode = True
BACKUPS = Path('/var/lib/msb-ops/releases')
BOTS = ('default', 'mistrjarvis')


def deployment(base):
    class FleetRelease(base.Deployment):
        def __init__(self, stage, backup, roots, host, manifest, environment, native):
            self.stage, self.backup, self.roots, self.host = stage, backup, roots, host
            self.manifest, self.environment, self.native_proof = manifest, environment, native

        def check(self):
            super().check()
            uid, gid, _ = base.bot_owner()
            for item in self.manifest['files']:
                if item['before_sha256'] is not None:
                    observed = base.info(base.safe_file(self.roots['bot'], item['relative']))
                    if (observed['uid'], observed['gid']) != (uid, gid) or observed['mode'] not in (0o644, 0o664):
                        raise RuntimeError('Unexpected changed file owner or mode: ' + item['relative'])

        def check_host(self, running):
            self.host.system_idle()
            self.host.support_inventory(self.manifest['support_files'])
            self.check_native_identity(bot=running)
            if self.host.runtime_identity(self.stage) != self.environment:
                raise RuntimeError('Runtime identity changed since verification')
            if running and self.host.bot_node_sha() != self.environment['node_sha256']:
                raise RuntimeError('A bot runs a different Node executable')

        def install(self, record):
            for item in record['files']:
                payload = self.stage / 'payload/bot' / item['relative']
                base.atomic_write(self.roots['bot'], item['relative'], payload.read_bytes(), item['owner'],
                                  create=item['before_sha256'] is None,
                                  prepared=self.backup / 'prepared' / base.item_key(item),
                                  before_identity=item['before_identity'], after_identity=item['after_identity'])

        def read_record(self):
            file = base.safe_file(self.backup, 'metadata.json')
            st = file.lstat()
            if st.st_uid != os.geteuid() or st.st_mode & 0o077:
                raise RuntimeError('Untrusted rollback metadata')
            data = json.loads(file.read_bytes())
            self.validate_backup(data)
            return data

        def save_polling_identity(self, identity):
            path = self.backup / 'polling.json'
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as stream:
                json.dump(identity, stream)
                stream.flush()
                os.fsync(stream.fileno())
            base.sync_dir(self.backup)

        def polling_identity(self):
            path = base.safe_file(self.backup, 'polling.json')
            st = path.lstat()
            value = json.loads(path.read_bytes())
            if st.st_uid != os.geteuid() or st.st_mode & 0o077 or set(value) != set(BOTS) or any(
                    not self.host.valid_identity(item) for item in value.values()):
                raise RuntimeError('Untrusted polling identities')
            return value

        def check_guard(self):
            guard = base.safe_file(self.backup, 'guard.pending', allow_absent=True)
            if not os.path.lexists(guard):
                return False
            st = guard.lstat()
            if st.st_uid != os.geteuid() or st.st_mode & 0o077 or json.loads(guard.read_bytes()) != {'restart_after': True}:
                raise RuntimeError('Untrusted startup guard record')
            return True

        def stop(self, protected, recover=False):
            self.host.stop_all(recover=recover)
            if self.host.protected() != protected:
                raise RuntimeError('Protected bot data changed during shutdown')

        def start(self, identity):
            # Each unit is attempted independently, even if its peer fails.
            self.host.start_all(identity)

        def recover(self, record, identity, modified):
            if modified:
                # The applied tree may have started. Mask and stop both before restoring any byte.
                self.host.arm_all(recover=True)
                self.host.stop_all(recover=True)
                self.restore(record)
            self.verify_restored(record)
            self.start(identity)
            self.verify_restored(record)
            self.finish_guard()

        def apply(self):
            self.check()
            self.host.require_unmasked()
            identity = self.host.polling_identity()
            protected = self.host.protected()
            record = self.save_backup()
            self.save_polling_identity(identity)
            self.validate_backup(record)
            self.record_guard()
            modified = False
            try:
                self.host.arm_all()
                self.stop(protected)
                self.check_host(running=False)
                if self.host.pending_status() != self.pending:
                    raise RuntimeError('Pending system request changed before installation')
                self.verify_restored(record)
                modified = True
                self.install(record)
                self.verify_applied(record)
                self.check_host(running=False)
                if self.host.protected() != protected:
                    raise RuntimeError('Protected bot data changed during publication')
                self.start(identity)
                self.check_host(running=True)
                self.verify_applied(record)
                if self.host.pending_status() != self.pending:
                    raise RuntimeError('Pending system request changed after startup')
                if self.host.protected() != protected:
                    raise RuntimeError('Protected bot data changed after startup')
                self.finish_guard()
            except BaseException as original:
                try:
                    self.recover(record, identity, modified)
                except BaseException as recovery:
                    raise RuntimeError(f'Apply failed ({original}); recovery incomplete ({recovery}); '
                                       'retry --rollback with the same backup') from original
                raise RuntimeError(f'Apply failed ({original}); restored previous code and both polling services') from original
            return {'source_commit': record['source_commit'], 'files': len(record['files']),
                    'backup': str(self.backup), 'polling': list(BOTS)}

        def rollback(self):
            record = self.read_record()
            identity = self.polling_identity()
            pending = self.check_guard()
            self.check_host(running=not pending)
            if not pending:
                self.host.require_unmasked()
                self.host.bot_idle()
                self.record_guard()
            protected = self.host.protected()
            try:
                self.host.arm_all(recover=pending)
                self.stop(protected, recover=pending)
                self.restore(record)
                self.verify_restored(record)
            except BaseException as original:
                try:
                    # If code is incomplete, restart is prohibited. A retry uses the same materialized identities.
                    self.verify_restored(record)
                except Exception:
                    try:
                        # If no restore happened and the complete candidate is still present, recover service availability.
                        self.verify_applied(record)
                    except Exception:
                        raise RuntimeError('Rollback incomplete; retain startup guards and retry --rollback') from original
                self.start(identity)
                self.finish_guard()
                raise
            self.start(identity)
            self.check_host(running=True)
            self.verify_restored(record)
            if self.host.protected() != protected:
                raise RuntimeError('Protected bot data changed after rollback startup')
            self.finish_guard()
            return {'restored': len(record['files']), 'polling': list(BOTS)}

    return FleetRelease


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('stage', 'backup', 'manifest-sha', 'report-sha'):
        parser.add_argument('--' + name, required=True)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--apply', action='store_true')
    actions.add_argument('--rollback', action='store_true')
    parser.add_argument('--queue-confirmed', action='store_true',
                        help='operator observed no active turn or queued message on either bot')
    args = parser.parse_args()
    stage, backup = Path(args.stage).absolute(), Path(args.backup).absolute()
    if os.geteuid() != 0 or os.getegid() != 0 or socket.gethostname() != 'VM-422100' or \
            stage.parent != Path('/var/tmp') or backup.parent != BACKUPS or \
            Path(__file__).resolve(strict=True) != stage / 'deploy.py':
        raise RuntimeError('Unexpected JAR1 deployment context')
    if (args.apply or args.rollback) and not args.queue_confirmed:
        raise RuntimeError('Confirm the turn and queue of both bots before stopping them')

    def load(name):
        spec = spec_from_file_location('parity_operator_' + name, stage / (name + '.py'))
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    # The manifest hashes this copied helper, but no staged module is imported before its hash is pinned.
    def sha(raw):
        return hashlib.sha256(raw).hexdigest()

    def trusted_root(path, sticky=False):
        st = path.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or (
                not (st.st_mode & stat.S_ISVTX) if sticky else st.st_mode & 0o022):
            raise RuntimeError('Untrusted operator directory')
    for directory in ('/', '/var', '/var/lib', '/var/lib/msb-ops', str(BACKUPS), str(stage)):
        trusted_root(Path(directory))
    trusted_root(stage.parent, sticky=True)

    def read_top(name):
        fd = os.open(stage / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            st = os.fstat(stream.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
                raise RuntimeError('Untrusted staged file')
            return stream.read()

    manifest_raw, proof_raw = (read_top(name) for name in ('manifest.json', 'proof.json'))
    if sha(manifest_raw) != args.manifest_sha or sha(proof_raw) != args.report_sha:
        raise RuntimeError('Manifest or verification proof differs from pinned SHA')
    manifest, proof = json.loads(manifest_raw), json.loads(proof_raw)
    for name in ('build', 'deploy_ux'):
        if sha(read_top(name + '.py')) != manifest.get(name + '_sha256'):
            raise RuntimeError('Operator tool changed: ' + name)
    builder, ux = load('build'), load('deploy_ux')
    for name in builder.TOOLS:
        if sha(ux.trusted(stage, name)) != manifest.get(name.removesuffix('.py') + '_sha256'):
            raise RuntimeError('Operator tool changed: ' + name)
    ux.verify_payload(stage, manifest, builder)
    verifier, source_guard = load('verify_ux'), load('source_guard')
    environment, native = ux.verify_proof(proof, manifest, args.manifest_sha, verifier.CORE_EXCLUSIONS)
    source_guard.verify_source(stage, manifest)
    load('verify').verify_artifact(stage, manifest, builder)

    base, fleet = load('deploy_base'), load('fleet')
    if fleet.BOTS != BOTS:
        raise RuntimeError('Service scope mismatch')
    base.RELEASE_ORDER = [('bot', name) for name in builder.FILES]
    base.ADDED = {('bot', name) for name in builder.ADDED}
    roots = {'bot': Path('/home/client/.msb/bot'), 'engine': Path('/usr/local/lib/msb-engine'),
             'bin': Path('/usr/local/bin')}
    release = deployment(base)(stage, backup, roots, fleet.host_class(base)(), manifest, environment, native)

    def interrupt(signum, _frame):
        raise InterruptedError('operator interrupted by signal ' + str(signum))
    for signum in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(signum, interrupt)
    lock = base.open_directory(BACKUPS)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.apply:
            result = release.apply()
        elif args.rollback:
            result = release.rollback()
        else:
            release.check()
            release.host.require_unmasked()
            release.host.polling_identity()
            release.host.protected()
            if os.path.lexists(backup):
                raise RuntimeError('Backup path already exists')
            result = {'operation': 'read-only plan', 'files': len(builder.FILES), 'units': list(BOTS)}
        print(json.dumps(result))
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
