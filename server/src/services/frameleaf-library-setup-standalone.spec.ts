import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';

const make = () =>
  new FrameleafLibrarySetupService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
it('leaves an unmanaged server outside Manager setup without accessing migration state', async () => {
  vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', '');
  vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', '');
  const service = make();
  expect(await service.progress()).toMatchObject({ active: false, phase: null, stages: [] });
  await expect(service.begin()).rejects.toThrow('not provisioned by Frameleaf Manager');
  await expect(service.status()).rejects.toThrow('not provisioned by Frameleaf Manager');
});
it('does not schedule Manager setup on an unmanaged server', async () => {
  vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', '');
  vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', '');
  vi.useFakeTimers();
  const service = make();
  service.onBootstrap();
  expect(vi.getTimerCount()).toBe(0);
  await service.onShutdown();
});
