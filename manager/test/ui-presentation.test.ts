import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import {
  operationProgress, canCancel, serviceState, formatBytes, readable, hasGpu, processorName,
  lossText, photoAppReason, untestedNotice, restrictionText, ownerEmailProblems, isPhotoAppCapture, photoAppDetail,
} from '../ui/src/presentation.js';

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
  assert.doesNotMatch(readable('release_service_unavailable'), /could not reach|can reach github/);
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

test('shared discovery refusals do not misidentify a source app', () => {
  for (const code of ['source_version_unreachable', 'database_connection_ambiguous', 'unsupported_database_connection']) {
    assert.doesNotMatch(readable(code), /\bImmich\b/u);
    assert.notEqual(readable(code), code.replaceAll('_', ' '));
  }
  assert.match(readable('source_version_unreachable'), /IMMICH_PORT and IMMICH_HOST/u);
  assert.match(readable('database_connection_ambiguous'), /DB_HOSTNAME/u);
  assert.match(readable('unsupported_database_connection'), /password and a port.*1 to 65535/u);
});

test('common import recovery shows its own credential and transfer steps', () => {
  const operation = {
    kind: 'import', state: 'failed', step: 'stage-bootstrap-admin', completed: ['preflight'],
    error: 'import_bootstrap_credentials_required', commonImport: { requiresBootstrap: true },
  };
  const progress = operationProgress(operation);
  assert.equal(progress.steps[1].id, 'stage-bootstrap-admin');
  assert.equal(progress.steps[1].state, 'failed');
  assert.ok(progress.steps.some((step) => step.id === 'preflight-common-import'));
  assert.ok(!progress.steps.some((step) => step.id === 'copy-current-database' || step.id === 'database-backup'));
  assert.ok(!operationProgress({ ...operation, step: null, commonImport: { requiresBootstrap: false } }).steps.some(
    (step) => step.id === 'stage-bootstrap-admin',
  ));
});


test('captured imports show a named snapshot step before preflight', () => {
  const capture = {
    kind: 'import', state: 'awaiting-review', step: null, completed: ['capture-common-source'], error: null,
  };
  assert.deepEqual(operationProgress(capture).steps, [
    { id: 'capture-common-source', label: 'Stop the app and read its library', state: 'complete' },
  ]);
  const approved = operationProgress({ ...capture, commonImport: { requiresBootstrap: false } });
  assert.deepEqual(approved.steps.slice(0, 2).map(({ id }) => id), ['capture-common-source', 'preflight']);
});

// Retail wording: none of the words owners told us read as operator jargon.
const JARGON = /\b(fence|fenced|snapshot|manifest|loss code|qualification|partitioned)\b/iu;

test('every loss a photo-app reader can report reads as a plain sentence', () => {
  const directory = new URL('../../server/src/library-import/', import.meta.url);
  const codes = new Set(['SOURCE_VERSION_UNTESTED']);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('-manifest.ts'))) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    for (const [, code] of source.matchAll(/loss\('([A-Z0-9_]+)'/gu)) codes.add(code);
    // Losses a reader records up front, outside loss(): { code: 'X', acknowledged: false }
    for (const [, code] of source.matchAll(/\{ code: '([A-Z0-9_]+)', acknowledged: false \}/gu)) codes.add(code);
  }
  assert.ok(codes.size > 60, `found ${codes.size} loss codes`);
  for (const code of codes) {
    const text = lossText(code, 'lychee');
    assert.ok(!text.includes(code), `${code} has no plain sentence`);
    assert.doesNotMatch(text, JARGON, code);
    assert.match(text, /^[A-Z].*\.$/u, code);
  }
  assert.equal(lossText('LYCHEE_TITLE_ARCHIVED', 'lychee'), 'Photo titles won’t come across. Descriptions do.');
  assert.match(lossText('PHOTOPRISM_DELETED_ALBUM_ARCHIVED', 'photoprism'), /deleted in PhotoPrism/u);
  assert.match(lossText('SOURCE_VERSION_UNTESTED', 'piwigo'), /version of Piwigo hasn't been tested/u);
  assert.equal(lossText('PIWIGO_SOMETHING_NEW', 'piwigo'), "Some Piwigo details won't come across (PIWIGO_SOMETHING_NEW).");
});

test('apps that cannot be imported say why in words', () => {
  assert.equal(photoAppReason({ kind: 'nextcloud', database: 'mysql', reason: 'database_unsupported' }), "Nextcloud on MySQL isn't supported yet.");
  assert.equal(photoAppReason({ kind: 'lychee', database: 'postgres' }), "Lychee on PostgreSQL isn't supported yet.");
  assert.match(photoAppReason({ kind: 'photoview', database: 'unknown' }), /couldn't tell which database Photoview uses/u);
  for (const reason of [
    'database_unknown', 'database_container_not_found', 'database_image_unsupported', 'database_credentials_unavailable',
    'source_mount_missing', 'source_mount_unsupported', 'source_mount_unqualified',
  ]) {
    const text = photoAppReason({ kind: 'piwigo', database: 'mysql', reason });
    assert.match(text, /Piwigo/u, reason);
    assert.ok(!text.includes(reason) && !JARGON.test(text), reason);
  }
  assert.equal(photoAppReason({ kind: 'piwigo', database: 'mysql', reason: 'brand_new_reason' }), "Piwigo can't be imported yet (brand_new_reason).");
  assert.equal(photoAppDetail({ version: '5.1.0', database: 'sqlite' }), 'Version 5.1.0 · SQLite');
  assert.equal(photoAppDetail({ version: null, database: 'unknown' }), 'Version unknown · an unknown database');
});

test('an untested version suggests the tested one without blocking the import', () => {
  assert.equal(
    untestedNotice('photoprism', '231011', '240915'),
    "PhotoPrism 231011 hasn't been tested. Photos and albums should come across; anything that can’t will be listed. For best results, upgrade PhotoPrism to 240915 first.",
  );
  assert.match(untestedNotice('lychee', null, '6.6.0'), /^This version of Lychee hasn't been tested\./u);
});

test('account restrictions and email checks speak to the owner', () => {
  assert.equal(restrictionText('second-factor-required', 'nextcloud'), 'This account uses two-step sign-in in Nextcloud.');
  assert.equal(restrictionText('something-else', 'nextcloud'), 'This account has a limit in Nextcloud (something-else).');
  assert.deepEqual(
    ownerEmailProblems([
      { sourceId: '1', email: 'ann@example.test' },
      { sourceId: '2', email: ' ANN@example.test ' },
      { sourceId: '3', email: '' },
      { sourceId: '4', email: 'not-an-email' },
      { sourceId: '5', email: 'bo@example.test' },
    ]),
    {
      '1': 'Each account needs its own email address.',
      '2': 'Each account needs its own email address.',
      '3': 'Enter an email address for this account.',
      '4': 'Enter a valid email address, like name@example.com.',
    },
  );
});

test('a photo-app capture is recognised until the reviewed import begins', () => {
  const capture = { kind: 'import', state: 'awaiting-review', step: null, completed: ['capture-common-source'], error: null };
  assert.equal(isPhotoAppCapture(capture), true);
  assert.equal(isPhotoAppCapture({ ...capture, state: 'running', step: 'capture-common-source', completed: [] }), true);
  assert.equal(isPhotoAppCapture({ ...capture, commonImport: { requiresBootstrap: false } }), false);
  assert.equal(isPhotoAppCapture({ ...capture, completed: [] }), false);
  assert.equal(readable('awaiting-review'), 'Waiting for your review');
  assert.doesNotMatch(readable('capture-common-source'), JARGON);
});
