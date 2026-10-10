import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { Docker, type Container } from '../src/docker.js';
import type { Installation, Operation } from '../src/contracts.js';
import type { Releases, VerifiedRelease } from '../src/releases.js';
import type { Backups } from '../src/backups.js';
import type { PostgresStorage } from '../src/postgres-storage.js';
import { fileHash } from '../src/files.js';

for (const restoredAgain of [false, true])
  for (const mode of ['empty', 'installed', 'cancel']) {
    test(`reviewed canonical restore carries original import identity before setup (restored again=${restoredAgain}, mode=${mode})`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'manager-restore-regeneration-')));
      const store = new Store(join(root, 'state'));
      const original = 'aaaabbbbcccc';
      const prior = {
        id: restoredAgain ? 'ccccddddeeee' : original,
        project: `frameleaf-${restoredAgain ? 'ccccddddeeee' : original}`,
        release: 'frameleaf-v3.2.4-1',
        port: 2283,
        ml: false,
        origin: restoredAgain ? 'restored_library' : 'new_import',
        ...(restoredAgain ? { importInstallation: original } : {}),
        libraryId: original,
        sourceId: null,
        mayHaveWrittenMedia: true,
        databaseRoot: root,
        databasePath: join(root, 'old-db'),
        mounts: [{ type: 'bind', source: join(root, 'media'), target: '/data', readOnly: false }],
      } as Installation;
      const events: string[] = [];
      let interruptReconstruction = true;
      const release = {
        directory: join(root, 'release'),
        nas: {
          tag: prior.release,
          platforms: ['linux/amd64'],
          images: {
            server: `fixture.invalid/server@sha256:${'a'.repeat(64)}`,
            machineLearning: `fixture.invalid/ml@sha256:${'b'.repeat(64)}`,
            postgres: `fixture.invalid/postgres@sha256:${'c'.repeat(64)}`,
          },
        },
      } as VerifiedRelease;
      const inventory: Container[] =
        mode === 'empty'
          ? []
          : [
              {
                Id: 'f'.repeat(64),
                Name: '/prior-server',
                State: { Running: true },
                Config: { Labels: { 'app.frameleaf.manager': prior.id } },
                HostConfig: {
                  RestartPolicy: { Name: 'unless-stopped' },
                  PortBindings: { '2283/tcp': [{ HostPort: '2283' }] },
                },
                Mounts: [{ Type: 'bind', Source: prior.mounts[0].source, Destination: '/data', RW: true }],
              } as Container,
            ];
      const docker = {
        inventory: async () => inventory,
        compatibility: async () => ({ platform: 'linux/amd64' }),
        pull: async () => {},
        restartPolicy: async (id: string, policy: string) => {
          inventory.find((c) => c.Id === id)!.HostConfig.RestartPolicy.Name = policy;
        },
        stop: async (id: string) => {
          inventory.find((c) => c.Id === id)!.State.Running = false;
        },
        compose: async (_directory: string, _project: string, _action: string, services?: string[]) => {
          events.push(services ? 'database' : 'workers');
          const installation = store.get<Installation>('installation')!;
          inventory.push({
            Id: randomUUID(),
            Name: '/target-database',
            HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
            State: { Running: true },
            Config: {
              Labels: {
                'app.frameleaf.manager': installation.id,
                'com.docker.compose.service': services ? 'database' : 'frameleaf-server',
              },
            },
            Mounts: [{ Type: 'bind', Source: installation.databasePath, Destination: '/var/lib/postgresql', RW: true }],
          } as Container);
        },
        sql: async () => '0',
        verifyDump: async () => {},
        restore: async () => {
          events.push('restore');
        },
        restoreCommand: async (directory: string, project: string, operationId: string) => {
          events.push('reconstruct');
          const compose = JSON.parse(await readFile(join(directory, 'compose.json'), 'utf8'));
          const environment = compose.services['frameleaf-server'].environment;
          assert.equal(environment.FRAMELEAF_MANAGER_IMPORT_INSTALLATION, original);
          assert.equal(environment.FRAMELEAF_MANAGER_ORIGIN, 'restored_library');
          assert.equal(environment.FRAMELEAF_MANAGER_ML_ENABLED, undefined);
          assert.equal(environment.FRAMELEAF_MANAGER_TOKEN_FILE, '/run/frameleaf/manager-token');
          assert.equal(project, store.get<Installation>('installation')!.project);
          assert.ok(operationId);
          if (interruptReconstruction) {
            interruptReconstruction = false;
            throw new Error('lost offline reconstruction acknowledgement');
          }
        },
        node: async (_id: string, _script: string, args: string[]) => {
          events.push('setup');
          assert.deepEqual(args, ['POST']);
          return JSON.stringify({ phase: 'awaiting-account', canFinish: false });
        },
      } as unknown as Docker;
      const backups = {
        restore: async (_snapshot: string, checkpoint: string) => {
          await mkdir(checkpoint);
          await writeFile(join(checkpoint, 'database.dump'), 'fixture canonical dump');
          await writeFile(
            join(checkpoint, 'recovery.json'),
            JSON.stringify({
              schemaVersion: 2,
              mediaIncluded: false,
              databaseFormat: 'frameleaf-canonical',
              databasePassword: 'd'.repeat(48),
              application: { environment: {}, settings: null, authority: 'database' },
              dumpSha256: await fileHash(join(checkpoint, 'database.dump')),
              installation: prior,
            }),
          );
        },
      } as Backups;
      const operations = new Operations(
        store,
        docker,
        {
          acquire: async () => release,
          eligible: async () => {},
          verify: async () => {},
        } as unknown as Releases,
        backups,
        [root],
        {
          validate: async () => ({}),
          allocate: async () => join(root, randomUUID()),
          verify: async () => {},
        } as unknown as PostgresStorage,
      );
      try {
        await mkdir(prior.mounts[0].source);
        await mkdir(prior.databasePath);
        await writeFile(join(prior.databasePath, 'retained'), 'old database untouched');
        if (mode !== 'empty') {
          store.set('installation', prior);
          store.set('database-password', 'prior-private-password');
          await mkdir(operations.directory());
          await writeFile(join(operations.directory(), 'compose.json'), 'old compose');
          await writeFile(join(operations.directory(), 'manager-token'), 'e'.repeat(64));
        }
        await mkdir(release.directory);
        await writeFile(
          join(release.directory, 'docker-compose.yml'),
          JSON.stringify({
            services: {
              database: {},
              'frameleaf-server': {},
              'immich-machine-learning': {},
            },
          }),
        );
        if (mode !== 'empty') {
          store.set('installation', { ...prior, libraryId: 'ffffffffffff' });
          await assert.rejects(operations.reviewRestore('a'.repeat(64), root), /backup_belongs_to_another_library/);
          store.set('installation', prior);
        }
        const review = await operations.reviewRestore('a'.repeat(64), root);
        const key = randomUUID();
        store.set('installation', { ...prior, port: 2284 });
        assert.throws(() => operations.restore(review.id, key), /review_expired/);
        store.set('installation', mode === 'empty' ? null : prior);
        const { operation } = store.start('restore', key, { reviewId: review.id });
        const saved = store.get<any>(`restore:${review.id}`);
        saved.expires = 0;
        store.set(`restore:${review.id}`, saved);
        assert.equal(operations.restore(review.id, key).id, operation.id); // lost HTTP acknowledgment survives review expiry
        const run = (
          operations as unknown as { applyRestore(operation: Operation, review: unknown): Promise<void> }
        ).applyRestore.bind(operations);
        if (mode === 'installed' && !restoredAgain) {
          const privateOperations = operations as any,
            archive = privateOperations.archiveStack.bind(operations);
          let interrupted = true;
          privateOperations.archiveStack = async (path: string) => {
            await archive(path);
            if (interrupted) {
              interrupted = false;
              throw Error('lost archive acknowledgement');
            }
          };
          await assert.rejects(run(operation, store.get(`restore:${review.id}`)), /lost archive acknowledgement/);
          assert.equal(operation.completed.includes('archive-previous-installation'), false);
          assert.equal(operations.installation()!.id, prior.id);
        }
        await assert.rejects(
          run(operation, store.get(`restore:${review.id}`)),
          /lost offline reconstruction acknowledgement/,
        );
        assert.deepEqual(events, ['database', 'restore', 'reconstruct']);
        if (mode !== 'empty') {
          assert.equal(inventory[0].State.Running, false);
          assert.equal(inventory[0].HostConfig.RestartPolicy.Name, 'no');
          assert.equal(await readFile(join(prior.databasePath, 'retained'), 'utf8'), 'old database untouched');
          inventory[0].State.Running = true;
          await assert.rejects(run(operation, store.get(`restore:${review.id}`)), /previous_installation_not_fenced/);
          inventory[0].State.Running = false;
        }
        if (mode === 'cancel') {
          operation.state = 'failed';
          store.save(operation);
          await operations.recover(operation.id);
          assert.equal(operations.installation()!.id, prior.id);
          assert.equal(store.get('database-password'), 'prior-private-password');
          assert.equal(await readFile(join(operations.directory(), 'compose.json'), 'utf8'), 'old compose');
          assert.equal(
            inventory.every((c) => !c.State.Running),
            true,
          );
          assert.equal(store.history()[0].error, 'restore_cancelled_previous_installation_stopped');
          return;
        }
        await run(operation, store.get(`restore:${review.id}`));
        assert.deepEqual(events, ['database', 'restore', 'reconstruct', 'reconstruct', 'workers', 'setup']);
        const installation = operations.installation()!;
        assert.notEqual(installation.id, prior.id);
        assert.equal(installation.importInstallation, original);
        await run(operation, store.get(`restore:${review.id}`));
        assert.deepEqual(events, ['database', 'restore', 'reconstruct', 'reconstruct', 'workers', 'setup']);
        assert.equal(operations.installation()!.id, installation.id);
        assert.equal(operation.receipts['reconstruct-execution-state'], true);
        operation.state = 'failed';
        store.save(operation);
        await assert.rejects(operations.recover(operation.id), /manual_media_recovery_required/);
      } finally {
        store.close();
        await rm(root, { recursive: true });
      }
    });
  }

test('offline reconstruction uses the real command environment and refuses a running worker or unowned name', async () => {
  const project = 'frameleaf-aaaabbbbcccc',
    operation = randomUUID();
  const name = `${project}-restore-${operation}`;
  let containers: Container[] = [
    {
      Id: 'a'.repeat(64),
      State: { Running: true },
      Config: {
        Labels: {
          'app.frameleaf.manager': 'aaaabbbbcccc',
          'com.docker.compose.service': 'database',
        },
      },
    } as Container,
  ];
  const calls: string[][] = [];
  const docker = new Docker(async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'ps') return containers.map((c) => c.Id).join('\n');
    if (args[0] === 'inspect') return JSON.stringify(containers);
    return '';
  });
  await docker.restoreCommand('/private/fixture', project, operation);
  const command = calls.find((args) => args[0] === 'compose')!;
  assert.ok(command.includes(`FRAMELEAF_MANAGER_RESTORE_OPERATION_ID=${operation}`));
  assert.ok(command.includes(`app.frameleaf.manager.restore=${operation}`));
  assert.deepEqual(command.slice(-4), ['frameleaf-server', 'dist/main.js', 'frameleaf-admin', 'restore-state']);
  assert.ok(command.includes('--no-deps'));
  assert.ok(command.includes('never'));
  containers.push({
    Id: 'b'.repeat(64),
    Name: `/${name}`,
    State: { Running: false },
    Config: { Labels: {} },
  } as Container);
  await assert.rejects(
    docker.restoreCommand('/private/fixture', project, operation),
    /restore_container_identity_changed/,
  );
  assert.equal(
    calls.some((args) => args[0] === 'rm'),
    false,
  );
  containers[1].Config.Labels = {
    'app.frameleaf.manager.restore': operation,
    'app.frameleaf.manager': 'aaaabbbbcccc',
    'com.docker.compose.service': 'frameleaf-server',
  };
  await docker.restoreCommand('/private/fixture', project, operation);
  assert.deepEqual(
    calls.find((args) => args[0] === 'rm'),
    ['rm', 'b'.repeat(64)],
  );
  containers = [
    {
      Id: 'c'.repeat(64),
      State: { Running: true },
      Config: {
        Labels: {
          'app.frameleaf.manager': 'aaaabbbbcccc',
          'com.docker.compose.service': 'frameleaf-server',
        },
      },
    } as Container,
  ];
  await assert.rejects(
    docker.restoreCommand('/private/fixture', project, operation),
    /restore_workers_must_be_stopped/,
  );
});
