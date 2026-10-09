import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDetachedChildGroup } from './media-encode-process-group.mjs';

const runnerPid = 9000;
const options = { detached: true };
for (const pid of [undefined, '1234', 0, -1234, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, runnerPid]) {
  test(`invalid child pid ${String(pid)} never signals a group`, () => {
    const signals = [];
    assert.throws(() =>
      checkDetachedChildGroup(
        { pid },
        options,
        (...signalArguments) => {
          signals.push(signalArguments);
        },
        runnerPid,
      ),
    );
    assert.deepEqual(signals, []);
  });
}
test('EACCES spawn failure with pid zero preserves error and never signals', () => {
  const error = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  const signals = [];
  assert.throws(
    () =>
      checkDetachedChildGroup(
        { pid: 0, error },
        options,
        (...signalArguments) => {
          signals.push(signalArguments);
        },
        runnerPid,
      ),
    /spawn EACCES/,
  );
  assert.deepEqual(signals, []);
});
test('spawn failure with positive pid never signals', () => {
  const signals = [];
  assert.throws(
    () =>
      checkDetachedChildGroup(
        { pid: 1234, error: new Error('spawn failed') },
        options,
        (...signalArguments) => {
          signals.push(signalArguments);
        },
        runnerPid,
      ),
    /spawn failed/,
  );
  assert.deepEqual(signals, []);
});
test('numeric pid without detached-spawn ownership never signals', () => {
  const signals = [];
  assert.throws(() =>
    checkDetachedChildGroup(
      { pid: 1234 },
      { detached: false },
      (...signalArguments) => {
        signals.push(signalArguments);
      },
      runnerPid,
    ),
  );
  assert.deepEqual(signals, []);
});
test('owned valid child group already gone returns false after ESRCH probe', () => {
  const signals = [];
  const result = checkDetachedChildGroup(
    { pid: 1234 },
    options,
    (...signalArguments) => {
      signals.push(signalArguments);
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
    runnerPid,
  );
  assert.equal(result, false);
  assert.deepEqual(signals, [[-1234, 0]]);
});
test('owned valid lingering child group is probed and killed', () => {
  const signals = [];
  assert.equal(
    checkDetachedChildGroup(
      { pid: 1234 },
      options,
      (...signalArguments) => {
        signals.push(signalArguments);
      },
      runnerPid,
    ),
    true,
  );
  assert.deepEqual(signals, [
    [-1234, 0],
    [-1234, 'SIGKILL'],
  ]);
});
test('unexpected signal permission error stays visible', () => {
  assert.throws(
    () =>
      checkDetachedChildGroup(
        { pid: 1234 },
        options,
        () => {
          throw Object.assign(new Error('signal denied'), { code: 'EPERM' });
        },
        runnerPid,
      ),
    /signal denied/,
  );
});
