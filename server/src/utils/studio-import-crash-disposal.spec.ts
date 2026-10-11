import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teardownRetentionFixture } from 'test/fixtures/studio-import-fixture-teardown.js';
import { getLibraryQueueDB } from 'test/medium/library-queue-database.js';

const controls = vi.hoisted(() => ({
  cloneClose: vi.fn(),
  parentClose: vi.fn(),
  drop: vi.fn(),
  adminClose: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('test/utils.js', () => ({ getKyselyDB: () => Promise.resolve({ destroy: controls.cloneClose }) }));
vi.mock('src/utils/database.js', () => ({ boundPoolClose: (value: unknown) => value }));
vi.mock('src/utils/execution-database.js', () => ({ boundExecutionReservations: (value: unknown) => value }));
vi.mock('@frameleaf/sql-tools', () => ({ createPostgres: controls.connect }));
vi.mock('kysely-postgres-js', () => ({ PostgresJSDialect: class {} }));
vi.mock('kysely', () => ({
  Kysely: class {
    destroy = controls.parentClose;
  },
  sql: () => ({ execute: () => Promise.resolve({ rows: [{ name: 'frameleaf_mock' }] }) }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  controls.cloneClose.mockResolvedValue(undefined);
  controls.parentClose.mockResolvedValue(undefined);
  controls.drop.mockResolvedValue(undefined);
  controls.adminClose.mockResolvedValue(undefined);
  controls.connect.mockReturnValue({ unsafe: controls.drop, end: controls.adminClose });
  vi.stubEnv('IMMICH_TEST_POSTGRES_URL', 'postgres://postgres@localhost/frameleaf');
});
afterEach(() => vi.unstubAllEnvs());

describe('parent disposal authority, with mocked SQL and files only', () => {
  it('preserves evidence at local PASS and again after a late independent UNKNOWN', async () => {
    const db = await getLibraryQueueDB(1, true);
    const removeFiles = vi.fn();
    // Parent teardown runs after local PASS, before an independent decision is available.
    await teardownRetentionFixture(true, removeFiles, () => db.destroy());
    expect(removeFiles).not.toHaveBeenCalled();
    expect(controls.drop).not.toHaveBeenCalled();
    // A late UNKNOWN cannot restore deleted evidence: repeat teardown must still preserve it.
    await teardownRetentionFixture(true, removeFiles, () => db.destroy());
    expect(removeFiles).not.toHaveBeenCalled();
    expect(controls.parentClose).toHaveBeenCalledTimes(2);
    expect(controls.connect).toHaveBeenCalledTimes(1);
    expect(controls.drop).not.toHaveBeenCalled();
    expect(controls.adminClose).not.toHaveBeenCalled();
  });
  it('the real crash cases retain final evidence and choose immutable external disposal ownership', async () => {
    const source = await readFile('test/medium/specs/services/studio-import-retention.service.spec.ts', 'utf8');
    expect(source).toContain('createRetentionTestDatabase(crashWindowOwned ? 1 : 2, crashWindowOwned)');
    expect(source).not.toContain('crashClosureUnknown');
    const crashCases = source.slice(source.indexOf('describe.skipIf'));
    expect(crashCases).toContain("expect(run('recover'))");
    expect(crashCases).not.toMatch(/\b(?:unlink|rmdir)\(/);
  });
  it('keeps ordinary cleanup: removes files, closes parent pool, drops exact clone and closes admin', async () => {
    const db = await getLibraryQueueDB();
    const removeFiles = vi.fn().mockResolvedValue(undefined);
    await teardownRetentionFixture(false, removeFiles, () => db.destroy());
    expect(removeFiles).toHaveBeenCalledExactlyOnceWith();
    expect(controls.parentClose).toHaveBeenCalledExactlyOnceWith();
    expect(controls.connect).toHaveBeenCalledTimes(2);
    expect(controls.drop).toHaveBeenCalledExactlyOnceWith('drop database "frameleaf_mock"');
    expect(controls.adminClose).toHaveBeenCalledExactlyOnceWith();
  });
  it('still closes the ordinary parent pool when file cleanup fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    await expect(
      teardownRetentionFixture(false, () => Promise.reject(new Error('file_failure')), close),
    ).rejects.toThrow('file_failure');
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });
});
