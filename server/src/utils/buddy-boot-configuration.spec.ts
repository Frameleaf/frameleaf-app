import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuddySettingsSchema } from 'src/dtos/buddy-backup.dto.js';
import {
  BuddyBootDeclarationSchema,
  captureBuddyBootConfiguration,
  readBuddyBootConfiguration,
  stageBuddyBootConfiguration,
} from 'src/utils/buddy-boot-configuration.js';
import { EnvSchema } from 'src/utils/environment-schema.js';

describe('Declared Buddy boot configuration', () => {
  let root: string;
  const settings = {
    directory: '/synthetic/vault',
    quotaBytes: 20 * 1024 ** 3,
    uploadMbps: 10,
    downloadMbps: 10,
    schedule: '0 2 * * *',
    timezone: 'UTC',
    windowStart: '00:00',
    windowEnd: '23:59',
    pausedSending: false,
    pausedReceiving: false,
    includeDerived: false,
    configurationFiles: [],
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-boot-configuration-')));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['FRAMELEAF_TRUSTED_PROXIES', '', undefined],
    ['FRAMELEAF_TRUSTED_PROXIES', ' '.repeat(3), []],
    ['IMMICH_TRUSTED_PROXIES', '', undefined],
    ['IMMICH_TRUSTED_PROXIES', ' '.repeat(3), []],
  ] as const)('round-trips normalized empty proxy inputs from %s (%j)', (key, raw, effective) => {
    expect(EnvSchema.parse({ FRAMELEAF_TRUSTED_PROXIES: raw }).FRAMELEAF_TRUSTED_PROXIES).toEqual(effective);
    vi.stubEnv('FRAMELEAF_TRUSTED_PROXIES', undefined);
    vi.stubEnv('IMMICH_TRUSTED_PROXIES', undefined);
    vi.stubEnv(key, raw);
    const captured = captureBuddyBootConfiguration({ version: 1, environmentKeys: ['FRAMELEAF_TRUSTED_PROXIES'] });
    expect(captured.entries).toEqual([
      effective === undefined
        ? { key: 'FRAMELEAF_TRUSTED_PROXIES', state: 'unset' }
        : { key: 'FRAMELEAF_TRUSTED_PROXIES', state: 'value', value: [] },
    ]);
    expect(readBuddyBootConfiguration(captured)).toEqual(captured);
  });

  it('derives declaration names from the canonical PostgreSQL environment validators', () => {
    const keys = Object.keys(EnvSchema.shape).filter((key) => !key.startsWith('IMMICH_'));
    expect(BuddyBootDeclarationSchema.parse({ version: 1, environmentKeys: keys }).environmentKeys).toEqual(keys);
    expect(BuddyBootDeclarationSchema.safeParse({ version: 1, environmentKeys: ['REDIS_PASSWORD'] }).success).toBe(
      false,
    );
    expect(() =>
      readBuddyBootConfiguration({
        version: 1,
        entries: [{ key: 'DB_VECTOR_EXTENSION', state: 'value', value: 'vectorchord' }],
      }),
    ).toThrow('Invalid declared boot configuration values');
    expect(
      readBuddyBootConfiguration({
        version: 1,
        entries: [{ key: 'DB_VECTOR_EXTENSION', state: 'value', value: 'pgvector' }],
      }).entries,
    ).toHaveLength(1);
  });

  it('rejects unknown, legacy or incomplete declarations while retaining undeclared legacy settings', () => {
    expect(BuddySettingsSchema.safeParse(settings).success).toBe(true);
    for (const bootConfiguration of [
      { version: 2, environmentKeys: ['FRAMELEAF_PORT'] },
      { version: 1, environmentKeys: ['FRAMELEAF_PORT', 'FRAMELEAF_PORT'] },
      { version: 1, environmentKeys: ['BUDDY_UNKNOWN_FIXTURE'] },
      { version: 1, environmentKeys: ['NODE_OPTIONS'] },
      { version: 1, environmentKeys: ['LD_PRELOAD'] },
      { version: 1, environmentKeys: ['IMMICH_PORT'] },
      { version: 1, environmentKeys: ['IMMICH_THIRD_PARTY_SUPPORT_URL'] },
      { version: 1, environmentKeys: ['FRAMELEAF_SHUTDOWN_GRACE_SECONDS'] },
      { version: 1, environmentKeys: ['FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS'] },
    ]) {
      expect(BuddySettingsSchema.safeParse({ ...settings, bootConfiguration }).success).toBe(false);
    }
    expect(
      BuddySettingsSchema.safeParse({
        ...settings,
        bootConfiguration: {
          version: 1,
          environmentKeys: [
            'FRAMELEAF_EDGE_SECRET',
            'FRAMELEAF_IDENTITY_DIR',
            'FRAMELEAF_LINK_TOKEN',
            'FRAMELEAF_LICENSE_EXTRA_JWKS_FILE',
            'FRAMELEAF_ALLOW_EXTERNAL_PLUGINS',
            'DB_SKIP_MIGRATIONS',
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('validates effective aliases, unset inputs and canonical typed values without exposing secrets', async () => {
    vi.stubEnv('FRAMELEAF_PORT', undefined);
    vi.stubEnv('IMMICH_PORT', '2285');
    vi.stubEnv('DB_PASSWORD', undefined);
    const configuration = captureBuddyBootConfiguration({
      version: 1,
      environmentKeys: ['FRAMELEAF_PORT', 'DB_PASSWORD'],
    });
    expect(configuration.entries).toEqual([
      { key: 'FRAMELEAF_PORT', state: 'value', value: 2285 },
      { key: 'DB_PASSWORD', state: 'unset' },
    ]);
    for (const input of [
      { version: 2, entries: [] },
      { version: 1, entries: [{ key: 'FRAMELEAF_PORT', state: 'value', value: '2285' }] },
      { version: 1, entries: [{ key: 'FRAMELEAF_PORT', state: 'value', value: true }] },
      { version: 1, entries: [{ key: 'DB_PASSWORD', state: 'value', value: 17 }] },
      { version: 1, entries: [{ key: 'FRAMELEAF_IMPORT_ROOTS', state: 'value', value: ['relative'] }] },
      { version: 1, entries: [{ key: 'NODE_OPTIONS', state: 'unset' }] },
      { version: 1, entries: [{ key: 'FRAMELEAF_SHUTDOWN_GRACE_SECONDS', state: 'value', value: 55 }] },
      { version: 1, entries: [{ key: 'FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS', state: 'value', value: 60 }] },
      { version: 1, entries: [{ key: 'DB_PASSWORD', state: 'unset', value: 'unexpected' }] },
      {
        version: 1,
        entries: [
          { key: 'DB_PASSWORD', state: 'unset' },
          { key: 'DB_PASSWORD', state: 'unset' },
        ],
      },
      {
        version: 1,
        entries: [
          { key: 'FRAMELEAF_SHUTDOWN_GRACE_SECONDS', state: 'value', value: 40 },
          { key: 'FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS', state: 'value', value: 20 },
        ],
      },
    ])
      expect(() => readBuddyBootConfiguration(input)).toThrow(/declared boot configuration/i);
    vi.stubEnv('IMMICH_PORT', 'invalid-port');
    expect(() => captureBuddyBootConfiguration({ version: 1, environmentKeys: ['FRAMELEAF_PORT'] })).toThrow(
      'Invalid declared boot configuration values',
    );
    const directory = join(root, 'fenced-boot-stage');
    await expect(
      stageBuddyBootConfiguration(directory, randomUUID(), configuration, () =>
        Promise.reject(new Error('Synthetic staging fence lost')),
      ),
    ).rejects.toThrow('Synthetic staging fence lost');
    await expect(readFile(join(directory, 'boot-configuration.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const publicDirectory = join(root, 'public-boot-stage');
    await mkdir(publicDirectory, { mode: 0o755 });
    await chmod(publicDirectory, 0o755); // The refusal fixture must remain public under a private process umask.
    await expect(stageBuddyBootConfiguration(publicDirectory, randomUUID(), configuration)).rejects.toThrow(
      'Boot configuration staging requires a private regular directory',
    );
    await expect(stageBuddyBootConfiguration(directory, 'foreign-path', configuration)).rejects.toThrow(
      'Invalid boot configuration snapshot binding',
    );
  });

  it('uses actual report-only help fallback and preserves complete declared shutdown context', () => {
    vi.stubEnv('FRAMELEAF_DOCS_URL', undefined);
    vi.stubEnv('IMMICH_THIRD_PARTY_DOCUMENTATION_URL', ' https://legacy.example.test/docs/// ');
    vi.stubEnv('FRAMELEAF_SUPPORT_URL', ' https://canonical.example.test/support/ ');
    vi.stubEnv('IMMICH_THIRD_PARTY_SUPPORT_URL', 'https://legacy.example.test/support');
    vi.stubEnv('FRAMELEAF_BUG_FEATURE_URL', '');
    // eslint-disable-next-line unicorn/prefer-https -- Invalid legacy HTTP must remain inert in report-only fallback.
    vi.stubEnv('IMMICH_THIRD_PARTY_BUG_FEATURE_URL', 'http://invalid-legacy.example.test');
    vi.stubEnv('FRAMELEAF_SOURCE_URL', ' ');
    vi.stubEnv('IMMICH_THIRD_PARTY_SOURCE_URL', 'https://legacy.example.test/source/');
    const declaration = {
      version: 1,
      environmentKeys: [
        'FRAMELEAF_DOCS_URL',
        'FRAMELEAF_SUPPORT_URL',
        'FRAMELEAF_BUG_FEATURE_URL',
        'FRAMELEAF_SOURCE_URL',
      ],
    };
    expect(captureBuddyBootConfiguration(declaration).entries).toEqual([
      { key: 'FRAMELEAF_DOCS_URL', state: 'value', value: 'https://legacy.example.test/docs' },
      { key: 'FRAMELEAF_SUPPORT_URL', state: 'value', value: 'https://canonical.example.test/support' },
      { key: 'FRAMELEAF_BUG_FEATURE_URL', state: 'unset' },
      { key: 'FRAMELEAF_SOURCE_URL', state: 'value', value: 'https://legacy.example.test/source' },
    ]);
    // eslint-disable-next-line unicorn/prefer-https -- Invalid canonical HTTP must exercise capture refusal.
    vi.stubEnv('FRAMELEAF_DOCS_URL', 'http://invalid-canonical.example.test');
    expect(() => captureBuddyBootConfiguration(declaration)).toThrow('Invalid declared boot configuration values');
    expect(() =>
      readBuddyBootConfiguration({
        version: 1,
        // eslint-disable-next-line unicorn/prefer-https -- Invalid typed HTTP must exercise configuration refusal.
        entries: [{ key: 'FRAMELEAF_SUPPORT_URL', state: 'value', value: 'http://invalid-canonical.example.test' }],
      }),
    ).toThrow('Invalid declared boot configuration values');
    vi.stubEnv('FRAMELEAF_SHUTDOWN_GRACE_SECONDS', '55');
    vi.stubEnv('FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS', '60');
    const shutdown = captureBuddyBootConfiguration({
      version: 1,
      environmentKeys: ['FRAMELEAF_SHUTDOWN_GRACE_SECONDS', 'FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS'],
    });
    expect(shutdown.entries).toEqual([
      { key: 'FRAMELEAF_SHUTDOWN_GRACE_SECONDS', state: 'value', value: 55 },
      { key: 'FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS', state: 'value', value: 60 },
    ]);
    expect(readBuddyBootConfiguration(shutdown)).toEqual(shutdown);
  });
});
