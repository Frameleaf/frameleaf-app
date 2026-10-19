import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Operations } from '../src/operations.js';
import { compareReleases } from '../src/release-order.js';
import { Store } from '../src/store.js';
import {
  navSection,
  newerReleases,
  plural,
  releaseNotesText,
} from '../ui/src/presentation.js';

// OPS-24: v1.1.1 offered v1.1.0 and v1.0.0 as updates, and v1.1.2 still showed "Updates available".
const published = [
  'frameleaf-v1.1.2',
  'frameleaf-v1.1.0',
  'frameleaf-v1.0.0',
  'frameleaf-v1.1.1',
].map((tag) => ({ tag }));

test('only releases newer than the running one are updates', () => {
  assert.deepEqual(
    newerReleases(published, 'frameleaf-v1.1.1').map((release) => release.tag),
    ['frameleaf-v1.1.2'],
  );
  assert.deepEqual(newerReleases(published, 'frameleaf-v1.1.2'), []);
  assert.deepEqual(newerReleases(published, undefined), []);
  assert.ok(compareReleases('frameleaf-v1.10.0', 'frameleaf-v1.9.9') > 0);
  assert.ok(compareReleases('frameleaf-v2.0.0-rc.1', 'frameleaf-v2.0.0') < 0);
  assert.ok(
    compareReleases('frameleaf-v2.0.0-rc.10', 'frameleaf-v2.0.0-rc.2') > 0,
  );
  assert.equal(compareReleases('frameleaf-v1.0.0', 'not-a-release'), 0);
});

test('reviewing an older or the running release is refused before anything is downloaded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-order-'));
  const store = new Store(directory);
  try {
    store.set('installation', {
      id: 'a'.repeat(12),
      release: 'frameleaf-v1.1.1',
    });
    const acquired: string[] = [];
    const releases = {
      acquire: async (tag: string) => {
        acquired.push(tag);
        throw new Error('stop after eligibility');
      },
    };
    const docker = { compatibility: async () => ({ platform: 'linux/amd64' }) };
    const operations = new Operations(
      store,
      docker as never,
      releases as never,
      {} as never,
      [],
      {} as never,
    );
    for (const tag of [
      'frameleaf-v1.1.0',
      'frameleaf-v1.0.0',
      'frameleaf-v1.1.1',
    ])
      await assert.rejects(
        operations.reviewUpdate(tag),
        /select_a_new_release/,
      );
    assert.deepEqual(acquired, []);
    await assert.rejects(
      operations.reviewUpdate('frameleaf-v1.1.2'),
      /stop after eligibility/,
    );
    assert.deepEqual(acquired, ['frameleaf-v1.1.2']);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});

test('release notes show as text without the generator comment or markdown markers', () => {
  const notes =
    'Source: abc\n\n\n<!-- Release notes generated using configuration in .github/release.yml at abc -->\n\n## 🐛 Bug fixes\n* Fix <b>it</b> by @aj\n\n\n\n**Full Changelog**: https://example.test/compare/frameleaf-v1.1.1...frameleaf-v1.1.2';
  const text = releaseNotesText(notes);
  assert.equal(
    text,
    'Source: abc\n\n🐛 Bug fixes\n• Fix <b>it</b> by @aj\n\nFull Changelog: https://example.test/compare/frameleaf-v1.1.1...frameleaf-v1.1.2',
  );
  assert.equal(releaseNotesText('before <!-- unterminated'), 'before');
});

test('library counts are pluralised', () => {
  assert.equal(
    `${plural(1, 'album')} · ${plural(1, 'account')}`,
    '1 album · 1 account',
  );
  assert.equal(plural(0, 'album'), '0 albums');
  assert.equal(plural(24860, 'photo'), '24,860 photos');
});

test('navigation highlights the section an installed server operation belongs to', () => {
  assert.equal(navSection('progress', true, 'backup'), 'backups');
  assert.equal(navSection('progress', true, 'update'), 'updates');
  assert.equal(navSection('progress', true, 'restore'), 'backups');
  assert.equal(navSection('restore', true), 'backups');
  assert.equal(navSection('progress', true, 'stop'), 'services');
  assert.equal(navSection('updates', true), 'updates');
  // First-run setup still belongs to Set up Frameleaf.
  assert.equal(navSection('restore', false), 'welcome');
  assert.equal(navSection('progress', false, 'install'), 'welcome');
  assert.equal(navSection('phone', true), 'welcome');
});
