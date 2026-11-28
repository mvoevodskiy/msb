"""Operate only the two established JAR1 bot processes and fingerprint their profile files."""
import hashlib
import os
from pathlib import Path
import re
import time

BOTS = ('default', 'mistrjarvis')
READY = re.compile(r'^\[msb/bot\] (@[A-Za-z0-9_]{1,32}) ready$', re.MULTILINE)
FRAGMENT = '/etc/systemd/system/msb-bot@.service'


def host_class(base):
    class FleetHost(base.Host):
        def unit(self, bot):
            return f'msb-bot@{bot}.service'

        def properties(self, bot, *keys):
            return base.unit_properties(self.unit(bot), *keys)

        def command(self, action, bot):
            base.command('systemctl', action, self.unit(bot))

        def process(self, bot, masked=False):
            row = self.properties(bot, 'ActiveState', 'SubState', 'MainPID', 'User', 'Group',
                                  'FragmentPath', 'ControlGroup', 'InvocationID')
            pid = int(row.get('MainPID', '0'))
            if row.get('ActiveState') != 'active' or row.get('SubState') != 'running' or pid <= 0:
                raise RuntimeError('Unexpected running bot unit: ' + bot)
            if not masked and (row.get('User') != 'client' or row.get('Group') not in ('', 'client') or
                               row.get('FragmentPath') != FRAGMENT):
                raise RuntimeError('Unexpected running bot unit: ' + bot)
            return row, pid

        def process_env(self, pid):
            raw = (Path('/proc') / str(pid) / 'environ').read_bytes()
            return dict(entry.split(b'=', 1) for entry in raw.split(b'\0') if b'=' in entry)

        def check_process_scope(self, bot, pid):
            root = self.home / '.msb'
            proc = Path('/proc') / str(pid)
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            env = self.process_env(pid)
            if os.fsencode(root / 'bot/run.mjs') not in args or env.get(b'HOME') != os.fsencode(self.home) or \
                    env.get(b'MSB_SESSION_DIR') != os.fsencode(root / 'bots' / bot / 'sessions') or \
                    env.get(b'CODEX_HOME', os.fsencode(self.home / '.codex')) != os.fsencode(self.home / '.codex'):
                raise RuntimeError('Unexpected bot runtime or profile path: ' + bot)

        def bot_idle(self, masked=False):
            for bot in BOTS:
                row, pid = self.process(bot, masked=masked)
                self.check_process_scope(bot, pid)
                group = Path(row['ControlGroup'])
                if not group.is_absolute() or '..' in group.parts or not str(group).endswith('/' + self.unit(bot)):
                    raise RuntimeError('Unexpected bot control group: ' + bot)
                group = Path('/sys/fs/cgroup') / group.relative_to('/')
                for procs in (group / 'cgroup.procs', *group.rglob('cgroup.procs')):
                    if any(int(value) != pid for value in procs.read_text().split()):
                        raise RuntimeError('Bot has an active child process: ' + bot)

        def network_inode(self, bot=True):
            if not bot:
                return super().network_inode(bot=False)
            values = [os.stat(f'/proc/{self.process(name)[1]}/ns/net').st_ino for name in BOTS]
            if len(set(values)) != 1:
                raise RuntimeError('Bots are in different network namespaces')
            return values[0]

        def bot_node_sha(self):
            values = []
            for bot in BOTS:
                _, pid = self.process(bot)
                self.check_process_scope(bot, pid)
                values.append(hashlib.sha256((Path('/proc') / str(pid) / 'exe').read_bytes()).hexdigest())
            if len(set(values)) != 1:
                raise RuntimeError('Bots run different Node executables')
            return values[0]

        def protected(self):
            # Whole state files cover the selected saved session ID and settings.
            # Native auth/config and both instance files are hashed in place.
            files = [('.msb/.env', False), ('.codex/auth.json', True), ('.codex/config.toml', True)]
            files.extend((f'.msb/bots/{bot}/{name}', True) for bot in BOTS
                         for name in ('.env', 'state.json', 'ext-providers.json'))
            result = {}
            for relative, required in files:
                path = base.safe_file(self.home, relative, allow_absent=not required)
                if not os.path.lexists(path):
                    result[relative] = None
                    continue
                directory = base.open_parent(self.home, relative)
                try:
                    observed, _ = base.read_entry(directory, path.name)
                finally:
                    os.close(directory)
                result[relative] = observed
            return result

        def mask_path(self, bot):
            return Path('/etc/systemd/system') / self.unit(bot)

        def masked(self, bot):
            path = self.mask_path(bot)
            if not os.path.lexists(path):
                if self.properties(bot, 'UnitFileState').get('UnitFileState') != 'enabled':
                    raise RuntimeError('Bot is not enabled: ' + bot)
                return False
            if not path.is_symlink() or os.readlink(path) != '/dev/null' or path.lstat().st_uid != 0 or \
                    self.properties(bot, 'UnitFileState').get('UnitFileState') != 'masked':
                raise RuntimeError('Unexpected bot startup guard: ' + bot)
            return True

        def require_unmasked(self):
            if any(self.masked(bot) for bot in BOTS):
                raise RuntimeError('A bot already has a startup guard')

        def arm_all(self, recover=False):
            for bot in BOTS:
                if self.masked(bot):
                    if not recover:
                        raise RuntimeError('A bot became masked independently: ' + bot)
                else:
                    self.command('mask', bot)
                if not self.masked(bot):
                    raise RuntimeError('Bot startup guard not established: ' + bot)
                base.sync_dir(self.mask_path(bot).parent)

        def stop_all(self, recover=False):
            if not all(self.masked(bot) for bot in BOTS):
                raise RuntimeError('Both bots must be masked before shutdown')
            if not recover:
                self.bot_idle(masked=True)
            errors = []
            for bot in BOTS:
                try:
                    self.command('stop', bot)
                    row = self.properties(bot, 'ActiveState', 'MainPID')
                    if row.get('ActiveState') not in ('inactive', 'failed') or row.get('MainPID') != '0':
                        raise RuntimeError('Not stopped')
                except (OSError, RuntimeError):
                    errors.append(bot)
            if errors:
                raise RuntimeError('Could not stop bot units: ' + ', '.join(errors))

        @staticmethod
        def valid_identity(value):
            return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None

        def current_identity(self, bot):
            row, pid = self.process(bot)
            invocation = row.get('InvocationID', '')
            if not re.fullmatch(r'[0-9a-f]{32}', invocation):
                raise RuntimeError('Missing systemd invocation identity: ' + bot)
            logs = base.command('journalctl', '_SYSTEMD_UNIT=' + self.unit(bot), '_PID=' + str(pid),
                                '_SYSTEMD_INVOCATION_ID=' + invocation, '-o', 'cat', '--no-pager',
                                '--grep', r'^\[msb/bot\] @[A-Za-z0-9_]+ ready$')
            identities = {match.lower() for match in READY.findall(logs)}
            if len(identities) != 1:
                raise RuntimeError('Polling startup marker missing or ambiguous: ' + bot)
            return hashlib.sha256(identities.pop().encode()).hexdigest()

        def polling_identity(self):
            result = {bot: self.current_identity(bot) for bot in BOTS}
            if len(set(result.values())) != len(BOTS):
                raise RuntimeError('Both polling instances have the same identity')
            return result

        def start_all(self, identity):
            errors, waiting = set(), set()
            for bot in BOTS:
                try:
                    if self.masked(bot):
                        self.command('unmask', bot)
                        base.sync_dir(self.mask_path(bot).parent)
                    if self.masked(bot):
                        raise RuntimeError('Startup guard persists')
                    self.command('start', bot)
                    waiting.add(bot)
                except (OSError, RuntimeError):
                    errors.add(bot)
            deadline = time.monotonic() + 60
            while waiting and time.monotonic() < deadline:
                for bot in tuple(waiting):
                    try:
                        current = self.current_identity(bot)
                    except (OSError, RuntimeError):
                        continue
                    waiting.remove(bot)
                    if current != identity[bot]:
                        errors.add(bot)
                if waiting:
                    time.sleep(1)
            if errors | waiting:
                raise RuntimeError('Polling recovery failed for bot units: ' + ', '.join(sorted(errors | waiting)))

    return FleetHost
