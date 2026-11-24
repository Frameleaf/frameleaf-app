import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Cloud, CloudError, Grant, Lease, createIdentity, publicJwk, signText, uuidv7, type Identity } from '../src/cloud-link.js';
import { API, ISSUER, fixture, fixtures, machine, standIn, thumbprint } from './cloud-stand-in.js';

const refused = (code: string, status?: number) => (error: unknown) => error instanceof CloudError && error.code === code && (status === undefined || error.status === status);

const connect = (options: { old?: boolean } = {}) => {
  const cloud = standIn(options);
  return { ...cloud, client: new Cloud(API, { fetch: cloud.fetch, now: () => cloud.state.now }) };
};

/** A machine that has been through linking. */
async function linked(options: { old?: boolean } = {}) {
  const made = connect(options);
  const identity = createIdentity(made.state.now);
  const started = await made.client.startLink(identity, machine);
  await made.client.pollLink(started.deviceCode);
  const approved = await made.client.pollLink(started.deviceCode);
  assert.equal(approved.state, 'approved');
  const account = await made.client.register(identity, (approved as { linkToken: string }).linkToken, machine);
  return { ...made, identity, started, account };
}

test('an identity is a version 7 id and a key named by its thumbprint', () => {
  const first = uuidv7(1_000);
  const later = uuidv7(2_000);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(first < later);
  const identity = createIdentity();
  assert.equal(identity.kid, thumbprint(publicJwk(identity.privateKey)));
  assert.equal(identity.kid.length, 43);
  assert.match(identity.privateKey, /BEGIN PRIVATE KEY/);
});

test('linking shows a code, waits for approval and registers as a backup machine', async () => {
  const { state, started, account, identity } = await linked();
  assert.deepEqual([started.userCode, started.approveAt, started.intervalSec], ['BCDF-GHJK', 'https://frameleaf.cloud/device?user_code=BCDF-GHJK', 5]);
  assert.deepEqual(account, { account: 'Taylor household', email: 'owner@example.test', dataRegion: 'na' });
  assert.equal(state.instances.get(identity.instanceId)?.kind, 'backup-machine');
  // Registration is sent twice: the first answer only says which nonce to use.
  assert.equal(state.calls.filter((call) => call === 'POST api/v1/instances').length, 2);
});

test('a Cloud that links it as a photo server is refused, and the link is undone', async () => {
  await assert.rejects(linked({ old: true }), refused('cloud_too_old_for_backup_machines'));
});

test('calls sign in once, prove the key each time, and follow a changed nonce', async () => {
  const { state, client, identity } = await linked();
  assert.equal((await client.locations(identity))[0]!.locationId, 'loc-01');
  await client.locations(identity);
  // One sign-in (asked twice, for its nonce), reused by both calls.
  assert.equal(state.calls.filter((call) => call === 'POST id/token').length - 2, 2);

  // The API's nonce moves on: the next call is told so once, and is sent again with the new one.
  state.nonce[API] = 'api-2';
  await client.locations(identity);
  assert.equal(state.calls.filter((call) => call === 'GET api/v4/backup/locations').length, 4);

  // A token that stops working is dropped; the next call signs in again.
  state.tokens.clear();
  await assert.rejects(client.locations(identity), refused('invalid_token', 401));
  assert.equal((await client.locations(identity)).length, 1);

  // Ten minutes on, the held token is past its use-by time and a new one is fetched first.
  const before = state.calls.filter((call) => call === 'POST id/token').length;
  state.now += 10 * 60_000;
  await client.locations(identity);
  assert.ok(state.calls.filter((call) => call === 'POST id/token').length > before);
});

test('attaching needs a statement signed by the photo server’s own key', async () => {
  const { state, client, identity } = await linked();
  const server: Identity = createIdentity(state.now);
  state.instances.set(server.instanceId, { jwk: publicJwk(server.privateKey), kind: 'server', linked: true });
  const statement = { version: 1, parentInstanceId: server.instanceId, machineInstanceId: identity.instanceId, issuedAt: new Date(state.now).toISOString(), signerKid: server.kid };
  const signature = signText(server, `frameleaf-backup-machine-attach-v1\n${JSON.stringify(statement)}`);

  assert.deepEqual(await client.attach(identity, { statement, signature }), { instanceId: server.instanceId, name: 'Family library', attachedAt: new Date(state.now).toISOString(), follows: true });
  // Signed by the machine itself: not the photo server's word.
  await assert.rejects(client.attach(identity, { statement, signature: signText(identity, `frameleaf-backup-machine-attach-v1\n${JSON.stringify(statement)}`) }), refused('request-invalid', 422));
});

test('credentials come only under a lease, and one run holds it at a time', async () => {
  const { state, client, identity } = await linked();
  await assert.rejects(client.grant(identity, { locationId: 'loc-01', operation: 'upload', leaseId: randomUUID() }), refused('lease-lost', 409));

  const lease = await client.acquireLease(identity, 'backup');
  const grant = await client.grant(identity, { locationId: 'loc-01', operation: 'upload', leaseId: lease.leaseId });
  assert.deepEqual([grant.capability.operation, grant.region, grant.bucket.startsWith('fl-')], ['upload', 'us-east-1', true]);
  assert.ok(grant.capability.credentials.sessionToken);
  assert.equal((await client.rotate(identity, { operation: 'upload', leaseId: lease.leaseId })).capability.operation, 'upload');
  assert.equal((await client.heartbeat(identity, lease.leaseId)).leaseId, lease.leaseId);
  // Restores need no lease, and may not name one.
  assert.equal((await client.rotate(identity, { operation: 'restore' })).capability.operation, 'restore');

  await assert.rejects(client.acquireLease(identity, 'prune'), (error: unknown) => refused('lease-held', 409)(error) && (error as CloudError).retryAfterSec === 240);
  await client.releaseLease(identity, lease.leaseId);
  assert.equal((await client.acquireLease(identity, 'prune')).operation, 'prune');

  state.entitled = false;
  await assert.rejects(client.rotate(identity, { operation: 'restore' }), (error: unknown) => refused('entitlement-missing', 402)(error) && (error as CloudError).data?.missing === 'licence');
});

test('a grant that names storage over plain HTTP, on this machine or on the LAN is refused', async () => {
  const { state, client, identity } = await linked();
  for (const endpoint of [
    'http://s3.us-east-1.backup.frameleaf.cloud/',
    'https://user:secret@s3.us-east-1.backup.frameleaf.cloud/',
    'https://127.0.0.1:9000',
    'https://192.168.1.20',
    'https://10.0.0.5',
    'https://172.20.0.2',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[fd00::1]',
    'https://[::ffff:192.168.1.20]',
    'https://nas.local',
    'https://storage',
    'https://localhost',
  ]) {
    state.storage = { endpoint };
    await assert.rejects(client.grant(identity, { locationId: 'loc-01', operation: 'restore' }), refused('cloud_address_untrusted'), endpoint);
  }
  state.storage = { endpoint: 'https://s3.eu-central-2.wasabisys.com' };
  assert.equal((await client.grant(identity, { locationId: 'loc-01', operation: 'restore' })).endpoint, 'https://s3.eu-central-2.wasabisys.com');
});

test('finished backups are added to a signed history, in order, and a lost answer is safe to send again', async () => {
  const { state, client, identity } = await linked();
  const vaultId = randomUUID();
  const entry = (sequence: number, previousDigest: string | null) => ({
    snapshotId: randomUUID(),
    vaultId,
    sequence,
    previousDigest,
    objectKey: `r/v1/${vaultId}/s/${String(sequence).padStart(12, '0')}-0123456789abcdef`,
    versionId: `version-${sequence}`,
    ciphertextSha256: 'a'.repeat(64),
    keyVersion: 1,
    createdAt: new Date(state.now).toISOString(),
  });
  assert.equal(await client.snapshotHead(identity, vaultId), null);

  const first = entry(1, null);
  const recorded = await client.recordSnapshot(identity, first);
  assert.match(recorded.digest, /^[0-9a-f]{64}$/);
  // The same entry again is answered with the first record; nothing is added twice.
  assert.deepEqual(await client.recordSnapshot(identity, first), recorded);
  assert.deepEqual(await client.snapshotHead(identity, vaultId), recorded);

  // The next entry must name the one before it.
  await assert.rejects(client.recordSnapshot(identity, entry(2, 'b'.repeat(64))), refused('snapshot-conflict', 409));
  await assert.rejects(client.recordSnapshot(identity, entry(3, recorded.digest)), refused('snapshot-conflict', 409));
  assert.equal((await client.recordSnapshot(identity, entry(2, recorded.digest))).sequence, 2);

  const report = { runId: randomUUID(), status: 'succeeded' as const, startedAt: new Date(state.now - 60_000).toISOString(), finishedAt: new Date(state.now).toISOString(), bytesUploaded: 10, objectsUploaded: 2, objectsSkipped: 0, manifestKey: first.objectKey, errorCode: null };
  await client.reportRun(identity, report);
  await assert.rejects(client.reportRun(identity, { ...report, manifestKey: 'm/v1/old-style' }), refused('request-invalid', 422));
});

test('an address Cloud hands over must be on Cloud', async () => {
  for (const issuer of ['https://id.frameleaf.example', 'http://id.frameleaf.cloud', 'https://id.frameleaf.cloud:8443', 'https://user:pass@id.frameleaf.cloud']) {
    const { state, client } = connect();
    state.discovery.issuer = issuer;
    await assert.rejects(client.discovery(), refused('cloud_address_untrusted'), issuer);
  }
  const { client } = connect();
  assert.deepEqual(await client.discovery().then(({ issuer, api }) => [issuer, api]), [ISSUER, API]);
});

test('Cloud’s own example answers still read the way this client expects', async () => {
  const pinned: Record<string, string> = {
    'capability-repository-upload.json': '19779b163029c660b491e500228f76bf7ad6359d514d0551875ac8d5bf46775c',
    'lease.json': '99fad84cc5533127a0a9edd3763c3f1ca7e48d21a330f04b394a12d5fc190755',
  };
  for (const [name, hash] of Object.entries(pinned)) assert.equal(createHash('sha256').update(await readFile(join(fixtures, name))).digest('hex'), hash, name);
  assert.equal(Grant.parse(await fixture('capability-repository-upload.json')).capability.operation, 'upload');
  assert.equal(Lease.parse(await fixture('lease.json')).heartbeatAfterSec, 60);
});

test('a takeover waits for the owner, and then this machine signs in as the older one', async () => {
  const { state, client, identity: older, approve } = await linked();
  const vaultId = randomUUID();
  await client.recordSnapshot(older, { snapshotId: randomUUID(), vaultId, sequence: 1, previousDigest: null, objectKey: `r/v1/${vaultId}/s/000000000001-0123456789abcdef`, versionId: 'version-1', ciphertextSha256: 'a'.repeat(64), keyVersion: 1, createdAt: new Date(state.now).toISOString() });

  // A replacement server links as a machine of its own first.
  const fresh = createIdentity(state.now + 1);
  const started = await client.startLink(fresh, machine);
  await client.pollLink(started.deviceCode);
  await client.register(fresh, ((await client.pollLink(started.deviceCode)) as { linkToken: string }).linkToken, machine);

  assert.deepEqual((await client.takeoverCandidates(fresh)).map((item) => [item.instanceId, item.name]), [[older.instanceId, machine.name]]);
  await assert.rejects(client.requestTakeover(fresh, randomUUID()), refused('not-found', 404));
  assert.deepEqual(await client.requestTakeover(fresh, older.instanceId).then((asked) => [asked.status, asked.instanceId]), ['pending', null]);
  assert.equal((await client.takeover(fresh, older.instanceId)).status, 'pending');

  approve();
  // The token it already had still reads the answer...
  const answer = await client.takeover(fresh, older.instanceId);
  assert.deepEqual([answer.status, answer.instanceId, typeof answer.writesFrom], ['approved', older.instanceId, 'string']);
  // ...and once that has run out, being able to sign in as the older machine is the answer.
  state.now += 11 * 60_000;
  assert.deepEqual(await client.takeover(fresh, older.instanceId).then((late) => [late.status, late.instanceId, late.writesFrom]), ['approved', older.instanceId, null]);

  // From here it is the older machine: that id, its own key, the same signed history.
  assert.equal((await client.snapshotHead({ ...fresh, instanceId: older.instanceId }, vaultId))?.sequence, 1);
  // The installation it replaced is out, and the id it linked as is gone.
  await assert.rejects(client.parent(older), refused('invalid_client', 400));
  await assert.rejects(client.parent(fresh), refused('invalid_client', 400));
});

test('a machine nobody approved learns nothing by asking who it is', async () => {
  const { state, client, identity } = await linked();
  state.instances.get(identity.instanceId)!.linked = false;
  await assert.rejects(client.takeover(identity, randomUUID()), refused('invalid_client', 400));
});

test('an answer far bigger than any Cloud sends is not read into memory', async () => {
  const huge = new Cloud(API, { fetch: async () => new Response('x'.repeat(5 * 1024 * 1024), { status: 200 }) });
  await assert.rejects(huge.discovery(), refused('cloud_answer_unreadable'));
});
