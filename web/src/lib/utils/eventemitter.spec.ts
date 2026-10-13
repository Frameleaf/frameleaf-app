import { Manager } from 'socket.io-client';
import { createEventEmitter } from './eventemitter';

describe('createEventEmitter', () => {
  it('removes only the registered Socket.IO callback and supports repeated cleanup', () => {
    const socket = new Manager({ autoConnect: false }).socket('/');
    const events = createEventEmitter(socket);
    const first = () => {};
    const second = () => {};
    const remove = events.on('change', first);
    const removeSecond = events.on('change', second);
    expect(socket.listeners('change')).toEqual([first, second]);
    remove();
    remove();
    expect(socket.listeners('change')).toEqual([second]);
    removeSecond();
    expect(socket.listeners('change')).toEqual([]);
  });
});
