import { MediaOperationChange } from 'src/repositories/media-operation.repository.js';
import { MediaOperationEventService } from 'src/services/media-operation-event.service.js';

describe(MediaOperationEventService.name, () => {
  let listener: ((changes: MediaOperationChange[]) => void) | undefined;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let operations: { onChange: ReturnType<typeof vi.fn> };
  let websocket: { clientSend: ReturnType<typeof vi.fn> };
  let sut: MediaOperationEventService;

  beforeEach(() => {
    listener = undefined;
    unsubscribe = vi.fn();
    operations = {
      onChange: vi.fn().mockImplementation((fn) => {
        listener = fn;
        return unsubscribe;
      }),
    };
    websocket = { clientSend: vi.fn() };
    sut = new MediaOperationEventService(operations as never, websocket as never);
  });

  it('sends each changed job’s id to its owner only (FL-43)', () => {
    sut.onBootstrap();
    listener!([
      { id: 'job-1', ownerId: 'owner-a' },
      { id: 'job-2', ownerId: 'owner-b' },
    ]);

    expect(websocket.clientSend).toHaveBeenCalledTimes(2);
    expect(websocket.clientSend).toHaveBeenCalledWith('on_media_operation_update', 'owner-a', 'job-1');
    expect(websocket.clientSend).toHaveBeenCalledWith('on_media_operation_update', 'owner-b', 'job-2');
  });

  it('sends one nudge per job, however many of its rows a pass changed', () => {
    sut.notify([
      { id: 'job-1', ownerId: 'owner-a' },
      { id: 'job-1', ownerId: 'owner-a' },
    ]);

    expect(websocket.clientSend).toHaveBeenCalledTimes(1);
  });

  it('subscribes once and lets go on shutdown', () => {
    sut.onBootstrap();
    sut.onBootstrap();
    expect(operations.onChange).toHaveBeenCalledTimes(1);

    sut.onShutdown();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
