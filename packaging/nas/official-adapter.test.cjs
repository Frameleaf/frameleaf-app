// Synthetic trust/type/transaction rejection contracts only. No container or certification proof.
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateOfficialPlan, validateAcceptance, pairedRecovery, project } = require('./official-adapter.cjs');
const { hash } = require('../../.github/frameleaf-release.cjs');
const supported = require('../../server/src/fork-schema/supported-versions.json');
const { verifyDatabaseCheckpoint } = require('./checkpoint-database.cjs');
const digest = (n) => `sha256:${String(n).repeat(64)}`;
const id = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
const plan = () => ({ family: 'officialImmich', sourceVersion: 'v3.1.0', targetServer: `ghcr.io/frameleaf/frameleaf-server@${digest(1)}`, checkpoint: { id: 'synthetic-contract-only', database: { digest: digest(2) }, media: { digest: digest(3) } }, adapter: { kind: 'official-immich-v3.1.0', sourceServer: `${supported.certification.officialImage}@${supported.certification.officialDigest}`, sourceEvidence: { commit: 'a'.repeat(40), path: 'packaging/nas/qualification-fixtures/contract-only.json', digest: digest(4) }, acceptance: { name: 'acceptance.json', checkpointId: 'synthetic-contract-only', digest: digest(5) } } });
const fixture = (p) => ({ schemaVersion: 1, environment: 'sanitized-production-shaped', checkpointId: p.checkpoint.id, sourceVersion: p.sourceVersion, sourceServer: p.adapter.sourceServer, targetServer: p.targetServer, targetVersion: { major: 3, minor: 1, patch: 0 }, accounts: [1, 2].map((n) => ({ id: id(n), email: `contract-${n}@example.test`, password: 'synthetic-fixture-only', name: `Contract ${n}`, isAdmin: n === 1, statistics: { images: 1, videos: 0, total: 1 }, assets: [{ id: id(n === 1 ? 3 : 5), ownerId: id(n), originalFileName: 'fixture.png', type: 'IMAGE' }], albums: [{ id: id(4), albumName: 'Fixture', assetCount: 1, albumUsers: [{ user: { id: id(n) }, role: 'owner' }] }], deniedAssetIds: n === 2 ? [id(3)] : [] })), database: { users: 2, assets: 2, albums: 1, usersDigest: digest(6), assetsDigest: digest(7), albumMembershipDigest: digest(8), targetLedgerDigest: digest(9) }, media: { original: { path: 'upload/original.png', digest: digest(6) }, derivative: { path: 'thumbs/thumbnail.jpg', digest: digest(7) } } });

test('source admission binds supported image and reviewed stopped-source capture to both halves and acceptance', async () => {
  const p = plan();
  const nas = { images: { valkey: `docker.io/valkey/valkey:9@${digest(1)}` } };
  const capture = { schemaVersion: 1, environment: 'sanitized-production-shaped', sourceVersion: p.sourceVersion, sourceServer: p.adapter.sourceServer, postgresMajor: 14, sourceStopped: true, sanitizationReviewed: true, checkpointId: p.checkpoint.id, databaseDigest: p.checkpoint.database.digest, mediaDigest: p.checkpoint.media.digest, acceptanceDigest: p.adapter.acceptance.digest };
  const bytes = Buffer.from(JSON.stringify(capture)); p.adapter.sourceEvidence.digest = hash(bytes);
  const response = async () => ({ encoding: 'base64', content: bytes.toString('base64') });
  await validateOfficialPlan(p, nas, response);
  for (const mutate of [
    (x) => { x.family = 'priorFrameleaf'; },
    (x) => { x.sourceVersion = 'v3.1.1'; },
    (x) => { x.adapter.sourceServer = 'ghcr.io/immich-app/immich-server:v3.1.0'; },
    (x) => { x.checkpoint.media.digest = digest(9); },
    (x) => { x.adapter.acceptance.checkpointId = 'other-point'; },
    (x) => { x.adapter.sourceEvidence.path = '../unreviewed.json'; },
  ]) { const changed = structuredClone(p); mutate(changed); await assert.rejects(validateOfficialPlan(changed, nas, response)); }
  const changedCapture = { ...capture, sourceStopped: false };
  const changedBytes = Buffer.from(JSON.stringify(changedCapture));
  const changedPlan = structuredClone(p); changedPlan.adapter.sourceEvidence.digest = hash(changedBytes);
  await assert.rejects(validateOfficialPlan(changedPlan, nas, async () => ({ encoding: 'base64', content: changedBytes.toString('base64') })), /false.*true|strictly equal/s);
  await assert.rejects(validateOfficialPlan(p, nas, async () => ({ encoding: 'base64', content: Buffer.from('modified').toString('base64') })), /evidence differs/);
});

test('acceptance admits typed fixture invariants, refuses executable fields/live credentials/path escapes/empty permission checks', () => {
  const p = plan(); validateAcceptance(fixture(p), p);
  for (const mutate of [
    (x) => { x.sql = 'DROP TABLE public.asset'; },
    (x) => { x.database.query = 'SELECT 1'; },
    (x) => { x.accounts[0].email = 'operator@real-company.com'; },
    (x) => { x.accounts[0].assets[0].id = '../secret'; },
    (x) => { x.accounts[0].albums[0].albumUsers[0].role = 'superadmin'; },
    (x) => { x.accounts[1].deniedAssetIds = []; },
    (x) => { x.accounts[1].deniedAssetIds = [id(9)]; },
    (x) => { x.accounts[1].id = x.accounts[0].id; },
    (x) => { x.media.original.path = '../../outside'; },
    (x) => { x.media.original.path = '/data/original'; },
    (x) => { x.media.original.path = x.media.derivative.path; },
    (x) => { x.checkpointId = 'other'; },
    (x) => { x.database.usersDigest = 'unbound'; },
  ]) { const changed = fixture(p); mutate(changed); assert.throws(() => validateAcceptance(changed, p)); }
  assert.deepEqual(project({ id: 'a', accessToken: 'not-retained', details: { count: 2, secret: 'not-retained' } }, { id: 'a', details: { count: 2 } }), { id: 'a', details: { count: 2 } });
});

test('paired recovery discards mutated database and restores/verifies both original halves before source startup', async () => {
  const names = ['stopTarget', 'discardDatabase', 'restoreDatabase', 'restoreMedia', 'verifyOriginalDatabase', 'verifyOriginalMedia', 'startSource', 'acceptSource'];
  for (const failure of [null, 'restoreDatabase', 'restoreMedia', 'verifyOriginalDatabase', 'verifyOriginalMedia', 'acceptSource']) {
    const seen = [];
    const operations = Object.fromEntries(names.map((name) => [name, async () => { seen.push(name); if (name === failure) throw new Error('synthetic rejection'); }]));
    if (failure) await assert.rejects(pairedRecovery(operations), /synthetic rejection/); else await pairedRecovery(operations);
    const length = failure ? names.indexOf(failure) + 1 : names.length;
    assert.deepEqual(seen, names.slice(0, length));
    if (['verifyOriginalDatabase', 'verifyOriginalMedia'].includes(failure)) assert(!seen.includes('startSource'));
  }
});

test('original checkpoint verifier independently refuses schema, table bytes, extension and sequence corruption', () => {
  const schema = 'CREATE TABLE public.asset (id text);\n';
  const rows = '{"id":"original"}\n';
  const original = { extensions: [{ name: 'plpgsql', version: '1.0' }], checkpoint: { databaseSchemaDigest: hash(schema), tableCounts: [{ schema: 'public', table: 'asset', count: 1, dataDigest: hash(rows) }], sequences: [{ schema: 'public', name: 'asset_seq', lastValue: '7', isCalled: true }] } };
  const response = (corruption) => (args) => {
    if (args.includes('pg_dump')) return corruption === 'schema' ? `${schema}CREATE TABLE unexpected (id int);\n` : schema;
    const query = args.at(-1);
    if (query.includes('pg_extension')) return JSON.stringify([{ name: 'plpgsql', version: corruption === 'extension' ? 'other' : '1.0' }]);
    if (query.includes('FROM pg_tables')) return JSON.stringify([{ schema: 'public', table: 'asset' }]);
    if (query.includes('SELECT count(*)')) return corruption === 'count' ? '2' : '1';
    if (query.startsWith('COPY')) return corruption === 'rows' ? '{"id":"corrupt"}\n' : rows;
    if (query.includes('FROM pg_sequences')) return JSON.stringify([{ schema: 'public', name: 'asset_seq' }]);
    if (query.includes('last_value')) return JSON.stringify({ lastValue: corruption === 'sequence' ? '8' : '7', isCalled: true });
    throw new Error('Unexpected verifier query');
  };
  verifyDatabaseCheckpoint(original, 'synthetic-contract-only', response(null));
  for (const corruption of ['schema', 'rows', 'extension', 'count', 'sequence']) assert.throws(() => verifyDatabaseCheckpoint(original, 'synthetic-contract-only', response(corruption)));
});
