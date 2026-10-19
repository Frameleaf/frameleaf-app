import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { MASKED, maskSettings, unmaskSettings, unsupportedSettings } from '../src/discovery.js';
import type { Source } from '../src/contracts.js';
import type { Docker } from '../src/docker.js';
import type { Releases } from '../src/releases.js';
import type { Backups } from '../src/backups.js';
import type { PostgresStorage } from '../src/postgres-storage.js';

// Top-level keys an Immich 3.2 server stores once an administrator saves its settings.
const immich32 = {
  oauth: { enabled: true, clientId: 'photos', clientSecret: 's3cret' },
  notifications: { smtp: { transport: { password: 'mail-pass', host: 'smtp' } } },
  nightlyTasks: { startTime: '00:00' },
  integrityChecks: {},
  templates: { email: {} },
  theme: { customCss: '' },
  image: { quality: 80 },
};

test('Immich 3.2 settings are compatible', () => {
  assert.deepEqual(unsupportedSettings(immich32), []);
  assert.deepEqual(unsupportedSettings({ ...immich32, forkOnly: {} }), ['forkOnly']);
});

test('secrets are masked for the editor and restored on save', () => {
  const masked = maskSettings(immich32) as typeof immich32;
  assert.equal(masked.oauth.clientSecret, MASKED);
  assert.equal(masked.notifications.smtp.transport.password, MASKED);
  assert.equal(masked.oauth.clientId, 'photos');
  assert.deepEqual(unmaskSettings(masked, immich32), immich32);
  assert.throws(() => unmaskSettings({ oauth: { clientSecret: MASKED } }, {}), /masked_secret_missing/);
});

test('an edit removes unsupported keys until the source settings change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manager-source-settings-'));
  const store = new Store(root);
  try {
    const source = {
      id: 'c'.repeat(64),
      settings: { ...immich32, forkOnly: { x: 1 } },
      unsupportedSettings: ['forkOnly'],
      settingsAuthority: 'database',
      database: { name: 'immich', user: 'u', host: 'h', port: 5432, password: 'p' },
      environment: {},
      restart: {},
    } as unknown as Source;
    store.set(`source:${source.id}`, source);
    const operations = new Operations(store, {} as Docker, {} as Releases, {} as Backups, [], {} as PostgresStorage);
    (operations as unknown as { discovery: unknown }).discovery = { revalidate: async () => {} };

    const view = operations.sourceSettings(source.id);
    const { forkOnly: _, ...edited } = view.settings as Record<string, unknown>;
    const saved = await operations.saveSourceSettings(source.id, edited);
    assert.deepEqual(saved.source.unsupportedSettings, []);
    assert.equal(saved.source.settingsEdited, true);
    assert.equal(JSON.stringify(saved).includes('s3cret'), false);
    const stored = store.get<{ settings: typeof immich32 }>(`source-settings:${source.id}`)!;
    assert.equal(stored.settings.oauth.clientSecret, 's3cret');

    // Re-discovery with different source settings drops the stale edit.
    store.set(`source:${source.id}`, { ...source, settings: { ...source.settings, image: { quality: 90 } } });
    assert.equal(operations.sourceSettings(source.id).source.settingsEdited, false);

    store.set(`source:${source.id}`, source);
    const reset = await operations.saveSourceSettings(source.id, null);
    assert.deepEqual(reset.source.unsupportedSettings, ['forkOnly']);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
