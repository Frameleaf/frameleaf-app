import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Operations } from '../src/operations.js';
import { Releases } from '../src/releases.js';
import { compareReleases } from '../src/release-order.js';
import { Store } from '../src/store.js';
import { Refusal, databaseImageChangeAllowed, databaseImageMove, postgresMajor, postgresVersion } from '../src/contracts.js';
import { fileHash } from '../src/files.js';
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

// Issue 626: a failed update keeps the operation lock, so Resume must move off a withdrawn release.
for (const prepared of [false, true])
for (const missing of [false, true])
test(`resuming an update whose release was ${missing ? 'removed' : 'withdrawn'} retries with the next offered release (prepared=${prepared})`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-retarget-'));
  const store = new Store(directory);
  try {
    const release = (tag: string) => ({
      nas: {
        tag,
        platforms: ['linux/amd64'],
        images: {
          postgres: tag === 'frameleaf-v1.1.19' ? 'postgres:20' : 'postgres:19',
        },
      },
    });
    await mkdir(join(directory, 'stack'));
    await writeFile(
      join(directory, 'stack', 'compose.json'),
      JSON.stringify({ services: { database: { image: 'postgres:19' } } }),
    );
    // 1.1.19 changes PostgreSQL, which needs a restore rather than an update.
    const offered = new Set([
      'frameleaf-v1.1.16',
      'frameleaf-v1.1.18',
      'frameleaf-v1.1.19',
    ]);
    const acquired: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      const tag = url.split('/').at(-1)!;
      if (missing && !offered.has(tag)) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({
        draft: false, prerelease: false, body: offered.has(tag) ? '' : 'withdrawn: unsafe',
      }));
    });
    const client = new Releases(directory, 'seed');
    const releases = {
      eligible: client.eligible.bind(client),
      // Publication order, not version order: a 1.1.18 backport published after 1.1.19.
      available: async () => [
        { tag: 'frameleaf-v1.1.18' },
        { tag: 'frameleaf-v1.1.19' },
        { tag: 'frameleaf-v1.1.16' },
      ],
      acquire: async (tag: string) => (acquired.push(tag), release(tag)),
    };
    const operations = new Operations(
      store,
      {} as never,
      releases as never,
      {} as never,
      [],
      {} as never,
    );
    const retarget = (operation: unknown, review: unknown) =>
      (operations as any).retargetWithdrawnUpdate(operation, review);
    const { operation } = store.start('update', 'k', { reviewId: 'r' });
    operation.completed = [
      'download-images',
      'stop-application',
      'database-checkpoint',
    ];
    operation.step = 'apply-release';
    if (prepared) {
      store.set('installation', { release: 'frameleaf-v1.1.17' });
      operation.receipts['release-start-state'] = 'prepared';
    }
    operation.receipts['database-checkpoint'] = 'snapshot';
    store.save(operation);
    const review = {
      current: { release: 'frameleaf-v1.1.16' },
      platform: 'linux/amd64',
      release: release('frameleaf-v1.1.17'),
    };

    const retargeted = await retarget(operation, review);
    assert.equal(retargeted.release.nas.tag, 'frameleaf-v1.1.18');
    assert.equal(retargeted.current.release, 'frameleaf-v1.1.16');
    assert.deepEqual(operation.completed, [
      'stop-application',
      'database-checkpoint',
    ]);
    assert.equal(operation.receipts['database-checkpoint'], 'snapshot');
    assert.equal(
      store.get<any>('update:r').release.nas.tag,
      'frameleaf-v1.1.18',
    );

    // A release that is still offered is retried as it is.
    assert.equal(await retarget(operation, retargeted), retargeted);
    // Review L7: the lowest newer compatible release, never a jump to the newest; 1.1.19 is never fetched.
    assert.deepEqual(acquired, ['frameleaf-v1.1.18']);
    offered.delete('frameleaf-v1.1.18');
    await assert.rejects(
      retarget(operation, retargeted),
      /release_not_eligible/,
    );
    // Only 1.1.19 remained, and it changes PostgreSQL without declaring an in-place change.
    assert.deepEqual(acquired, ['frameleaf-v1.1.18', 'frameleaf-v1.1.19']);
    // An expired review is not silently retargeted: the administrator reviews the newer release.
    offered.add('frameleaf-v1.1.18');
    await assert.rejects(
      retarget(operation, { ...review, expires: Date.now() - 1 }),
      (error: any) => error.code === 'update_review_expired' && /review the newer release/.test(error.detail),
    );
    assert.equal(acquired.length, 2, 'nothing is fetched for an expired review');
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});

for (const state of ['complete', 'legacy', 'starting'])
test(`an interrupted update keeps its selected release (state=${state})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-applied-'));
  const store = new Store(directory);
  try {
    let checks = 0;
    const operations = new Operations(store, {} as never, {
      eligible: async () => { checks++; throw new Error('release no longer available'); },
    } as never, {} as never, [], {} as never);
    const { operation } = store.start('update', 'applied', { reviewId: 'r' });
    operation.state = 'interrupted';
    operation.step = 'apply-release';
    const completed = ['download-images', 'stop-application', 'database-checkpoint'];
    if (state === 'complete') completed.push('apply-release');
    else store.set('installation', { release: 'frameleaf-v1.1.17' });
    if (state === 'starting') operation.receipts['release-start-state'] = 'starting';
    operation.completed = [...completed];
    store.save(operation);
    const review = { release: { nas: { tag: 'frameleaf-v1.1.17' } } };
    assert.equal(await (operations as any).retargetWithdrawnUpdate(operation, review), review);
    assert.equal(checks, 0);
    assert.deepEqual(operation.completed, completed);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});

for (const interrupt of ['selected', 'starting'])
test(`update startup boundary is durable when interrupted at ${interrupt}`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-boundary-'));
  const store = new Store(directory);
  try {
    const image = `fixture.invalid/server@sha256:${'a'.repeat(64)}`;
    const current = { id: 'a'.repeat(12), project: 'frameleaf-test', release: 'frameleaf-v1.1.16',
      ml: false, mounts: [], origin: 'new_library', port: 2283, databasePath: join(directory, 'db') };
    const release = { directory, nas: { tag: 'frameleaf-v1.1.17',
      images: { server: image, postgres: image, machineLearning: image } } };
    await mkdir(join(directory, 'stack'));
    await writeFile(join(directory, 'docker-compose.yml'), JSON.stringify({ services: {
      database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {},
    } }));
    await writeFile(join(directory, 'stack', 'compose.json'), JSON.stringify({ services: { database: { image } } }));
    store.set('installation', current);
    store.set('database-password', 'fixture-only');
    const { operation } = store.start('update', 'boundary', { reviewId: 'r' });
    operation.completed = ['download-images', 'stop-application', 'database-checkpoint'];
    store.save(operation);
    const persistedState = () => store.history()[0].receipts['release-start-state'];
    const originalSet = store.set.bind(store);
    t.mock.method(store, 'set', (key: string, value: unknown) => {
      originalSet(key, value);
      if (key === 'installation') {
        assert.equal(persistedState(), 'prepared');
        if (interrupt === 'selected') throw new Error('interrupted-selected');
      }
    });
    const operations = new Operations(store, {
      compose: async () => {
        assert.equal(persistedState(), 'starting');
        throw new Error('interrupted-starting');
      },
    } as never, { eligible: async () => {} } as never, {} as never, [], { verify: async () => {} } as never);
    (operations as any).fencing = { assertMedia: async () => {} };
    await assert.rejects((operations as any).applyUpdate(operation, { current, release }),
      new RegExp(`interrupted-${interrupt}`));
    // Docker could not show that the server never served, so the failed start is not rolled back.
    assert.equal(persistedState(), interrupt === 'selected' ? 'prepared' : 'started');
    assert.equal(store.get<any>('installation').release, release.nas.tag);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});

// Review M2: the database image may change inside an update only for the same major and only when the
// signed bundle declares that exact in-place transition; anything else stays on the restore path.
test('a database image change is an in-place update only when the bundle declares it for the same major', () => {
  const image = (tag: string, digest = 'a') => `ghcr.io/frameleaf/frameleaf-postgres:${tag}@sha256:${digest.repeat(64)}`;
  assert.equal(postgresMajor(image('19beta4-pgvector0.8.7')), 19);
  assert.equal(postgresMajor(image('19.1-pgvector0.8.7')), 19);
  assert.equal(postgresMajor(image('20rc1-pgvector0.9.0')), 20);
  assert.equal(postgresMajor('ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7'), 19);
  assert.equal(postgresMajor('postgres:19'), null);
  assert.equal(postgresMajor(image('latest')), null);
  const current = image('19beta4-pgvector0.8.7');
  const ga = image('19.0-pgvector0.8.7', 'b');
  const declared = {
    strategy: 'in-place' as const,
    from: ['ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7'],
    to: 'ghcr.io/frameleaf/frameleaf-postgres:19.0-pgvector0.8.7',
    requiresBackup: true as const,
  };
  const release = (postgres: string, databaseImageChange?: any) => ({ images: { postgres } as any, databaseImageChange });
  assert.equal(databaseImageChangeAllowed(current, release(current)), true, 'same image');
  assert.equal(databaseImageChangeAllowed(current, release(ga)), false, 'undeclared beta to GA');
  assert.equal(databaseImageChangeAllowed(current, release(ga, declared)), true, 'declared beta to GA');
  assert.equal(databaseImageChangeAllowed(image('19beta3-pgvector0.8.7'), release(ga, declared)), false, 'not listed in from');
  assert.equal(databaseImageChangeAllowed(current, release(ga, { ...declared, to: declared.from[0] })), false, 'to differs');
  assert.equal(databaseImageChangeAllowed(current, release(ga, { ...declared, strategy: 'restore' })), false);
  assert.equal(databaseImageChangeAllowed(current, release(ga, { ...declared, requiresBackup: false })), false);
  const twenty = image('20.0-pgvector0.9.0', 'c');
  assert.equal(
    databaseImageChangeAllowed(current, release(twenty, { ...declared, to: 'ghcr.io/frameleaf/frameleaf-postgres:20.0-pgvector0.9.0' })),
    false,
    'a new major always restores',
  );
  assert.equal(databaseImageChangeAllowed('postgres:19', release(image('19.0-pgvector0.8.7'), declared)), false, 'unparseable current');
});

// Review: an update that failed inside apply-release before journaling `release-start-state = 'starting'`
// never ran its target. It stays cancellable (and recover() restarts the previous release) even when the
// selected release was withdrawn and its review expired, so retargeting on resume is refused.
for (const state of [undefined, 'prepared'] as const)
test(`a failed update that never started its target is cancelled back to the previous release (state=${state})`, async () => {
  process.env.MANAGER_ML_ACCELERATION = 'cpu';
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-cancel-'));
  const bundle = join(directory, 'bundle');
  await mkdir(bundle);
  const image = `fixture.invalid/server@sha256:${'a'.repeat(64)}`;
  await writeFile(join(bundle, 'docker-compose.yml'), JSON.stringify({ services: {
    database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {},
  } }));
  const store = new Store(join(directory, 'state'));
  try {
    const current = { id: 'a'.repeat(12), project: 'frameleaf-test', release: 'frameleaf-v1.1.16', ml: false,
      mounts: [], origin: 'new_library', port: 2283, sourceId: null, mayHaveWrittenMedia: true, databasePath: join(directory, 'db') };
    const target = { ...current, release: 'frameleaf-v1.1.17' };
    const release = (tag: string) => ({ directory: bundle, nas: { tag, images: { server: image, postgres: image, machineLearning: image } } });
    store.set('installation', state === 'prepared' ? target : current);
    store.set('previous-installation', current);
    store.set('database-password', 'fixture-only');
    store.set('application-config', { environment: {}, settings: null, services: {} });
    store.set('update:r', { expires: Date.now() - 1, current, release: release('frameleaf-v1.1.17'), platform: 'linux/amd64' });
    const { operation } = store.start('update', 'cancel', { reviewId: 'r' });
    operation.completed = ['download-images', 'stop-application', 'database-checkpoint'];
    operation.step = 'apply-release';
    operation.state = 'failed';
    operation.error = 'release_not_eligible';
    if (state) operation.receipts['release-start-state'] = state;
    store.save(operation);
    const composed: unknown[][] = [];
    const operations = new Operations(
      store,
      { compose: async (...args: unknown[]) => { composed.push(args); }, inventory: async () => [] } as never,
      { eligible: async () => { throw new Refusal('release_not_eligible'); }, available: async () => [],
        acquire: async (tag: string) => release(tag) } as never,
      {} as never,
      [],
      { verify: async () => {} } as never,
    );
    (operations as any).fencing = { assertMedia: async () => {}, verify: async () => {} };
    assert.equal(operations.history()[0].canCancel, true, 'cancellable before the target started');
    // Resume cannot retarget: the review expired after the release was withdrawn.
    operations.resume(operation.id);
    for (const deadline = Date.now() + 5000; store.history()[0].state === 'running' && Date.now() < deadline; )
      await new Promise((pause) => setTimeout(pause, 5));
    assert.equal(store.history()[0].state, 'failed');
    assert.equal(store.history()[0].error, 'update_review_expired');
    // The failed operation keeps its step; history still offers cancellation.
    assert.equal(store.history()[0].step, 'apply-release');
    assert.equal(operations.history()[0].canCancel, true);
    await operations.recover(operation.id);
    const done = store.history()[0];
    assert.equal(done.state, 'complete');
    assert.equal(done.receipts['cancelled'], 'update_cancelled_previous_release_running');
    assert.deepEqual(composed, [[operations.directory(), current.project, 'up']]);
    assert.equal(store.get<any>('installation').release, current.release, 'the previous release is the installation again');
    if (state === 'prepared') {
      const compose = JSON.parse(await readFile(join(operations.directory(), 'compose.json'), 'utf8'));
      assert.equal(compose.services['frameleaf-server'].image, image, 'the previous release stack was rendered before the start');
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const started of ['starting', 'complete'])
test(`an update that journaled its start, or applied its release, is not cancellable (${started})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-started-'));
  const store = new Store(directory);
  try {
    store.set('installation', { release: 'frameleaf-v1.1.17', mayHaveWrittenMedia: true });
    const operations = new Operations(store, {} as never, {} as never, {} as never, [], {} as never);
    const { operation } = store.start('update', started, { reviewId: 'r' });
    operation.completed = ['download-images', 'stop-application', 'database-checkpoint'];
    operation.step = 'apply-release';
    operation.state = 'failed';
    if (started === 'starting') operation.receipts['release-start-state'] = 'starting';
    else { operation.completed.push('apply-release'); operation.step = 'start'; }
    store.save(operation);
    assert.equal(operations.history()[0].canCancel, false);
    await assert.rejects(operations.recover(operation.id), /manual_media_recovery_required/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Issue 863: a target that starts but never turns healthy is rolled back to the previous release and
// the pre-update checkpoint, instead of being left as the installation to boot-loop.
test('an update whose server never turns healthy restores the previous release and its database', async () => {
  process.env.MANAGER_ML_ACCELERATION = 'cpu';
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-rollback-'));
  const store = new Store(directory);
  try {
    const image = (name: string) => `fixture.invalid/${name}@sha256:${'a'.repeat(64)}`;
    const current = { id: 'a'.repeat(12), project: 'frameleaf-test', release: 'frameleaf-v1.2.2', ml: false,
      mounts: [], origin: 'new_library', port: 2283, sourceId: null, mayHaveWrittenMedia: true,
      databaseRoot: directory, databasePath: join(directory, 'db-$old') };
    const release = { directory, nas: { tag: 'frameleaf-v1.2.3',
      images: { server: image('new-server'), postgres: image('postgres'), machineLearning: image('ml') } } };
    await writeFile(join(directory, 'docker-compose.yml'), JSON.stringify({ services: {
      database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {},
    } }));
    const previousCompose = { services: {
      // renderCompose doubles `$` for Compose interpolation.
      database: { image: image('postgres'), volumes: [{ type: 'bind', source: join(directory, 'db-$$old'), target: '/var/lib/postgresql' }] },
      'frameleaf-server': { image: image('old-server') },
    } };
    await mkdir(join(directory, 'stack'));
    await writeFile(join(directory, 'stack', 'compose.json'), JSON.stringify(previousCompose));
    store.set('installation', current);
    store.set('database-password', 'fixture-only');
    const { operation } = store.start('update', 'rollback', { reviewId: 'r' });
    const checkpoint = join(directory, 'checkpoints', operation.id);
    await mkdir(checkpoint, { recursive: true });
    await writeFile(join(checkpoint, 'database.dump'), 'pre-update dump');
    await writeFile(join(checkpoint, 'compose.json'), JSON.stringify(previousCompose));
    operation.completed = ['download-images', 'stop-application', 'database-checkpoint'];
    operation.receipts['checkpoint-dump'] = { sha256: await (await import('../src/files.js')).fileHash(join(checkpoint, 'database.dump')) };
    store.save(operation);

    const composed: unknown[][] = [];
    const restored: string[] = [];
    let targetStarts = 0;
    const docker = {
      compose: async (_dir: string, project: string, action: string, services: string[] = []) => {
        composed.push([action, ...services]);
        const stack = JSON.parse(await readFile(join(directory, 'stack', 'compose.json'), 'utf8'));
        if (action === 'up' && !services.length && stack.services['frameleaf-server'].image === image('new-server')) {
          targetStarts++;
          throw new Error('container frameleaf-test-frameleaf-server-1 is unhealthy');
        }
      },
      inventory: async () => [{ Id: 'b'.repeat(64), Config: { Labels: {
        'app.frameleaf.manager': current.id, 'com.docker.compose.service': 'database' } },
        Mounts: [{ Type: 'bind', Source: store.get<any>('installation').databasePath, RW: true, Destination: '/var/lib/postgresql' }] }],
      verifyDump: async () => {},
      restore: async (_db: unknown, file: string) => { restored.push(file); },
    };
    const databaseStorage = { verify: async () => {}, allocate: async () => join(directory, 'db-$rollback') };
    const operations = new Operations(store, docker as never, { eligible: async () => {} } as never, {} as never, [],
      databaseStorage as never);
    (operations as any).fencing = { assertMedia: async () => {}, verify: async () => {} };

    await (operations as any).applyUpdate(operation, { current, release, platform: 'linux/amd64' });

    assert.equal(targetStarts, 1, 'the new release was started once');
    assert.equal(operation.receipts['rollback-intent'], 'release_start_failed');
    assert.equal(operation.receipts['cancelled'], 'update_failed_rolled_back');
    assert.deepEqual(composed, [['up'], ['stop'], ['up', 'database'], ['up']]);
    assert.deepEqual(restored, [join(checkpoint, 'database.dump')]);
    const installation = store.get<any>('installation');
    assert.equal(installation.release, 'frameleaf-v1.2.2', 'the previous release is the installation again');
    assert.equal(installation.databasePath, join(directory, 'db-$rollback'), 'the checkpoint went into an empty directory');
    assert.deepEqual(store.get('retained-database-directories'), [current.databasePath], 'the migrated directory is kept');
    assert.deepEqual(store.get('rolled-back-releases'), ['frameleaf-v1.2.3'], 'automatic updates skip it from now on');
    const stack = JSON.parse(await readFile(join(directory, 'stack', 'compose.json'), 'utf8'));
    assert.equal(stack.services['frameleaf-server'].image, image('old-server'));
    assert.equal(stack.services.database.volumes[0].source, join(directory, 'db-$$rollback'));
    // A resumed rollback is not retargeted, even once the failed release is withdrawn, and never starts it again.
    const review = { current, release, platform: 'linux/amd64', expires: Date.now() - 1 };
    assert.equal(await (operations as any).retargetWithdrawnUpdate(operation, review), review);
    await (operations as any).applyUpdate(operation, { current, release, platform: 'linux/amd64' });
    assert.equal(targetStarts, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Review: a target that passed its health check may have accepted writes, so a later failure is not rolled back.
test('an update that fails after its server turned healthy is not rolled back', async () => {
  process.env.MANAGER_ML_ACCELERATION = 'cpu';
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-started-healthy-'));
  const store = new Store(directory);
  try {
    const image = `fixture.invalid/server@sha256:${'a'.repeat(64)}`;
    const current = { id: 'a'.repeat(12), project: 'frameleaf-test', release: 'frameleaf-v1.2.2', ml: false,
      mounts: [], origin: 'new_library', port: 2283, sourceId: null, mayHaveWrittenMedia: true,
      databaseRoot: directory, databasePath: join(directory, 'db') };
    const release = { directory, nas: { tag: 'frameleaf-v1.2.3', images: { server: image, postgres: image, machineLearning: image } } };
    await writeFile(join(directory, 'docker-compose.yml'), JSON.stringify({ services: {
      database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {},
    } }));
    await mkdir(join(directory, 'stack'));
    await writeFile(join(directory, 'stack', 'compose.json'), JSON.stringify({ services: { database: { image } } }));
    store.set('installation', current);
    store.set('database-password', 'fixture-only');
    const { operation } = store.start('update', 'healthy', { reviewId: 'r' });
    operation.completed = ['download-images', 'stop-application', 'database-checkpoint'];
    store.save(operation);
    const composed: string[] = [];
    const operations = new Operations(store, { compose: async (_d: string, _p: string, action: string) => { composed.push(action); } } as never,
      { eligible: async () => {} } as never, {} as never, [], { verify: async () => {} } as never);
    (operations as any).fencing = { assertMedia: async () => {} };
    (operations as any).libraryStatus = async () => { throw new Error('status request failed'); };
    await assert.rejects((operations as any).applyUpdate(operation, { current, release }), /status request failed/);
    assert.equal(operation.receipts['release-start-state'], 'started');
    assert.equal(operation.receipts['rollback-intent'], undefined);
    assert.deepEqual(composed, ['up'], 'nothing was stopped or restored');
    assert.equal(store.get<any>('installation').release, 'frameleaf-v1.2.3');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Review: `up --wait` also fails when machine learning fails after the server was healthy and took writes.
test('a failed start whose server passed a health probe keeps the new database', async () => {
  process.env.MANAGER_ML_ACCELERATION = 'cpu';
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-served-'));
  const store = new Store(directory);
  try {
    const image = `fixture.invalid/server@sha256:${'a'.repeat(64)}`;
    const current = { id: 'a'.repeat(12), project: 'frameleaf-test', release: 'frameleaf-v1.2.2', ml: false,
      mounts: [], origin: 'new_library', port: 2283, sourceId: null, mayHaveWrittenMedia: true,
      databaseRoot: directory, databasePath: join(directory, 'db') };
    const release = { directory, nas: { tag: 'frameleaf-v1.2.3', images: { server: image, postgres: image, machineLearning: image } } };
    await writeFile(join(directory, 'docker-compose.yml'), JSON.stringify({ services: {
      database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {},
    } }));
    await mkdir(join(directory, 'stack'));
    await writeFile(join(directory, 'stack', 'compose.json'), JSON.stringify({ services: { database: { image } } }));
    store.set('installation', current);
    store.set('database-password', 'fixture-only');
    const { operation } = store.start('update', 'served', { reviewId: 'r' });
    operation.completed = ['download-images', 'stop-application', 'database-checkpoint'];
    store.save(operation);
    const composed: string[] = [];
    const docker = {
      compose: async (_d: string, _p: string, action: string) => {
        composed.push(action);
        throw new Error('container frameleaf-test-frameleaf-machine-learning-1 exited (1)');
      },
      inventory: async () => [{ Id: 'c'.repeat(64), Config: { Image: image, Labels: {
        'app.frameleaf.manager': current.id, 'com.docker.compose.service': 'frameleaf-server' } },
        State: { Running: true, Health: { Status: 'unhealthy', Log: [{ ExitCode: 0 }, { ExitCode: 1 }] } } }],
    };
    const operations = new Operations(store, docker as never, { eligible: async () => {} } as never, {} as never, [],
      { verify: async () => {} } as never);
    (operations as any).fencing = { assertMedia: async () => {} };
    await assert.rejects((operations as any).applyUpdate(operation, { current, release }), /machine-learning/);
    assert.equal(operation.receipts['release-start-state'], 'started');
    assert.equal(operation.receipts['rollback-intent'], undefined);
    assert.deepEqual(composed, ['up'], 'nothing was stopped or restored');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Review: a successful probe can age out of Docker's five-entry health log before `up --wait` fails.
test('a server seen healthy while starting is never rolled back after its probe ages out', async (t) => {
  process.env.MANAGER_ML_ACCELERATION = 'cpu';
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-aged-probe-'));
  const store = new Store(directory);
  try {
    const image = `fixture.invalid/server@sha256:${'a'.repeat(64)}`;
    const current = { id: 'a'.repeat(12), project: 'frameleaf-test', release: 'frameleaf-v1.2.2', ml: false,
      mounts: [], origin: 'new_library', port: 2283, sourceId: null, mayHaveWrittenMedia: true,
      databaseRoot: directory, databasePath: join(directory, 'db') };
    const release = { directory, nas: { tag: 'frameleaf-v1.2.3', images: { server: image, postgres: image, machineLearning: image } } };
    await writeFile(join(directory, 'docker-compose.yml'), JSON.stringify({ services: {
      database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {},
    } }));
    await mkdir(join(directory, 'stack'));
    await writeFile(join(directory, 'stack', 'compose.json'), JSON.stringify({ services: { database: { image } } }));
    store.set('installation', current);
    store.set('database-password', 'fixture-only');
    const { operation } = store.start('update', 'aged', { reviewId: 'r' });
    operation.completed = ['download-images', 'stop-application', 'database-checkpoint'];
    store.save(operation);
    let log = [{ ExitCode: 0 }];
    const composed: string[] = [];
    const docker = {
      compose: async (_d: string, _p: string, action: string) => {
        composed.push(action);
        await new Promise((pause) => setTimeout(pause, 50)); // the watcher sees the healthy probe
        log = [1, 1, 1, 1, 1].map((ExitCode) => ({ ExitCode })); // ...which then ages out
        throw new Error('container frameleaf-test-frameleaf-server-1 is unhealthy');
      },
      inventory: async () => [{ Id: 'c'.repeat(64), Config: { Image: image, Labels: {
        'app.frameleaf.manager': current.id, 'com.docker.compose.service': 'frameleaf-server' } },
        State: { Running: true, Health: { Status: log.some((p) => p.ExitCode === 0) ? 'healthy' : 'unhealthy', Log: log } } }],
    };
    const operations = new Operations(store, docker as never, { eligible: async () => {} } as never, {} as never, [],
      { verify: async () => {} } as never);
    operations.serverWatchMs = 5;
    (operations as any).fencing = { assertMedia: async () => {} };
    // The first journal write of the receipt fails: the poll logs it, forgets the receipt and retries.
    const save = store.save.bind(store);
    let failed = false;
    t.mock.method(store, 'save', (saved: any) => {
      if (saved.receipts['server-served'] && !failed) {
        failed = true;
        throw new Error('disk full');
      }
      save(saved);
    });
    await assert.rejects((operations as any).applyUpdate(operation, { current, release }), /unhealthy/);
    assert.ok(failed);
    assert.equal(store.history()[0].receipts['server-served'], true, 'journaled while starting');
    assert.equal(operation.receipts['release-start-state'], 'started');
    assert.equal(operation.receipts['rollback-intent'], undefined);
    assert.deepEqual(composed, ['up'], 'nothing was stopped or restored');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Review: a failed journal write in the final health check must not replace the start's own error.
test('a failed start reports its own error when the final health receipt cannot be journaled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-final-check-'));
  const store = new Store(directory);
  try {
    const image = `fixture.invalid/server@sha256:${'a'.repeat(64)}`;
    const review = { current: { id: 'a'.repeat(12) }, release: { nas: { images: { server: image } } } };
    const { operation } = store.start('update', 'final', { reviewId: 'r' });
    const operations = new Operations(store, { inventory: async () => [{ Config: { Image: image, Labels: {
      'app.frameleaf.manager': 'a'.repeat(12), 'com.docker.compose.service': 'frameleaf-server' } },
      State: { Running: true, Health: { Status: 'healthy' } } }] } as never, {} as never, {} as never, [], {} as never);
    operations.serverWatchMs = 60_000; // only the final check runs
    t.mock.method(store, 'save', () => { throw new Error('disk full'); });
    await assert.rejects(
      (operations as any).watchServer(operation, review, async () => { throw new Error('server unhealthy'); }),
      /server unhealthy/,
    );
    assert.equal(operation.receipts['server-served'], undefined, 'an unjournaled receipt is not kept');
  } finally {
    t.mock.restoreAll();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// FL-1254: a poll already running when the start fails journals `server-served` before the caller decides
// between keeping the target and rolling back, never after the rollback intent.
test('a health poll in flight when the start fails is awaited before the rollback decision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-update-in-flight-'));
  const store = new Store(directory);
  try {
    const image = `fixture.invalid/server@sha256:${'a'.repeat(64)}`;
    const review = { current: { id: 'a'.repeat(12) }, release: { nas: { images: { server: image } } } };
    const { operation } = store.start('update', 'in-flight', { reviewId: 'r' });
    let polls = 0;
    let pollStarted!: () => void;
    let finishPoll!: () => void;
    const started = new Promise<void>((resolve) => (pollStarted = resolve));
    const finished = new Promise<void>((resolve) => (finishPoll = resolve));
    const healthy = [{ Config: { Image: image, Labels: {
      'app.frameleaf.manager': 'a'.repeat(12), 'com.docker.compose.service': 'frameleaf-server' } },
      State: { Running: true, Health: { Status: 'healthy' } } }];
    const operations = new Operations(store, { inventory: async () => {
      if (++polls > 1) return []; // a later check no longer sees the server
      pollStarted();
      await finished;
      return healthy;
    } } as never, {} as never, {} as never, [], {} as never);
    operations.serverWatchMs = 1;
    await assert.rejects(
      (operations as any).watchServer(operation, review, async () => {
        while (!polls) await new Promise((tick) => setTimeout(tick, 2)); // the poll timer itself is unref'd
        await started;
        setTimeout(finishPoll, 30); // the poll answers after the start has failed
        throw new Error('server unhealthy');
      }),
      /server unhealthy/,
    );
    assert.equal(operation.receipts['server-served'], true);
    assert.equal(store.history()[0].receipts['server-served'], true, 'journaled before watchServer returned');
    assert.equal(polls, 1, 'one poll at a time; the final check finds the journaled receipt');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// FL-1210: a `frameleaf-served` marker newer than the start keeps the new database even when Docker's bounded
// health log shows no pass; an older marker with no health pass rolls back.
for (const [marker, rollsBack] of [['after-start', false], ['before-start', true]] as const) {
  test(`a failed start with a frameleaf-served marker from ${marker} ${rollsBack ? 'rolls back' : 'keeps the new database'}`, async () => {
    process.env.MANAGER_ML_ACCELERATION = 'cpu';
    const directory = await mkdtemp(join(tmpdir(), 'manager-update-marker-'));
    const store = new Store(directory);
    try {
      const image = `fixture.invalid/server@sha256:${'a'.repeat(64)}`;
      const current = { id: 'a'.repeat(12), project: 'frameleaf-test', release: 'frameleaf-v1.2.2', ml: false,
        mounts: [], origin: 'new_library', port: 2283, sourceId: null, mayHaveWrittenMedia: true,
        databaseRoot: directory, databasePath: join(directory, 'db') };
      const release = { directory, nas: { tag: 'frameleaf-v1.2.3', images: { server: image, postgres: image, machineLearning: image } } };
      await writeFile(join(directory, 'docker-compose.yml'), JSON.stringify({ services: {
        database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {},
      } }));
      await mkdir(join(directory, 'stack'));
      await writeFile(join(directory, 'stack', 'compose.json'), JSON.stringify({ services: { database: { image } } }));
      store.set('installation', current);
      store.set('database-password', 'fixture-only');
      const { operation } = store.start('update', marker, { reviewId: 'r' });
      operation.completed = ['download-images', 'stop-application', 'database-checkpoint'];
      store.save(operation);
      const servedAt = () => new Date(Date.parse(operation.receipts['release-started-at'] as string)
        + (marker === 'after-start' ? 1000 : -1000)).toISOString();
      const docker = {
        compose: async () => { throw new Error('container frameleaf-test-frameleaf-server-1 is unhealthy'); },
        inventory: async () => [
          { Id: 'b'.repeat(64), Config: { Labels: { 'app.frameleaf.manager': current.id, 'com.docker.compose.service': 'database' } },
            Mounts: [{ Type: 'bind', Source: current.databasePath, RW: true, Destination: '/var/lib/postgresql' }] },
          { Id: 'c'.repeat(64), Config: { Image: image, Labels: {
            'app.frameleaf.manager': current.id, 'com.docker.compose.service': 'frameleaf-server' } },
            State: { Running: true, Health: { Status: 'unhealthy', Log: [{ ExitCode: 1 }] } } },
        ],
        sql: async (_db: unknown, query: string) => (query.includes("key='frameleaf-served'") ? `${servedAt()}\n` : ''),
      };
      const operations = new Operations(store, docker as never, { eligible: async () => {} } as never, {} as never, [],
        { verify: async () => {} } as never);
      operations.serverWatchMs = 60_000;
      (operations as any).fencing = { assertMedia: async () => {} };
      let rolledBack = false;
      (operations as any).rollbackUpdate = async () => { rolledBack = true; };
      if (rollsBack) await (operations as any).applyUpdate(operation, { current, release });
      else await assert.rejects((operations as any).applyUpdate(operation, { current, release }), /unhealthy/);
      assert.equal(rolledBack, rollsBack);
      assert.equal(operation.receipts['rollback-intent'], rollsBack ? 'release_start_failed' : undefined);
      assert.equal(operation.receipts['release-start-state'], rollsBack ? 'starting' : 'started');
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

// FL-1265: a frameleaf-postgres image that cannot open the data directory (19 beta 4 to 19 RC 1) moves the
// database by dump and restore into a new folder; the previous folder is never written again.
test('a database image the bundle does not declare in place moves by dump and restore', () => {
  const image = (tag: string, digest = 'a') => `ghcr.io/frameleaf/frameleaf-postgres:${tag}@sha256:${digest.repeat(64)}`;
  const beta = image('19beta4-pgvector0.8.7');
  const rc = image('19rc1-pgvector0.8.7', 'b');
  const release = (postgres: string, databaseImageChange?: any) => ({ images: { postgres } as any, databaseImageChange });
  assert.equal(databaseImageMove(beta, release(rc)), true, 'beta to RC moves');
  assert.equal(databaseImageMove(beta, release(beta)), false, 'same image stays');
  assert.equal(databaseImageMove(beta, release(image('20.0-pgvector0.9.0', 'c'))), true, 'a new major moves');
  assert.equal(databaseImageMove(image('20.0-pgvector0.9.0', 'c'), release(rc)), false, 'never to an older major');
  assert.equal(databaseImageMove('postgres:19', release(rc)), false, 'never from an image Manager cannot identify');
  assert.equal(databaseImageMove(beta, release('postgres:19@sha256:' + 'd'.repeat(64))), false);
  const declared = { strategy: 'in-place', from: [beta.split('@')[0]], to: rc.split('@')[0], requiresBackup: true };
  assert.equal(databaseImageMove(beta, release(rc, declared)), false, 'a declared in-place change is not moved');
  assert.equal(postgresVersion(rc), '19rc1');
  assert.equal(postgresVersion(beta.split('@')[0]), '19beta4');
  assert.equal(postgresVersion(image('19.0-pgvector0.8.7')), '19.0');
  assert.equal(postgresVersion(image('latest')), null);
  // A major-only tag names no exact version: the move then checks only the server's major (19.1 passes).
  assert.equal(postgresVersion(image('19-pgvector0.8.7')), null);
});

type MoveOptions = { space?: boolean; restore?: 'fails' | 'differs' | 'hangs'; start?: 'fails' };
async function databaseMoveFixture(options: MoveOptions = {}) {
  process.env.MANAGER_ML_ACCELERATION = 'cpu';
  const directory = await mkdtemp(join(tmpdir(), 'manager-database-move-'));
  const store = new Store(join(directory, 'state'));
  const digest = (c: string) => `@sha256:${c.repeat(64)}`;
  const beta = `ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7${digest('a')}`;
  const rc = `ghcr.io/frameleaf/frameleaf-postgres:19rc1-pgvector0.8.7${digest('b')}`;
  const server = (name: string) => `fixture.invalid/${name}${digest('c')}`;
  const id = 'a'.repeat(12);
  // renderCompose doubles `$` for Compose interpolation; the folder names contain one on purpose.
  const escaped = (path: string) => path.replaceAll('$', '$$$$');
  const current = { id, project: 'frameleaf-test', release: 'frameleaf-v1.2.5', ml: false, mounts: [], origin: 'new_library',
    port: 2283, sourceId: null, mayHaveWrittenMedia: true, databaseRoot: directory,
    databasePath: join(directory, `frameleaf-${id}-postgres-$old`) };
  const bundle = (tag: string, postgres: string, name: string) => ({ directory: join(directory, tag), nas: { tag,
    platforms: ['linux/amd64'], images: { server: server(name), postgres, machineLearning: server('ml') } } });
  const previousRelease = bundle(current.release, beta, 'old-server');
  const release = bundle('frameleaf-v1.2.6', rc, 'new-server');
  for (const { directory: folder } of [previousRelease, release]) {
    await mkdir(folder);
    await writeFile(join(folder, 'docker-compose.yml'), JSON.stringify({ services: {
      database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {} } }));
  }
  const previousCompose = { services: {
    database: { image: beta, volumes: [{ type: 'bind', source: escaped(current.databasePath), target: '/var/lib/postgresql' }] },
    'frameleaf-server': { image: server('old-server') },
  } };
  const stack = join(directory, 'state', 'stack', 'compose.json');
  await mkdir(join(directory, 'state', 'stack'), { recursive: true });
  await writeFile(stack, JSON.stringify(previousCompose));
  store.set('installation', current);
  store.set('database-password', 'fixture-only');
  store.set('application-config', { environment: {}, settings: null, services: {} });
  const review = { expires: Date.now() + 60_000, current, release, platform: 'linux/amd64' };
  store.set('update:r', review);
  const { operation } = store.start('update', 'move', { reviewId: 'r' });
  const checkpoint = join(directory, 'state', 'checkpoints', operation.id);
  await mkdir(checkpoint, { recursive: true });
  await writeFile(join(checkpoint, 'database.dump'), 'pre-update dump');
  await writeFile(join(checkpoint, 'compose.json'), JSON.stringify(previousCompose));
  operation.completed = ['download-images', 'stop-application', 'database-checkpoint'];
  operation.receipts['checkpoint-dump'] = { sha256: await fileHash(join(checkpoint, 'database.dump')) };
  store.save(operation);

  // The database "running" is whichever folder compose.json mounts; each folder holds its own tables.
  const library = { version: '19beta4', extensions: ['plpgsql', 'vector'], tables: { 'public.asset': 3, 'public.user': 1 } };
  const folders = new Map<string, any>([[current.databasePath, library]]);
  const running = async () => {
    const compose = JSON.parse(await readFile(stack, 'utf8'));
    const data = compose.services.database.volumes.find((v: any) => v.target === '/var/lib/postgresql');
    return { path: data.source.replaceAll('$$', '$') as string, compose };
  };
  const composed: string[][] = [];
  const restored: string[] = [];
  const allocated: number[] = [];
  let hang: () => void = () => {};
  const reachedRestore = new Promise<void>((resolve) => (hang = resolve));
  const docker = {
    compose: async (_dir: string, _project: string, action: string, services: string[] = []) => {
      composed.push([action, ...services]);
      const { path, compose } = await running();
      if (action === 'up' && !folders.has(path))
        folders.set(path, { version: compose.services.database.image === rc ? '19rc1' : '19beta4', extensions: ['plpgsql'], tables: {} });
      if (action === 'up' && !services.length && options.start === 'fails' && compose.services['frameleaf-server'].image === server('new-server'))
        throw new Error('container frameleaf-test-frameleaf-server-1 is unhealthy');
    },
    inventory: async () => [{ Id: 'b'.repeat(64), Config: { Labels: { 'app.frameleaf.manager': id, 'com.docker.compose.service': 'database' } },
      Mounts: [{ Type: 'bind', Source: (await running()).path, RW: true, Destination: '/var/lib/postgresql' }] }],
    sql: async (_db: unknown, query: string) => {
      if (query.includes('frameleaf-served')) return '';
      assert.match(query, /query_to_xml/);
      return JSON.stringify(folders.get((await running()).path));
    },
    verifyDump: async () => {},
    restore: async (_db: unknown, file: string) => {
      const { path } = await running();
      assert.notEqual(path, current.databasePath, 'never restored into the previous folder');
      assert.equal(file, join(checkpoint, 'database.dump'));
      restored.push(path);
      if (options.restore === 'hangs' && restored.length === 1) {
        hang();
        return new Promise<void>(() => {});
      }
      if (options.restore === 'fails') throw new Error('pg_restore: error: could not execute query');
      const copy = structuredClone(library);
      if (options.restore === 'differs') copy.tables['public.asset'] = 2;
      folders.set(path, { ...copy, version: folders.get(path).version });
    },
  };
  let attempt = 0;
  const databaseStorage = {
    verify: async () => {},
    validate: async () => ({}),
    allocate: async (root: string, installation: string, bytes: number) => {
      allocated.push(bytes);
      if (options.space === false) throw new Refusal('insufficient_database_space');
      return join(root, `frameleaf-${installation}-postgres-$new${++attempt}`);
    },
  };
  const releases = { eligible: async () => {}, verify: async () => {},
    acquire: async (tag: string) => (tag === current.release ? previousRelease : release) };
  const create = () => {
    const operations = new Operations(store, docker as never, releases as never, {} as never, [], databaseStorage as never);
    (operations as any).fencing = { assertMedia: async () => {}, verify: async () => {} };
    (operations as any).libraryStatus = async () => null;
    operations.serverWatchMs = 60_000;
    return operations;
  };
  return { directory, store, operation, review, current, release, previousCompose, beta, rc, folders,
    composed, restored, allocated, reachedRestore, create, escaped,
    stackNow: async () => JSON.parse(await readFile(stack, 'utf8')),
    cleanup: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const moved = (f: { directory: string; current: { id: string } }, attempt: number) =>
  join(f.directory, `frameleaf-${f.current.id}-postgres-$new${attempt}`);

test('an update to a new PostgreSQL build moves the database into a new folder and starts the release on it', async () => {
  const f = await databaseMoveFixture();
  try {
    await (f.create() as any).applyUpdate(f.operation, f.review);
    assert.deepEqual(f.composed, [['stop'], ['up', 'database'], ['up']]);
    assert.deepEqual(f.restored, [moved(f, 1)], 'the checkpoint went into the new folder only');
    assert.deepEqual(f.allocated, [1024 ** 3], 'room for the restored database (at least 1 GiB, dump x4)');
    assert.equal(f.operation.receipts['cancelled'], undefined);
    assert.equal(f.operation.receipts['rollback-intent'], undefined);
    assert.ok(f.operation.completed.includes('database-move') && f.operation.completed.includes('apply-release'));
    const installation = f.store.get<any>('installation');
    assert.equal(installation.release, f.release.nas.tag);
    assert.equal(installation.databasePath, moved(f, 1));
    const stack = await f.stackNow();
    assert.equal(stack.services.database.image, f.rc);
    assert.equal(stack.services.database.volumes.find((v: any) => v.target === '/var/lib/postgresql').source, f.escaped(moved(f, 1)));
    assert.deepEqual(f.folders.get(f.current.databasePath).tables, { 'public.asset': 3, 'public.user': 1 }, 'previous folder unchanged');
    assert.deepEqual(f.store.get('retained-database-directories'), [f.current.databasePath], 'the previous folder is kept');
  } finally {
    await f.cleanup();
  }
});

for (const failure of ['fails', 'differs'] as const)
test(`a database move whose restore ${failure === 'fails' ? 'fails' : 'does not match'} puts the previous release back on its folder`, async () => {
  const f = await databaseMoveFixture({ restore: failure });
  try {
    await (f.create() as any).applyUpdate(f.operation, f.review);
    assert.equal(f.operation.receipts['rollback-intent'], failure === 'fails' ? 'database_move_failed' : 'database_move_verification_failed');
    assert.equal(f.operation.receipts['cancelled'], 'database_move_failed_rolled_back');
    assert.deepEqual(f.composed, [['stop'], ['up', 'database'], ['stop'], ['up']], 'no restore into the previous folder');
    assert.deepEqual(await f.stackNow(), f.previousCompose, 'the previous image and folder');
    assert.deepEqual(f.store.get<any>('installation'), f.current);
    assert.deepEqual(f.store.get('retained-database-directories'), [moved(f, 1)]);
    assert.deepEqual(f.store.get('rolled-back-releases'), [f.release.nas.tag]);
    assert.ok(!f.operation.completed.includes('apply-release'), 'the new release never started');
  } finally {
    await f.cleanup();
  }
});

test('a database move without room for the new folder changes nothing and restarts the previous release', async () => {
  const f = await databaseMoveFixture({ space: false });
  try {
    await (f.create() as any).applyUpdate(f.operation, f.review);
    assert.equal(f.operation.receipts['rollback-intent'], 'insufficient_database_space');
    assert.equal(f.operation.receipts['cancelled'], 'database_move_failed_rolled_back');
    assert.deepEqual(f.composed, [['stop'], ['up']]);
    assert.deepEqual(f.restored, []);
    assert.deepEqual(await f.stackNow(), f.previousCompose);
    assert.deepEqual(f.store.get<any>('installation'), f.current);
  } finally {
    await f.cleanup();
  }
});

test('reviewing an update that moves the database checks the database drive has room for a second copy', async () => {
  for (const room of [true, false]) {
    const f = await databaseMoveFixture();
    try {
      const operations = f.create() as any;
      const checked: unknown[][] = [];
      operations.databaseStorage.validate = async (...args: unknown[]) => {
        checked.push(args);
        if (!room) throw new Refusal('insufficient_database_space');
        return {};
      };
      operations.docker.compatibility = async () => ({ platform: 'linux/amd64' });
      operations.docker.sql = async (_db: unknown, query: string) =>
        query.includes('pg_database_size') ? String(3 * 1024 ** 3) : JSON.stringify({ major: 19, extensions: [] });
      if (!room) {
        await assert.rejects(operations.reviewUpdate(f.release.nas.tag), /insufficient_database_space/);
        continue;
      }
      const review = await operations.reviewUpdate(f.release.nas.tag);
      assert.deepEqual(checked, [[f.current.databaseRoot, 3 * 1024 ** 3, f.current.id]]);
      assert.deepEqual(review.databaseMove, { from: '19beta4', to: '19rc1', bytes: 3 * 1024 ** 3 });
      assert.match(review.recovery, /new folder beside the current one/);
      assert.equal(f.store.get<any>(`update:${review.id}`).databaseMove.to, f.rc);
    } finally {
      await f.cleanup();
    }
  }
});

test('a moved release that does not start goes back to the previous folder without restoring the checkpoint', async () => {
  const f = await databaseMoveFixture({ start: 'fails' });
  try {
    await (f.create() as any).applyUpdate(f.operation, f.review);
    assert.equal(f.operation.receipts['rollback-intent'], 'release_start_failed');
    assert.equal(f.operation.receipts['cancelled'], 'update_failed_rolled_back');
    assert.deepEqual(f.restored, [moved(f, 1)], 'only the move restored, into its own folder');
    assert.deepEqual(f.composed, [['stop'], ['up', 'database'], ['up'], ['stop'], ['up']]);
    assert.deepEqual(await f.stackNow(), f.previousCompose);
    assert.deepEqual(f.store.get<any>('installation'), f.current);
    assert.ok(f.operation.completed.includes('rollback-previous-database'));
    assert.ok(!f.operation.completed.includes('rollback-restore-database'));
  } finally {
    await f.cleanup();
  }
});

test('an interrupted database move resumes into another new folder and keeps the partial one', async () => {
  const f = await databaseMoveFixture({ restore: 'hangs' });
  try {
    // Manager stops while pg_restore runs: the journal is all the next Manager has.
    void (f.create() as any).applyUpdate(f.operation, f.review);
    await f.reachedRestore;
    const journal = f.store.history().find((o) => o.id === f.operation.id)!;
    assert.equal(journal.step, 'database-move');
    assert.deepEqual((journal.receipts['database-move-intent'] as any).attempts, [moved(f, 1)]);
    await (f.create() as any).applyUpdate(journal, f.review);
    assert.deepEqual(f.restored, [moved(f, 1), moved(f, 2)]);
    assert.ok(journal.completed.includes('apply-release'));
    assert.equal(f.store.get<any>('installation').databasePath, moved(f, 2));
    assert.deepEqual(f.store.get('retained-database-directories'), [f.current.databasePath, moved(f, 1)]);
    assert.deepEqual(f.folders.get(moved(f, 2)).tables, f.folders.get(f.current.databasePath).tables);
  } finally {
    await f.cleanup();
  }
});

test('cancelling an interrupted database move restarts the previous release on its own folder', async () => {
  const f = await databaseMoveFixture({ restore: 'hangs' });
  try {
    void (f.create() as any).applyUpdate(f.operation, f.review);
    await f.reachedRestore;
    const journal = f.store.history().find((o) => o.id === f.operation.id)!;
    journal.state = 'interrupted';
    f.store.save(journal);
    const operations = f.create();
    const listed = operations.history().find((o) => o.id === journal.id)!;
    assert.equal(listed.canCancel, true);
    assert.equal(listed.databaseMove, true);
    await operations.recover(journal.id);
    assert.equal(f.store.history().find((o) => o.id === journal.id)!.receipts['cancelled'], 'update_cancelled_previous_release_running');
    const stack = await f.stackNow();
    assert.equal(stack.services.database.image, f.beta);
    assert.equal(stack.services.database.volumes.find((v: any) => v.target === '/var/lib/postgresql').source,
      f.escaped(f.current.databasePath));
    assert.deepEqual(f.store.get<any>('installation'), f.current);
    assert.deepEqual(f.store.get('retained-database-directories'), [moved(f, 1)]);
  } finally {
    await f.cleanup();
  }
});
