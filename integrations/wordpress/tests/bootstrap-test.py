"""No-network checks for disposable bootstrap input and download integrity."""
import importlib.util
import tempfile
import sys
sys.dont_write_bytecode = True
from pathlib import Path

runner = Path(__file__).with_name('run.py')
assert runner.is_file(), 'disposable qualification bootstrap is implemented'
spec = importlib.util.spec_from_file_location('bootstrap', runner)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for unsafe in ['db.production.test:3306', '127.0.0.1:3306/real_database', 'localhost;rm -rf /']:
    try:
        module.database_endpoint(unsafe)
        raise AssertionError('non-loopback or ambiguous database endpoint accepted')
    except ValueError:
        pass
assert module.database_endpoint('127.0.0.1:39306') == ('127.0.0.1', 39306)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / 'archive'
    path.write_bytes(b'changed archive')
    try:
        module.verify_sha256(path, '0' * 64)
        raise AssertionError('changed download accepted')
    except ValueError:
        pass
print('PASS bootstrap rejects unsafe database endpoints and altered downloads')

# No subprocess, signal, database or filesystem mutation: simulate failure ordering.
from unittest.mock import Mock, patch
import subprocess

root = Path('/disposable-fixture-not-created')
child = Mock(pid=12345)
child.wait.side_effect = OSError('synthetic child wait failure')
handle = Mock()

def database_timeout(command, **kwargs):
    if command[0] == 'php':
        raise subprocess.TimeoutExpired(command, 15)
    return subprocess.CompletedProcess(command, 0, '', '')

primary = AssertionError('original qualification failure')
with patch.object(module.os, 'killpg') as kill, patch.object(module.subprocess, 'run', side_effect=database_timeout) as run, patch.object(module.shutil, 'rmtree') as remove:
    try:
        try:
            raise primary
        finally:
            module.cleanup(root, [child], [handle], ['php'], {}, True, 'owned-container', False, sys.exception())
    except AssertionError as error:
        assert error is primary, 'cleanup must preserve the original test exception'
        assert 'process' in error.__notes__[0] and 'database' in error.__notes__[0]
    else:
        raise AssertionError('original test failure was swallowed')
    handle.close.assert_called_once()
    assert run.call_args_list[-1].args[0] == ['docker', 'rm', '-f', 'owned-container'], 'database timeout skipped container removal'
    remove.assert_called_once_with(root)
print('PASS child and database cleanup exceptions do not skip later resources or mask the test failure')

with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess(['php'], 1)), patch.object(module.shutil, 'rmtree') as remove, patch('builtins.print') as report:
    try:
        module.cleanup(root, [], [], ['php'], {}, True, None, True)
        raise AssertionError('nonzero cleanup status was ignored')
    except RuntimeError as error:
        assert 'database' in str(error)
    report.assert_called_once_with('Private fixture retained: ' + str(root), flush=True)
    remove.assert_not_called()
print('PASS cleanup-only failure stays nonzero and still reports retained fixture')
