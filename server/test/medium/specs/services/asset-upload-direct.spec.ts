import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { RTCPeerConnection } from 'werift';
import type { DB } from 'src/schema/index.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetUploadDirectService } from 'src/services/asset-upload-direct.service.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { DIRECT_UPLOAD_CHANNEL } from 'src/utils/asset-upload-direct.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('direct peer and actual native resource publication', () => {
  let db: Kysely<DB>;
  let folder: string;
  let admission: RateLimitRepository;
  let direct: AssetUploadDirectService;
  const peers: RTCPeerConnection[] = [];
  beforeAll(async () => {
    db = await getKyselyDB();
    folder = await mkdtemp(join(tmpdir(), 'fc170-native-upload-'));
    StorageCore.setMediaLocation(folder);
    await mkdir(join(folder, 'upload'), { recursive: true });
    const { rows } = await sql<{ name: string }>`select current_database() name`.execute(db);
    const config = new ConfigRepository();
    const env = config.getEnv();
    vi.spyOn(config, 'getEnv').mockReturnValue({
      ...env,
      database: {
        ...env.database,
        config: {
          connectionType: 'url',
          url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name),
        },
      },
    });
    admission = new RateLimitRepository(config);
  });
  afterAll(async () => {
    await direct?.onShutdown();
    await Promise.all(peers.map((peer) => peer.close()));
    await admission?.onModuleDestroy();
    await db?.destroy();
    await rm(folder, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  it('commits real immutable parts, recovers a lost ACK via HEAD and publishes exactly once with SHA256', async () => {
    const { sut: media, ctx } = newMediumService(AssetMediaService, {
      database: db,
      real: [
        ConfigRepository,
        SystemMetadataRepository,
        PhysicalFileRepository,
        AssetChecksumRepository,
        AccessRepository,
        AlbumRepository,
        AssetRepository,
        SharedLinkRepository,
        UserRepository,
        StorageRepository,
      ],
      mock: [EventRepository, LoggingRepository, JobRepository],
    });
    ctx.getMock(JobRepository).queue.mockResolvedValue(undefined);
    ctx.getMock(EventRepository).emit.mockResolvedValue(undefined);
    const { user } = await ctx.newUser();
    const token = randomBytes(32).toString('hex');
    const { sut: authentication, ctx: authContext } = newMediumService(AuthService, {
      database: db,
      real: [
        ConfigRepository,
        SystemMetadataRepository,
        UserRepository,
        CryptoRepository,
        SessionRepository,
        ApiKeyRepository,
        SharedLinkRepository,
        FrameleafAccountRepository,
        AccessRepository,
      ],
      mock: [LoggingRepository, EventRepository],
    });
    const { session } = await authContext.newSession({
      userId: user.id,
      token: authContext.get(CryptoRepository).hashSha256(token),
      updatedAt: new Date(),
    });
    await authContext.get(FrameleafAccountRepository).tagSession({
      sessionId: session.id,
      userId: user.id,
      sid: null,
      sub: `fixture-${user.id}`,
      authTime: new Date(),
    });
    const headers = { authorization: `Bearer ${token}` };
    const auth = await authentication.authenticate({
      headers,
      queryParams: {},
      metadata: {
        sharedLinkRoute: false,
        adminRoute: false,
        uri: '/assets/uploads',
        via: 'wan',
      },
    });
    const repo = new AssetUploadResourceRepository(db);
    const native = new AssetUploadResourceService(
      repo,
      media,
      ctx.get(AssetRepository),
      ctx.get(AccessRepository),
      ctx.get(StorageRepository),
      ctx.get(PhysicalFileRepository),
      ctx.getMock(LoggingRepository),
      admission,
      new ICloudIdentityRepository(db),
    );
    const startDirect = () => {
      direct = new AssetUploadDirectService(native, authentication, admission);
      vi.spyOn(direct as unknown as { createPeer: () => RTCPeerConnection }, 'createPeer').mockImplementation(() => {
        const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
        peers.push(peer);
        return peer;
      });
    };
    // A shut-down service takes no new negotiations, so each phase continues on a restarted server.
    const restartDirect = async () => {
      await direct.onShutdown();
      startDirect();
    };
    startDirect();
    const payload = randomBytes(128 * 1024);
    const sha256 = createHash('sha256').update(payload).digest();
    const initial = await native.create(
      auth,
      {
        'upload-draft-interop-version': '9',
        'upload-complete': '?0',
        'content-type': 'image/jpeg',
        'upload-length': String(payload.length),
        'repr-digest': `sha-256=:${sha256.toString('base64')}:`,
        'asset-metadata': Buffer.from(
          JSON.stringify({
            filename: 'synthetic.jpg',
            fileCreatedAt: new Date().toISOString(),
            fileModifiedAt: new Date().toISOString(),
          }),
        ).toString('base64url'),
      },
      Readable.from([]),
      () => {},
    );
    const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
    peers.push(peer);
    const channel = peer.createDataChannel(DIRECT_UPLOAD_CHANNEL, { ordered: true });
    await peer.setLocalDescription(await peer.createOffer());
    const answer = await direct.negotiate(
      auth,
      initial.resource.id,
      { version: 1, sdp: peer.localDescription!.sdp },
      headers,
    );
    const opened = channel.stateChange.watch((state) => state === 'open', 10_000);
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    await opened;
    const committed = Promise.withResolvers<void>();
    const append = native.append.bind(native);
    vi.spyOn(native, 'append').mockImplementationOnce(async (...args) => {
      const result = await append(...args);
      await peer.close(); // Drop the native commit ACK, then recover from the real durable resource.
      committed.resolve();
      return result;
    });
    channel.send(
      JSON.stringify({
        version: 1,
        type: 'append',
        requestId: randomUUID(),
        offset: 0,
        length: 65_536,
        complete: false,
      }),
    );
    channel.send(payload.subarray(0, 65_536));
    await committed.promise;
    const recovered = await native.head(auth, initial.resource.id);
    expect(recovered.offset).toBe(65_536);
    const final = await native.append(
      auth,
      recovered.id,
      {
        'content-type': 'application/partial-upload',
        'upload-draft-interop-version': '9',
        'upload-offset': String(recovered.offset),
        'upload-complete': '?1',
      },
      Readable.from([payload.subarray(recovered.offset)]),
    );
    expect(final.result).toMatchObject({ status: 'created', sha256: sha256.toString('hex') });
    expect(await readFile(final.resource.finalPath!)).toEqual(payload);
    expect((await native.result(auth, recovered.id)).result).toEqual(final.result);
    expect(await db.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute()).toHaveLength(1);
    expect(await repo.parts(undefined, recovered.id)).toHaveLength(2);
    const duplicate = await native.create(
      auth,
      {
        'upload-draft-interop-version': '9',
        'upload-complete': '?0',
        'content-type': 'image/jpeg',
        'upload-length': String(payload.length),
        'repr-digest': `sha-256=:${sha256.toString('base64')}:`,
        'asset-metadata': Buffer.from(
          JSON.stringify({
            filename: 'synthetic.jpg',
            fileCreatedAt: new Date().toISOString(),
            fileModifiedAt: new Date().toISOString(),
          }),
        ).toString('base64url'),
      },
      Readable.from([]),
      () => {},
    );
    const directPeer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
    peers.push(directPeer);
    const finalChannel = directPeer.createDataChannel(DIRECT_UPLOAD_CHANNEL, { ordered: true });
    await directPeer.setLocalDescription(await directPeer.createOffer());
    const finalAnswer = await direct.negotiate(
      auth,
      duplicate.resource.id,
      { version: 1, sdp: directPeer.localDescription!.sdp },
      headers,
    );
    const finalOpened = finalChannel.stateChange.watch((state) => state === 'open', 10_000);
    await directPeer.setRemoteDescription({ type: 'answer', sdp: finalAnswer.sdp });
    await finalOpened;
    const receipt = finalChannel.onMessage.asPromise(10_000);
    finalChannel.send(
      JSON.stringify({
        version: 1,
        type: 'append',
        requestId: randomUUID(),
        offset: 0,
        length: payload.length,
        complete: true,
      }),
    );
    finalChannel.send(payload.subarray(0, 65_536));
    finalChannel.send(payload.subarray(65_536));
    const [ack] = await receipt;
    expect(JSON.parse(String(ack))).toMatchObject({
      type: 'ack',
      status: 200,
      offset: payload.length,
      complete: true,
      result: { id: final.result!.id, status: 'duplicate', sha256: sha256.toString('hex') },
    });
    expect(await db.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute()).toHaveLength(1);
    await restartDirect();
    for (const refusal of [new UnauthorizedException(), new ForbiddenException()]) {
      const interrupted = await native.create(
        auth,
        {
          'upload-draft-interop-version': '9',
          'upload-complete': '?0',
          'content-type': 'image/jpeg',
          'upload-length': String(payload.length),
          'repr-digest': `sha-256=:${sha256.toString('base64')}:`,
          'asset-metadata': Buffer.from(
            JSON.stringify({
              filename: 'synthetic.jpg',
              fileCreatedAt: new Date().toISOString(),
              fileModifiedAt: new Date().toISOString(),
            }),
          ).toString('base64url'),
        },
        Readable.from([]),
        () => {},
      );
      const authenticate = authentication.authenticate.bind(authentication);
      const authorization = vi
        .spyOn(authentication, 'authenticate')
        .mockImplementationOnce(authenticate)
        .mockImplementationOnce(authenticate)
        .mockRejectedValueOnce(refusal);
      const eofPeer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
      peers.push(eofPeer);
      const eofChannel = eofPeer.createDataChannel(DIRECT_UPLOAD_CHANNEL, { ordered: true });
      await eofPeer.setLocalDescription(await eofPeer.createOffer());
      const eofAnswer = await direct.negotiate(
        auth,
        interrupted.resource.id,
        { version: 1, sdp: eofPeer.localDescription!.sdp },
        headers,
      );
      const eofOpened = eofChannel.stateChange.watch((state) => state === 'open', 10_000);
      await eofPeer.setRemoteDescription({ type: 'answer', sdp: eofAnswer.sdp });
      await eofOpened;
      const response = eofChannel.onMessage.asPromise(10_000);
      const requestId = randomUUID();
      eofChannel.send(
        JSON.stringify({ version: 1, type: 'append', requestId, offset: 0, length: payload.length, complete: true }),
      );
      eofChannel.send(payload.subarray(0, 65_536));
      eofChannel.send(payload.subarray(65_536));
      const [message] = await response;
      expect(JSON.parse(String(message))).toEqual({
        version: 1,
        type: 'error',
        requestId,
        status: refusal.getStatus(),
      });
      expect(authorization).toHaveBeenCalledTimes(3);
      authorization.mockRestore();
      const retained = await native.head(auth, interrupted.resource.id);
      expect(retained).toMatchObject({
        state: 'receiving',
        offset: payload.length,
        verifiedChecksum: null,
        resultAssetId: null,
        ingested: false,
      });
      const [part] = await repo.parts(undefined, retained.id);
      expect(await readFile(part.path)).toEqual(payload);
      expect(await db.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute()).toHaveLength(1);
      await restartDirect();
    }
    await authContext.get(SessionRepository).delete(session.id);
    const client = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
    peers.push(client);
    client.createDataChannel(DIRECT_UPLOAD_CHANNEL);
    await client.setLocalDescription(await client.createOffer());
    await expect(
      direct.negotiate(auth, recovered.id, { version: 1, sdp: client.localDescription!.sdp }, headers),
    ).rejects.toMatchObject({ status: 401 });
  }, 30_000);
});
