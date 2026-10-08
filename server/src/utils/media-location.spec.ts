import { existsSync } from 'node:fs';
import { StorageCore } from 'src/cores/storage.core.js';
import { detectMediaLocation as edgeMediaLocation } from 'src/edge/edge.module.js';
import { MaintenanceWorkerService } from 'src/maintenance/maintenance-worker.service.js';
import { StorageService } from 'src/services/storage.service.js';
import { discoverMediaLocation } from 'src/utils/media-location.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()), existsSync: vi.fn() }));

describe('Normal media discovery parity across API, maintenance and Edge', () => {
  it.each([
    [undefined, [], '/usr/src/app/upload'],
    [undefined, ['/data'], '/data'],
    [undefined, ['/usr/src/app/upload'], '/usr/src/app/upload'],
    [undefined, ['/data', '/usr/src/app/upload'], '/usr/src/app/upload'],
    ['', ['/data'], '/data'],
    ['/explicit', ['/data'], '/explicit'],
  ] as [string | undefined, string[], string][])(
    'preserves configured %s with directories %j',
    (configured, directories, expected) => {
      const exists = vi.fn((path: string) => directories.includes(path));
      vi.mocked(existsSync).mockImplementation((path) => directories.includes(String(path)));
      const configRepository = { getEnv: () => ({ storage: { mediaLocation: configured } }) };
      const storageRepository = { existsSync: exists };
      const api = Object.assign(Object.create(StorageService.prototype), {
        configRepository,
        storageRepository,
      }) as StorageService;
      const maintenance = Object.assign(Object.create(MaintenanceWorkerService.prototype), {
        configRepository,
        storageRepository,
      }) as MaintenanceWorkerService;
      const set = vi.spyOn(StorageCore, 'setMediaLocation');
      expect(discoverMediaLocation(configured, exists)).toBe(expected);
      api.initializeMediaLocation();
      expect(set).toHaveBeenLastCalledWith(expected);
      expect(maintenance.detectMediaLocation()).toBe(expected);
      expect(edgeMediaLocation(configRepository as never)).toBe(expected);
      if (configured) expect(exists).not.toHaveBeenCalled();
      set.mockRestore();
    },
  );
});
