import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Operations } from '../src/operations.js';
import { Releases } from '../src/releases.js';
import { compareReleases } from '../src/release-order.js';
import { Store } from '../src/store.js';
import { Refusal, databaseImageChangeAllowed, postgresMajor } from '../src/contracts.js';
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
    assert.equal(persistedState(), interrupt === 'selected' ? 'prepared' : 'starting');
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
      databaseRoot: directory, databasePath: join(directory, 'db-old') };
    const release = { directory, nas: { tag: 'frameleaf-v1.2.3',
      images: { server: image('new-server'), postgres: image('postgres'), machineLearning: image('ml') } } };
    await writeFile(join(directory, 'docker-compose.yml'), JSON.stringify({ services: {
      database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {},
    } }));
    const previousCompose = { services: {
      database: { image: image('postgres'), volumes: [{ type: 'bind', source: current.databasePath, target: '/var/lib/postgresql' }] },
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
    const databaseStorage = { verify: async () => {}, allocate: async () => join(directory, 'db-rollback') };
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
    assert.equal(installation.databasePath, join(directory, 'db-rollback'), 'the checkpoint went into an empty directory');
    assert.deepEqual(store.get('retained-database-directories'), [current.databasePath], 'the migrated directory is kept');
    const stack = JSON.parse(await readFile(join(directory, 'stack', 'compose.json'), 'utf8'));
    assert.equal(stack.services['frameleaf-server'].image, image('old-server'));
    assert.equal(stack.services.database.volumes[0].source, join(directory, 'db-rollback'));
    // A resumed rollback never starts the failed release again.
    await (operations as any).applyUpdate(operation, { current, release, platform: 'linux/amd64' });
    assert.equal(targetStarts, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
