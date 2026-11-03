import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DevelopBatchController } from 'src/controllers/develop-batch.controller.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DevelopBatchService, batchStagingFolder } from 'src/services/develop-batch.service.js';
import { type ControllerContext, controllerSetup } from 'test/utils.js';

const owner = 'e2d7dc82-8095-42ff-8338-19d9e3caac20';
const batch = 'e2d7dc82-8095-42ff-8338-19d9e3caac21';
const item = 'e2d7dc82-8095-42ff-8338-19d9e3caac22';
describe('batch multipart validation cleanup', () => {
  let ctx: ControllerContext, root: string, previous: string;
  const service = { import: vi.fn() };
  beforeAll(async () => {
    try {
      previous = StorageCore.getMediaLocation();
    } catch {
      /* unset in unit tests */
    }
    root = await mkdtemp(join(tmpdir(), 'batch-controller-'));
    StorageCore.setMediaLocation(root);
    ctx = await controllerSetup(DevelopBatchController, [
      { provide: DevelopBatchService, useValue: service },
      {
        provide: LoggingRepository,
        useValue: { setContext: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn(), debug: vi.fn() },
      },
    ]);
    ctx.authenticate.mockResolvedValue({ user: { id: owner } });
  });
  afterAll(async () => {
    await ctx.close();
    if (previous) StorageCore.setMediaLocation(previous);
    await rm(root, { recursive: true, force: true });
  });
  it('removes staged bytes when body validation fails and rejects invalid IDs before staging', async () => {
    const base = `/develop-batches/${batch}/items/${item}/import`;
    const result = await request(ctx.getHttpServer())
      .post(base)
      .field('confirmationId', 'invalid')
      .field('renditionChecksum', 'invalid')
      .attach('file', Buffer.from('test'), 'test.png');
    expect(result.status).toBe(400);
    expect(await readdir(batchStagingFolder(owner, batch)).catch(() => [])).toEqual([]);
    const invalid = await request(ctx.getHttpServer())
      .post(`/develop-batches/not-a-uuid/items/${item}/import`)
      .attach('file', Buffer.from('test'), 'test.png');
    expect(invalid.status).toBe(400);
    expect(service.import).not.toHaveBeenCalled();
  });
  it('removes a partial upload when its client aborts', async () => {
    const server = ctx.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const req = httpRequest({
      method: 'POST',
      port: server.address().port,
      path: `/develop-batches/${batch}/items/${item}/import`,
      headers: { 'content-type': 'multipart/form-data; boundary=boundary' },
    });
    req.on('error', () => {});
    req.write(
      '--boundary\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\npartial',
    );
    let staged: string[] = [];
    for (let attempt = 0; attempt < 50 && staged.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      staged = await readdir(batchStagingFolder(owner, batch)).catch(() => []);
    }
    expect(staged).toHaveLength(1);
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readdir(batchStagingFolder(owner, batch)).catch(() => [])).toEqual([]);
    expect(service.import).not.toHaveBeenCalled();
  });
});
