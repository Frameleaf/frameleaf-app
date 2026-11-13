import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  sign,
  type KeyObject,
  randomUUID,
} from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { Security } from '../src/security.js';
import { sha256 } from '../src/contracts.js';
import {
  DesktopGrants,
  pairingMessage,
  requestMessage,
} from '../src/desktop-grants.js';
const password = 'synthetic independent Manager password';
const origin = 'https://manager.test:9443';
const keypair = () => {
  const pair = generateKeyPairSync('ed25519');
  return {
    secret: pair.privateKey,
    publicKey: pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('base64'),
  };
};
const signature = (key: KeyObject, message: string) =>
  sign(null, Buffer.from(message), key).toString('base64');
const deviceId = randomUUID(),
  installationId = 'a'.repeat(12),
  device = keypair();
const details = {
  deviceId,
  publicKey: device.publicKey,
  installationId,
  scopes: ['status', 'start', 'stop', 'restore'],
};
const context = {
  installationId,
  scope: 'start',
  method: 'POST',
  path: '/manager-api/desktop/control',
  bodySha256: sha256('{"action":"start"}'),
};
async function fixture(
  run: (
    grants: DesktopGrants,
    store: Store,
    security: Security,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-manager-grants-')),
    store = new Store(root);
  const security = new Security(store, origin);
  try {
    await security.claim('Owner', password, '127.0.0.1');
    await run(new DesktopGrants(store, security), store, security);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function paired(grants: DesktopGrants, scopes = details.scopes) {
  const approval = await grants.approve(password, { ...details, scopes });
  const grant = grants.redeem({
    pairingId: approval.pairingId,
    secret: approval.secret,
    signature: signature(device.secret, pairingMessage(approval)),
  });
  return { approval, grant };
}
function proof(
  grants: DesktopGrants,
  grant: any,
  change: Record<string, unknown> = {},
  target = context,
) {
  const value = {
    protocolVersion: 1,
    managerId: grants.identity.id,
    grantId: grant.id,
    deviceId,
    token: grant.token,
    timestamp: Date.now(),
    nonce: randomUUID(),
    ...change,
  };
  return {
    ...value,
    signature: signature(
      device.secret,
      requestMessage(grants.identity, value, target),
    ),
  };
}

test('explicit Manager approval issues a device-bound grant usable after Manager replacement', async () => {
  await fixture(async (grants, store, security) => {
    await assert.rejects(
      grants.approve('ordinary-photo-token', details),
      /invalid_credentials/,
    );
    const { approval, grant } = await paired(grants);
    assert.equal(
      grants.authorize(proof(grants, grant), context).deviceId,
      deviceId,
    );
    const reopened = new DesktopGrants(store, security);
    assert.deepEqual(reopened.identity, grants.identity);
    assert.equal(
      reopened.authorize(proof(reopened, grant), context).id,
      grant.id,
    );
    assert.throws(
      () =>
        grants.redeem({
          pairingId: approval.pairingId,
          secret: approval.secret,
          signature: signature(device.secret, pairingMessage(approval)),
        }),
      /desktop_pairing_unavailable/,
    );
    const persisted =
      JSON.stringify(store.db.prepare('SELECT * FROM desktop_pairings').all()) +
      JSON.stringify(store.db.prepare('SELECT * FROM desktop_grants').all());
    for (const secret of [password, approval.secret, grant.token])
      assert.ok(!persisted.includes(secret));
    assert.ok(!JSON.stringify(grants.list()).includes(grant.token));
  });
});
test('pairing rejects a wrong key, secret, changed approval and expired approval', async (t) => {
  await fixture(async (grants) => {
    const approval = await grants.approve(password, details);
    const redeem = (patch = {}, key = device.secret, signed = approval) =>
      grants.redeem({
        pairingId: approval.pairingId,
        secret: approval.secret,
        signature: signature(key, pairingMessage(signed)),
        ...patch,
      });
    assert.throws(
      () => redeem({}, keypair().secret),
      /desktop_pairing_invalid/,
    );
    assert.throws(
      () => redeem({ secret: '0'.repeat(64) }),
      /desktop_pairing_invalid/,
    );
    assert.throws(
      () =>
        redeem({}, device.secret, {
          ...approval,
          installationId: 'b'.repeat(12),
        }),
      /desktop_pairing_invalid/,
    );
    t.mock.timers.enable({ apis: ['Date'], now: approval.expiresAt });
    assert.throws(() => redeem(), /desktop_pairing_unavailable/);
  });
});
test('requests bind Manager, device, installation, action, body and reject durable replay', async () => {
  await fixture(async (grants, store, security) => {
    const { grant } = await paired(grants),
      signed = proof(grants, grant);
    for (const patch of [
      { scope: 'backup' },
      { installationId: 'b'.repeat(12) },
      { bodySha256: sha256('changed') },
      { method: 'GET' },
      { path: '/manager-api/desktop/status' },
    ])
      assert.throws(
        () => grants.authorize(signed, { ...context, ...patch }),
        /desktop_grant_(?:invalid|scope_denied|installation_changed)/,
      );
    for (const patch of [
      { managerId: randomUUID() },
      { deviceId: randomUUID() },
      { token: 'd'.repeat(64) },
      { timestamp: Date.now() - 120000 },
      { timestamp: Date.now() + 120000 },
    ])
      assert.throws(
        () => grants.authorize(proof(grants, grant, patch), context),
        /desktop_grant_invalid/,
      );
    assert.throws(
      () =>
        grants.authorize(
          { ...signed, signature: signature(keypair().secret, 'forged') },
          context,
        ),
      /desktop_grant_invalid/,
    );
    const foreignOrigin = {
      ...grants.identity,
      origin: 'https://other.test:9443',
    };
    assert.throws(
      () =>
        grants.authorize(
          {
            ...signed,
            signature: signature(
              device.secret,
              requestMessage(foreignOrigin, signed, context),
            ),
          },
          context,
        ),
      /desktop_grant_invalid/,
    );
    grants.authorize(signed, context);
    assert.throws(
      () => new DesktopGrants(store, security).authorize(signed, context),
      /desktop_request_replayed/,
    );
    // A changed MANAGER_ORIGIN rotates the grant epoch instead of refusing to start (review M1).
    const otherOrigin = new Security(
      store,
      'https://other.test:9443',
    );
    const rotated = new DesktopGrants(store, otherOrigin);
    assert.equal(rotated.identity.id, grants.identity.id);
    assert.equal(rotated.identity.origin, 'https://other.test:9443');
    assert.throws(
      () => rotated.authorize(proof(grants, grant), context),
      /desktop_grant_invalid/,
    );
  });
});
test('changing MANAGER_ORIGIN after pairing revokes grants and pending pairings, and Manager still starts', async (t) => {
  await fixture(async (grants, store, security) => {
    const { grant } = await paired(grants);
    const pending = await grants.approve(password, { ...details, deviceId: randomUUID() });
    assert.equal(grants.list().length, 1);
    // Unchanged origin: nothing is rotated across a Manager restart.
    assert.equal(new DesktopGrants(store, security).list().length, 1);
    assert.equal(store.get('desktop-manager-identity-rotation'), null);
    const logged: string[] = [];
    t.mock.method(console, 'error', (line: string) => logged.push(line));
    const moved = new DesktopGrants(store, new Security(store, 'http://tower.local:2282'));
    assert.equal(moved.identity.id, grants.identity.id, 'the Manager identity survives; only its origin moves');
    assert.equal(moved.identity.origin, 'http://tower.local:2282');
    assert.deepEqual(moved.list(), []);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM desktop_pairings').get()!.count, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM desktop_nonces').get()!.count, 0);
    assert.throws(() => moved.authorize(proof(moved, grant), context), /desktop_grant_invalid/);
    assert.throws(
      () =>
        moved.redeem({
          pairingId: pending.pairingId,
          secret: pending.secret,
          signature: signature(device.secret, pairingMessage(pending)),
        }),
      /desktop_pairing_unavailable/,
    );
    const rotation = store.get<any>('desktop-manager-identity-rotation');
    assert.equal(rotation.from, origin);
    assert.equal(rotation.to, 'http://tower.local:2282');
    assert.equal(rotation.revokedGrants, 1);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /MANAGER_ORIGIN changed from https:\/\/manager.test:9443 to http:\/\/tower.local:2282; 1 desktop grant/);
    // Devices pair again under the new origin.
    const again = await paired(moved);
    assert.equal(again.grant.origin, 'http://tower.local:2282');
    assert.equal(moved.authorize(proof(moved, again.grant), context).id, again.grant.id);
    // Reopening with the same new origin keeps the new epoch.
    assert.equal(new DesktopGrants(store, new Security(store, 'http://tower.local:2282')).list().length, 1);
  });
});
test('recent Manager authentication gates every destructive scope and renews explicitly', async (t) => {
  await fixture(async (grants) => {
    const scopes = [
      'stop',
      'restart',
      'backup',
      'update',
      'restore',
      'move-library',
    ];
    const { grant } = await paired(grants, ['status', 'start', ...scopes]);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 300001 });
    for (const scope of scopes) {
      const target = { ...context, scope };
      assert.throws(
        () => grants.authorize(proof(grants, grant, {}, target), target),
        /desktop_recent_auth_required/,
      );
    }
    grants.authorize(proof(grants, grant), context);
    const status = { ...context, scope: 'status' };
    grants.authorize(proof(grants, grant, {}, status), status);
    await assert.rejects(
      grants.reauthenticate('photo-or-worker-token', grant.id),
      /invalid_credentials/,
    );
    await grants.reauthenticate(password, grant.id);
    for (const scope of scopes) {
      const target = { ...context, scope };
      grants.authorize(proof(grants, grant, {}, target), target);
    }
  });
});
test('revoke and administrator rotation invalidate grants and pending pairings', async () => {
  await fixture(async (grants, _store, security) => {
    const { grant } = await paired(grants);
    await assert.rejects(
      grants.revoke('wrong', grant.id),
      /invalid_credentials/,
    );
    await grants.revoke(password, grant.id);
    assert.throws(
      () => grants.authorize(proof(grants, grant), context),
      /desktop_grant_invalid/,
    );
    const active = await paired(grants),
      pending = await grants.approve(password, details);
    await security.updateAdministrator(
      'Owner',
      password,
      'replacement synthetic Manager password',
    );
    assert.throws(
      () => grants.authorize(proof(grants, active.grant), context),
      /desktop_grant_invalid/,
    );
    assert.throws(
      () =>
        grants.redeem({
          pairingId: pending.pairingId,
          secret: pending.secret,
          signature: signature(device.secret, pairingMessage(pending)),
        }),
      /desktop_pairing_unavailable/,
    );
  });
});
test('expired grants and malformed or authority-expanding input fail closed', async (t) => {
  await fixture(async (grants) => {
    for (const patch of [
      { publicKey: 'bad' },
      { scopes: ['shell'] },
      { scopes: [] },
      { scopes: ['start', 'start'] },
      { deviceId: 'bad' },
      { installationId: '../host' },
      { trusted: true },
    ])
      await assert.rejects(
        grants.approve(password, { ...details, ...patch }),
        /desktop_pairing_invalid/,
      );
    const { grant } = await paired(grants);
    assert.throws(
      () =>
        grants.authorize(
          { ...proof(grants, grant), photoToken: 'anything' },
          context,
        ),
      /desktop_grant_invalid/,
    );
    t.mock.timers.enable({ apis: ['Date'], now: grant.expiresAt });
    assert.throws(
      () => grants.authorize(proof(grants, grant), context),
      /desktop_grant_invalid/,
    );
  });
});

test('pairing consumption and request replay are serialized across separate Manager stores', async () => {
  await fixture(async (grants, store) => {
    const second = new Store(store.directory);
    try {
      const peer = new DesktopGrants(
        second,
        new Security(second, origin),
      );
      const approval = await grants.approve(password, details);
      const redemption = {
        pairingId: approval.pairingId,
        secret: approval.secret,
        signature: signature(device.secret, pairingMessage(approval)),
      };
      const grant = peer.redeem(redemption);
      assert.throws(
        () => grants.redeem(redemption),
        /desktop_pairing_unavailable/,
      );
      const signed = proof(grants, grant);
      peer.authorize(signed, context);
      assert.throws(
        () => grants.authorize(signed, context),
        /desktop_request_replayed/,
      );
      await grants.revoke(password, grant.id);
      assert.throws(
        () => peer.authorize(proof(peer, grant), context),
        /desktop_grant_invalid/,
      );
    } finally {
      second.close();
    }
  });
});

test('a backwards clock cannot extend a grant or its recent authentication', async (t) => {
  await fixture(async (grants) => {
    const { grant } = await paired(grants);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() - 86_400_000 });
    assert.throws(
      () => grants.authorize(proof(grants, grant), context),
      /desktop_grant_invalid/,
    );
  });
});
test('a native Manager moved to another loopback port keeps its grants; every other origin change still revokes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-manager-grants-')),
    store = new Store(root);
  const loopback = 'https://127.0.0.1:9443';
  try {
    const security = new Security(store, loopback);
    await security.claim('Owner', password, '127.0.0.1');
    const grants = new DesktopGrants(store, security, true);
    const { grant } = await paired(grants);
    const moved = new DesktopGrants(
      store,
      new Security(store, 'https://127.0.0.1:19443'),
      true,
    );
    assert.equal(moved.identity.id, grants.identity.id);
    assert.equal(moved.identity.origin, 'https://127.0.0.1:19443');
    assert.equal(moved.list().length, 1);
    assert.equal(store.get('desktop-manager-identity-rotation'), null);
    // The proof is signed over the origin, so the device signs for the new one from now on.
    assert.equal(moved.authorize(proof(moved, grant), context).id, grant.id);
    assert.throws(
      () => moved.authorize(proof(grants, grant), context),
      /desktop_grant_invalid/,
    );
    // Without the native runtime the same change is an ordinary origin change.
    const docker = new DesktopGrants(store, new Security(store, loopback));
    assert.deepEqual(docker.list(), []);
    await paired(docker);
    // Another host, another scheme or an unparseable stored origin is never carried.
    for (const other of [
      'https://[::1]:9443',
      'https://localhost:9443',
      'https://192.168.1.20:9443',
      'http://127.0.0.1:9443',
    ]) {
      const next = new DesktopGrants(store, new Security(store, other), true);
      assert.deepEqual(next.list(), [], other);
      new DesktopGrants(store, new Security(store, loopback), true);
      await paired(new DesktopGrants(store, new Security(store, loopback), true));
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
