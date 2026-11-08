import { type ExecutionContext, StreamableFile } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { PrivateJsonCacheInterceptor } from 'src/middleware/private-json-cache.interceptor.js';

const run = async (
  body: unknown,
  { user = { user: { id: 'user-1' } } as object | null, header = false, headersSent = false } = {},
) => {
  const setHeader = vi.fn();
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ user }),
      getResponse: () => ({ headersSent, hasHeader: () => header, setHeader }),
    }),
  } as unknown as ExecutionContext;
  await lastValueFrom(new PrivateJsonCacheInterceptor().intercept(context, { handle: () => of(body) }));
  return setHeader;
};

describe(PrivateJsonCacheInterceptor.name, () => {
  it('marks signed-in JSON for revalidation', async () => {
    await expect(run({ id: 1 })).resolves.toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
    await expect(run([])).resolves.toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
  });

  it('leaves public, file, already-sent and route-set responses alone', async () => {
    await expect(run({ id: 1 }, { user: null })).resolves.not.toHaveBeenCalled();
    await expect(run(undefined)).resolves.not.toHaveBeenCalled();
    await expect(run(new StreamableFile(Buffer.from('x')))).resolves.not.toHaveBeenCalled();
    await expect(run({ id: 1 }, { header: true })).resolves.not.toHaveBeenCalled();
    await expect(run({ id: 1 }, { headersSent: true })).resolves.not.toHaveBeenCalled();
  });
});
