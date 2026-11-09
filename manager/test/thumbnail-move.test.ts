import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { LibraryMove, type ServerPause } from '../src/library-move.js';
import { Operations } from '../src/operations.js';
import { Refusal, sha256, type Installation, type Mount } from '../src/contracts.js';
import { THUMBNAIL_TARGET } from '../src/mounts.js';
import { folderSize } from '../src/folder-size.js';

const worker = createRequire(import.meta.url)('../media-copy.cjs');
const ID = 'a'.repeat(12);
const status = async () => ({ verificationPassed: true, phase: 'complete' });

/** The FL-360 pause as the Manager sees it: refused while the server is stopped. */
class FakeServerPause implements ServerPause {
  state: { operationId: string } | null = null;
  calls: string[] = [];
  constructor(private running: () => boolean) {}
  private report() {
    return { paused: !!this.state, operationId: this.state?.operationId ?? null, drained: !!this.state, activeJobs: 0, writesInFlight: 0 };
  }
  private check() {
    if (!this.running()) throw new Refusal('application_unavailable');
  }
  async pause(operationId: string) {
    this.check();
    this.calls.push('pause');
    this.state = { operationId };
    return this.report();
  }
  async status() {
    this.check();
    return this.report();
  }
  async resume(operationId: string) {
    this.check();
    this.calls.push('resume');
    if (this.state?.operationId === operationId) this.state = null;
    return this.report();
  }
}

type Context = {
  move: LibraryMove;
  store: Store;
  base: string;
  photos: string;
  thumbs: string;
  root: string;
  directory: string;
  server: FakeServerPause;
  containers: any[];
  step: (operation: any, crash?: string) => (name: string, action: () => Promise<unknown>) => Promise<any>;
  checkpoint: (id: string) => () => Promise<string>;
  compose: () => Promise<any>;
};

/**
 * A library with photos and thumbnails on real folders, copied by the real helper. `own`: thumbnails already have a
 * folder of their own (FL-1320), else they are in the photos folder's `thumbs`.
 */
async function fixture(run: (context: Context) => Promise<void>, own = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'manager-thumbnail-move-')));
  const directory = join(base, 'state'),
    photos = join(base, 'photos'),
    root = join(base, 'fast-drive');
  const thumbs = own ? join(base, 'old-fast') : join(photos, 'thumbs');
  await mkdir(photos);
  await mkdir(root);
  await writeFile(join(photos, 'photo.jpg'), 'original photo');
  await mkdir(join(thumbs, 'user', 'ab'), { recursive: true });
  await writeFile(join(thumbs, '.frameleaf'), '1700000000000');
  await writeFile(join(thumbs, 'user', 'ab', 'one-thumbnail.webp'), 'thumbnail one');
  await writeFile(join(thumbs, 'user', 'ab', 'one-preview.jpeg'), 'preview one, a little larger');
  const store = new Store(directory);
  await mkdir(join(directory, 'stack'));
  const mounts: Mount[] = [
    { type: 'bind', source: photos, target: '/data', readOnly: false },
    ...(own ? [{ type: 'bind' as const, source: thumbs, target: THUMBNAIL_TARGET, readOnly: false }] : []),
  ];
  const current = {
    id: ID,
    project: `frameleaf-${ID}`,
    mounts,
    databaseRoot: join(base, 'database'),
    databasePath: join(base, 'database', 'pg'),
  } as Installation;
  store.set('installation', current);
  const composePath = join(directory, 'stack', 'compose.json');
  await writeFile(
    composePath,
    JSON.stringify({
      services: {
        'frameleaf-server': {
          volumes: [
            ...mounts.map((m) => ({ type: 'bind', source: m.source, target: m.target, read_only: false, bind: { create_host_path: false } })),
            { type: 'bind', source: join(directory, 'manager-token'), target: '/run/frameleaf/manager-token', read_only: true },
          ],
        },
        database: { image: 'preserved' },
      },
    }),
  );
  const compose = async () => JSON.parse(await readFile(composePath, 'utf8'));
  /** What Docker gives the server: every bind in compose.json, as the host sees it. */
  const serverMounts = async () =>
    (await compose()).services['frameleaf-server'].volumes.map((v: any) => ({ Type: 'bind', Source: v.source, Destination: v.target, RW: !v.read_only }));
  const containers: any[] = [
    {
      Id: 'c'.repeat(64),
      Image: 'sha256:' + 'd'.repeat(64),
      State: { Running: true },
      Config: { Env: ['MANAGER_DATA=' + directory], Labels: { 'app.frameleaf.manager.role': 'controller' } },
    },
    ...['frameleaf-server', 'database'].map((service, index) => ({
      Id: String(index + 1).repeat(64),
      State: { Running: true, Health: { Status: 'healthy' } },
      Config: { Env: [], Labels: { 'app.frameleaf.manager': ID, 'com.docker.compose.service': service } },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
      Mounts: [],
    })),
  ];
  containers[1].Mounts = await serverMounts();
  const docker: any = {
    inventory: async () => containers,
    checked: [] as string[],
    // Runs the server's read-back check against the host folder Docker would show at that container path.
    node: async (id: string, script: string, args: string[]) => {
      const c = containers.find((c) => c.Id === id);
      const mount = c.Mounts.filter((m: any) => args[0] === m.Destination)[0];
      docker.checked.push(...JSON.parse(args[1]).map((entry: { path: string }) => entry.path));
      return execFileSync(process.execPath, ['-e', script, '--', mount.Source, args[1]], { encoding: 'utf8' });
    },
    restartPolicy: async (id: string, policy: string) => {
      containers.find((c) => c.Id === id).HostConfig.RestartPolicy.Name = policy;
    },
    compose: async (_path: string, _project: string, _action: string, services?: string[]) => {
      for (const c of containers.filter(
        (c) => c.Config.Labels['app.frameleaf.manager'] && (!services || services.includes(c.Config.Labels['com.docker.compose.service'])),
      )) {
        c.State.Running = true;
        if (c.Config.Labels['com.docker.compose.service'] === 'frameleaf-server') c.Mounts = await serverMounts();
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
  // The isolated copy helper, run in this process on the folders it would mount.
  const execute: any = async (_binary: string, args: string[]) => {
    if (args[0] === 'inspect') {
      const c = containers.find((c) => c.Name === args[1]);
      if (!c) throw new Refusal('docker_operation_failed');
      return JSON.stringify([c]);
    }
    if (args[0] === 'rm') {
      containers.splice(containers.findIndex((c) => c.Id === args[1]), 1);
      return '';
    }
    const name = args[args.indexOf('--name') + 1],
      label = args[args.indexOf('--label') + 1];
    const c = {
      Id: sha256(name),
      Name: name,
      Image: containers[0].Image,
      State: { Running: true },
      Config: { Labels: { 'app.frameleaf.move': label.split('=')[1] }, Env: [] },
    };
    containers.push(c);
    const binds = args.filter((_arg, index) => args[index - 1] === '--mount').map((m) => m.split(',')[1].slice(7));
    const [from, to, state] = binds;
    const manifest = join(state, 'manifest.json');
    try {
      const action = args.at(-1)!;
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
  const move = new LibraryMove(store, docker, fencing, { validate: async () => {} } as any, directory, join(base, 'backups'), execute, server, {
    timeoutMs: 200,
    intervalMs: 1,
  });
  // Host mount authority is covered by the library move tests; this fixture copies real files.
  (move as any).physicalPaths = async () => {};
  const step = (operation: any, crash?: string) => async (name: string, action: () => Promise<unknown>) => {
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
    await writeFile(join(path, 'compose.json'), await readFile(composePath));
    return 'settings';
  };
  try {
    await run({ move, store, base, photos, thumbs, root, directory, server, containers, step, checkpoint, compose });
  } finally {
    store.close();
    await rm(base, { recursive: true, force: true });
  }
}

const destinationOf = (root: string, operationId: string) => join(root, `frameleaf-${ID}-thumbnails-${operationId}`);

test('thumbnails move from the photos folder to a faster drive; the photos are not touched', async () => {
  await fixture(async ({ move, store, photos, thumbs, root, server, step, checkpoint, compose, containers }) => {
    const review = await move.review(root, 'thumbs');
    // The review measures the real folder: three files, and their exact size.
    assert.equal(review.kind, 'thumbs');
    assert.equal(review.source, thumbs);
    assert.deepEqual({ files: review.files, bytes: review.bytes }, await folderSize(thumbs));
    assert.equal(review.files, 3);
    // A library move's review can't start a thumbnail move, or the other way around.
    assert.throws(() => move.start(review.id, 'request'), /review_expired/);
    const { operation } = move.start(review.id, 'request', 'thumbs');
    assert.equal(operation.kind, 'move-thumbnails');
    await move.run(operation, step(operation), checkpoint(operation.id), status);

    const destination = destinationOf(root, operation.id);
    const next = store.get<Installation>('installation')!;
    assert.deepEqual(next.mounts, [
      { type: 'bind', source: photos, target: '/data', readOnly: false },
      { type: 'bind', source: destination, target: THUMBNAIL_TARGET, readOnly: false },
    ]);
    // The thumbnails mapping comes straight after the library's, and the library mapping is unchanged.
    const volumes = (await compose()).services['frameleaf-server'].volumes;
    assert.deepEqual(
      volumes.map((v: any) => [v.source, v.target]),
      [[photos, '/data'], [destination, THUMBNAIL_TARGET], [volumes[2].source, '/run/frameleaf/manager-token']],
    );
    assert.equal(await readFile(join(destination, 'user', 'ab', 'one-thumbnail.webp'), 'utf8'), 'thumbnail one');
    assert.equal(await readFile(join(destination, '.frameleaf'), 'utf8'), '1700000000000', 'the marker came with the copy');
    // The photos and the original thumbnails are kept exactly as they were.
    assert.equal(await readFile(join(photos, 'photo.jpg'), 'utf8'), 'original photo');
    assert.equal(await readFile(join(thumbs, 'user', 'ab', 'one-preview.jpeg'), 'utf8'), 'preview one, a little larger');
    assert.deepEqual(store.get(`retained-thumbnails:${operation.id}`), { source: thumbs, destination, installation: review.current });
    // The server reads thumbnails back from the new folder, and uploads and jobs resume.
    assert.ok((move as any).docker.checked.includes('user/ab/one-thumbnail.webp'));
    assert.equal(server.state, null);
    assert.deepEqual(server.calls, ['pause', 'resume']);
    assert.ok(containers.filter((c) => c.Config.Labels['app.frameleaf.manager']).every((c) => c.State.Running));
    assert.equal(store.get<Installation>('installation')!.databasePath, review.current.databasePath);
  });
});

test('thumbnails on a folder of their own move to another drive, changing only that mapping', async () => {
  await fixture(
    async ({ move, store, photos, thumbs, root, step, checkpoint, compose }) => {
      const review = await move.review(root, 'thumbs');
      const { operation } = move.start(review.id, 'request', 'thumbs');
      await move.run(operation, step(operation), checkpoint(operation.id), status);
      const destination = destinationOf(root, operation.id);
      assert.deepEqual(
        store.get<Installation>('installation')!.mounts.map((m) => m.source),
        [photos, destination],
      );
      assert.deepEqual(
        (await compose()).services['frameleaf-server'].volumes.filter((v: any) => v.target === THUMBNAIL_TARGET).map((v: any) => v.source),
        [destination],
      );
      assert.equal(await readFile(join(thumbs, 'user', 'ab', 'one-thumbnail.webp'), 'utf8'), 'thumbnail one');
    },
    true,
  );
});

for (const crash of ['move-stop-writers', 'move-checkpoint', 'move-fence-stack', 'move-freeze', 'move-copy', 'move-verify', 'move-switch', 'move-start']) {
  test(`a thumbnail move whose ${crash} acknowledgement is lost resumes to the new folder`, async () => {
    await fixture(async ({ move, store, photos, root, step, checkpoint }) => {
      const review = await move.review(root, 'thumbs');
      const { operation } = move.start(review.id, 'request', 'thumbs');
      await assert.rejects(move.run(operation, step(operation, crash), checkpoint(operation.id), status), /lost acknowledgement/);
      const resumed = store.history()[0];
      await move.run(resumed, step(resumed), checkpoint(resumed.id), status);
      const mounts = store.get<Installation>('installation')!.mounts;
      assert.equal(mounts[0].source, photos);
      assert.equal(mounts[1].source, destinationOf(root, operation.id));
      assert.equal(await readFile(join(mounts[1].source, 'user', 'ab', 'one-thumbnail.webp'), 'utf8'), 'thumbnail one');
    });
  });
}

for (const crash of ['move-copy', 'move-verify', 'move-switch']) {
  test(`a thumbnail move interrupted at ${crash} returns to the original folder`, async () => {
    await fixture(async ({ move, store, photos, thumbs, root, server: pause, step, checkpoint, compose, containers }) => {
      const before = await compose();
      const review = await move.review(root, 'thumbs');
      const { operation } = move.start(review.id, 'request', 'thumbs');
      await assert.rejects(move.run(operation, step(operation, crash), checkpoint(operation.id), status), /lost acknowledgement/);
      // Manager restarts: the operation is interrupted, and Cancel safely goes back.
      const interrupted = store.history()[0];
      await move.recover(interrupted);
      assert.equal(interrupted.receipts['cancelled'], 'media_move_cancelled_original_retained');
      assert.deepEqual(store.get<Installation>('installation'), review.current);
      assert.deepEqual(await compose(), before, 'the stack runs on the original folders again');
      const server = containers.find((c) => c.Config.Labels['com.docker.compose.service'] === 'frameleaf-server');
      assert.ok(server.State.Running);
      assert.deepEqual(
        server.Mounts.filter((m: any) => m.Destination.startsWith('/data')).map((m: any) => m.Source),
        [photos],
        'the server reads thumbnails from the photos folder, where they were',
      );
      assert.equal(await readFile(join(thumbs, 'user', 'ab', 'one-thumbnail.webp'), 'utf8'), 'thumbnail one');
      assert.equal(await readFile(join(photos, 'photo.jpg'), 'utf8'), 'original photo');
      assert.equal(interrupted.receipts['move-server-resumed'], true);
      assert.equal(pause.state, null, 'uploads and jobs resume on the original folder');
      // The partial copy is kept, never deleted.
      assert.ok((await readdir(root)).includes(`frameleaf-${ID}-thumbnails-${operation.id}`));
    });
  });
}

test('a thumbnail move once Frameleaf has started on the new folder is not reversed', async () => {
  await fixture(async ({ move, store, root, step, checkpoint }) => {
    const review = await move.review(root, 'thumbs');
    const { operation } = move.start(review.id, 'request', 'thumbs');
    await assert.rejects(
      move.run(operation, step(operation), checkpoint(operation.id), async () => ({ verificationPassed: false, phase: 'needs-attention' })),
      /media_move_library_needs_attention/,
    );
    await assert.rejects(move.recover(store.history()[0]), /media_move_reverse_required/);
  });
});

test('a thumbnail move refuses a folder inside the photos, and a library with no thumbnails folder', async () => {
  await fixture(async ({ move, photos, thumbs }) => {
    await assert.rejects(move.review(join(photos, 'elsewhere'), 'thumbs'), /media_move_overlap/);
    await rm(thumbs, { recursive: true });
    await assert.rejects(move.review(join(photos, '..', 'fast-drive'), 'thumbs'), /thumbnail_folder_missing/);
  });
});

test('the thumbnails mapping is added after the library, or replaces the one there, with $ kept escaped', () => {
  const library: Mount = { type: 'bind', source: '/mnt/user/pho$tos', target: '/data', readOnly: false };
  const compose = {
    services: {
      'frameleaf-server': {
        volumes: [
          { type: 'bind', source: '/mnt/user/pho$$tos', target: '/data', read_only: false },
          { type: 'bind', source: '/token', target: '/run/frameleaf/manager-token', read_only: true },
        ],
      },
    },
  };
  const added = LibraryMove.thumbnailConfiguration(compose, { mounts: [library] } as Installation, '/mnt/cache/thu$mbs');
  assert.deepEqual(added.services['frameleaf-server'].volumes[1], {
    type: 'bind',
    source: '/mnt/cache/thu$$mbs',
    target: THUMBNAIL_TARGET,
    read_only: false,
    bind: { create_host_path: false },
  });
  assert.equal(compose.services['frameleaf-server'].volumes.length, 2, 'the original is not changed');
  const own: Mount = { type: 'bind', source: '/mnt/cache/thu$mbs', target: THUMBNAIL_TARGET, readOnly: false };
  const replaced = LibraryMove.thumbnailConfiguration(added, { mounts: [library, own] } as Installation, '/mnt/ssd/thumbs');
  assert.deepEqual(
    replaced.services['frameleaf-server'].volumes.map((v: any) => v.source),
    ['/mnt/user/pho$$tos', '/mnt/ssd/thumbs', '/token'],
  );
  assert.throws(
    () => LibraryMove.thumbnailConfiguration(compose, { mounts: [{ ...library, source: '/elsewhere' }] } as Installation, '/x'),
    /media_mapping_changed/,
  );
});

/** Operations with only what putting thumbnails back needs: compose.json, the stack and the server's rebuild call. */
async function homeFixture(run: (context: { operations: Operations; store: Store; photos: string; missing: string; directory: string; calls: string[] }) => Promise<void>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'manager-thumbnails-home-')));
  const directory = join(base, 'state'),
    photos = join(base, 'photos'),
    missing = join(base, 'unplugged', 'thumbs');
  await mkdir(photos);
  await writeFile(join(photos, 'photo.jpg'), 'original photo');
  const store = new Store(directory);
  await mkdir(join(directory, 'stack'), { recursive: true });
  const installation = {
    id: ID,
    project: `frameleaf-${ID}`,
    mounts: [
      { type: 'bind', source: photos, target: '/data', readOnly: false },
      { type: 'bind', source: missing, target: THUMBNAIL_TARGET, readOnly: false },
    ],
    databaseRoot: join(base, 'database'),
    databasePath: join(base, 'database', 'pg'),
  } as Installation;
  store.set('installation', installation);
  await writeFile(
    join(directory, 'stack', 'compose.json'),
    JSON.stringify({
      services: {
        'frameleaf-server': {
          volumes: [
            { type: 'bind', source: photos, target: '/data', read_only: false },
            { type: 'bind', source: missing, target: THUMBNAIL_TARGET, read_only: false },
            { type: 'bind', source: '/token', target: '/run/frameleaf/manager-token', read_only: true },
          ],
        },
      },
    }),
  );
  const calls: string[] = [];
  const docker = {
    inventory: async () => [],
    compose: async (_directory: string, _project: string, action: string, services: string[] = []) => {
      calls.push([action, ...services].join(' '));
    },
  };
  const operations = new Operations(store, docker as never, {} as never, {} as never, [base], {} as never);
  (operations as any).fencing = { assertMedia: async () => {} };
  (operations as any).librarySummary = async () => ({ assets: 412880 });
  (operations as any).serverRequest = async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    return { queued: true };
  };
  try {
    await run({ operations, store, photos, missing, directory, calls });
  } finally {
    store.close();
    await rm(base, { recursive: true, force: true });
  }
}

async function finished(store: Store, id: string) {
  for (let i = 0; i < 200; i++) {
    const operation = store.history().find((o) => o.id === id)!;
    if (operation.state !== 'running') return operation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the operation did not finish');
}

test('with the thumbnail drive missing, thumbnails go back with the photos and are queued to be made again', async () => {
  await homeFixture(async ({ operations, store, photos, missing, directory, calls }) => {
    const review = await operations.reviewThumbnailsHome();
    assert.deepEqual({ ...review, id: undefined }, { id: undefined, missing, folder: join(photos, 'thumbs'), assets: 412880 });
    const operation = await finished(store, operations.thumbnailsHome(review.id, crypto.randomUUID()).id);
    assert.equal(operation.state, 'complete', String(operation.error));
    assert.deepEqual(operation.completed, ['thumbs-home-switch', 'start', 'thumbs-queue']);
    assert.deepEqual(store.get<Installation>('installation')!.mounts, [{ type: 'bind', source: photos, target: '/data', readOnly: false }]);
    const compose = JSON.parse(await readFile(join(directory, 'stack', 'compose.json'), 'utf8'));
    assert.deepEqual(
      compose.services['frameleaf-server'].volumes.map((v: any) => v.target),
      ['/data', '/run/frameleaf/manager-token'],
    );
    assert.deepEqual(calls, ['stop frameleaf-server', 'up', 'POST library-move/manager/thumbnails']);
    // Only the photos folder's own `thumbs` folder is made, with the server's marker; the photos are untouched.
    assert.deepEqual((await readdir(photos)).sort(), ['photo.jpg', 'thumbs']);
    assert.deepEqual(await readdir(join(photos, 'thumbs')), ['.frameleaf']);
    assert.equal(await readFile(join(photos, 'photo.jpg'), 'utf8'), 'original photo');
    // The missing drive's folder is never recreated on the boot disk.
    await assert.rejects(readFile(join(missing, '..')), /ENOENT/);
  });
});

test('putting thumbnails back is offered only while their drive is missing, and goes forward only', async () => {
  await homeFixture(async ({ operations, store, missing, calls }) => {
    await mkdir(missing, { recursive: true });
    await assert.rejects(operations.reviewThumbnailsHome(), /thumbnail_folder_present/);
    await rm(join(missing, '..'), { recursive: true });
    const review = await operations.reviewThumbnailsHome();
    // The rebuild request fails once (the server is still starting): Resume finishes it, and Cancel is not offered.
    let failed = false;
    const request = (operations as any).serverRequest;
    (operations as any).serverRequest = async (...args: string[]) => {
      if (!failed) {
        failed = true;
        throw new Refusal('application_unavailable');
      }
      return request(...args);
    };
    const operation = await finished(store, operations.thumbnailsHome(review.id, crypto.randomUUID()).id);
    assert.equal(operation.state, 'failed');
    assert.equal(operations.history().find((o) => o.id === operation.id)!.canCancel, false);
    await assert.rejects(operations.recover(operation.id), /thumbnails_home_resume_required/);
    const resumed = await finished(store, operations.resume(operation.id).id);
    assert.equal(resumed.state, 'complete');
    assert.equal(calls.filter((call) => call === 'up').length, 1, 'the finished start is not repeated');
    assert.ok(calls.includes('POST library-move/manager/thumbnails'));
    store.set('installation', { ...store.get<Installation>('installation')!, mounts: store.get<Installation>('installation')!.mounts.slice(0, 1) });
    await assert.rejects(operations.reviewThumbnailsHome(), /thumbnails_already_with_photos/);
  });
});

test('a thumbnail drive that comes back before the switch is used again, and one Manager cannot see is never put back', async () => {
  await homeFixture(async ({ operations, store, photos, missing, directory, calls }) => {
    const before = await readFile(join(directory, 'stack', 'compose.json'), 'utf8');
    const installation = store.get<Installation>('installation');
    const review = await operations.reviewThumbnailsHome();
    await mkdir(missing, { recursive: true });
    const operation = await finished(store, operations.thumbnailsHome(review.id, crypto.randomUUID()).id);
    assert.equal(operation.state, 'complete');
    assert.equal(operation.error, 'thumbnail_folder_present');
    assert.deepEqual(store.get<Installation>('installation'), installation);
    assert.equal(await readFile(join(directory, 'stack', 'compose.json'), 'utf8'), before);
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(photos), ['photo.jpg']);
    // A folder only Docker reaches can't be told apart from a missing one: nothing is offered.
    await rm(join(missing, '..'), { recursive: true });
    operations.visibility = async () => (path: string) => path !== missing;
    await assert.rejects(operations.reviewThumbnailsHome(), /thumbnail_folder_not_visible/);
  });
});

test('a missing photos drive stops the thumbnails from being put back', async () => {
  await homeFixture(async ({ operations, photos }) => {
    await rm(photos, { recursive: true });
    await assert.rejects(operations.reviewThumbnailsHome(), /media_folder_missing/);
  });
});

test('the Storage page reports a missing thumbnail drive and measures a thumbnails folder', async () => {
  await homeFixture(async ({ operations, store, photos, missing }) => {
    (operations as any).targetDatabase = async () => ({});
    (operations as any).docker.sql = async (_database: unknown, query: string) => (query.includes('quotaUsageInBytes') ? '1800000000000\n' : '12000000000\n');
    const gone = await operations.storageUsage();
    assert.deepEqual(gone.thumbnails, { path: missing, own: true, missing: true, bytes: null, files: null });
    assert.deepEqual(gone.media, { path: photos, bytes: 1_800_000_000_000 });
    assert.equal(gone.database.bytes, 12_000_000_000);
    store.set('installation', { ...store.get<Installation>('installation')!, mounts: store.get<Installation>('installation')!.mounts.slice(0, 1) });
    await mkdir(join(photos, 'thumbs', 'user'), { recursive: true });
    await writeFile(join(photos, 'thumbs', 'user', 'a.webp'), '12345');
    assert.deepEqual((await operations.storageUsage()).thumbnails, { path: join(photos, 'thumbs'), own: false, missing: false, bytes: null, files: null });
    await operations.measured();
    assert.deepEqual((await operations.storageUsage()).thumbnails, { path: join(photos, 'thumbs'), own: false, missing: false, bytes: 5, files: 1 });
  });
});
