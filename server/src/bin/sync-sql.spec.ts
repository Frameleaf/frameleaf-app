import { SetMetadata } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as files from 'node:fs/promises';
import { SqlGenerator } from 'src/bin/sync-sql.js';
import { GENERATE_SQL_KEY, type GenerateSqlQueries } from 'src/decorators.js';

const application = vi.hoisted(() => ({ init: vi.fn(), close: vi.fn(), get: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  rm: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock('@nestjs/testing', () => ({ Test: { createTestingModule: vi.fn() } }));
vi.mock('nestjs-cls', () => ({ ClsModule: { forRoot: vi.fn() } }));
vi.mock('nestjs-kysely', () => ({ KyselyModule: { forRoot: vi.fn() } }));
vi.mock('src/repositories/index.js', () => ({ repositories: [] }));
vi.mock('src/repositories/access.repository.js', () => ({ AccessRepository: class {} }));
vi.mock('src/repositories/sync.repository.js', () => ({ SyncRepository: class {} }));
vi.mock('src/repositories/logging.repository.js', () => ({ LoggingRepository: class {} }));
vi.mock('src/repositories/machine-learning.repository.js', () => ({ MachineLearningRepository: class {} }));
vi.mock('src/services/auth.service.js', () => ({ AuthService: class {} }));
vi.mock('src/services/locked-encryption.service.js', () => ({ LockedEncryptionService: class {} }));
vi.mock('src/utils/database.js', () => ({ getKyselyConfig: vi.fn() }));
vi.mock('src/repositories/config.repository.js', () => ({
  ConfigRepository: class {
    getEnv() {
      return { database: { config: {} }, cls: { config: {} } };
    }
  },
}));

const importedWithoutStarting = vi.mocked(files.rm).mock.calls.length === 0;
const targetDir = 'fixture-queries';
const fixture = (method: (...params: unknown[]) => unknown, queries: GenerateSqlQueries[] = []) => {
  class Fixture {
    query(...params: unknown[]) {
      return method(...params);
    }
  }
  SetMetadata(GENERATE_SQL_KEY, queries)(Fixture.prototype.query);
  return new Fixture();
};

beforeEach(() => {
  vi.stubEnv('DB_HOSTNAME', 'fixture-host');
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(Test.createTestingModule).mockReturnValue({
    compile: () => Promise.resolve({ createNestApplication: () => application }),
  } as never);
  vi.mocked(files.readdir).mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('does not start database setup or remove output when imported', () => {
  expect(importedWithoutStarting).toBe(true);
});

it('keeps existing generated files when application initialization fails', async () => {
  const failure = new Error('initialization failed');
  application.init.mockRejectedValueOnce(failure);
  await expect(new SqlGenerator({ targetDir }).run()).rejects.toBe(failure);
  expect(files.rm).not.toHaveBeenCalled();
});

it('closes the application even when initialization rejects', async () => {
  application.init.mockRejectedValueOnce(new Error('initialization failed'));
  await expect(new SqlGenerator({ targetDir }).run()).rejects.toThrow('initialization failed');
  expect(application.close).toHaveBeenCalledOnce();
});

it('does not mutate empty query-decorator metadata when supplying default arguments', async () => {
  const generator = new SqlGenerator({ targetDir });
  const queries: GenerateSqlQueries[] = [];
  const instance = fixture(() => Promise.resolve(generator['sqlLogger'].logQuery('SELECT 1')), queries);
  expect(await generator['runTargets'](instance, 'Fixture')).toEqual(['-- Fixture.query\nSELECT\n  1']);
  expect(queries).toEqual([]);
});

it.each(['value', 'throw', 'reject'] as const)('retains recorded SQL from a target returning %s', async (mode) => {
  const generator = new SqlGenerator({ targetDir });
  const failure = new Error('expected query failure');
  const instance = fixture(
    (value) => {
      expect(value).toBe(42);
      generator['sqlLogger'].logQuery('SELECT 1');
      if (mode === 'throw') throw failure;
      if (mode === 'reject') return Promise.reject(failure);
      return 42;
    },
    [{ name: 'variant', params: [42] }],
  );
  await expect(generator['runTargets'](instance, 'Fixture')).resolves.toEqual([
    '-- Fixture.query (variant)\nSELECT\n  1',
  ]);
});

it('closes a streamed target after its first value while retaining its SQL', async () => {
  const generator = new SqlGenerator({ targetDir });
  const closed = vi.fn();
  const first = Promise.withResolvers<number>();
  const instance = fixture(
    async function* () {
      try {
        generator['sqlLogger'].logQuery('SELECT 1');
        yield await first.promise;
        yield 2;
      } finally {
        closed();
      }
    },
    [{ params: [], stream: true }],
  );
  const pending = generator['runTargets'](instance, 'Fixture');
  first.resolve(1);
  await expect(pending).resolves.toEqual(['-- Fixture.query\nSELECT\n  1']);
  expect(closed).toHaveBeenCalledOnce();
});

const publication = () => {
  const generator = new SqlGenerator({ targetDir });
  generator['results'] = { ExampleRepository: ['-- header', '-- query\nSELECT 1'] };
  return generator;
};

it('leaves matching output bytes untouched and prunes only obsolete SQL files', async () => {
  vi.mocked(files.readFile).mockResolvedValue('-- header\n\n-- query\nSELECT 1\n');
  vi.mocked(files.readdir).mockResolvedValue(['example.repository.sql', 'obsolete.sql', 'notes.md'] as never);
  expect(await publication()['write']()).toBe(0);
  expect(files.writeFile).not.toHaveBeenCalled();
  expect(files.rm).toHaveBeenCalledExactlyOnceWith('fixture-queries/obsolete.sql');
});

it('writes missing output with its existing format', async () => {
  vi.mocked(files.readFile).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  expect(await publication()['write']()).toBe(1);
  expect(files.writeFile).toHaveBeenCalledExactlyOnceWith(
    'fixture-queries/example.repository.sql',
    '-- header\n\n-- query\nSELECT 1\n',
  );
});

it('does not overwrite output when reading existing bytes fails', async () => {
  const failure = Object.assign(new Error('unreadable'), { code: 'EACCES' });
  vi.mocked(files.readFile).mockRejectedValueOnce(failure);
  await expect(publication()['write']()).rejects.toBe(failure);
  expect(files.writeFile).not.toHaveBeenCalled();
  expect(files.rm).not.toHaveBeenCalled();
});

it('reports actual writes and query groups without counting skipped headers', async () => {
  const generator = publication();
  generator['results'].EmptyRepository = ['-- header'];
  vi.mocked(files.readFile).mockResolvedValue('-- header\n\n-- query\nSELECT 1\n');
  await generator.run();
  expect(console.log).toHaveBeenCalledWith('Wrote 0 files');
  expect(console.log).toHaveBeenCalledWith('Generated 1 query groups');
  expect(application.close).toHaveBeenCalledOnce();
});

it('does not prune obsolete output after a failed write', async () => {
  const failure = new Error('disk full');
  vi.mocked(files.readFile).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  vi.mocked(files.writeFile).mockRejectedValueOnce(failure);
  vi.mocked(files.readdir).mockResolvedValue(['obsolete.sql'] as never);
  await expect(publication()['write']()).rejects.toBe(failure);
  expect(files.rm).not.toHaveBeenCalled();
});
