import { Emitter } from '@socket.io/component-emitter';
import { Manager } from 'socket.io-client';
import { createEventEmitter } from './eventemitter';

describe('createEventEmitter', () => {
  it('removes only the registered Socket.IO callback and supports repeated cleanup', () => {
    const socket = new Manager({ autoConnect: false }).socket('/');
    const events = createEventEmitter(socket);
    const first = vi.fn();
    const second = vi.fn();
    const remove = events.on('change', first);
    const removeSecond = events.on('change', second);
    expect(socket.listeners('change')).toHaveLength(2);
    Emitter.prototype.emit.call(socket, 'change');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    remove();
    remove();
    expect(socket.listeners('change')).toHaveLength(1);
    Emitter.prototype.emit.call(socket, 'change');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    removeSecond();
    expect(socket.listeners('change')).toEqual([]);
  });
});
