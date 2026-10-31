import { Emitter } from '@socket.io/component-emitter';
import { Manager } from 'socket.io-client';
import { createEventEmitter } from './eventemitter';

const createSocket = () => new Manager({ autoConnect: false }).socket('/');
const emit = (socket: ReturnType<typeof createSocket>, ...args: unknown[]) =>
  Reflect.apply(Emitter.prototype.emit, socket, args);

describe('Socket.IO subscription ownership', () => {
  it('removes the requested duplicate without changing the retained callback order', () => {
    const socket = createSocket();
    const events = createEventEmitter(socket);
    const calls: string[] = [];
    const shared = () => {
      calls.push('shared');
    };
    const first = events.on('change', shared);
    const middle = events.on('change', () => {
      calls.push('middle');
    });
    const last = events.on('change', shared);
    last();
    emit(socket, 'change');
    expect(calls).toEqual(['shared', 'middle']);
    first();
    middle();
  });

  it('keeps a duplicate owner alive after another cleanup is repeated', () => {
    const socket = createSocket();
    const events = createEventEmitter(socket);
    let calls = 0;
    const listener = () => calls++;
    const first = events.on('change', listener);
    const second = createEventEmitter(socket).on('change', listener);
    first();
    first();
    emit(socket, 'change');
    expect(calls).toBe(1);
    second();
    expect(socket.hasListeners('change')).toBe(false);
  });

  it('keeps direct and once registrations when its own cleanup is repeated', () => {
    const socket = createSocket();
    const events = createEventEmitter(socket);
    let calls = 0;
    const listener = () => calls++;
    const cleanup = events.on('change', listener);
    socket.on('change', listener);
    socket.once('change', listener);
    cleanup();
    cleanup();
    emit(socket, 'change');
    expect(calls).toBe(2);
    emit(socket, 'change');
    expect(calls).toBe(3);
    socket.off('change', listener);
  });

  it('retains Socket.IO context, shared argument identity and exact return values', () => {
    const socket = createSocket();
    const events = createEventEmitter(socket);
    const payload = { value: 0 };
    const output: string[] = [];
    const contexts: unknown[] = [];
    const result = Promise.resolve('result');
    const first = events.on('change', function (this: unknown, data, values) {
      expect(data).toBe(payload);
      expect(values).toBe(output);
      contexts.push(this);
      data.value++;
      values.push('first');
      return result;
    });
    const second = events.on('change', function (this: unknown, data, values) {
      contexts.push(this);
      values.push(`second:${data.value}`);
    });
    expect(socket.listeners('change')[0].apply(socket, [payload, output])).toBe(result);
    expect(contexts).toEqual([socket]);
    output.length = 0;
    contexts.length = 0;
    emit(socket, 'change', payload, output);
    expect(contexts).toEqual([socket, socket]);
    expect(output).toEqual(['first', 'second:2']);
    first();
    second();
  });

  it('supports removal by the original callback and harmless owner cleanup afterward', () => {
    const socket = createSocket();
    const events = createEventEmitter(socket);
    let calls = 0;
    const listener = () => calls++;
    const cleanup = events.on('change', listener);
    const second = events.on('change', listener);
    socket.off('change', listener);
    cleanup();
    emit(socket, 'change');
    expect(calls).toBe(1);
    second();
  });

  it('retains outer dispatch snapshots through cleanup, additions and nested delivery', () => {
    const socket = createSocket();
    const events = createEventEmitter(socket);
    const calls: string[] = [];
    let remove = () => {};
    let added = false;
    const cleanups = [
      events.on('change', (value) => {
        calls.push(`first:${value}`);
        if (!added) {
          added = true;
          remove();
          cleanups.push(
            events.on('change', (next) => {
              calls.push(`new:${next}`);
            }),
          );
          emit(socket, 'change', 2);
        }
      }),
    ];
    remove = events.on('change', (value) => {
      calls.push(`removed:${value}`);
    });
    emit(socket, 'change', 1);
    expect(calls).toEqual(['first:1', 'first:2', 'new:2', 'removed:1']);
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it('propagates the original synchronous error and leaves later listeners untouched', () => {
    const socket = createSocket();
    const events = createEventEmitter(socket);
    const error = new Error('listener failure');
    let later = 0;
    const remove = events.on('change', () => {
      throw error;
    });
    const last = events.on('change', () => later++);
    try {
      emit(socket, 'change');
      expect.unreachable();
    } catch (error_) {
      expect(error_).toBe(error);
    }
    expect(later).toBe(0);
    remove();
    emit(socket, 'change');
    expect(later).toBe(1);
    last();
  });

  it('retries failed native removal without detaching another owner', () => {
    const socket = createSocket();
    const events = createEventEmitter(socket);
    const callback = () => {};
    const first = events.on('change', callback);
    const second = events.on('change', callback);
    const error = new Error('removal failed');
    const off = vi.spyOn(socket, 'off').mockImplementationOnce(() => {
      throw error;
    });
    expect(first).toThrow(error);
    expect(socket.listeners('change')).toHaveLength(2);
    first();
    first();
    expect(socket.listeners('change')).toHaveLength(1);
    expect(off).toHaveBeenCalledTimes(2);
    second();
    expect(socket.hasListeners('change')).toBe(false);
  });
});
