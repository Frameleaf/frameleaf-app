import { HttpException, NotFoundException } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { HouseholdInvitationAcceptDto, HouseholdLinkUpdateDto } from 'src/dtos/household-link.dto.js';
import { HouseholdLinkService } from 'src/services/household-link.service.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import {
  type HouseholdCloud,
  type HouseholdServer,
  connectHouseholds,
  startHouseholdCloud,
  startHouseholdServer,
} from 'test/fixtures/household-servers.js';

// the system config is the one thing read from the database here: each fixture server answers with its own name
vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConfig: (repos: { configRepo: { serverName: string } }) =>
    Promise.resolve({ server: { name: repos.configRepo.serverName } }),
}));

/**
 * FL-952 acceptance: two real service graphs (services, Cloud repository, identity keys, request proofs, signed
 * replies) against one fake Frameleaf Cloud. Peer requests are carried in process to the other server's real
 * peer controller; only the database tables are replaced by an in-memory repository.
 */
describe(HouseholdLinkService.name, () => {
  let fixture: HouseholdCloud;
  let anna: HouseholdServer;
  let ben: HouseholdServer;
  let calls: ReturnType<typeof connectHouseholds>;
  /** Which address reaches which server; a spec changes it to move a server or take it off the network. */
  let hosts: Record<string, HouseholdServer>;

  const cloudCalls = (path: string) => fixture.cloud.requests.filter((request) => request.path === path).length;
  /** Anna invites, Ben accepts, Anna's list picks the link up from Cloud. Returns each side's link id. */
  const pair = async () => {
    const { token } = await anna.service.invite();
    const accepted = await ben.service.accept(token);
    const [listed] = await anna.service.list();
    return { annaLink: listed.id, benLink: accepted.id };
  };

  beforeEach(async () => {
    fixture = await startHouseholdCloud();
    anna = await startHouseholdServer(fixture, 'Anna');
    ben = await startHouseholdServer(fixture, 'Ben');
    hosts = { [anna.host]: anna, [ben.host]: ben };
    calls = connectHouseholds(hosts);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all([anna.close(), ben.close(), fixture.cloud.close()]);
  });

  it('pairs two servers through a Frameleaf Cloud invitation and completes a handshake both ways', async () => {
    const invitation = await anna.service.invite();
    expect(invitation.token).toMatch(/^[\w-]{43}$/);
    await expect(ben.service.preview(invitation.token)).resolves.toEqual({ name: 'Anna' });

    const accepted = await ben.service.accept(invitation.token);
    expect(accepted).toMatchObject({ peerName: 'Anna', state: 'active', active: true, paused: false, ended: false });
    // the inviter confirms nothing: its row appears when it next asks Cloud
    const [listed] = await anna.service.list();
    expect(listed).toMatchObject({ peerName: 'Ben', state: 'active', active: true });

    // each side stored the other's key as Cloud introduced it
    expect(anna.links.rows[0]).toMatchObject({
      peerPublicKey: ben.identity.publicJwk.x,
      peerInstanceId: ben.identity.instanceId,
    });
    expect(ben.links.rows[0]).toMatchObject({ peerPublicKey: anna.identity.publicJwk.x });

    const fromBen = await ben.service.refresh(accepted.id);
    expect(fromBen).toMatchObject({ active: true, reason: null, connectionPath: 'wan' });
    expect(fromBen.lastSeenAt).not.toBeNull();
    const fromAnna = await anna.service.refresh(listed.id);
    expect(fromAnna).toMatchObject({ active: true, reason: null, connectionPath: 'wan' });
    expect(calls.map(({ status }) => status)).toEqual([200, 200]);
    // every peer call went to an address from the Cloud grant, and no redirect would have been followed
    expect(calls.map(({ url }) => new URL(url).host)).toEqual([anna.host, ben.host]);
    expect(calls.every(({ redirect }) => redirect === 'error')).toBe(true);
    expect(ben.links.rows[0].addresses).toEqual([{ kind: 'wan', uri: `https://${anna.host}` }]);

    // nothing an administrator is shown names an account or an address of the other household
    expect(JSON.stringify([accepted, listed, fromBen, fromAnna])).not.toMatch(/account|email|@/i);
    expect(Object.keys(fromBen).toSorted()).toEqual(
      [
        'active',
        'connectionPath',
        'createdAt',
        'ended',
        'endedAt',
        'id',
        'lastSeenAt',
        'paused',
        'householdName',
        'peerName',
        'reason',
        'state',
      ].toSorted(),
    );
  });

  it('takes the short invitation code, and lets each administrator name the other household for themselves', async () => {
    const { code, token } = await anna.service.invite();
    expect(code).toMatch(/^[A-Z\d]{4}-[A-Z\d]{4}-[A-Z\d]{4}$/);
    expect(code).not.toBe(token);
    await expect(ben.service.preview(code)).resolves.toEqual({ name: 'Anna' });

    const accepted = await ben.service.accept(code, 'Nana and Grandad');
    expect(accepted).toMatchObject({ householdName: 'Nana and Grandad', peerName: 'Anna', active: true });
    // the inviter did not name anyone: the household goes by its server's name until it does
    const [listed] = await anna.service.list();
    expect(listed).toMatchObject({ householdName: 'Ben', peerName: 'Ben' });

    // a name is this server's own note: renaming asks nobody and tells nobody
    const before = fixture.cloud.requests.length;
    await expect(anna.service.rename(listed.id, 'The Bakers')).resolves.toMatchObject({
      householdName: 'The Bakers',
      peerName: 'Ben',
    });
    expect(fixture.cloud.requests.length).toBe(before);
    expect(calls).toEqual([]);
    expect(ben.links.rows[0].householdName).toBe('Nana and Grandad');
    // Cloud's list never overwrites it
    await anna.service.reconcile();
    expect(anna.links.rows[0].householdName).toBe('The Bakers');
    expect(JSON.stringify(fixture.cloud.requests.map(({ body }) => body))).not.toMatch(/Bakers|Nana/);
    await expect(anna.service.rename('019b0000-0000-7000-8000-000000000000', 'Nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('accepts a code as it was typed, and a household name of 1 to 80 characters', async () => {
    const accept = (body: unknown) => HouseholdInvitationAcceptDto.schema.safeParse(body);
    const { code } = await anna.service.invite();
    const typed = accept({ code: `  ${code.toLowerCase().replaceAll('-', ' ')} ` });
    expect(typed.data).toEqual({ code: code.toLowerCase().replaceAll('-', '') });
    // Cloud takes it in that form
    await expect(ben.service.accept(typed.data!.code)).resolves.toMatchObject({ peerName: 'Anna' });

    expect(accept({ code: 'a'.repeat(43), householdName: '  Nana  ' }).data).toMatchObject({ householdName: 'Nana' });
    for (const body of [
      { code: 'short' },
      { code: 'FERN-7Q4K/M2XD' },
      { code: '../links/x/end-now' },
      { code: 'a'.repeat(44) },
      { code, householdName: '   ' },
      { code, householdName: 'x'.repeat(81) },
      { code, token: code },
    ])
      expect(accept(body).success).toBe(false);
    expect(HouseholdLinkUpdateDto.schema.safeParse({ householdName: 'x'.repeat(80) }).success).toBe(true);
    expect(HouseholdLinkUpdateDto.schema.safeParse({ householdName: '' }).success).toBe(false);
    expect(HouseholdLinkUpdateDto.schema.safeParse({ householdName: 'A', peerName: 'B' }).success).toBe(false);
  });

  it('keeps one grant until less than a minute of it remains, then gets a new one by itself', async () => {
    const { benLink } = await pair();
    vi.useFakeTimers({ toFake: ['Date'] });
    await ben.service.refresh(benLink);
    await ben.service.refresh(benLink);
    expect(cloudCalls('/v1/households/grants')).toBe(1);

    vi.setSystemTime(Date.now() + 241_000);
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({ active: true, connectionPath: 'wan' });
    expect(cloudCalls('/v1/households/grants')).toBe(2);

    // long after the first grant expired, the link still works without anyone doing anything
    vi.setSystemTime(Date.now() + 900_000);
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({ active: true, connectionPath: 'wan' });
    expect(cloudCalls('/v1/households/grants')).toBe(3);
  });

  it('shows the link as paused, with the reason, when Cloud refuses a new grant, and resumes when it issues one', async () => {
    const { benLink } = await pair();
    vi.useFakeTimers({ toFake: ['Date'] });
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({ active: true });

    anna.registered.licensed = false;
    // the grant in hand is still good, so nothing changes until it needs replacing
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({ active: true });
    vi.setSystemTime(Date.now() + 250_000);
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({
      state: 'paused',
      paused: true,
      active: false,
      reason: 'licence',
      connectionPath: null,
    });

    anna.registered.licensed = true;
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({ state: 'active', paused: false, reason: null });
  });

  it.each([
    [
      'the other server left Frameleaf Cloud',
      'peer-unlinked',
      () => fixture.households.servers.delete(ed25519Thumbprint(anna.identity.publicJwk)),
    ],
    [
      'Cloud does not answer',
      'cloud',
      () =>
        fixture.cloud.on('POST /v1/households/grants', () => ({
          status: 503,
          body: { code: 'unavailable', message: 'down' },
        })),
    ],
    [
      'Cloud refuses for a reason this server does not know',
      'cloud',
      () =>
        fixture.cloud.on('POST /v1/households/grants', () => ({
          status: 403,
          body: { code: 'forbidden', message: 'no' },
        })),
    ],
    ['this server is no longer linked to Cloud', 'unlinked', () => ben.metadata.clear()],
  ])('pauses the link when %s', async (_name, reason, arrange) => {
    const { benLink } = await pair();
    arrange();
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({ state: 'paused', paused: true, reason });
    expect(calls).toEqual([]);
  });

  it('says a household without a plan is only reachable on its home network, and stays linked', async () => {
    anna.registered.plan = false;
    anna.registered.home = 'https://192-168-1-20.home.test:2283';
    const { benLink } = await pair();

    // Ben is somewhere else: the home address does not answer, and Cloud lists nothing else without the plan
    const away = await ben.service.refresh(benLink);
    expect(away).toMatchObject({
      state: 'active',
      active: true,
      paused: false,
      reason: 'home-network',
      connectionPath: null,
    });
    expect(away.lastSeenAt).toBeNull();
    expect(ben.links.rows[0].addresses).toEqual([{ kind: 'local', uri: 'https://192-168-1-20.home.test:2283' }]);

    // with the plan Cloud also lists the remote address, which answers
    anna.registered.plan = true;
    ben.service['clients'].clear();
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({
      active: true,
      reason: null,
      connectionPath: 'wan',
    });
    expect(ben.links.rows[0].addresses.map(({ kind }) => kind)).toEqual(['local', 'wan']);
  });

  it('uses the home address when both servers are on the same network, plan or not', async () => {
    anna.registered.plan = false;
    anna.registered.home = 'https://192-168-1-20.home.test:2283';
    hosts['192-168-1-20.home.test:2283'] = anna;
    const { benLink } = await pair();
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({
      active: true,
      reason: null,
      connectionPath: 'local',
    });
  });

  it('says an address did not answer when the other household has a plan but cannot be reached', async () => {
    const { benLink } = await pair();
    delete hosts[anna.host];
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({
      state: 'active',
      reason: 'unreachable',
      connectionPath: null,
    });
  });

  it('ends a link for both households and deletes nothing else', async () => {
    const { annaLink, benLink } = await pair();
    await ben.service.refresh(benLink);

    await anna.service.end(annaLink);
    expect(anna.links.rows[0]).toMatchObject({ state: 'ended', pausedReason: null });
    expect(anna.links.rows[0].endedAt).toBeInstanceOf(Date);
    expect([...fixture.households.links.values()][0].endedBy).toBe(anna.identity.instanceId);
    // ending twice is not an error
    await expect(anna.service.end(annaLink)).resolves.toBeUndefined();

    // the other side still holds a live grant: Anna refuses it from her own state, before looking at it
    const refused = await ben.service.refresh(benLink);
    expect(refused).toMatchObject({ state: 'active', reason: 'unreachable' });
    expect(calls.at(-1)).toMatchObject({ status: 403 });

    // Ben learns from Cloud, at the next list or the hourly check
    const [listed] = await ben.service.list();
    expect(listed).toMatchObject({ state: 'ended', ended: true, active: false });
    // both rows are still there, with what they knew: ending changes state and nothing else
    expect(anna.links.rows).toHaveLength(1);
    expect(ben.links.rows[0]).toMatchObject({ peerName: 'Anna', peerPublicKey: anna.identity.publicJwk.x });
    expect(ben.links.rows[0].lastSeenAt).toBeInstanceOf(Date);

    // an ended link is final: a refresh does not ask Cloud or the peer, and cannot bring it back
    const before = fixture.cloud.requests.length;
    await expect(ben.service.refresh(listed.id)).resolves.toMatchObject({ ended: true });
    expect(fixture.cloud.requests.length).toBe(before);
  });

  it('ends the link as soon as Cloud says it was ended, even between hourly checks', async () => {
    const { benLink } = await pair();
    fixture.households.end([...fixture.households.links.values()][0], anna.identity.instanceId);
    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({ state: 'ended', ended: true });
  });

  it('ends the link here even when Cloud cannot be told, and tells Cloud at the next check', async () => {
    const { annaLink } = await pair();
    const [link] = fixture.households.links.values();
    const end = fixture.cloud.routes.get(`POST /v1/households/links/${link.id}/end`)!;
    fixture.cloud.on(`POST /v1/households/links/${link.id}/end`, () => ({
      status: 503,
      body: { code: 'unavailable', message: 'down' },
    }));

    await expect(anna.service.end(annaLink)).resolves.toBeUndefined();
    expect(anna.links.rows[0].state).toBe('ended');
    expect(link.endedAt).toBeNull();
    expect(anna.logger.warn).toHaveBeenCalledWith(expect.stringContaining(annaLink));

    fixture.cloud.on(`POST /v1/households/links/${link.id}/end`, end);
    await anna.service.reconcile();
    expect(link.endedBy).toBe(anna.identity.instanceId);
    expect(anna.links.rows[0].state).toBe('ended');
  });

  it('pauses the link, and keeps the key stored at pairing, when Cloud names another key for the peer', async () => {
    const { benLink } = await pair();
    const pinned = ben.links.rows[0].peerPublicKey;
    // the other server now presents a different key to Cloud
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string };
    anna.registered.key = { kty: 'OKP', crv: 'Ed25519', x: other.x };

    await expect(ben.service.refresh(benLink)).resolves.toMatchObject({ state: 'paused', reason: 'key' });
    await ben.service.reconcile();
    expect(ben.links.rows[0].peerPublicKey).toBe(pinned);
    expect(calls).toEqual([]);
  });

  it('keeps Cloud’s status, code and message when Cloud refuses an invitation or an accept', async () => {
    anna.registered.licensed = false;
    const refused = await anna.service.invite().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(403);
    expect((refused as HttpException).getResponse()).toMatchObject({
      code: 'entitlement-missing',
      message: 'Both servers need a Server licence to link households.',
    });

    anna.registered.licensed = true;
    const { token } = await anna.service.invite();
    await ben.service.accept(token);
    const used = await ben.service.accept(token).catch((error: unknown) => error);
    expect((used as HttpException).getStatus()).toBe(410);
    expect((used as HttpException).getResponse()).toMatchObject({ code: 'invitation_gone' });
    // a server cannot accept its own invitation
    const own = await anna.service.invite();
    await expect(anna.service.accept(own.token)).rejects.toMatchObject({ status: 422 });
    expect(anna.links.rows.every(({ peerInstanceId }) => peerInstanceId !== anna.identity.instanceId)).toBe(true);
  });

  it('refuses to link households before the server is linked to Frameleaf Cloud', async () => {
    anna.metadata.clear();
    await expect(anna.service.invite()).rejects.toMatchObject({ status: 403 });
    // and lists what it has without asking Cloud
    await expect(anna.service.list()).resolves.toEqual([]);
    expect(cloudCalls('/v1/households/links')).toBe(0);
  });

  it('answers 404 for a link id it does not hold', async () => {
    const unknown = '019b0000-0000-7000-8000-000000000000';
    await expect(anna.service.refresh(unknown)).rejects.toBeInstanceOf(NotFoundException);
    await expect(anna.service.end(unknown)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('checks every live link from the worker timer: new links appear, paused ones are retried', async () => {
    const { token } = await anna.service.invite();
    await ben.service.accept(token);
    expect(anna.links.rows).toEqual([]);

    // Anna's worker: the first run asks Cloud for its links, then shakes hands on each
    anna.service.tick();
    await anna.service['active'];
    expect(anna.links.rows[0]).toMatchObject({ peerName: 'Ben', state: 'active', connectionPath: 'wan' });
    expect(anna.links.rows[0].lastSeenAt).toBeInstanceOf(Date);

    // a paused link is tried again at the next run
    ben.registered.licensed = false;
    anna.service['clients'].clear();
    anna.service.tick();
    await anna.service['active'];
    expect(anna.links.rows[0]).toMatchObject({ state: 'paused', pausedReason: 'licence' });
    ben.registered.licensed = true;
    anna.service.tick();
    await anna.service['active'];
    expect(anna.links.rows[0]).toMatchObject({ state: 'active', pausedReason: null });
    // Cloud's list is read once an hour, not at every run
    expect(
      fixture.cloud.requests.filter(
        ({ path, dpop }) => path === '/v1/households/links' && dpop?.jkt === ed25519Thumbprint(anna.identity.publicJwk),
      ),
    ).toHaveLength(1);

    await anna.service.onShutdown();
    anna.service.tick();
    expect(anna.service['active']).toBeUndefined();
  });
});
