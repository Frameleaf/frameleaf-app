"""Test-only Linux process-crash driver. Root provisions/adopts no resources here.

Descriptor-bound cgroup.kill + populated-zero follows the reviewed linux-owner.py
route. Root must independently arm the enclosing guardian before invoking this.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time

POINTS = ('stage-file-barrier', 'stage-namespace-barrier', 'prepare-commit',
          'target-link', 'target-namespace-barrier', 'publication-commit',
          'stage-unlink', 'cleanup-namespace-barrier')
HERE = Path(__file__).resolve().parent
WORKER = HERE / 'studio-import-crash-worker.ts'
SOURCE = HERE.parents[2]


def require(value, code):
    if not value:
        raise RuntimeError(code)


def identity(st):
    return {'device': st.st_dev, 'inode': st.st_ino, 'uid': st.st_uid}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o077 == 0, 'owner_record_permissions')
        data = os.read(fd, 65537)
        require(len(data) <= 65536, 'owner_record_size')
        return json.loads(data)
    finally:
        os.close(fd)


def validate_record(record, path, now):
    nonce = record.get('nonce')
    require(isinstance(nonce, str) and re.fullmatch('[a-f0-9]{32}', nonce), 'owner_nonce')
    require(path == Path('/run/fl111-crash-' + nonce + '/owner.json'), 'owner_namespace')
    require(record.get('controlGroup') == '/fl111_crash_' + nonce + '.slice', 'owner_group')
    require(record.get('guardianUnit') == 'fl111-crash-guardian-' + nonce + '.service', 'owner_guardian')
    require(record.get('driverUnit') == 'fl111-crash-driver-' + nonce + '.service', 'owner_driver')
    for key in ('guardianInvocation', 'driverInvocation'):
        require(isinstance(record.get(key), str) and re.fullmatch('[a-f0-9]{32}', record[key]), 'owner_invocation')
    require(type(record.get('expiresAt')) in (int, float) and 0 < record['expiresAt'] - now <= 600, 'owner_expiry')
    for key in ('workerUid', 'workerGid'):
        require(type(record.get(key)) is int and record[key] > 0, 'nonroot_worker')
    for key in ('driverSha256', 'workerSha256', 'sourceHead', 'sourceTree'):
        require(isinstance(record.get(key), str) and re.fullmatch('[a-f0-9]{64}' if key.endswith('Sha256') else '[a-f0-9]{40}', record[key]), 'owner_source')
    require(isinstance(record.get('scratchRoot'), str) and Path(record['scratchRoot']).is_absolute(), 'scratch_root')
    require(isinstance(record.get('scratchIdentity'), dict) and set(record['scratchIdentity']) == {'device', 'inode', 'uid'} and record['scratchIdentity']['uid'] == 0, 'scratch_identity')
    require(isinstance(record.get('identity'), dict) and set(record['identity']) == {'device', 'inode', 'uid'} and record['identity']['uid'] == 0, 'owner_identity')
    require(isinstance(record.get('driverControlGroup'), str) and record['driverControlGroup'] == '/system.slice/' + record['driverUnit'], 'driver_group')
    return record


def command(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=3, env={'PATH': '/usr/bin:/bin'}).strip()


def systemd(record, kind):
    unit = record[kind + 'Unit']
    require(command(['/usr/bin/systemctl', 'show', unit, '-p', 'InvocationID', '--value']) == record[kind + 'Invocation'], 'invocation_changed')
    require(command(['/usr/bin/systemctl', 'show', unit, '-p', 'ActiveState', '--value']) == 'active', 'guardian_not_active')
    # An independent kernel deadline must remain armed if the Python driver dies.
    limit = command(['/usr/bin/systemctl', 'show', unit, '-p', 'RuntimeMaxUSec', '--value'])
    require(limit == ('2min' if kind == 'driver' else '10min'), 'kernel_deadline_mismatch')


def read_at(fd):
    os.lseek(fd, 0, 0)
    return os.read(fd, 8192).decode()


def populated(fd):
    fields = dict(line.split() for line in read_at(fd).splitlines())
    require(fields.get('populated') in ('0', '1'), 'cgroup_events_invalid')
    return fields['populated'] == '1'


def kill_readback(kill, events):
    require(kill is not None and events is not None, 'ownership_descriptors_missing')
    require(os.write(kill, b'1') == 1, 'cgroup_kill_short_write')
    end = time.monotonic() + 10
    while populated(events) and time.monotonic() < end:
        time.sleep(.05)
    require(not populated(events), 'cgroup_still_populated')


def birth(pid):
    # Only used for the driver's unreaped direct child, never a caller-supplied PID.
    text = Path('/proc/' + str(pid) + '/stat').read_text()
    return text[text.rfind(')') + 2:].split()[19]


def line(child, selector, deadline):
    value = b''
    while not value.endswith(b'\n'):
        require(selector.select(max(0, deadline - time.monotonic())), 'worker_deadline')
        part = os.read(child.stdout.fileno(), 1)
        require(part and len(value) < 4096, 'worker_protocol')
        value += part
    return json.loads(value)


def admit(owner_path):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'root_linux_driver_required')
    record = validate_record(private_json(owner_path), owner_path, time.time())
    parent = owner_path.parent
    st = parent.lstat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and st.st_mode & 0o077 == 0, 'owner_directory')
    require(Path('/proc/sys/kernel/random/boot_id').read_text().strip() == record['bootId'], 'boot_changed')
    require(digest(Path(__file__)) == record['driverSha256'] and digest(WORKER) == record['workerSha256'], 'source_changed')
    require(command(['/usr/bin/git', '-C', str(SOURCE), 'rev-parse', 'HEAD']) == record['sourceHead'], 'head_changed')
    require(command(['/usr/bin/git', '-C', str(SOURCE), 'rev-parse', 'HEAD^{tree}']) == record['sourceTree'], 'tree_changed')
    require(command(['/usr/bin/git', '-C', str(SOURCE), 'status', '--porcelain', '--untracked-files=no']) == '', 'source_dirty')
    require(Path('/proc/self/cgroup').read_text().strip() == '0::' + record['driverControlGroup'], 'driver_membership')
    systemd(record, 'guardian')
    systemd(record, 'driver')
    require(re.search(r'^NoNewPrivs:\s+1$', Path('/proc/self/status').read_text(), re.M), 'driver_nonewprivs_required')
    scratch = Path(record['scratchRoot'])
    info = scratch.lstat()
    require(scratch.resolve() == scratch and stat.S_ISDIR(info.st_mode) and info.st_mode & 0o022 == 0 and identity(info) == record['scratchIdentity'], 'scratch_replaced')
    return record


def run(owner_path, task):
    record = admit(owner_path)
    scratch = Path(record['scratchRoot'])
    relative = Path(task['root']).relative_to(scratch).parts
    require(len(relative) == 2 and relative[1] == 'exports' and re.fullmatch('case-[a-zA-Z0-9_-]+', relative[0]), 'task_namespace')
    require(task.get('point') in POINTS and task.get('mode') in ('publish', 'recover'), 'fault_point')
    require(task.get('workerUid') == record['workerUid'] and task.get('workerGid') == record['workerGid'], 'worker_identity')
    require(task.get('sourceHead') == record['sourceHead'], 'task_head')
    group = Path('/sys/fs/cgroup' + record['controlGroup'])
    fd = os.open(group, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    kill = events = None
    child = None
    admitted = False
    lane_claimed = False
    selector = selectors.DefaultSelector()
    report = {'point': task['point'], 'sourceHead': record['sourceHead'], 'cleanup': 'UNKNOWN', 'boundary': 'process-restart-only'}
    deadline = min(time.monotonic() + 45, time.monotonic() + record['expiresAt'] - time.time())
    try:
        require(identity(os.fstat(fd)) == record['identity'] == identity(group.lstat()) and os.fstat(fd).st_mode & 0o022 == 0, 'cgroup_replaced')
        for name in ('cgroup.procs', 'cgroup.kill', 'cgroup.subtree_control'):
            info = (group / name).lstat()
            require(info.st_uid == 0 and info.st_mode & 0o022 == 0, 'delegated_cgroup_refused')
        require((group / 'cgroup.subtree_control').read_text().strip() == '', 'leaf_required')
        kill = os.open('/proc/self/fd/' + str(fd) + '/cgroup.kill', os.O_WRONLY | os.O_NOFOLLOW)
        events = os.open('/proc/self/fd/' + str(fd) + '/cgroup.events', os.O_RDONLY | os.O_NOFOLLOW)
        require(not populated(events), 'lane_not_empty')
        lane_claimed = True
        # Nonroot worker cannot migrate out through a writable common ancestor.
        for ancestor in (group, *group.parents):
            if str(ancestor) == '/sys/fs':
                break
            info = (ancestor / 'cgroup.procs').lstat()
            require(info.st_uid == 0 and info.st_mode & 0o022 == 0, 'writable_migration_ancestor')
        env = {'PATH': '/usr/bin:/bin', 'IMMICH_TEST_POSTGRES_URL': os.environ['IMMICH_TEST_POSTGRES_URL'],
               'TSX_TSCONFIG_PATH': str(SOURCE / 'server/tsconfig.json')}
        # No application/SQL work before admission. Supplementary groups and inherited FDs are removed.
        child = subprocess.Popen([task['node'], '--import', task['tsx'], str(WORKER)], cwd=SOURCE / 'server',
                                 env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 bufsize=0, close_fds=True, user=record['workerUid'],
                                 group=record['workerGid'], extra_groups=[])
        born = birth(child.pid)
        selector.register(child.stdout, selectors.EVENT_READ)
        ready = line(child, selector, deadline)
        require(ready == {'state': 'parked', 'pid': child.pid} and birth(child.pid) == born, 'parked_child_changed')
        status = Path('/proc/' + str(child.pid) + '/status').read_text()
        for field, value in [('Uid', record['workerUid']), ('Gid', record['workerGid'])]:
            require(re.search(r'^' + field + r':\s+' + r'\s+'.join([str(value)] * 4) + r'$', status, re.M), 'worker_privilege_changed')
        for field in ('CapEff', 'CapPrm', 'CapInh', 'CapAmb'):
            require(re.search(r'^' + field + r':\s+0+$', status, re.M), 'worker_capability_refused')
        require(re.search(r'^NoNewPrivs:\s+1$', status, re.M), 'worker_nonewprivs_required')
        # Child is not reaped before migration, so its PID cannot be reused even if it dies here.
        procs = os.open('/proc/self/fd/' + str(fd) + '/cgroup.procs', os.O_WRONLY | os.O_NOFOLLOW)
        try:
            value = str(child.pid).encode()
            require(os.write(procs, value) == len(value), 'migration_short_write')
        finally:
            os.close(procs)
        require(birth(child.pid) == born and Path('/proc/' + str(child.pid) + '/cgroup').read_text().strip() == '0::' + record['controlGroup'], 'child_admission_failed')
        admitted = True
        task['controlGroup'] = record['controlGroup']
        child.stdin.write((json.dumps(task) + '\n').encode())
        child.stdin.flush()
        reached = line(child, selector, deadline)
        if task['mode'] == 'publish':
            require(reached.get('state') == 'barrier' and reached.get('point') == task['point'], 'barrier_not_reached')
            descendant = reached.get('descendantPid')
            require(type(descendant) is int and descendant > 0 and descendant != child.pid, 'descendant_missing')
            require(Path('/proc/' + str(descendant) + '/cgroup').read_text().strip() == '0::' + record['controlGroup'], 'descendant_outside_lane')
            report.update(barrierObserved=True, descendantObserved=True, directChildBirth=born)
        else:
            require(reached == {'state': 'recovered', 'point': task['point']}, 'recovery_failed')
            require(child.wait(timeout=max(.1, deadline - time.monotonic())) == 0, 'recovery_exit_failed')
            report['restartedRecoveryCompleted'] = True

    finally:
        # Preserve primary failure; UNKNOWN closure is always a failure and forbids recovery/cleanup.
        try:
            if child is not None and not admitted:
                # Before release there are no application imports or descendants, and no reap/PID reuse.
                child.kill()
                child.wait(timeout=3)
            require(lane_claimed and kill is not None and events is not None and identity(os.fstat(fd)) == record['identity'] == identity(group.lstat()), 'closure_identity')
            if admitted:
                kill_readback(kill, events)
            else:
                require(not populated(events), 'unadmitted_lane_changed')
            if child is not None:
                report['workerExitCode'] = child.wait(timeout=3)
            report.update(cleanup='kernel-cgroup-populated-zero', populatedAfterKill=0)
        finally:
            selector.close()
            for handle in (kill, events, fd):
                if handle is not None:
                    os.close(handle)
            if child is not None:
                child.stdin.close()
                child.stdout.close()
    require(report.get('workerExitCode') == (-9 if task['mode'] == 'publish' else 0), 'worker_exit_wrong')
    return report


def self_test():
    import unittest
    class Controls(unittest.TestCase):
        def test_record_refusals(self):
            nonce = 'a' * 32
            record = {'nonce': nonce, 'controlGroup': '/fl111_crash_' + nonce + '.slice',
                      'guardianUnit': 'fl111-crash-guardian-' + nonce + '.service',
                      'driverUnit': 'fl111-crash-driver-' + nonce + '.service',
                      'guardianInvocation': 'b' * 32, 'driverInvocation': 'c' * 32,
                      'expiresAt': 100, 'workerUid': 1001, 'workerGid': 1001,
                      'driverSha256': 'd' * 64, 'workerSha256': 'e' * 64,
                      'sourceHead': 'f' * 40, 'sourceTree': '1' * 40,
                      'identity': {'device': 1, 'inode': 2, 'uid': 0},
                      'scratchRoot': '/tmp/fl111-owned-test', 'scratchIdentity': {'device': 1, 'inode': 3, 'uid': 0}}
            record['driverControlGroup'] = '/system.slice/' + record['driverUnit']
            path = Path('/run/fl111-crash-' + nonce + '/owner.json')
            self.assertEqual(validate_record(record, path, 99), record)
            for key, value in [('workerUid', 0), ('workerGid', True), ('expiresAt', 99),
                               ('expiresAt', 1000), ('controlGroup', '/'), ('guardianInvocation', ''),
                               ('driverControlGroup', record['controlGroup']), ('sourceHead', 'bad')]:
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    validate_record({**record, key: value}, path, 99)
            with self.assertRaises(RuntimeError):
                validate_record(record, Path('/tmp/owner.json'), 99)
        def test_kernel_closure_controls(self):
            from unittest.mock import patch
            with patch(__name__ + '.os.write', return_value=1) as write, patch(__name__ + '.populated', side_effect=[True, False, False]):
                kill_readback(10, 11)
                write.assert_called_once_with(10, b'1')
            with patch(__name__ + '.os.write') as write:
                with self.assertRaises(RuntimeError):
                    kill_readback(None, 11)
                write.assert_not_called()
            with patch(__name__ + '.os.write', return_value=0), self.assertRaises(RuntimeError):
                kill_readback(10, 11)
            with patch(__name__ + '.os.write', return_value=1), patch(__name__ + '.populated', return_value=True), patch(__name__ + '.time.monotonic', side_effect=[0, 11]), self.assertRaises(RuntimeError):
                kill_readback(10, 11)
            with patch(__name__ + '.os.write', side_effect=OSError('control')), self.assertRaises(OSError):
                kill_readback(10, 11)
        def test_points(self):
            self.assertEqual(len(POINTS), 8)
            self.assertEqual(len(set(POINTS)), 8)
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(Controls))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        sys.exit(self_test())
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--admit':
            record = admit(Path(sys.argv[2]))
            print(json.dumps({key: record[key] for key in ('workerUid', 'workerGid', 'scratchRoot', 'sourceHead')}), flush=True)
        else:
            task = json.loads(sys.stdin.readline(65537))
            print(json.dumps(run(Path(sys.argv[1]), task)), flush=True)
    except BaseException:
        print(json.dumps({'cleanup': 'UNKNOWN', 'error': 'crash_driver_refused'}), flush=True)
        sys.exit(1)
