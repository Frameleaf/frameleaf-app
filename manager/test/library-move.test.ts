import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { LibraryMove, type ServerPause } from '../src/library-move.js';
import { Refusal, sha256, type Installation } from '../src/contracts.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const worker = createRequire(import.meta.url)('../media-copy.cjs');
import { filesystemMounts } from '../src/postgres-storage.js';

test('a move rejects unsupported mappings and overlapping storage before stopping any writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-move-'));
  const store = new Store(directory);
  const source = join(directory, 'media'),
    target = join(directory, 'new-drive');
  await mkdir(source);
  await mkdir(target);
  const installation = {
    id: 'a'.repeat(12),
    project: 'frameleaf-' + 'a'.repeat(12),
    mounts: [{ type: 'bind', source, target: '/data', readOnly: false }],
    databaseRoot: join(directory, 'database'),
    databasePath: join(directory, 'database', 'pg'),
  } as Installation;
  store.set('installation', installation);
  const move = new LibraryMove(store, {} as any, {} as any, {} as any, directory, '/separate-backups');
  try {
    store.set('installation', {
      ...installation,
      mounts: [{ ...installation.mounts[0], type: 'volume' }],
    });
    await assert.rejects(move.review(target), /unsupported_media_mappings/);
    store.set('installation', installation);
    await assert.rejects(move.review(source), /media_move_overlap/);
    await assert.rejects(move.review(installation.databaseRoot), /media_move_overlap/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('move configuration changes exactly the reviewed media mapping and preserves database/settings', async () => {
  const original = {
    services: {
      'frameleaf-server': {
        image: 'immutable',
        environment: { secret: 'retained' },
        volumes: [
          { type: 'bind', source: '/old', target: '/data', read_only: false },
          {
            type: 'bind',
            source: '/private-token',
            target: '/run/token',
            read_only: true,
          },
        ],
      },
      database: {
        image: 'postgres-pin',
        volumes: [{ source: '/postgres', target: '/var/lib/postgresql' }],
      },
    },
  };
  const changed = LibraryMove.configuration(
    original,
    { type: 'bind', source: '/old', target: '/data', readOnly: false },
    '/new',
  );
  assert.equal(changed.services['frameleaf-server'].volumes[0].source, '/new');
  assert.deepEqual(changed.services.database, original.services.database);
  assert.deepEqual(changed.services['frameleaf-server'].environment, original.services['frameleaf-server'].environment);
  assert.deepEqual(changed.services['frameleaf-server'].volumes[1], original.services['frameleaf-server'].volumes[1]);
  assert.equal(original.services['frameleaf-server'].volumes[0].source, '/old');
  assert.throws(
    () =>
      LibraryMove.configuration(
        original,
        {
          type: 'bind',
          source: '/different',
          target: '/data',
          readOnly: false,
        },
        '/new',
      ),
    /media_mapping_changed/,
  );
});

test('post-start rollback is refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-move-'));
  const store = new Store(directory);
  const original = {
    id: 'a'.repeat(12),
    mounts: [],
  } as unknown as Installation;
  store.set('installation', original);
  const { operation } = store.start('move-library', 'key', {});
  operation.receipts['move-writes-intent'] = true;
  store.save(operation);
  const move = new LibraryMove(store, {} as any, {} as any, {} as any, directory, '/backups');
  try {
    await assert.rejects(move.recover(operation), /media_move_reverse_required/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** The server's FL-360 pause as the Manager sees it: durable across stack restarts, refused while stopped. */
class FakeServerPause implements ServerPause {
  state: { operationId: string } | null = null;
  busy = 0;
  calls: string[] = [];
  constructor(private running: () => boolean) {}
  private check() {
    if (!this.running()) throw new Refusal('application_unavailable');
  }
  private report() {
    return {
      paused: !!this.state,
      operationId: this.state?.operationId ?? null,
      drained: !!this.state && this.busy === 0,
      activeJobs: this.busy,
      writesInFlight: 0,
    };
  }
  async pause(operationId: string) {
    this.check();
    this.calls.push('pause');
    if (this.state && this.state.operationId !== operationId) throw new Refusal('pause_conflict');
    this.state = { operationId };
    return this.report();
  }
  async status() {
    this.check();
    this.calls.push('status');
    if (this.busy > 0) this.busy--;
    return this.report();
  }
  async resume(operationId: string) {
    this.check();
    this.calls.push('resume');
    if (this.state?.operationId === operationId) this.state = null;
    return this.report();
  }
}

async function movingFixture(
  run: (
    move: LibraryMove,
    store: Store,
    root: string,
    source: string,
    step: any,
    checkpoint: any,
    server: FakeServerPause,
    containers: any[],
  ) => Promise<void>,
) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'manager-move-runtime-')));
  const directory = join(base, 'state'),
    source = join(base, 'original'),
    root = join(base, 'new-drive');
  await mkdir(source);
  await mkdir(root);
  await writeFile(join(source, 'photo'), 'unchanged-original');
  const store = new Store(directory);
  await mkdir(join(directory, 'stack'));
  const current = {
    id: 'a'.repeat(12),
    project: 'frameleaf-' + 'a'.repeat(12),
    mounts: [{ type: 'bind', source, target: '/data', readOnly: false }],
    databaseRoot: join(base, 'database'),
    databasePath: join(base, 'database', 'pg'),
  } as Installation;
  store.set('installation', current);
  await writeFile(
    join(directory, 'stack', 'compose.json'),
    JSON.stringify({
      services: {
        'frameleaf-server': {
          volumes: [{ type: 'bind', source, target: '/data', read_only: false }],
        },
        database: { image: 'preserved' },
      },
    }),
  );
  const containers: any[] = [
    {
      Id: 'c'.repeat(64),
      Image: 'sha256:' + 'd'.repeat(64),
      State: { Running: true, Health: { Status: 'healthy' } },
      Config: {
        Env: ['MANAGER_DATA=' + directory],
        Labels: { 'app.frameleaf.manager.role': 'controller' },
      },
    },
    ...['frameleaf-server', 'database'].map((service, index) => ({
      Id: String(index + 1).repeat(64),
      State: { Running: true, Health: { Status: 'healthy' } },
      Config: {
        Env: [],
        Labels: {
          'app.frameleaf.manager': current.id,
          'com.docker.compose.service': service,
        },
      },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      },
      Mounts: service === 'frameleaf-server' ? [{ Type: 'bind', Source: source, Destination: '/data', RW: true }] : [],
    })),
  ];
  const docker: any = {
    inventory: async () => containers,
    node: async (id: string, script: string, args: string[]) => {
      const c = containers.find((c) => c.Id === id);
      return execFileSync(process.execPath, ['-e', script, '--', c.Mounts[0].Source, args[1]], { encoding: 'utf8' });
    },
    restartPolicy: async (id: string, policy: string) => {
      containers.find((c) => c.Id === id).HostConfig.RestartPolicy.Name = policy;
    },
    compose: async (_path: string, _project: string, _action: string, services?: string[]) => {
      for (const c of containers.filter(
        (c) =>
          c.Config.Labels['app.frameleaf.manager'] &&
          (!services || services.includes(c.Config.Labels['com.docker.compose.service'])),
      )) {
        c.State.Running = true;
        if (c.Mounts.length)
          c.Mounts[0].Source = JSON.parse(await readFile(join(directory, 'stack', 'compose.json'), 'utf8')).services[
            'frameleaf-server'
          ].volumes[0].source;
      }
    },
  };
  const fencing: any = {
    assertMedia: async () => {},
    stopInstallation: async () => {
      for (const c of containers.filter((c) => c.Config.Labels['app.frameleaf.manager'])) {
        c.State.Running = false;
        c.HostConfig.RestartPolicy.Name = 'no';
      }
    },
    verifyInstallation: async () => {
      if (containers.some((c) => c.Config.Labels['app.frameleaf.manager'] && c.State.Running))
        throw new Refusal('previous_installation_not_fenced');
    },
  };
  const execute: any = async (_binary: string, args: string[]) => {
    if (args[0] === 'inspect') {
      const c = containers.find((c) => c.Name === args[1]);
      if (!c) throw new Refusal('docker_operation_failed');
      return JSON.stringify([c]);
    }
    if (args[0] === 'rm') {
      containers.splice(
        containers.findIndex((c) => c.Id === args[1]),
        1,
      );
      return '';
    }
    const name = args[args.indexOf('--name') + 1],
      label = args[args.indexOf('--label') + 1];
    const c = {
      Id: sha256(name),
      Name: name,
      Image: containers[0].Image,
      State: { Running: true, Health: { Status: 'healthy' } },
      Config: {
        Labels: { 'app.frameleaf.move': label.split('=')[1] },
        Env: [],
      },
    };
    containers.push(c);
    const mounts = args.filter((_arg, index) => args[index - 1] === '--mount');
    const from = mounts[0].split(',')[1].slice(7),
      to = mounts[1].split(',')[1].slice(7),
      state = mounts[2].split(',')[1].slice(7);
    const manifest = join(state, 'manifest.json');
    try {
      const action = args.at(-1);
      const receipt =
        action === 'measure'
          ? await worker.measure(from)
          : action === 'freeze'
            ? await worker.freeze(from, manifest)
            : await worker[action](from, to, manifest, join(state, 'cancel'));
      return JSON.stringify(receipt);
    } finally {
      c.State.Running = false;
    }
  };
  const server = new FakeServerPause(
    () => containers.find((c) => c.Config.Labels['com.docker.compose.service'] === 'frameleaf-server').State.Running,
  );
  const move = new LibraryMove(
    store,
    docker,
    fencing,
    { validate: async () => {} } as any,
    directory,
    join(base, 'backups'),
    execute,
    server,
    { timeoutMs: 200, intervalMs: 1 },
  );
  // Host mount authority is separately exercised by the existing storage tests; this fixture tests the journal with real file copying.
  (move as any).physicalPaths = async () => {};
  const step = (operation: any, crash?: string) => async (name: string, action: any) => {
    if (operation.completed.includes(name)) return operation.receipts[name];
    operation.step = name;
    store.save(operation);
    const receipt = await action();
    if (crash === name) throw new Error('lost acknowledgement');
    operation.receipts[name] = receipt;
    operation.completed.push(name);
    operation.step = null;
    store.save(operation);
    return receipt;
  };
  const checkpoint = (id: string) => async () => {
    const path = join(directory, 'checkpoints', id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'compose.json'), await readFile(join(directory, 'stack', 'compose.json')));
    return 'verified-fixture-snapshot';
  };
  try {
    await run(move, store, root, source, step, checkpoint, server, containers);
  } finally {
    store.close();
    await rm(base, { recursive: true, force: true });
  }
}

for (const crash of [
  'move-stop-writers',
  'move-checkpoint',
  'move-fence-stack',
  'move-freeze',
  'move-copy',
  'move-switch',
  'move-start',
]) {
  test(`lost acknowledgement at ${crash} resumes without losing originals or changing PostgreSQL`, async () => {
    await movingFixture(async (move, store, root, source, step, checkpoint, server) => {
      const review = await move.review(root);
      assert.equal(review.available, true);
      const { operation } = move.start(review.id, 'request');
      assert.equal(move.start(review.id, 'request').created, false);
      await assert.rejects(
        move.run(operation, step(operation, crash), checkpoint(operation.id), async () => ({
          verificationPassed: true,
          phase: 'complete',
        })),
        /lost acknowledgement/,
      );
      const resumed = store.history()[0];
      await move.run(resumed, step(resumed), checkpoint(resumed.id), async () => ({
        verificationPassed: true,
        phase: 'complete',
      }));
      const next = store.get<Installation>('installation')!;
      assert.notEqual(next.mounts[0].source, source);
      assert.equal(await readFile(join(source, 'photo'), 'utf8'), 'unchanged-original');
      assert.equal(await readFile(join(next.mounts[0].source, 'photo'), 'utf8'), 'unchanged-original');
      assert.equal(next.databasePath, join(root, '..', 'database', 'pg'));
      await assert.rejects(move.recover(resumed), /media_move_reverse_required/);
      assert.equal(server.state, null, 'uploads and jobs resume after the move');
      assert.ok(server.calls.includes('pause'));
    });
  });
}
test('stop before switching safely restores the old mapping and retains the copied destination', async () => {
  await movingFixture(async (move, store, root, source, step, checkpoint, server) => {
    const review = await move.review(root),
      { operation } = move.start(review.id, 'request');
    await assert.rejects(
      move.run(operation, step(operation, 'move-copy'), checkpoint(operation.id), async () => ({
        verificationPassed: true,
        phase: 'complete',
      })),
      /lost acknowledgement/,
    );
    await move.stop(operation);
    await move.recover(operation);
    assert.equal(store.get<Installation>('installation')!.mounts[0].source, source);
    assert.equal(server.state, null, 'a stopped move resumes uploads and jobs on the original folder');
    assert.ok(server.calls.includes('resume'));
    assert.equal(await readFile(join(source, 'photo'), 'utf8'), 'unchanged-original');
    assert.equal(
      await readFile(join(root, `frameleaf-${'a'.repeat(12)}-media-${operation.id}`, 'photo'), 'utf8'),
      'unchanged-original',
    );
  });
});

test('a server without the library move pause refuses the move before taking its operation lock', async () => {
  await movingFixture(async (move, store, root, source) => {
    (move as any).server = undefined;
    const review = await move.review(root);
    assert.equal(review.available, false);
    assert.throws(() => move.start(review.id, 'request'), /media_quiescence_unavailable/);
    assert.equal(store.history().length, 0);
    assert.equal(await readFile(join(source, 'photo'), 'utf8'), 'unchanged-original');
  });
});

test('the move waits until uploads and jobs have drained before stopping anything', async () => {
  await movingFixture(async (move, store, root, _source, step, checkpoint, server, containers) => {
    const review = await move.review(root),
      { operation } = move.start(review.id, 'request');
    server.busy = 3;
    const stop = (move as any).fencing.stopInstallation;
    let drainedAtStop: boolean | undefined;
    (move as any).fencing.stopInstallation = async (installation: Installation) => {
      if (drainedAtStop === undefined) drainedAtStop = server.busy === 0 && !!server.state;
      await stop(installation);
    };
    await move.run(operation, step(operation), checkpoint(operation.id), async () => ({
      verificationPassed: true,
      phase: 'complete',
    }));
    assert.equal(drainedAtStop, true);
    const paused = server.calls.indexOf('pause');
    assert.deepEqual(server.calls.slice(paused, paused + 4), ['pause', 'status', 'status', 'status']);
    assert.equal(server.calls.at(-1), 'resume');
    assert.equal(server.state, null);
    assert.ok(containers.every((c) => c.State.Running));
  });
});

test('a drain that does not finish in time resumes the server and stops nothing', async () => {
  await movingFixture(async (move, store, root, source, step, checkpoint, server, containers) => {
    server.busy = Number.POSITIVE_INFINITY;
    const review = await move.review(root),
      { operation } = move.start(review.id, 'request');
    await assert.rejects(
      move.run(operation, step(operation), checkpoint(operation.id), async () => ({
        verificationPassed: true,
        phase: 'complete',
      })),
      /media_quiescence_timeout/,
    );
    assert.equal(server.state, null);
    assert.equal(server.calls.at(-1), 'resume');
    assert.ok(containers.every((c) => c.State.Running), 'no container was stopped');
    assert.equal(operation.receipts['move-writer-policies'], undefined);
    assert.equal(store.get<Installation>('installation')!.mounts[0].source, source);
  });
});

test('a failed check after the switch still resumes uploads and jobs', async () => {
  await movingFixture(async (move, store, root, _source, step, checkpoint, server) => {
    const review = await move.review(root),
      { operation } = move.start(review.id, 'request');
    await assert.rejects(
      move.run(operation, step(operation), checkpoint(operation.id), async () => ({
        verificationPassed: false,
        phase: 'needs-attention',
      })),
      /media_move_library_needs_attention/,
    );
    assert.equal(server.state, null);
    assert.equal(operation.receipts['move-server-resumed'], true);
  });
});

test('host bind aliases resolve to the same physical backing path', () => {
  const mounts = filesystemMounts(
    '1 0 8:1 / /disk rw - ext4 /dev/sda rw\n2 0 8:1 /library /alias/library rw - ext4 /dev/sda rw',
  );
  assert.deepEqual(
    LibraryMove.backing('/disk/library/photo', mounts),
    LibraryMove.backing('/alias/library/photo', mounts),
  );
});

test('accepted cancellation while start fencing awaits cannot start writers', async () => {
  await movingFixture(async (move, store, root, source, step, checkpoint) => {
    const review = await move.review(root),
      { operation } = move.start(review.id, 'request');
    (move as any).fencing.assertMedia = async () => {
      if (operation.step === 'move-start') await move.stop(operation);
    };
    await assert.rejects(
      move.run(operation, step(operation), checkpoint(operation.id), async () => ({
        verificationPassed: true,
        phase: 'complete',
      })),
      /media_move_cancelled/,
    );
    assert.equal(operation.receipts['move-writes-intent'], undefined);
    await move.recover(operation);
    assert.equal(store.get<Installation>('installation')!.mounts[0].source, source);
  });
});

test('recovery with lost restart acknowledgement does not reject or overwrite new original writes', async () => {
  await movingFixture(async (move, store, root, source, step, checkpoint) => {
    const review = await move.review(root),
      { operation } = move.start(review.id, 'request');
    await assert.rejects(
      move.run(operation, step(operation, 'move-copy'), checkpoint(operation.id), async () => ({
        verificationPassed: true,
        phase: 'complete',
      })),
      /lost acknowledgement/,
    );
    await move.stop(operation);
    const compose = (move as any).docker.compose;
    let fail = true;
    (move as any).docker.compose = async (...args: any[]) => {
      await compose(...args);
      if (fail) {
        fail = false;
        await writeFile(join(source, 'photo'), 'new original write');
        throw new Error('restart response lost');
      }
    };
    await assert.rejects(move.recover(operation), /restart response lost/);
    const resumed = store.history()[0];
    await move.run(resumed, step(resumed), checkpoint(resumed.id), async () => ({
      verificationPassed: true,
      phase: 'complete',
    }));
    assert.equal(await readFile(join(source, 'photo'), 'utf8'), 'new original write');
    assert.equal(resumed.receipts['cancelled'], 'media_move_cancelled_original_retained');
  });
});

test('a failed media copy keeps its own error when cleanup finds no container', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-move-copy-'));
  const store = new Store(directory);
  const controller = {
    Image: `sha256:${'b'.repeat(64)}`,
    State: { Running: true },
    Config: { Labels: { 'app.frameleaf.manager.role': 'controller' }, Env: [`MANAGER_DATA=${directory}`] },
  };
  const calls: string[] = [];
  const execute = async (_binary: string, args: string[]) => {
    calls.push(args[0]);
    if (args[0] === 'run') throw new Error('copy failed');
    throw new Refusal('docker_operation_failed', 503);
  };
  const move = new LibraryMove(
    store,
    { inventory: async () => [controller] } as any,
    {} as any,
    {} as any,
    directory,
    '/backups',
    execute as any,
  );
  const review = { id: 'c'.repeat(36), current: { mounts: [{ source: join(directory, 'media') }] } };
  try {
    await assert.rejects((move as any).helper('copy', review, join(directory, 'target')), /copy failed/);
    assert.deepEqual(calls, ['inspect', 'run', 'inspect']);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a copier receipt error survives a failed container cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-move-receipt-'));
  const store = new Store(directory);
  const image = `sha256:${'b'.repeat(64)}`;
  const reviewId = 'd'.repeat(36);
  const controller = {
    Image: image,
    State: { Running: true },
    Config: { Labels: { 'app.frameleaf.manager.role': 'controller' }, Env: [`MANAGER_DATA=${directory}`] },
  };
  let inspections = 0;
  const execute = async (_binary: string, args: string[]) => {
    if (args[0] === 'run') return JSON.stringify({ error: 'media_copy_mismatch' });
    if (args[0] === 'rm') throw new Refusal('docker_operation_failed', 503);
    if (++inspections === 1) throw new Refusal('docker_operation_failed', 503);
    return JSON.stringify([
      { Id: 'e'.repeat(64), Image: image, State: { Running: false }, Config: { Labels: { 'app.frameleaf.move': reviewId } } },
    ]);
  };
  const move = new LibraryMove(
    store,
    { inventory: async () => [controller] } as any,
    {} as any,
    {} as any,
    directory,
    '/backups',
    execute as any,
  );
  const review = { id: reviewId, current: { mounts: [{ source: join(directory, 'media') }] } };
  try {
    await assert.rejects((move as any).helper('copy', review, join(directory, 'target')), /media_copy_mismatch/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
