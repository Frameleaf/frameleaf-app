# postgres 3.4.9 Node transport and reservation patch

The pinned patch applies identical changes to the ESM and CommonJS Node entrypoints. It does not upgrade postgres, replay queries, reconnect a transaction on a replacement backend, or change application retry ownership.

- `connection.js`: the one-line null-socket write guard corresponds to the upstream proposal [porsager/postgres#1168](https://github.com/porsager/postgres/pull/1168). It prevents an uncaught delayed write after connection close; by itself it does not settle a stranded reservation.
- `connection.js`: reject old active/sent work with the backend's FATAL response when one exists, then clear its response and row/result state before admitting a new backend. Otherwise the new backend's startup response can pass that old error to a fresh reservation. Network closes without a backend error retain the generic connection error. Discard the cancelled write buffer and timer reference on close so the replacement socket receives only new-session bytes. The initial connection retry branch remains unchanged.
- `index.js`: Frameleaf's reservation ownership repair follows an actual same-pool backend-termination failure. The driver emitted connection close and then rollback, but the rollback never settled within the unchanged thirty-second acceptance deadline. A reservation now retains its callback identity; obsolete queries reject with `CONNECTION_CLOSED`, and obsolete releases cannot reopen a closed connection or clear a replacement owner's claim. Connection close rejects the reservation's private pending-query queue. Pool-level consumers awaiting fresh reservations still use the existing reconnect path.
- `index.js` / `queue.js`: reconnect peeks at a pending reserve without removing it from the FIFO. Startup consumes that marker and then the existing onopen path grants the queued reservation. Ordinary queries still shift exactly once. This prevents a fresh reserve already waiting at connection close from being orphaned, without replaying old work or changing who owns the new connection.

[porsager/postgres#1195](https://github.com/porsager/postgres/issues/1195) is related upstream context, not proof of the exact local cause or an assertion that this downstream repair is accepted upstream. Remove this patch only after an upstream version passes both Node entrypoint controls and the existing real queue reconnect/rollback/fencing/single-retry test using the same pool and deadline.

Regression sources:

- `server/test/medium/specs/database/postgres-reservation.spec.ts`: actual backend termination, queued-query rejection, fresh pending reservation, no write replay, and stale/double release refusal for ESM and CommonJS.
- `server/test/medium/specs/repositories/queue-reliability-acceptance.spec.ts`: real queue publication rollback and one retry without replacing the pool/store.

Source review is separate from runtime qualification. These regression controls must pass against the installed patched dependency; the existence of this note or patch is not a passing result.
