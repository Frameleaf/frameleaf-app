import { PassThrough, Readable } from 'node:stream';
import { StudioPreviewController } from 'src/controllers/studio-preview.controller.js';
import { authStub } from 'test/fixtures/auth.stub.js';

describe(StudioPreviewController.name, () => {
  it('delivers the verified stream without reopening its reported path', async () => {
    const bytes = Buffer.from('verified preview');
    const service = {
      getFrame: vi.fn().mockResolvedValue({
        etag: 'revision',
        file: { path: '/never-open-this-path', contentType: 'image/png' },
        stream: Readable.from([bytes]),
      }),
    };
    const controller = new StudioPreviewController(service as never, { setContext: vi.fn() } as never);
    const res = Object.assign(new PassThrough(), { setHeader: vi.fn() });
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    await controller.viewStudioPreviewFrame(
      authStub.user1,
      { id: 'frame' },
      {},
      { headers: {} } as never,
      res as never,
    );
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-cache, no-transform');
    expect(res.setHeader).toHaveBeenCalledWith('ETag', 'revision');
  });
});
