import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationProgress, readable } from '../ui/src/presentation.js';
import { storageSuggestions } from '../src/storage-suggestions.js';
import type { Drive } from '../src/drives.js';

const GB = 1024 ** 3;
const drive = (path: string, speed: Drive['speed'], freeGb: number, label: string): Drive => ({
  path,
  hostPath: path,
  name: label.split(' (')[0],
  label,
  kind: speed === 'fast' ? 'nvme' : 'hdd',
  speed,
  evidence: 'device',
  filesystem: 'xfs',
  freeBytes: freeGb * GB,
  totalBytes: 1000 * GB,
  base: `${path}/appdata`,
});
const cache = drive('/mnt/cache', 'fast', 180, 'Cache pool (NVMe SSD)');
const array = drive('/mnt/user', 'slow', 2150, 'Hard drive array');

test('the database has first claim on a shared fast drive; thumbnails count its room as taken', () => {
  const suggestions = storageSuggestions([cache, array], {
    database: { path: '/mnt/user/appdata/frameleaf-databases', bytes: 12 * GB },
    thumbnails: { own: false, bytes: 86 * GB },
  });
  assert.equal(suggestions.database?.status, 'found');
  assert.equal(
    suggestions.database?.status === 'found' && suggestions.database.reason,
    'It has 180 GB free, and the database needs about 12 GB. Browsing and search read it constantly, so an SSD or NVMe drive makes them noticeably faster.',
  );
  assert.equal(
    suggestions.thumbs?.status === 'found' && suggestions.thumbs.reason,
    'It has 168 GB free after the database, and thumbnails need about 86 GB. The timeline loads hundreds of small images at once, so large libraries scroll faster from an SSD or NVMe drive.',
  );
  assert.equal(suggestions.thumbs?.status === 'found' && suggestions.thumbs.folder, '/mnt/cache/appdata/frameleaf-thumbnails');
});

test('a database already on a fast drive gets no suggestion and claims nothing more; thumbnails on their own folder get none', () => {
  const fastDatabase = storageSuggestions([cache, array], {
    database: { path: '/mnt/cache/appdata/frameleaf-databases', bytes: 12 * GB },
    thumbnails: { own: false, bytes: 86 * GB },
  });
  assert.equal(fastDatabase.database, null);
  assert.match(fastDatabase.thumbs?.status === 'found' ? fastDatabase.thumbs.reason : '', /^It has 180 GB free, and thumbnails/);
  const own = storageSuggestions([cache, array], {
    database: { path: '/mnt/cache/appdata/frameleaf-databases', bytes: 12 * GB },
    thumbnails: { own: true, bytes: 86 * GB },
  });
  assert.equal(own.thumbs, null);
  // When the database takes the room the thumbnails would need, Manager says why it isn't suggesting the drive.
  const tight = storageSuggestions([drive('/mnt/cache', 'fast', 140, 'Cache pool (NVMe SSD)'), array], {
    database: { path: '/mnt/user/appdata/frameleaf-databases', bytes: 12 * GB },
    thumbnails: { own: false, bytes: 86 * GB },
  });
  assert.equal(tight.database?.status, 'found');
  assert.equal(tight.thumbs?.status, 'too_full');
});

test('a thumbnail move shows the Storage page review’s five steps, each done once every step within it is', () => {
  const running = operationProgress({
    kind: 'move-thumbnails',
    state: 'running',
    step: 'move-freeze',
    completed: ['move-stop-writers', 'move-checkpoint', 'move-fence-stack'],
    error: null,
  });
  assert.deepEqual(
    running.steps.map((step) => [step.label, step.state]),
    [
      ['Pause uploads and background work', 'complete'],
      ['Copy thumbnails', 'running'],
      ['Check every file', 'waiting'],
      ['Switch to the new folder', 'waiting'],
      ['Start Frameleaf', 'waiting'],
    ],
  );
  assert.equal(running.percent, 20);
  // Paused, but the settings to return to not yet kept: the first step is still the one running.
  const pausing = operationProgress({ kind: 'move-thumbnails', state: 'running', step: 'move-checkpoint', completed: ['move-stop-writers'], error: null });
  assert.deepEqual(pausing.steps.map((step) => step.state), ['running', 'waiting', 'waiting', 'waiting', 'waiting']);
  assert.deepEqual(
    operationProgress({ kind: 'thumbnails-home', state: 'complete', step: null, completed: ['thumbs-home-switch', 'start', 'thumbs-queue'], error: null }).steps.map(
      (step) => step.label,
    ),
    ['Switch to your photos folder', 'Start Frameleaf', 'Queue new thumbnails'],
  );
  // A library move keeps its own wording.
  assert.equal(operationProgress({ kind: 'move-library', state: 'running', step: 'move-copy', completed: [], error: null }).steps[4].label, 'Copy and check every file');
  assert.equal(readable('thumbnails_home_resume_required'), 'Thumbnails are going back with your photos. Choose Resume to finish; the old drive isn’t used again.');
});
