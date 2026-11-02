import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationProgress, canCancel, serviceState, formatBytes, readable, hasGpu, processorName } from '../ui/src/presentation.js';

test('operation timelines use journal steps and never infer successful completion from an error', () => {
  const operation = {
    kind: 'update',
    state: 'failed',
    step: 'apply-release',
    completed: ['download-images', 'stop-application', 'database-checkpoint'],
    error: 'database_failed',
  };
  const progress = operationProgress(operation);
  assert.ok(progress.percent < 100);
  assert.equal(progress.steps.find((step) => step.id === 'apply-release')?.state, 'failed');
  assert.equal(canCancel(operation, { mayHaveWrittenMedia: true }), false);
  assert.equal(canCancel({ ...operation, step: 'database-checkpoint' }, { mayHaveWrittenMedia: true }), true);
  assert.equal(
    operationProgress({ ...operation, state: 'complete', error: 'update_cancelled_previous_release_running' })
      .successful,
    false,
  );
  assert.equal(operationProgress({ ...operation, state: 'complete', error: null }).percent, 100);
});
test('import backup reuse omits the backup step only when the engine reports it skipped', () => {
  const operation = { kind: 'import', state: 'running', step: 'fence-source', completed: ['preflight'], error: null };
  assert.ok(operationProgress(operation).steps.some((step) => step.id === 'database-backup'));
  assert.ok(!operationProgress(operation, true).steps.some((step) => step.id === 'database-backup'));
});
test('a running container without a health check is not presented as verified healthy', () => {
  assert.equal(serviceState({ running: true, health: 'unknown' }), 'Running');
  assert.equal(serviceState({ running: true, health: 'unhealthy' }), 'Needs attention');
  assert.equal(serviceState({ running: false, health: 'healthy' }), 'Stopped');
  assert.equal(formatBytes(null), 'Unavailable');
  assert.equal(formatBytes(1024 ** 3), '1 GB');
});

test('release refusals read as sentences', () => {
  assert.match(readable('release_bundle_missing'), /^This Frameleaf release is missing installation files/);
  assert.equal(readable('download-images'), 'Download the verified image set');
  assert.match(readable('server_refused_403'), /refused Manager's request \(403\)/);
  assert.match(readable('manager_unexpected_response'), /^Manager sent an unexpected answer/);
});

test('a refusal detail names what blocked the request', () => {
  const text = readable('database_overlaps_existing_container_data', 'Blocking container: krusader, which can write to /mnt/user.');
  assert.match(text, /choose a database folder outside it\. Blocking container: krusader, which can write to \/mnt\/user\.$/);
});

test('setup names the detected graphics card and treats only GPUs as accelerated', () => {
  assert.equal(processorName('openvino'), 'Intel GPU');
  assert.equal(processorName('cuda'), 'NVIDIA GPU');
  assert.equal(processorName('rocm'), 'AMD GPU');
  assert.equal(processorName('cpu'), 'CPU processing');
  assert.equal(processorName(undefined), 'CPU processing');
  assert.equal(hasGpu('openvino'), true);
  assert.equal(hasGpu('cpu'), false);
  assert.equal(hasGpu(undefined), false);
});
