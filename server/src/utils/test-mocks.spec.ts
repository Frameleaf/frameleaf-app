import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { automock, getMocks } from 'test/utils.js';

describe('repository mock construction', () => {
  afterEach(() => StorageCore.reset());

  it('constructs the complete service mock set and retains configured database callbacks', async () => {
    const mocks = getMocks();
    expect(await mocks.database.isSchemaReady()).toBe(true);
    const callback = vi.fn().mockResolvedValue('locked result');
    await expect(mocks.database.withAssetMetadataLock('asset-id', callback)).resolves.toBe('locked result');
    expect(callback).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(vi.isMockFunction(mocks.album.getById)).toBe(true);
    expect(vi.isMockFunction(mocks.assetDevelop.listByAsset)).toBe(true);
    expect(vi.isMockFunction(mocks.search.searchMetadata)).toBe(true);
    expect(() => mocks.assetJob.getForSearchDuplicatesJob('asset-id')).toThrow(
      'Called a mock function without a mock implementation (AssetJobRepository.getForSearchDuplicatesJob)',
    );
  });

  it('constructs medium-test mocks without a live database or losing strict method defaults', () => {
    // No real repository method runs; this sentinel deliberately has no query methods.
    const database = {} as Kysely<DB>;
    const { ctx } = newMediumService(BaseService, {
      database,
      real: [],
      mock: [
        LoggingRepository,
        DatabaseRepository,
        AlbumRepository,
        AssetRepository,
        AssetJobRepository,
        OcrRepository,
        PersonRepository,
        SystemMetadataRepository,
        UserRepository,
        TagRepository,
      ],
    });
    expect(vi.isMockFunction(ctx.getMock(DatabaseRepository).withLock)).toBe(true);
    expect(vi.isMockFunction(ctx.getMock(AlbumRepository).getById)).toBe(true);
    expect(vi.isMockFunction(ctx.getMock(AssetRepository).getById)).toBe(true);
    expect(vi.isMockFunction(ctx.getMock(SystemMetadataRepository).get)).toBe(true);
    expect(() => ctx.getMock(TagRepository).get('tag-id')).toThrow(
      'Called a mock function without a mock implementation (TagRepository.get)',
    );
  });

  it('runs explicit constructors and discovers inherited, field and getter functions without calling them', () => {
    const constructed = vi.fn();
    const implementation = vi.fn(() => 'real result');
    class Parent {
      inherited() {
        return implementation();
      }
    }
    class Dependency extends Parent {
      field = () => implementation();
      constructor(dependency: object) {
        super();
        constructed(new Proxy(dependency, {}));
      }
      get callable() {
        return implementation;
      }
    }
    const dependency = {};
    const mock = automock(Dependency, { args: [dependency] });
    expect(constructed).toHaveBeenCalledExactlyOnceWith(dependency);
    for (const method of [mock.inherited, mock.field, mock.callable]) {
      expect(vi.isMockFunction(method)).toBe(true);
      expect(() => method()).toThrow('Called a mock function without a mock implementation');
      method.mockReturnValue('mock result');
      expect(method()).toBe('mock result');
    }
    expect(implementation).not.toHaveBeenCalled();
    mock.resetAllMocks();
    for (const method of [mock.inherited, mock.field, mock.callable]) {
      expect(method).not.toHaveBeenCalled();
      expect(() => method()).toThrow('Called a mock function without a mock implementation');
    }
    // Invalid constructor inputs must still fail instead of producing an incomplete successful mock.
    expect(() => automock(Dependency)).toThrow(TypeError);
  });
});
