import { createDropUploadChannel } from './drag-and-drop-files.store';

const files = [new File(['photo'], 'photo.png')];

it('does not replay a drop to a receiver registered later', () => {
  const channel = createDropUploadChannel();
  const drop = channel.capture();
  const receive = vi.fn();
  drop(files);
  channel.register(receive);
  drop(files);
  expect(receive).not.toHaveBeenCalled();
});

it('delivers repeated drops to the current receiver without storing files', () => {
  const channel = createDropUploadChannel();
  const receive = vi.fn();
  channel.register(receive);
  channel.capture()(files);
  channel.capture()(files);
  channel.capture()([]);
  expect(receive).toHaveBeenCalledTimes(2);
  expect(receive).toHaveBeenCalledWith(files);
});

it('cancels an unfinished drop when its receiver is removed', () => {
  const channel = createDropUploadChannel();
  const receive = vi.fn();
  const stop = channel.register(receive);
  const drop = channel.capture();
  stop();
  drop(files);
  expect(receive).not.toHaveBeenCalled();
});

it('does not send an old drop to a replacement receiver or let old cleanup remove it', () => {
  const channel = createDropUploadChannel();
  const first = vi.fn();
  const next = vi.fn();
  const stop = channel.register(first);
  const oldDrop = channel.capture();
  channel.register(next);
  stop();
  oldDrop(files);
  channel.capture()(files);
  expect(first).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledExactlyOnceWith(files);
});

it('treats a re-registered callback as a new owner', () => {
  const channel = createDropUploadChannel();
  const receive = vi.fn();
  channel.register(receive);
  const oldDrop = channel.capture();
  channel.register(receive);
  oldDrop(files);
  expect(receive).not.toHaveBeenCalled();
});

it('keeps independent layouts isolated', () => {
  const first = createDropUploadChannel();
  const second = createDropUploadChannel();
  const receive = vi.fn();
  const other = vi.fn();
  first.register(receive);
  second.register(other);
  first.capture()(files);
  expect(receive).toHaveBeenCalledExactlyOnceWith(files);
  expect(other).not.toHaveBeenCalled();
});
