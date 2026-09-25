import { BrowserContext, WebSocketRoute } from '@playwright/test';

/**
 * A stand-in for the server's socket.io endpoint, so a UI spec can send the live events another tab
 * or device would cause (FL-47). It speaks just enough of the Engine.IO v4 / Socket.IO v5 protocol
 * over the websocket transport the web app uses: the open packet, the namespace connect, pings, and
 * `42[...]` event packets. Every page of the context that connected receives each event.
 */
export const setupSocketMock = async (context: BrowserContext) => {
  const sockets = new Set<WebSocketRoute>();
  let next = 0;

  await context.routeWebSocket('**/api/socket.io/**', (socket) => {
    const sid = `e2e-${++next}`;
    socket.send(
      `0${JSON.stringify({ sid, upgrades: [], pingInterval: 300_000, pingTimeout: 300_000, maxPayload: 1_000_000 })}`,
    );
    socket.onMessage((message) => {
      if (typeof message !== 'string') {
        return;
      }
      if (message.startsWith('40')) {
        socket.send(`40${JSON.stringify({ sid: `${sid}-io` })}`);
        sockets.add(socket);
      } else if (message === '2') {
        socket.send('3');
      }
    });
    socket.onClose(() => sockets.delete(socket));
  });

  return {
    /** How many pages have a live connection. */
    connected: () => sockets.size,
    /** Send a server event, as `server/src/repositories/websocket` would, to every connected page. */
    emit: (event: string, ...args: unknown[]) => {
      for (const socket of sockets) {
        socket.send(`42${JSON.stringify([event, ...args])}`);
      }
    },
  };
};
