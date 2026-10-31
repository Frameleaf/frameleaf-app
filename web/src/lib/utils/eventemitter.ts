import type {
  DefaultEventsMap,
  EventsMap,
  ReservedOrUserEventNames,
  ReservedOrUserListener,
} from '@socket.io/component-emitter';
import type { Socket } from 'socket.io-client';

export function createEventEmitter<
  ListenEvents extends EventsMap = DefaultEventsMap,
  EmitEvents extends EventsMap = ListenEvents,
  ReservedEvents extends EventsMap = NonNullable<unknown>,
>(socket: Socket<ListenEvents, EmitEvents>) {
  function on<Ev extends ReservedOrUserEventNames<ReservedEvents, ListenEvents>>(
    ev: Ev,
    listener: ReservedOrUserListener<ReservedEvents, ListenEvents, Ev>,
  ) {
    const owned = Object.assign(
      function (this: unknown, ...args: unknown[]) {
        return Reflect.apply(listener, this, args);
      },
      // Socket.IO uses fn to support removal by the original callback.
      { fn: listener },
    ) as typeof listener;
    socket.on(ev, owned);
    let active = true;
    return () => {
      if (active) {
        socket.off(ev, owned);
        active = false;
      }
    };
  }

  return { on };
}
