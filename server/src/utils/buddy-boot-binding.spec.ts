import { fork } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import { BuddyRecoveryFiles, readBuddyRecovery } from 'src/utils/buddy-backup-recovery.js';
import { finalizeBuddyBootBinding, loadBuddyBootBinding } from 'src/utils/buddy-boot-binding.js';
import { type BuddyBootConfiguration, stageBuddyBootConfiguration } from 'src/utils/buddy-boot-configuration.js';
import { ENV_ALIASES } from 'src/utils/env-aliases.js';
import { EnvSchema } from 'src/utils/environment-schema.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('Replacement-local Buddy boot authority', () => {
  let root: string;
  let identity: string;
  let directory: string;
  let bindingPath: string;
  let recoveryId: string;
  let snapshotId: string;
  let files: BuddyRecoveryFiles;
  let binding: Record<string, unknown>;
  let configuration: BuddyBootConfiguration;

  const saveBinding = (changes: Record<string, unknown> = {}) =>
    writeFile(bindingPath, JSON.stringify({ ...binding, ...changes }), { mode: 0o600 });
  const prepare = async (
    mode: 'keep' | 'replace' = 'replace',
    environmentKeys = ['FRAMELEAF_PORT'],
    scope: 'settings' | 'server' = 'settings',
  ) => {
    await stageBuddyBootConfiguration(directory, snapshotId, configuration);
    const bytes = Buffer.from('recovered settings');
    const target = join(root, 'selected-settings.json');
    const file = { role: 'configuration', path: target, sha256: digest(bytes), size: bytes.length, mtime: null };
    await writeFile(join(directory, 'objects', file.sha256), bytes, { mode: 0o600 });
    const manifest: BuddyManifest = {
      version: 1,
      frameleafVersion: 'synthetic',
      vaultId: binding.vaultId as string,
      snapshotId,
      sequence: 1,
      previous: null,
      library: {
        format: 'frameleaf-backup-manifest',
        version: 2,
        instanceId: randomUUID(),
        createdAt: new Date().toISOString(),
        assets: {},
        database: scope === 'server' ? { key: 'database.sql.gz', sha256: digest(bytes), size: bytes.length } : null,
        albums: {},
        people: {},
        profiles: {},
      },
      contents: {},
      assetLinks: {},
      assetFiles: {},
      dependencies: [],
      configurationFiles: [file],
      environment: { FRAMELEAF_PORT: '2491', NODE_OPTIONS: '--untrusted-historical-option' },
      bootConfiguration: configuration,
      storageRoot: join(root, 'media'),
      storageRoots: [join(root, 'media')],
      settings: { system: {}, users: [] },
    };
    const prepared = Buffer.from(JSON.stringify({ version: 1, scope, mode, manifest, files: [file] }));
    await writeFile(join(directory, 'prepared.json'), prepared, { mode: 0o600 });
    files = new BuddyRecoveryFiles(root, recoveryId, async () => {});
    await files.state('publishing');
    const plan = await readBuddyRecovery(root, recoveryId);
    await files.publish(plan, [], [target]);
    await files.verify(plan, [], [target]);
    await files.state('complete');
    expect((await readFile(target)).equals(bytes)).toBe(true);
    binding = {
      ...binding,
      scope,
      mode,
      environmentKeys,
      artifactDigest: digest(await readFile(join(directory, 'boot-configuration.json'))),
      preparedDigest: digest(prepared),
    };
    await saveBinding();
  };
  const marker = async (id = recoveryId) => {
    await mkdir(join(identity, 'buddy'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(identity, 'buddy', 'recovery-active.json'),
      JSON.stringify({ isMaintenanceMode: true, secret: randomUUID(), action: { buddyRecoveryId: id } }),
      { mode: 0o600 },
    );
  };

  beforeEach(async () => {
    for (const key of Object.keys(EnvSchema.shape)) vi.stubEnv(key, undefined);
    for (const { legacy } of ENV_ALIASES) vi.stubEnv(legacy, undefined);
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-boot-binding-')));
    await chmod(root, 0o700);
    identity = join(root, 'identity');
    recoveryId = randomUUID();
    snapshotId = randomUUID();
    directory = join(root, 'recovery', recoveryId);
    for (const path of [identity, join(root, 'media'), join(directory, 'objects')])
      await mkdir(path, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await writeFile(join(identity, 'instance-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    const jwk = publicKey.export({ format: 'jwk' });
    bindingPath = join(identity, 'buddy-boot-binding.json');
    binding = {
      version: 1,
      state: 'ready',
      recoveryId,
      snapshotId,
      vaultId: randomUUID(),
      replacementIdentity: createHash('sha256')
        .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
        .digest('base64url'),
      scope: 'settings',
      recoveryDirectory: directory,
    };
    configuration = {
      version: 1,
      entries: [
        { key: 'FRAMELEAF_PORT', state: 'value', value: 2391 },
        { key: 'DB_PASSWORD', state: 'value', value: 'synthetic-historical-database-secret' },
        { key: 'FRAMELEAF_EDGE_SECRET', state: 'value', value: 'synthetic-historical-edge-secret' },
        { key: 'FRAMELEAF_IDENTITY_DIR', state: 'value', value: join(root, 'historical-identity') },
      ],
    };
    vi.stubEnv('FRAMELEAF_IDENTITY_DIR', identity);
    vi.stubEnv('FRAMELEAF_BUDDY_BOOT_BINDING_FILE', bindingPath);
    vi.stubEnv('FRAMELEAF_PORT', '2283');
    vi.stubEnv('DB_PASSWORD', 'synthetic-replacement-database-secret');
    vi.stubEnv('DB_PASSWORD_FILE', join(root, 'replacement-database-secret-source'));
    vi.stubEnv('FRAMELEAF_EDGE_SECRET', 'synthetic-replacement-edge-secret');
    await prepare();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('loads only selected application values after real fenced publication', async () => {
    const before = { ...process.env };
    await loadBuddyBootBinding();
    expect(JSON.stringify(process.env) === JSON.stringify({ ...before, FRAMELEAF_PORT: '2391' })).toBe(true);
    await loadBuddyBootBinding();
    expect(JSON.stringify(process.env) === JSON.stringify({ ...before, FRAMELEAF_PORT: '2391' })).toBe(true);
  });

  it.each(['process', 'thread'] as const)('passes validated and cleared values to fresh %s workers', async (kind) => {
    vi.stubEnv('FRAMELEAF_PORT', undefined);
    vi.stubEnv('IMMICH_PORT', '2491');
    await loadBuddyBootBinding();
    const workerFile = join(root, 'observe-environment.mjs');
    await writeFile(
      workerFile,
      `import { parentPort } from 'node:worker_threads';
const result = {
  selected: process.env.FRAMELEAF_PORT === '2391',
  aliasCleared: process.env.IMMICH_PORT === undefined,
  replacementSecret: process.env.DB_PASSWORD === 'synthetic-replacement-database-secret',
};
if (parentPort) {
  parentPort.postMessage(result);
  parentPort.close();
} else {
  process.send(result, () => process.disconnect());
}
`,
      { mode: 0o600 },
    );
    // Match the supervisor's environment inheritance for initial starts and restarts.
    for (let attempt = 0; attempt < 2; attempt++) {
      const worker =
        kind === 'process'
          ? fork(workerFile, [], {
              execArgv: process.execArgv.map((arg) => (arg.startsWith('--inspect') ? '--inspect=0.0.0.0:9231' : arg)),
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            })
          : new Worker(workerFile);
      try {
        const signal = AbortSignal.timeout(5000);
        const [[result], [code]] = await Promise.all([
          once(worker, 'message', { signal }),
          once(worker, 'exit', { signal }),
        ]);
        expect(result).toEqual({ selected: true, aliasCleared: true, replacementSecret: true });
        expect(code).toBe(0);
      } finally {
        if (worker instanceof Worker) await worker.terminate();
        else worker.kill();
      }
    }
  });

  it.each([
    ['foreign identity', { replacementIdentity: 'A'.repeat(43) }],
    ['foreign snapshot', { snapshotId: randomUUID() }],
    ['foreign vault', { vaultId: randomUUID() }],
    ['foreign recovery', { recoveryId: randomUUID() }],
    ['server scope without database', { scope: 'server' }],
    ['unfinished request', { state: 'request' }],
    ['foreign mode', { mode: 'keep' }],
    ['dependency credential', { environmentKeys: ['DB_PASSWORD'] }],
    ['identity path', { environmentKeys: ['FRAMELEAF_IDENTITY_DIR'] }],
    ['security value', { environmentKeys: ['FRAMELEAF_EDGE_SECRET'] }],
    ['link token', { environmentKeys: ['FRAMELEAF_LINK_TOKEN'] }],
    ['entitlement', { environmentKeys: ['FRAMELEAF_LICENSE_EXTRA_JWKS_FILE'] }],
    ['duplicate key', { environmentKeys: ['FRAMELEAF_PORT', 'FRAMELEAF_PORT'] }],
    ['runtime option', { environmentKeys: ['NODE_OPTIONS'] }],
    ['legacy key', { environmentKeys: ['IMMICH_PORT'] }],
    ['undeclared application key', { environmentKeys: ['FRAMELEAF_HOST'] }],
    ['incomplete shutdown pair', { environmentKeys: ['FRAMELEAF_SHUTDOWN_GRACE_SECONDS'] }],
    ['forged plan digest', { preparedDigest: '0'.repeat(64) }],
    ['forged artifact digest', { artifactDigest: '0'.repeat(64) }],
    ['unknown authority field', { unrecognized: true }],
  ])('refuses %s without changing any environment value', async (_name, change) => {
    const before = { ...process.env };
    await saveBinding(change);
    await expect(loadBuddyBootBinding()).rejects.toThrow('Invalid replacement-local Buddy boot authority');
    expect(JSON.stringify(process.env) === JSON.stringify(before)).toBe(true);
  });

  it.each(['publishing', 'files-ready', 'database-ready', 'rolled-back'] as const)(
    'refuses a %s publication journal',
    async (state) => {
      await files.state(state);
      await expect(loadBuddyBootBinding()).rejects.toThrow('Invalid replacement-local Buddy boot authority');
      expect(process.env.FRAMELEAF_PORT).toBe('2283');
    },
  );

  it('rejects public authority files, changed artifact bytes and symlink artifacts', async () => {
    await chmod(bindingPath, 0o644);
    await expect(loadBuddyBootBinding()).rejects.toThrow('Invalid replacement-local Buddy boot authority');
    await chmod(bindingPath, 0o600);
    const artifact = join(directory, 'boot-configuration.json');
    const bytes = await readFile(artifact);
    await writeFile(artifact, Buffer.concat([bytes, Buffer.from(' ')]));
    await expect(loadBuddyBootBinding()).rejects.toThrow('Invalid replacement-local Buddy boot authority');
    const foreign = join(root, 'foreign-artifact.json');
    await writeFile(foreign, bytes, { mode: 0o600 });
    await rm(artifact);
    await symlink(foreign, artifact);
    await expect(loadBuddyBootBinding()).rejects.toThrow('Invalid replacement-local Buddy boot authority');
    expect(process.env.FRAMELEAF_PORT).toBe('2283');
  });

  it('finalizes the same local request only with completed publication and a live matching maintenance fence', async () => {
    await marker();
    await saveBinding({ state: 'request' });
    await files.state('files-ready');
    await loadBuddyBootBinding();
    expect(process.env.FRAMELEAF_PORT).toBe('2283');
    await expect(finalizeBuddyBootBinding(root, recoveryId, async () => {})).rejects.toThrow();
    await files.state('complete');
    const assert = vi.fn(() =>
      assert.mock.calls.length === 3
        ? Promise.reject(new Error('synthetic fence lost before readiness'))
        : Promise.resolve(),
    );
    await expect(finalizeBuddyBootBinding(root, recoveryId, assert)).rejects.toThrow();
    expect(JSON.parse(await readFile(bindingPath, 'utf8')).state).toBe('request');
    await finalizeBuddyBootBinding(root, recoveryId, async () => {});
    const ready = await readFile(bindingPath);
    expect(JSON.parse(ready.toString()).state).toBe('ready');
    await finalizeBuddyBootBinding(root, recoveryId, async () => {});
    expect((await readFile(bindingPath)).equals(ready)).toBe(true);
    await loadBuddyBootBinding();
    expect(process.env.FRAMELEAF_PORT).toBe('2283');
    await marker(randomUUID());
    await expect(loadBuddyBootBinding()).rejects.toThrow('Invalid replacement-local Buddy boot authority');
    await rm(join(identity, 'buddy', 'recovery-active.json'));
    await loadBuddyBootBinding();
    expect(process.env.FRAMELEAF_PORT).toBe('2391');
  });

  it('preserves effective local aliases in keep mode and removes them in replace/unset mode', async () => {
    vi.stubEnv('FRAMELEAF_PORT', undefined);
    vi.stubEnv('IMMICH_PORT', '2284');
    await prepare('keep');
    await loadBuddyBootBinding();
    expect(process.env.IMMICH_PORT).toBe('2284');
    expect(process.env.FRAMELEAF_PORT).toBeUndefined();
    vi.stubEnv('IMMICH_PORT', undefined);
    await loadBuddyBootBinding();
    expect(process.env.FRAMELEAF_PORT).toBe('2391');
    vi.stubEnv('FRAMELEAF_PORT', undefined);
    vi.stubEnv('IMMICH_PORT', '2284');
    await prepare('replace');
    await loadBuddyBootBinding();
    expect(process.env.FRAMELEAF_PORT).toBe('2391');
    expect(process.env.IMMICH_PORT).toBeUndefined();
    configuration.entries = [{ key: 'FRAMELEAF_PORT', state: 'unset' }];
    await prepare('replace');
    await loadBuddyBootBinding();
    expect(process.env.FRAMELEAF_PORT).toBeUndefined();
  });

  describe('Supervisor worker service adapter', () => {
    const workerKeys = ['FRAMELEAF_WORKERS_INCLUDE', 'FRAMELEAF_WORKERS_EXCLUDE'];
    const prepareWorkers = async (mode: 'keep' | 'replace' = 'replace', included = 'api,microservices,edge') => {
      configuration.entries.push(
        { key: 'FRAMELEAF_WORKERS_INCLUDE', state: 'value', value: included },
        { key: 'FRAMELEAF_WORKERS_EXCLUDE', state: 'value', value: 'api' },
      );
      await prepare(mode, workerKeys, 'server');
      binding.workerService = 'supervisor';
      await saveBinding();
    };

    it.each(['process', 'thread'] as const)(
      'restores the admitted profile for fresh %s workers and restarts',
      async (kind) => {
        await prepareWorkers();
        vi.stubEnv('IMMICH_WORKERS_INCLUDE', 'api');
        vi.stubEnv('IMMICH_WORKERS_EXCLUDE', 'edge');
        const before = { ...process.env };
        await loadBuddyBootBinding();
        const expected: NodeJS.ProcessEnv = {
          ...before,
          FRAMELEAF_WORKERS_INCLUDE: 'api,microservices,edge',
          FRAMELEAF_WORKERS_EXCLUDE: 'api',
        };
        delete expected.IMMICH_WORKERS_INCLUDE;
        delete expected.IMMICH_WORKERS_EXCLUDE;
        expect(JSON.stringify(process.env) === JSON.stringify(expected)).toBe(true);
        const workerFile = join(root, 'observe-worker-profile.mjs');
        await writeFile(
          workerFile,
          `import { parentPort } from 'node:worker_threads';
import { parseWorkerSelection } from ${JSON.stringify(new URL('environment-values.ts', import.meta.url).href)};
const result = parseWorkerSelection(process.env).join(',');
if (parentPort) {
  parentPort.postMessage(result);
  parentPort.close();
} else {
  process.send(result, () => process.disconnect());
}
`,
          { mode: 0o600 },
        );
        for (let attempt = 0; attempt < 2; attempt++) {
          const worker =
            kind === 'process'
              ? fork(workerFile, [], {
                  execArgv: ['--experimental-transform-types'],
                  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                })
              : new Worker(workerFile, { execArgv: ['--experimental-transform-types'], stdout: true, stderr: true });
          try {
            const signal = AbortSignal.timeout(5000);
            const [[result], [code]] = await Promise.all([
              once(worker, 'message', { signal }),
              once(worker, 'exit', { signal }),
            ]);
            expect(result).toBe('microservices,edge');
            expect(code).toBe(0);
          } finally {
            if (worker instanceof Worker) await worker.terminate();
            else worker.kill();
          }
        }
      },
    );

    it('keeps the whole local worker profile when either local input is present', async () => {
      await prepareWorkers('keep');
      vi.stubEnv('IMMICH_WORKERS_INCLUDE', 'api');
      const before = JSON.stringify(process.env);
      await loadBuddyBootBinding();
      expect(JSON.stringify(process.env)).toBe(before);
      vi.stubEnv('IMMICH_WORKERS_INCLUDE', undefined);
      await loadBuddyBootBinding();
      expect(process.env.FRAMELEAF_WORKERS_INCLUDE).toBe('api,microservices,edge');
      expect(process.env.FRAMELEAF_WORKERS_EXCLUDE).toBe('api');
    });

    it('clears an explicitly unset profile and restores ordinary supervisor defaults', async () => {
      configuration.entries.push(...workerKeys.map((key) => ({ key, state: 'unset' as const })));
      await prepare('replace', workerKeys, 'server');
      await saveBinding({ workerService: 'supervisor' });
      vi.stubEnv('IMMICH_WORKERS_INCLUDE', 'api');
      vi.stubEnv('IMMICH_WORKERS_EXCLUDE', 'edge');
      await loadBuddyBootBinding();
      const { parseWorkerSelection } = await import('src/utils/environment-values.js');
      expect(parseWorkerSelection(process.env)).toEqual(['api', 'microservices', 'edge']);
      for (const key of [...workerKeys, 'IMMICH_WORKERS_INCLUDE', 'IMMICH_WORKERS_EXCLUDE']) {
        expect(process.env[key]).toBeUndefined();
      }
    });

    it.each([
      ['no service grant', { workerService: undefined }],
      ['unknown service', { workerService: 'postgres' }],
      ['settings recovery', { scope: 'settings' }],
      ['incomplete profile', { environmentKeys: ['FRAMELEAF_WORKERS_INCLUDE'] }],
      ['dependency credential', { environmentKeys: [...workerKeys, 'DB_PASSWORD'] }],
    ])('refuses %s without changing any boot input', async (_name, change) => {
      await prepareWorkers();
      await saveBinding(change);
      const before = JSON.stringify(process.env);
      await expect(loadBuddyBootBinding()).rejects.toThrow('Invalid replacement-local Buddy boot authority');
      expect(JSON.stringify(process.env)).toBe(before);
    });

    it('refuses an invalid worker before finalizing readiness or changing boot inputs', async () => {
      await prepareWorkers('replace', 'api,first-launch');
      await marker();
      await saveBinding({ state: 'request' });
      await expect(finalizeBuddyBootBinding(root, recoveryId, async () => {})).rejects.toThrow(
        'Invalid replacement-local Buddy boot authority',
      );
      expect(JSON.parse(await readFile(bindingPath, 'utf8')).state).toBe('request');
      await rm(join(identity, 'buddy', 'recovery-active.json'));
      await saveBinding();
      const before = JSON.stringify(process.env);
      await expect(loadBuddyBootBinding()).rejects.toThrow('Invalid replacement-local Buddy boot authority');
      expect(JSON.stringify(process.env)).toBe(before);
    });

    it('retains the replacement profile in maintenance and activates only after fenced completion', async () => {
      await prepareWorkers();
      vi.stubEnv('FRAMELEAF_WORKERS_INCLUDE', 'api');
      await marker();
      await saveBinding({ state: 'request' });
      await files.state('files-ready');
      await loadBuddyBootBinding();
      expect(process.env.FRAMELEAF_WORKERS_INCLUDE).toBe('api');
      await expect(finalizeBuddyBootBinding(root, recoveryId, async () => {})).rejects.toThrow();
      await files.state('complete');
      await finalizeBuddyBootBinding(root, recoveryId, async () => {});
      await loadBuddyBootBinding();
      expect(process.env.FRAMELEAF_WORKERS_INCLUDE).toBe('api');
      await rm(join(identity, 'buddy', 'recovery-active.json'));
      await loadBuddyBootBinding();
      expect(process.env.FRAMELEAF_WORKERS_INCLUDE).toBe('api,microservices,edge');
      expect(process.env.FRAMELEAF_WORKERS_EXCLUDE).toBe('api');
    });
  });
});
