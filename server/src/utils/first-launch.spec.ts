import { ExitCode, ImmichWorker } from 'src/enum.js';
import { chooseBootWorkers, isFirstLaunchHandover } from 'src/utils/first-launch.js';

const workers = [ImmichWorker.Api, ImmichWorker.Microservices, ImmichWorker.Edge];

describe('FL-295 supervisor boot', () => {
  describe('chooseBootWorkers', () => {
    it('starts only the "Getting Ready…" worker on the first start on an official library', async () => {
      await expect(
        chooseBootWorkers({ workers, prepared: false, isFirstLaunch: () => Promise.resolve(true) }),
      ).resolves.toEqual([ImmichWorker.FirstLaunch]);
    });

    it('starts the configured workers otherwise', async () => {
      await expect(
        chooseBootWorkers({ workers, prepared: false, isFirstLaunch: () => Promise.resolve(false) }),
      ).resolves.toEqual(workers);
    });

    it('starts the configured workers once the "Getting Ready…" worker handed over, without checking again', async () => {
      const isFirstLaunch = vi.fn().mockResolvedValue(true);

      await expect(chooseBootWorkers({ workers, prepared: true, isFirstLaunch })).resolves.toEqual(workers);
      expect(isFirstLaunch).not.toHaveBeenCalled();
    });

    it('starts the configured workers when the check fails; their boot takes the copy or refuses before migrating', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        chooseBootWorkers({ workers, prepared: false, isFirstLaunch: () => Promise.reject(new Error('down')) }),
      ).resolves.toEqual(workers);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('down'));
      log.mockRestore();
    });
  });

  describe('isFirstLaunchHandover', () => {
    it('is the "Getting Ready…" worker finishing on purpose', () => {
      expect(isFirstLaunchHandover(ImmichWorker.FirstLaunch, ExitCode.FirstLaunchReady)).toBe(true);
    });

    it.each([
      [ImmichWorker.FirstLaunch, 1],
      [ImmichWorker.FirstLaunch, 0],
      [ImmichWorker.FirstLaunch, null],
      [ImmichWorker.FirstLaunch, ExitCode.AppRestart],
      [ImmichWorker.Api, ExitCode.FirstLaunchReady],
    ])('is not %s exiting with %s', (name, code) => {
      expect(isFirstLaunchHandover(name, code)).toBe(false);
    });
  });
});
