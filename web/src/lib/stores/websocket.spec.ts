import { get } from 'svelte/store';
import { websocketStore } from '$lib/stores/websocket';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
vi.mock('socket.io-client', () => {
  const socket = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return socket;
    },
  };
  return { io: () => socket };
});
vi.mock('$lib/utils/eventemitter', () => ({ createEventEmitter: () => ({}) }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: {} }));
vi.mock('$lib/managers/event-manager.svelte', () => ({ eventManager: { emit: vi.fn() } }));
vi.mock('$lib/stores/notification-manager.svelte', () => ({ notificationManager: {} }));

describe('restart delivery acknowledgement', () => {
  beforeEach(() => websocketStore.serverRestarting.set(undefined));

  it('records the new mode before acknowledging the one-shot restart request', () => {
    const mode = { isMaintenanceMode: true };
    const acknowledge = vi.fn((value: string) => {
      expect(value).toBe('ok');
      expect(get(websocketStore.serverRestarting)).toEqual(mode);
    });
    handlers.get('AppRestartV1')!(mode, acknowledge);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith('ok');
  });

  it('continues to accept ordinary restart broadcasts without an acknowledgement callback', () => {
    const mode = { isMaintenanceMode: false };
    handlers.get('AppRestartV1')!(mode);
    expect(get(websocketStore.serverRestarting)).toEqual(mode);
  });
});
