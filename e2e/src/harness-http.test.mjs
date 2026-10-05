import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { requestOnce, withDeadline } from './harness-wait.ts';

const closeBudget = 1_000;
const testOptions = { timeout: 5_000, concurrency: false };

// This independent observer does not stop a request or manufacture settlement.
// Failure reaches the fixture's finally, which destroys its own sockets/server.
const observeUntil = async (predicate, signal, description) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(description)), closeBudget);
  const observation = AbortSignal.any([signal, controller.signal]);
  try {
    while (!predicate()) {
      await sleep(5, undefined, { signal: observation });
    }
  } finally {
    clearTimeout(timer);
  }
};

const withLoopback = async (t, handle, run) => {
  const listening = new AbortController();
  const sockets = new Set();
  const peers = [];
  const clients = [];
  const pendingRequests = [];
  const contexts = [];
  const parent = new AbortController();
  const signal = AbortSignal.any([t.signal, parent.signal]);
  const reason = new Error('The owning test cancelled its HTTP request');
  const counts = { factories: 0, requests: 0, mutations: 0, callbacks: 0, validations: 0, lateCallbacks: 0 };
  let joined = false;
  const server = createServer((incoming, response) => {
    counts.requests++;
    const peer = { incoming, response, closed: false, errors: [] };
    peers.push(peer);
    response.once('close', () => {
      peer.closed = true;
    });
    // A deliberately late write to an already cancelled peer must not be unhandled.
    response.on('error', (error) => peer.errors.push(error));
    handle(peer, { parent, reason, counts });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const track = (pending, onData) => {
    counts.factories++;
    const originalEnd = pending.end;
    // Observe the real SuperTest completion callback, preserving its arguments,
    // this binding and native transport. No synthetic promise or abort is used.
    pending.end = function (callback) {
      return originalEnd.call(this, function (...args) {
        counts.callbacks++;
        if (joined) counts.lateCallbacks++;
        return callback.apply(this, args);
      });
    };
    pendingRequests.push({ pending, originalEnd });
    pending.once('request', ({ req }) => {
      const client = { req, closed: false, socketClosed: false, bytes: 0, response: undefined, responseClosed: false };
      clients.push(client);
      req.once('close', () => {
        client.closed = true;
      });
      const captureSocket = (socket) => {
        client.socket = socket;
        socket.once('close', () => {
          client.socketClosed = true;
        });
      };
      if (req.socket) captureSocket(req.socket);
      else req.once('socket', captureSocket);
      req.once('response', (response) => {
        client.response = response;
        response.once('close', () => {
          client.responseClosed = true;
        });
        response.on('data', (chunk) => {
          client.bytes += chunk.length;
          onData?.();
        });
      });
    });
    return pending
      .agent(false)
      .set('Connection', 'close')
      .expect(() => {
        counts.validations++;
      });
  };

  const transportClosed = () =>
    sockets.size === 0 &&
    peers.every(({ closed }) => closed) &&
    clients.every(
      ({ closed, socket, socketClosed, response, responseClosed }) =>
        closed && (!socket || socketClosed) && (!response || responseClosed),
    );

  const fixture = {
    parent,
    signal,
    reason,
    counts,
    clients,
    peers,
    track,
    context: (context) => {
      contexts.push(context);
      return context;
    },
    joined: () => {
      joined = true;
    },
    closed: async () => {
      await observeUntil(transportClosed, t.signal, 'HTTP transport did not close within its owned budget');
      assert.equal(sockets.size, 0);
      assert.ok(peers.every(({ response }) => response.destroyed));
      assert.ok(clients.every(({ req, socket }) => req.destroyed && socket.destroyed));
      for (const { errors } of peers) {
        assert.ok(errors.every(({ code }) => ['ECONNRESET', 'EPIPE', 'ERR_STREAM_DESTROYED'].includes(code)));
      }
    },
    assertDetached: () => {
      assert.equal(getEventListeners(signal, 'abort').length, 0, 'withDeadline retained its parent listener');
      for (const { signal: child } of contexts) {
        assert.equal(getEventListeners(child, 'abort').length, 0, 'requestOnce retained its abort listener');
      }
    },
    assertQuiet: async () => {
      const before = { ...counts };
      // Exercise a late server completion while the listener is still live. Any
      // replay can still reach this server; teardown cannot hide it.
      for (const { response } of peers) {
        if (!response.writableEnded) response.end(response.headersSent ? 'true}' : '{"ready":true}');
      }
      await fixture.closed();
      await nextTurn();
      await nextTurn();
      assert.deepEqual(counts, before, 'HTTP callbacks, validation or replay continued after join');
      assert.equal(counts.lateCallbacks, 0);
      fixture.assertDetached();
    },
  };

  let failure;
  try {
    const ready = once(server, 'listening', { signal: t.signal });
    server.listen({ host: '127.0.0.1', port: 0, signal: listening.signal });
    await ready;
    fixture.url = `http://127.0.0.1:${server.address().port}`;
    await run(fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Cleanup is separately bounded and does not rely on the cancelled test
    // signal. First stop every resource, then await observed native closure.
    const cleanup = new AbortController();
    const timer = setTimeout(() => cleanup.abort(new Error('Loopback fixture cleanup did not finish')), closeBudget);
    try {
      const closed = server.listening ? once(server, 'close', { signal: cleanup.signal }) : Promise.resolve();
      parent.abort(reason);
      listening.abort();
      for (const { pending } of pendingRequests) {
        if (!pending.req?.destroyed) pending.abort();
        pending.req?.destroy();
        pending.req?.socket?.destroy();
      }
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await closed;
      await observeUntil(transportClosed, cleanup.signal, 'Loopback fixture left an owned transport open');
      assert.equal(server.listening, false);
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], 'HTTP contract and owned fixture cleanup both failed');
      throw error;
    } finally {
      clearTimeout(timer);
      for (const { pending, originalEnd } of pendingRequests) pending.end = originalEnd;
    }
  }
};

for (const stage of ['headers', 'body']) {
  for (const cancellation of ['deadline', 'parent']) {
    test(
      `${cancellation} joins a real stalled ${stage} request without late callbacks or validation`,
      testOptions,
      async (t) => {
        await withLoopback(
          t,
          ({ response }, { parent, reason }) => {
            if (stage === 'body') {
              response.writeHead(200, { 'Content-Type': 'application/json' });
              response.write('{"ready":');
            } else if (cancellation === 'parent') {
              parent.abort(reason);
            }
          },
          async (fixture) => {
            const budget = cancellation === 'deadline' ? 350 : 2_000;
            const started = performance.now();
            await assert.rejects(
              withDeadline(
                `stalled ${stage}`,
                budget,
                (context) =>
                  requestOnce(fixture.context(context), () =>
                    fixture.track(request(fixture.url).get('/stall'), () => {
                      if (cancellation === 'parent') fixture.parent.abort(fixture.reason);
                    }),
                  ),
                fixture.signal,
              ),
              (error) => {
                if (cancellation === 'parent') return error === fixture.reason;
                // SuperAgent and the helper share one remaining deadline. Either may
                // deliver its timeout first; an unrelated transport error is not a pass.
                return (
                  error.message === `stalled ${stage} timed out` ||
                  (error.code === 'ECONNABORTED' && error.timeout > 0 && error.timeout <= budget)
                );
              },
            );
            fixture.joined();
            assert.ok(
              performance.now() - started < closeBudget,
              'Cancellation waited for the full fallback request timeout',
            );
            assert.equal(fixture.counts.factories, 1);
            assert.equal(fixture.counts.requests, 1);
            assert.equal(fixture.clients.length, 1);
            if (stage === 'body') {
              assert.ok(fixture.clients[0].bytes > 0, 'The actual response body never reached the client');
              assert.equal(fixture.clients[0].response.complete, false);
            } else {
              assert.equal(fixture.clients[0].response, undefined);
            }
            assert.equal(fixture.counts.validations, 0);
            fixture.assertDetached();
            await fixture.assertQuiet();
          },
        );
      },
    );
  }
}

test('an applied mutation is never replayed after a lost response', testOptions, async (t) => {
  await withLoopback(
    t,
    ({ incoming, response }, { counts }) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        body += chunk;
      });
      incoming.once('end', () => {
        if (body !== '{"apply":true}') {
          response.writeHead(422).end('Unexpected mutation payload');
          return;
        }
        counts.mutations++;
        incoming.socket.destroy();
      });
    },
    async (fixture) => {
      await assert.rejects(
        withDeadline(
          'ambiguous mutation',
          2_000,
          (context) =>
            requestOnce(fixture.context(context), () =>
              fixture.track(request(fixture.url).post('/mutate').send({ apply: true })),
            ),
          fixture.signal,
        ),
        (error) => error.code === 'ECONNRESET',
      );
      fixture.joined();
      assert.equal(fixture.counts.factories, 1);
      assert.equal(fixture.counts.requests, 1);
      assert.equal(fixture.counts.mutations, 1);
      assert.equal(fixture.counts.callbacks, 1);
      assert.equal(fixture.counts.validations, 0);
      await fixture.assertQuiet();
    },
  );
});

test('a real successful response validates once and detaches cancellation', testOptions, async (t) => {
  await withLoopback(
    t,
    ({ response }) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ready":true}');
    },
    async (fixture) => {
      const response = await withDeadline(
        'successful request',
        2_000,
        (context) =>
          requestOnce(fixture.context(context), () => fixture.track(request(fixture.url).get('/success')).expect(200)),
        fixture.signal,
      );
      fixture.joined();
      assert.deepEqual(response.body, { ready: true });
      assert.equal(fixture.counts.factories, 1);
      assert.equal(fixture.counts.requests, 1);
      assert.equal(fixture.counts.callbacks, 1);
      assert.equal(fixture.counts.validations, 1);
      fixture.assertDetached();
      fixture.parent.abort(fixture.reason);
      await fixture.assertQuiet();
      assert.equal(fixture.clients[0].response.complete, true);
    },
  );
});

test('an already cancelled owner creates no real HTTP request or residual listener', testOptions, async (t) => {
  await withLoopback(
    t,
    ({ response }) => response.end('unexpected request'),
    async (fixture) => {
      fixture.parent.abort(fixture.reason);
      await assert.rejects(
        withDeadline(
          'pre-cancelled request',
          2_000,
          (context) => requestOnce(fixture.context(context), () => fixture.track(request(fixture.url).get('/never'))),
          fixture.signal,
        ),
        (error) => error === fixture.reason,
      );
      fixture.joined();
      assert.equal(fixture.counts.factories, 0);
      assert.equal(fixture.counts.requests, 0);
      assert.equal(fixture.counts.callbacks, 0);
      assert.equal(fixture.counts.validations, 0);
      await fixture.assertQuiet();
    },
  );
});
