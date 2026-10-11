import { describe, expect, it } from 'vitest';
import { type QualificationProfile, requirePublicationQualification } from 'src/utils/studio-import-qualification.js';

// Synthetic comparison inputs only; these are never deployment qualification records.
const observed: QualificationProfile = {
  serverVersion: 'candidate-test',
  adapterVersion: 'candidate-test',
  runtime: 'linux; kernel=synthetic-1',
  architecture: 'arm64',
  filesystem: 'apfs',
  mountIdentity: 'test-mount',
  rootIdentity: 'test-root',
  linkDomain: 'test-volume',
  bridge: 'desktop-host-bind; backend=synthetic-1',
  backingStorage: 'synthetic-device-1',
  storageOptions: 'synthetic-driver-1; sync=on',
  database: { fsync: true, synchronousCommit: true, fullPageWrites: true, walStorage: 'synthetic-wal' },
  failureBoundary: 'synthetic-only',
  evidenceReferences: [],
};
const contentReference = `sha256:${'ab'.repeat(32)}`;
const hostedReference = 'https://evidence.example.test/immutable/receipt-1';
const profile = { ...observed, evidenceReferences: [contentReference] };
const configurationFields = [
  'serverVersion',
  'adapterVersion',
  'runtime',
  'architecture',
  'filesystem',
  'mountIdentity',
  'rootIdentity',
  'linkDomain',
  'bridge',
  'backingStorage',
  'storageOptions',
  'failureBoundary',
] as const;

describe('publication qualification structural gate', () => {
  it.each(['apfs', 'fuse.shfs', 'ext4', 'xfs', 'btrfs', 'zfs', 'another-filesystem'])(
    'does not qualify %s from a filesystem label',
    (filesystem) => {
      const current = { ...observed, filesystem };
      expect(() => requirePublicationQualification(null, current)).toThrow('storage_unqualified');
      expect(() => requirePublicationQualification(current, current)).toThrow('storage_unqualified');
    },
  );

  it.each([contentReference, hostedReference])(
    'accepts structurally matching inputs with reference %s',
    (reference) => {
      expect(() =>
        requirePublicationQualification({ ...profile, evidenceReferences: [reference] }, observed),
      ).not.toThrow();
    },
  );

  it('normalizes top-level and database field order before comparison', () => {
    const reordered = {
      ...Object.fromEntries(Object.entries(observed).toReversed()),
      database: Object.fromEntries(Object.entries(observed.database).toReversed()),
    } as QualificationProfile;
    expect(() => requirePublicationQualification(profile, reordered)).not.toThrow();
  });

  it('excludes evidence references from configuration comparison without mutating inputs', () => {
    const current = { ...observed, evidenceReferences: [hostedReference] };
    const before = JSON.stringify({ profile, current });
    expect(() => requirePublicationQualification(profile, current)).not.toThrow();
    expect(JSON.stringify({ profile, current })).toBe(before);
  });

  it('accepts the configuration and reference size boundaries', () => {
    const current = {
      ...observed,
      storageOptions: 'a'.repeat(1024),
      database: { ...observed.database, walStorage: 'a'.repeat(1024) },
    };
    const prefix = 'https://evidence.example.test/';
    const reference = prefix.padEnd(2048, 'a');
    expect(() =>
      requirePublicationQualification(
        { ...current, evidenceReferences: Array.from({ length: 64 }, () => reference) },
        current,
      ),
    ).not.toThrow();
  });

  it.each(configurationFields)('refuses drift in %s', (field) => {
    expect(() =>
      requirePublicationQualification(profile, { ...observed, [field]: `${observed[field]}-changed` }),
    ).toThrow('storage_qualification_changed');
  });

  it('refuses WAL storage drift', () => {
    expect(() =>
      requirePublicationQualification(profile, {
        ...observed,
        database: { ...observed.database, walStorage: 'other-wal' },
      }),
    ).toThrow('storage_qualification_changed');
  });

  it.each(['fsync', 'synchronousCommit', 'fullPageWrites'] as const)('refuses disabled database %s', (field) => {
    const database = { ...observed.database, [field]: false };
    expect(() => requirePublicationQualification(profile, { ...observed, database })).toThrow(
      'database_durability_unqualified',
    );
    expect(() => requirePublicationQualification({ ...profile, database }, observed)).toThrow(
      'database_durability_unqualified',
    );
    expect(() => requirePublicationQualification({ ...profile, database }, { ...observed, database })).toThrow(
      'database_durability_unqualified',
    );
  });

  it.each(configurationFields)('requires a bounded nonblank %s on both inputs', (field) => {
    for (const value of [undefined, null, false, 1, '', ' '.repeat(3), 'a\n', 'a\0', 'a\u{7F}', 'a'.repeat(1025)]) {
      expect(() =>
        requirePublicationQualification({ ...profile, [field]: value } as QualificationProfile, observed),
      ).toThrow('storage_unqualified');
      expect(() =>
        requirePublicationQualification(profile, { ...observed, [field]: value } as QualificationProfile),
      ).toThrow('storage_unqualified');
    }
  });

  it.each([undefined, null, [], true, 1, '{}', { ...observed, extra: true }, { ...observed, database: {} }])(
    'refuses malformed profile/observation without coercion or stripping (%#)',
    (value) => {
      expect(() => requirePublicationQualification(value as QualificationProfile, observed)).toThrow(
        'storage_unqualified',
      );
      expect(() => requirePublicationQualification(profile, value as QualificationProfile)).toThrow(
        'storage_unqualified',
      );
    },
  );

  it.each(['fsync', 'synchronousCommit', 'fullPageWrites', 'walStorage'] as const)(
    'refuses missing or malformed database %s on both inputs',
    (field) => {
      const invalid =
        field === 'walStorage'
          ? [undefined, null, true, '', ' ', 'a\n', 'a'.repeat(1025)]
          : [undefined, null, 0, 1, 'true', 'false'];
      for (const value of invalid) {
        const database = { ...observed.database, [field]: value } as QualificationProfile['database'];
        expect(() => requirePublicationQualification({ ...profile, database }, observed)).toThrow(
          'storage_unqualified',
        );
        expect(() => requirePublicationQualification(profile, { ...observed, database })).toThrow(
          'storage_unqualified',
        );
      }
    },
  );

  it('refuses unknown database fields on both inputs', () => {
    const database = { ...observed.database, extra: true };
    expect(() => requirePublicationQualification({ ...profile, database }, observed)).toThrow('storage_unqualified');
    expect(() => requirePublicationQualification(profile, { ...observed, database })).toThrow('storage_unqualified');
  });

  it.each([
    undefined,
    null,
    'receipt',
    [1],
    [''],
    ['receipt'],
    ['../receipt'],
    ['sha256:ab'],
    [`sha256:${'AB'.repeat(32)}`],
    // eslint-disable-next-line unicorn/prefer-https -- HTTP must remain a negative qualification fixture.
    ['http://evidence.example.test/receipt'],
    ['https:receipt'],
    ['https://user:secret@evidence.example.test/receipt'],
    ['https://evidence.example.test/receipt?token=secret'],
    ['https://evidence.example.test/receipt?'],
    ['https://evidence.example.test/receipt#part'],
    ['https://evidence.example.test/receipt#'],
    ['https://evidence.example.test/a b'],
    ['https://evidence.example.test/a\n'],
    [String.raw`https://evidence.example.test/a\b`],
    ['https://evidence.example.test/%xx'],
    [`https://evidence.example.test/${'a'.repeat(2048)}`],
    Array.from({ length: 65 }, () => contentReference),
  ])('refuses malformed or unbounded references on either input (%#)', (evidenceReferences) => {
    expect(() =>
      requirePublicationQualification({ ...profile, evidenceReferences } as QualificationProfile, observed),
    ).toThrow('storage_unqualified');
    expect(() =>
      requirePublicationQualification(profile, { ...observed, evidenceReferences } as QualificationProfile),
    ).toThrow('storage_unqualified');
  });

  it.each(['namespace barriers', 'host propagation after successful guest sync', 'publication phase receipts'])(
    'refuses an absent approved evidence packet for %s',
    () => {
      expect(() => requirePublicationQualification(null, observed)).toThrow('storage_unqualified');
      expect(() => requirePublicationQualification({ ...profile, evidenceReferences: [] }, observed)).toThrow(
        'storage_unqualified',
      );
    },
  );
});
