import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BuddyRecoveryAccess,
  buddyAuthorityMatches,
  buddyBackupRequestAllowed,
  buddyRecoveryRequestAllowed,
  buddyRelayPurposeProblem,
  readBuddyRecovery,
} from 'src/edge/buddy-recovery.js';

const SOURCE = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e51';
const DESTINATION = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e52';
const PAIR = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';
const VAULT = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e54';
const OTHER_VAULT = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e55';
const HOST = 'recovery.u225vlzhsdlhwh4l.frameleaf.net';
const API = 'https://api.frameleaf.cloud.test';
const NOW = Date.UTC(2026, 9, 2);
const access: BuddyRecoveryAccess = {
  pairId: PAIR,
  vaultId: VAULT,
  sourceInstanceId: SOURCE,
  readUntil: null,
  host: HOST,
};
const path = `/api/buddy/v1/vaults/${VAULT}/`;
const publicKey = { kty: 'OKP', crv: 'Ed25519', x: 'a'.repeat(43) };
const vault = {
  vaultId: VAULT,
  sourceInstanceId: SOURCE,
  destinationInstanceId: DESTINATION,
  sourceKey: publicKey,
  destinationKey: publicKey,
  quotaBytes: 10 * 1024 ** 3,
  retention: { days: 30, monthly: 12 },
};
const pairing = {
  version: 1,
  pairId: PAIR,
  state: 'active',
  readUntil: null,
  vaults: [vault, { ...vault, vaultId: OTHER_VAULT, sourceInstanceId: DESTINATION, destinationInstanceId: SOURCE }],
};

describe('Buddy recovery edge boundary', () => {
  it('allows paid Buddy writes only on exact capability routes, preserving reads while receiving is paused', () => {
    const paid = { ...access, backupEnabled: true as const, writeAllowed: true as const };
    for (const suffix of ['inventory', 'reservations', 'snapshots']) {
      expect(buddyBackupRequestAllowed(paid, 'POST', path + suffix, NOW)).toBe(true);
      expect(buddyBackupRequestAllowed(paid, 'POST', path + suffix + '?extra=1', NOW)).toBe(false);
    }
    expect(buddyBackupRequestAllowed(paid, 'PUT', path + 'objects/' + 'a'.repeat(64), NOW)).toBe(true);
    expect(buddyBackupRequestAllowed(paid, 'DELETE', path + 'snapshots', NOW)).toBe(false);
    expect(buddyBackupRequestAllowed(paid, 'POST', path.replace(VAULT, () => OTHER_VAULT) + 'snapshots', NOW)).toBe(
      false,
    );
    expect(buddyBackupRequestAllowed({ ...paid, writeAllowed: undefined }, 'POST', path + 'snapshots', NOW)).toBe(
      false,
    );
    expect(buddyBackupRequestAllowed({ ...paid, writeAllowed: undefined }, 'GET', path + 'snapshots', NOW)).toBe(true);
    expect(buddyBackupRequestAllowed(access, 'POST', path + 'snapshots', NOW)).toBe(false);
    expect(buddyAuthorityMatches('192-168-1-10.example.net:2443', '192-168-1-10.example.net')).toBe(true);
    for (const host of ['evil.example', '192-168-1-10.example.net:65536', '192-168-1-10.example.net:2443:extra']) {
      expect(buddyAuthorityMatches(host, '192-168-1-10.example.net')).toBe(false);
    }
  });

  it('allows only canonical GET/HEAD recovery reads in the incoming vault', () => {
    for (const method of ['GET', 'HEAD']) {
      for (const suffix of ['handshake', 'snapshots', `snapshots/${PAIR}`, `objects/${'a'.repeat(64)}`]) {
        expect(buddyRecoveryRequestAllowed(access, method, path + suffix, HOST, NOW)).toBe(true);
      }
    }
    for (const target of [
      '/api/server/ping',
      '/',
      path,
      path + 'snapshots/',
      path + 'snapshots?scope=write',
      path + 'snapshots#ignored',
      path + '../snapshots',
      path + '%73napshots',
      path + 'snapshots%2f' + PAIR,
      path + 'snapshots//' + PAIR,
      path + 'objects/' + 'a'.repeat(63),
      path + 'objects/' + 'A'.repeat(64),
      path.replace(VAULT, () => OTHER_VAULT) + 'snapshots',
      `https://${HOST}${path}snapshots`,
    ]) {
      expect(buddyRecoveryRequestAllowed(access, 'GET', target, HOST, NOW)).toBe(false);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'CONNECT']) {
      expect(buddyRecoveryRequestAllowed(access, method, path + 'handshake', HOST, NOW)).toBe(false);
    }
    expect(
      buddyRecoveryRequestAllowed(access, 'GET', path + 'handshake', 'r.u225vlzhsdlhwh4l.frameleaf.net', NOW),
    ).toBe(false);
    expect(buddyRecoveryRequestAllowed(null, 'GET', path + 'handshake', HOST, NOW)).toBe(false);
    expect(
      buddyRecoveryRequestAllowed(
        { ...access, readUntil: new Date(NOW).toISOString() },
        'GET',
        path + 'handshake',
        HOST,
        NOW,
      ),
    ).toBe(false);
  });

  it('requires a reciprocal readable pairing and reads no symlink, oversized or malformed state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-edge-state-'));
    const file = join(dir, 'buddy', 'state.json');
    const save = (value: unknown) => writeFile(file, JSON.stringify({ version: 1, settings: null, pairing: value }));
    try {
      await mkdir(join(dir, 'buddy'));
      await save(pairing);
      expect(await readBuddyRecovery(dir, DESTINATION, NOW)).toEqual({
        pairId: PAIR,
        vaultId: VAULT,
        sourceInstanceId: SOURCE,
        readUntil: null,
      });
      for (const changed of [
        { ...pairing, state: 'blocked' },
        { ...pairing, state: 'pending' },
        { ...pairing, vaults: [vault, vault] },
        { ...pairing, readUntil: new Date(NOW + 1000).toISOString() },
        { ...pairing, state: 'ended', readUntil: new Date(NOW).toISOString() },
      ]) {
        await save(changed);
        expect(await readBuddyRecovery(dir, DESTINATION, NOW)).toBeNull();
      }
      await save({ ...pairing, state: 'ended', readUntil: new Date(NOW + 1000).toISOString() });
      expect((await readBuddyRecovery(dir, DESTINATION, NOW))?.readUntil).toBe(new Date(NOW + 1000).toISOString());
      await writeFile(file, '{');
      expect(await readBuddyRecovery(dir, DESTINATION, NOW)).toBeNull();
      await writeFile(file, ' '.repeat(256 * 1024 + 1));
      expect(await readBuddyRecovery(dir, DESTINATION, NOW)).toBeNull();
      await rm(file);
      await symlink(join(dir, 'other.json'), file);
      await writeFile(join(dir, 'other.json'), JSON.stringify({ version: 1, pairing }));
      expect(await readBuddyRecovery(dir, DESTINATION, NOW)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('binds tunnel purpose, vault, source, lifetime and caps on initial grants and refreshes', () => {
    const iat = NOW / 1000;
    const claims = {
      iss: API,
      purpose: 'buddy-recovery',
      pairId: PAIR,
      vaultId: VAULT,
      sourceInstanceId: SOURCE,
      hosts: [],
      iat,
      exp: iat + 300,
      thr: { bps: 8_000_000, burst: 4_194_304 },
      lim: { conns: 2 },
    };
    const answer = (change = {}) => ({
      token:
        [
          { alg: 'EdDSA', typ: 'relay+jwt', kid: 'kid' },
          { ...claims, ...change },
        ]
          .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
          .join('.') + '.signature',
      expiresAt: new Date(NOW + 300_000).toISOString(),
      recoveryHost: HOST,
      relay: {
        id: 'ca1',
        host: 'ca1.relays.frameleaf.cloud',
        port: 443 as const,
        sni: 'tun.ca1.relays.frameleaf.cloud',
        alpn: 'fl-tunnel/1' as const,
      },
      refreshAfterSec: 150,
      throttling: claims.thr,
      limits: claims.lim,
      keepaliveSec: 30,
    });
    const check = (change = {}) => buddyRelayPurposeProblem(answer(change), access, HOST, API, NOW);
    expect(check()).toBeNull();
    for (const change of [
      { purpose: undefined },
      { purpose: 'ordinary' },
      { pairId: OTHER_VAULT },
      { vaultId: OTHER_VAULT },
      { sourceInstanceId: DESTINATION },
      { hosts: ['photos.example.com'] },
      { iat: iat + 31 },
      { exp: iat + 301 },
      { exp: iat },
      { lim: { conns: 500 } },
      { thr: { bps: 99_999_999_999, burst: 4_194_304 } },
    ]) {
      expect(check(change)).not.toBeNull();
    }
    expect(buddyRelayPurposeProblem(answer(), undefined, HOST, API, NOW)).not.toBeNull();
    expect(
      buddyRelayPurposeProblem({ ...answer(), recoveryHost: 'other.example' }, access, HOST, API, NOW),
    ).not.toBeNull();
    expect(
      buddyRelayPurposeProblem(answer(), { ...access, readUntil: new Date(NOW + 1000).toISOString() }, HOST, API, NOW),
    ).not.toBeNull();
  });
});
