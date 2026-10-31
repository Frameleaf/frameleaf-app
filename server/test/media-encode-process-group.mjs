import assert from 'node:assert/strict';

// Group checks for a child returned by this driver's own detached spawnSync call.
export const checkDetachedChildGroup = (result, options, signalGroup, runnerPid) => {
  // A numeric PID alone is not ownership: require a successful detached spawn
  // from this driver, and exclude the runner before forming any group signal.
  assert.equal(result.error, undefined, result.error?.message);
  assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0, 'Spawn must return a safe positive child PID');
  assert.equal(options.detached, true, 'Only this driver’s detached child group may be signalled');
  assert.ok(Number.isSafeInteger(runnerPid) && runnerPid > 0, 'Runner identity must be known');
  assert.notEqual(result.pid, runnerPid, 'Never signal the runner group');
  let isGroupAliveAfterWait = false;
  try {
    signalGroup(-result.pid, 0);
    isGroupAliveAfterWait = true;
    signalGroup(-result.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  return isGroupAliveAfterWait;
};
