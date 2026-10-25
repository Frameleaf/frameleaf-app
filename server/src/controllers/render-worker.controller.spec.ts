import { RenderWorkerController } from 'src/controllers/render-worker.controller.js';
import { sendFile } from 'src/utils/file.js';
import { getMocks } from 'test/utils.js';

vi.mock('src/utils/file.js', async (original) => ({
  ...(await original<typeof import('src/utils/file.js')>()),
  sendFile: vi.fn(),
}));
it('passes the HTTP stream cancellation signal to remote input acquisition', async () => {
  const signal = new AbortController().signal;
  const file = {};
  const service = { readInput: vi.fn().mockResolvedValue(file) };
  vi.mocked(sendFile).mockImplementation(async (_res, _next, read) => {
    await read(signal);
  });
  const sut = new RenderWorkerController(service as never, getMocks().logger as never);
  await sut.readRenderOperationInput('session', { id: 'operation', grant: 'grant' }, {} as never, vi.fn());
  expect(service.readInput).toHaveBeenCalledWith('session', 'operation', 'grant', signal);
});
