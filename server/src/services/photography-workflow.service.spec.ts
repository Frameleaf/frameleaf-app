import { ConflictException, ForbiddenException } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { WorkflowRow } from 'src/repositories/photography-workflow.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { PhotographyWatermarkSchema } from 'src/dtos/photography-rendition.dto.js';
import {
  PhotographyGalleryDto,
  PhotographyPublicSiteDto,
  type PhotographySite,
  PhotographySiteSaveDto,
  PhotographyWorkflowDto,
} from 'src/dtos/photography-workflow.dto.js';
import { JobStatus } from 'src/enum.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import { preparePhotographyLogo, renderPhotographyRendition } from 'src/utils/photography-rendition.js';

vi.mock('src/repositories/job.repository.js', () => ({ JobRepository: class {} }));
vi.mock('src/services/album.service.js', () => ({ AlbumService: class {} }));
vi.mock('src/repositories/storage.repository.js', () => ({ StorageRepository: class {} }));
vi.mock('src/repositories/asset-develop.repository.js', () => ({ AssetDevelopRepository: class {} }));
vi.mock('src/repositories/crypto.repository.js', () => ({ CryptoRepository: class {} }));
vi.mock('src/repositories/photography-workspace.repository.js', () => ({ PhotographyWorkspaceRepository: class {} }));
vi.mock('src/repositories/photography-workflow.repository.js', () => ({ PhotographyWorkflowRepository: class {} }));

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
  folders.length = 0;
});
async function setup(brand?: unknown) {
  const ownerId = randomUUID(),
    shootId = randomUUID(),
    albumId = randomUUID(),
    assetId = randomUUID();
  const folder = await mkdtemp(path.join(os.tmpdir(), 'photography-flow-'));
  folders.push(folder);
  const source = path.join(folder, 'source.jpg');
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#667788' } })
    .jpeg()
    .toFile(source);
  vi.spyOn(StorageCore, 'getFolderLocation').mockReturnValue(folder);
  let row: WorkflowRow | undefined;
  let visible = true;
  let site: { revision: string; value: PhotographySite } | undefined;
  const asset = {
    id: assetId,
    ownerId,
    stackId: null,
    autoStackId: null as string | null,
    checksum: Buffer.alloc(32, 1),
    originalFileName: 'DSC_001.CR3',
    originalPath: '/must-never-use-original.CR3',
    fileCreatedAt: new Date('2026-10-01'),
    dateTimeOriginal: new Date('2026-10-01'),
    make: 'Camera',
    model: 'Model',
    rating: null,
    isOffline: false,
  };
  let studio = { revision: null as string | null, presets: [] as any[] };
  const repository = {
    studioPresets: vi.fn(() => Promise.resolve(structuredClone(studio))),
    mutateStudio: vi.fn(async (_owner: string, expected: string | null, change: (record: any) => unknown) => {
      if (expected !== studio.revision) throw new ConflictException();
      const record = { site: site?.value ?? null, presets: structuredClone(studio.presets) };
      const result = await change(record);
      studio = { revision: randomUUID(), presets: record.presets };
      return { revision: studio.revision, record, result };
    }),
    pinnedStudioPreset: vi.fn((_tx: unknown, _owner: string, expected: string, id: string) => {
      if (expected !== studio.revision) throw new ConflictException();
      const preset = studio.presets.find((preset) => preset.id === id);
      if (!preset) throw new ForbiddenException();
      return Promise.resolve(structuredClone(preset));
    }),
    site: vi.fn(() => Promise.resolve(site)),
    saveSite: vi.fn((_owner: string, _expected: string | null, value: PhotographySite) => {
      site = { revision: randomUUID(), value };
      return Promise.resolve({ revision: site.revision, site: value });
    }),
    studioLive: vi.fn(() => (visible ? Promise.resolve() : Promise.reject(new ForbiddenException()))),
    get: vi.fn((id: string) => Promise.resolve(id === shootId && row ? structuredClone(row) : undefined)),
    live: vi.fn(() => {
      if (!visible) return Promise.reject(new ForbiddenException());
      return Promise.resolve();
    }),
    assets: vi.fn(() => Promise.resolve(visible ? [asset] : [])),
    proofSource: vi.fn(() => Promise.resolve({ path: source })),
    logo: vi.fn(() => Promise.resolve([])),
    eligibleRevisions: vi.fn((_row: unknown, ids: string[]) => Promise.resolve(new Set(visible ? ids : []))),
    paymentOrder: vi.fn(() => Promise.resolve(row ? structuredClone(row) : undefined)),
    mutate: vi.fn(
      async (
        id: string,
        ownerId: string,
        albumId: string,
        expected: string | null | undefined,
        initial: WorkflowRow['value'],
        change: (v: WorkflowRow['value']) => unknown,
      ) => {
        if (expected !== undefined && (row?.revision ?? null) !== expected) throw new ConflictException();
        const value = structuredClone(row?.value ?? initial);
        const result = await change(value);
        row = { id, ownerId, albumId, revision: randomUUID(), value };
        return { row: structuredClone(row), result };
      },
    ),
  };
  const workspace = {
    get: vi.fn(() => Promise.resolve({ value: { shoots: [{ id: shootId, albumId, name: 'Portrait' }], brand } })),
  };
  const albums = {
    get: vi.fn(() => Promise.resolve({ albumUsers: [{ user: { id: ownerId } }], kind: 'album', isSmart: false })),
  };
  const revisionId = randomUUID();
  const revision = {
    id: revisionId,
    ownerId,
    assetId,
    status: AssetDevelopRevisionStatus.Rendered,
    masterPath: source,
    sourceChecksum: Buffer.alloc(32, 1),
  };
  const revisions = { get: vi.fn((id: string) => Promise.resolve(id === revisionId ? revision : undefined)) };
  const crypto = {
    hashBcrypt: vi.fn(() => Promise.resolve('hashed')),
    compareBcrypt: vi.fn((password) => password === 'correct-password'),
  };
  const jobs = { queue: vi.fn(async () => {}) };
  const storage = {
    createZipStream: vi.fn(() => ({ stream: { destroy: vi.fn() }, addFile: vi.fn(), finalize: async () => {} })),
  };
  const service = new PhotographyWorkflowService(
    repository as never,
    workspace as never,
    albums as never,
    revisions as never,
    crypto as never,
    jobs as never,
    storage as never,
  );
  const auth = { user: { id: ownerId, name: 'Studio' }, session: { hasElevatedPermission: true } } as AuthDto;
  const initial = await service.intake(auth, shootId, { expectedRevision: null });
  const captureId = initial.captures[0].id;
  async function invitation(canDownload = true, password: string | null = null) {
    const result = await service.createRecipient(auth, shootId, {
      expectedRevision: row!.revision,
      name: 'Client',
      password,
      expiresAt: null,
      canProof: true,
      canDownload,
      captureIds: null,
    });
    const session = await service.session(shootId, {
      token: result.invitation.token,
      ...(password && { password }),
    });
    return { ...session, token: result.invitation.token };
  }
  async function published() {
    await service.publish(auth, shootId, { expectedRevision: row!.revision, scope: 'all-eligible' });
    expect(await service.render({ id: shootId })).toBe(JobStatus.Success);
  }
  async function selected(session: string) {
    await service.choices(shootId, session, {
      expectedRevision: row!.revision,
      captureIds: [captureId],
      notes: [{ captureId, text: 'Natural colours' }],
    });
    await service.submit(shootId, session, { expectedRevision: row!.revision });
    return row!.value.rounds.at(-1)!;
  }
  return {
    service,
    auth,
    shootId,
    ownerId,
    captureId,
    assetId,
    asset,
    revisionId,
    source,
    repository,
    revisions,
    albums,
    storage,
    jobs,
    invitation,
    published,
    selected,
    row: () => row!,
    setVisible: (value: boolean) => {
      visible = value;
    },
  };
}

describe('photography workflow integration boundaries', () => {
  it('persists stable captures on intake retries, rejects stale revisions and strips elevated access', async () => {
    const s = await setup();
    const first = s.row();
    await s.service.intake(s.auth, s.shootId, { expectedRevision: first.revision });
    expect(s.row().value.captures.map((c) => [c.id, c.number])).toEqual(
      first.value.captures.map((c) => [c.id, c.number]),
    );
    await expect(s.service.intake(s.auth, s.shootId, { expectedRevision: first.revision })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(s.albums.get).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ hasElevatedPermission: false }) }),
      expect.any(String),
    );
    await expect(s.service.get({ ...s.auth, apiKey: {} } as AuthDto, s.shootId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('keeps primary capture identity when explicitly expanding a RAW/JPEG pair', async () => {
    const s = await setup();
    const other = { ...s.asset, id: randomUUID(), originalFileName: 'DSC_001.JPG', autoStackId: 'same-pair' };
    s.repository.assets.mockResolvedValue([{ ...s.asset, autoStackId: 'same-pair' }, other]);
    await s.service.intake(s.auth, s.shootId, { expectedRevision: s.row().revision });
    expect(s.row().value.captures).toHaveLength(1);
    expect(s.row().value.captures[0].assetIds).toHaveLength(2);
    await s.service.intake(s.auth, s.shootId, { expectedRevision: s.row().revision, expandCaptureIds: [s.captureId] });
    expect(s.row().value.captures).toHaveLength(2);
    expect(s.row().value.captures.find((capture) => capture.assetId === s.assetId)?.id).toBe(s.captureId);
    expect(new Set(s.row().value.captures.map((capture) => capture.number)).size).toBe(2);
  });
  it('burns protected pixel sizes, keeps draft presentation unpublished and rejects missing source processing', async () => {
    const s = await setup();
    const client = await s.invitation(false);
    await s.published();
    const file = await s.service.file(s.shootId, client.session, s.captureId, 'preview');
    const pixels = await readFile(file.path);
    expect(pixels.equals(await readFile(s.source))).toBe(false);
    const meta = await sharp(pixels).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(PhotographyGalleryDto.schema.safeParse(await s.service.gallery(s.shootId, client.session)).success).toBe(
      true,
    );
    expect(PhotographyWorkflowDto.schema.safeParse(await s.service.get(s.auth, s.shootId)).success).toBe(true);
    await s.service.config(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      config: { ...s.row().value.config, title: 'Draft only' },
    });
    expect((await s.service.gallery(s.shootId, client.session)).title).toBe('Portrait');
    s.repository.proofSource.mockResolvedValue(undefined as never);
    await s.service.publish(s.auth, s.shootId, { expectedRevision: s.row().revision, scope: 'all-eligible' });
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Failed);
    expect(s.row().value.publication?.failedCaptureId).toBe(s.captureId);
    expect(s.row().value.captures[0].processing).toBe('failed');
    expect((await s.service.file(s.shootId, client.session, s.captureId, 'preview')).path).toBe(file.path);
  });
  it('records decisions, pins final revisions and checks download/ZIP rights again after revocation', async () => {
    const s = await setup();
    const client = await s.invitation();
    await s.published();
    const round = await s.selected(client.session);
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      requestClientApproval: false,
    });
    await s.service.order(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      roundId: round.id,
      recipientId: client.recipientId,
      pricing: 'package',
    });
    const order = s.row().value.orders[0];
    await expect(s.service.file(s.shootId, client.session, s.captureId, 'download')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await s.service.accept(s.shootId, client.session, order.id, { expectedRevision: s.row().revision });
    await expect(s.service.file(s.shootId, client.session, s.captureId, 'download')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    const final = await s.service.file(s.shootId, client.session, s.captureId, 'download');
    expect(final.path).not.toBe(s.source);
    await rm(final.path);
    await expect(s.service.zip(s.shootId, client.session, { captureIds: [s.captureId] })).rejects.toThrow(
      'unavailable',
    );
    await s.service.retry(s.auth, s.shootId, { expectedRevision: s.row().revision });
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    expect((await s.service.file(s.shootId, client.session, s.captureId, 'download')).path).not.toBe(final.path);
    await s.service.recordDelivery(s.shootId, client.session, s.captureId);
    await s.service.recordDelivery(s.shootId, client.session, s.captureId);
    expect(s.row().value.receipts.filter((receipt) => receipt.action === 'delivered')).toHaveLength(1);
    expect(s.row().value.captures[0].state).toBe('delivered');
    const zip = await s.service.zip(s.shootId, client.session, { captureIds: [s.captureId] });
    await s.service.updateRecipient(s.auth, s.shootId, client.recipientId, {
      expectedRevision: s.row().revision,
      revoked: true,
      expiresAt: null,
      canProof: true,
      canDownload: true,
      captureIds: null,
    });
    await expect(s.service.archive(s.shootId, client.session, zip.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.storage.createZipStream).not.toHaveBeenCalled();
    await expect(s.service.session(s.shootId, { token: client.token })).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.row().value.orders[0].items[0].revisionId).toBe(s.revisionId);
  });
  it('never exposes source data when eligibility is lost and refuses a session from another gallery', async () => {
    const s = await setup();
    const client = await s.invitation();
    await s.published();
    await expect(s.service.gallery(randomUUID(), client.session)).rejects.toThrow();
    s.setVisible(false);
    const owner = await s.service.get(s.auth, s.shootId);
    expect(owner.captures[0]).toMatchObject({
      id: s.captureId,
      eligible: false,
      assetId: null,
      fileName: null,
      checksum: null,
      camera: null,
    });
    await expect(s.service.file(s.shootId, client.session, s.captureId, 'preview')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('rejects wrong password before creating a scoped session', async () => {
    const s = await setup();
    const client = await s.invitation(true, 'correct-password');
    await expect(s.service.session(s.shootId, { token: client.token, password: 'wrong' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('keeps notes independent of favorites, applies named presets without changing live settings, and delivers explicitly included edits', async () => {
    const s = await setup();
    const client = await s.invitation();
    await s.published();
    await s.service.choices(s.shootId, client.session, {
      expectedRevision: s.row().revision,
      captureIds: [],
      notes: [
        {
          captureId: s.captureId,
          text: 'Please soften this',
          annotations: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.3, text: 'Here' }],
        },
      ],
    });
    expect(s.row().value.recipients[0].choices).toEqual([]);
    expect(s.row().value.recipients[0].notes[0].annotations).toHaveLength(1);
    await expect(
      s.service.choices(s.shootId, client.session, {
        expectedRevision: s.row().revision,
        captureIds: [],
        notes: [
          { captureId: s.captureId, text: 'A' },
          { captureId: s.captureId, text: 'B' },
        ],
      }),
    ).rejects.toThrow('Duplicate');
    await s.service.savePreset(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      id: null,
      name: 'Included portrait',
      config: { ...s.row().value.config, mode: 'edited-delivery', title: 'Included portrait' },
    });
    await s.service.applyPreset(s.auth, s.shootId, s.row().value.presets[0].id, { expectedRevision: s.row().revision });
    expect((await s.service.gallery(s.shootId, client.session)).title).toBe('Portrait');
    expect((await s.service.gallery(s.shootId, client.session)).checkoutAvailable).toBe(false);
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      requestClientApproval: false,
    });
    await s.service.order(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      roundId: null,
      captureIds: [s.captureId],
      recipientId: client.recipientId,
      pricing: 'package',
    });
    expect(s.row().value.orders[0]).toMatchObject({ status: 'free', roundId: null });
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    expect((await s.service.file(s.shootId, client.session, s.captureId, 'download')).path).not.toBe(s.source);
  });
  it('does not release prepared finals when the atomic publication commit fails', async () => {
    const s = await setup();
    const client = await s.invitation();
    await s.published();
    const round = await s.selected(client.session);
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      requestClientApproval: false,
    });
    await s.service.order(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      roundId: round.id,
      recipientId: client.recipientId,
      pricing: 'package',
    });
    await s.service.accept(s.shootId, client.session, s.row().value.orders[0].id, {
      expectedRevision: s.row().revision,
    });
    const mutate = s.repository.mutate.getMockImplementation()!;
    s.repository.mutate.mockImplementation((...args) =>
      mutate(args[0], args[1], args[2], args[3], args[4], async (value: WorkflowRow['value']) => {
        const result = await args[5](value);
        if (value.publication?.status === 'ready') throw new ConflictException('Commit failed');
        return result;
      }),
    );
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Failed);
    expect(s.row().value.orders[0].items[0].finalPath).toBeNull();
    await expect(s.service.file(s.shootId, client.session, s.captureId, 'download')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('pins separate studio role presets only when initializing a new workflow', async () => {
    const proofId = randomUUID(),
      webId = randomUUID(),
      exportId = randomUUID();
    const brand = {
      name: 'Studio Taylor',
      watermarkColor: '#ffffff',
      watermarkOpacity: 45,
      watermarkPosition: 'bottom-right',
      watermarkSize: 6,
      proofWatermarkPresetId: proofId,
      webWatermarkPresetId: webId,
      exportWatermarkPresetId: exportId,
      watermarkPresets: [
        { id: proofId, name: 'Proof', version: 1, watermark: { text: 'Studio proof', pattern: 'tile' } },
        { id: webId, name: 'Web', version: 1, watermark: { text: 'Studio web' } },
        { id: exportId, name: 'Export', version: 1, watermark: { text: 'Studio export' } },
      ],
    };
    const s = await setup(brand);
    expect(s.row().value.config).toMatchObject({
      proofWatermark: { text: 'Studio proof' },
      webWatermark: { text: 'Studio web' },
      downloadWatermark: { text: 'Studio export' },
    });
    brand.watermarkPresets[0].watermark.text = 'Later studio preset';
    await s.service.intake(s.auth, s.shootId, { expectedRevision: s.row().revision });
    expect(s.row().value.config.proofWatermark.text).toBe('Studio proof');
    const legacy = await setup({
      name: 'Legacy studio',
      watermarkColor: '#ffffff',
      watermarkOpacity: 45,
      watermarkPosition: 'bottom-right',
      watermarkSize: 6,
    });
    expect(legacy.row().value.config.proofWatermark.text).toBe('Legacy studio');
  });
  it('publishes portfolio pixels only with explicit inclusion and a matching current approved web revision', async () => {
    const s = await setup();
    await s.published();
    const dto = PhotographySiteSaveDto.schema.parse({
      expectedRevision: null,
      site: {
        enabled: true,
        title: 'Studio',
        about: 'Portraits',
        services: '',
        contact: '',
        portfolio: [{ shootId: s.shootId, captureId: s.captureId, consent: true }],
      },
    });
    await expect(s.service.saveSite(s.auth, dto)).rejects.toThrow('approved web photograph');
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      requestClientApproval: false,
    });
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    await s.published();
    await s.service.saveSite(s.auth, dto);
    const site = await s.service.publicSite(s.ownerId);
    expect(PhotographyPublicSiteDto.schema.safeParse(site).success).toBe(true);
    expect(site.portfolio).toHaveLength(1);
    expect(JSON.stringify(site)).not.toContain(s.assetId);
    expect((await s.service.publicPhoto(s.ownerId, s.shootId, s.captureId)).path).not.toBe(s.source);
    s.setVisible(false);
    await expect(s.service.publicPhoto(s.ownerId, s.shootId, s.captureId)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('verifies provider amount/currency, applies payment once, and keeps snapshots after refund', async () => {
    const s = await setup();
    const client = await s.invitation();
    await s.published();
    await s.service.config(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      config: { ...s.row().value.config, additionalPrice: 1500 },
    });
    const round = await s.selected(client.session);
    await s.service.order(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      roundId: round.id,
      recipientId: client.recipientId,
      pricing: 'package',
    });
    const order = s.row().value.orders[0];
    await s.service.accept(s.shootId, client.session, order.id, { expectedRevision: s.row().revision });
    s.row().value.orders[0].checkoutId = 'cs_test_bound';
    vi.stubEnv('PHOTOGRAPHY_STRIPE_SECRET_KEY', 'sk_test_fixture');
    vi.stubEnv('PHOTOGRAPHY_STRIPE_STUDIO_OWNER_ID', s.ownerId);
    vi.stubEnv('PHOTOGRAPHY_STRIPE_WEBHOOK_SECRET', 'whsec_fixture');
    const state = {
      id: 'cs_test_bound',
      client_reference_id: order.id,
      amount_total: 1500,
      currency: 'cad',
      payment_status: 'paid',
      payment_intent: { id: 'pi_bound', status: 'succeeded', latest_charge: { amount_refunded: 0, refunded: false } },
    };
    const fetch = vi.fn(() => Promise.resolve(Response.json(state)));
    vi.stubGlobal('fetch', fetch);
    const event = (id: string, type = 'checkout.session.completed') => {
      const raw = Buffer.from(JSON.stringify({ id, type, data: { object: { client_reference_id: order.id } } }));
      const t = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', 'whsec_fixture').update(`${t}.`).update(raw).digest('hex');
      return [raw, `t=${t},v1=${signature}`] as const;
    };
    state.amount_total = 1499;
    await expect(s.service.callback(...event('evt_bad'))).rejects.toBeInstanceOf(ForbiddenException);
    state.amount_total = 1500;
    await s.service.callback(...event('evt_paid'));
    await s.service.callback(...event('evt_paid'));
    expect(s.row().value.orders[0].status).toBe('settled');
    expect(s.row().value.receipts.filter((r) => r.reference === 'evt_paid')).toHaveLength(1);
    state.payment_intent.latest_charge.amount_refunded = 500;
    await s.service.callback(...event('evt_refunded', 'charge.refunded'));
    expect(s.row().value.orders[0]).toMatchObject({ status: 'refunded', total: 1500, captureIds: [s.captureId] });
  });
  it('snapshots config outputs, renders distinct clean/branded sizes and historical approved versions, and scopes ZIP entries', async () => {
    const s = await setup();
    const client = await s.invitation();
    await s.published();
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      requestClientApproval: false,
    });
    const oldRevision = {
      ...(await s.revisions.get(s.revisionId))!,
      id: randomUUID(),
      isCurrent: false,
      masterPath: s.source,
    };
    s.revisions.get.mockImplementation((id) =>
      Promise.resolve(
        id === oldRevision.id
          ? oldRevision
          : id === s.revisionId
            ? { ...oldRevision, id: s.revisionId, isCurrent: true }
            : undefined,
      ),
    );
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: oldRevision.id,
      requestClientApproval: false,
    });
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      requestClientApproval: false,
    });
    const outputs = [
      { key: 'print', label: 'Full resolution', kind: 'print' as const, maxEdge: 65_535, watermark: null },
      { key: 'web', label: 'Clean web', kind: 'web' as const, maxEdge: 400, watermark: null },
      {
        key: 'social',
        label: 'Studio social',
        kind: 'social' as const,
        maxEdge: 400,
        watermark: { ...s.row().value.config.proofWatermark, opacity: 100, size: 15 },
      },
    ];
    await s.service.config(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      config: { ...s.row().value.config, mode: 'edited-delivery', downloadOutputs: outputs },
    });
    await s.service.order(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      recipientId: client.recipientId,
      roundId: null,
      pricing: 'package',
      captureIds: [s.captureId],
      outputs: outputs.map((output) => ({
        ...output,
        revisions: output.key === 'web' ? [{ captureId: s.captureId, revisionId: oldRevision.id }] : [],
      })),
    });
    const order = s.row().value.orders[0];
    expect(order.items[0].outputs).toHaveLength(3);
    expect((await s.service.get(s.auth, s.shootId)).orders[0].items[0].outputs[0].renderStatus).toBe('preparing');
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    const views = (await s.service.gallery(s.shootId, client.session)).photos[0].outputs;
    expect(views.every((output) => output.canDownload && output.renderStatus === 'ready')).toBe(true);
    const files = await Promise.all(
      views.map((output) => s.service.outputFile(s.shootId, client.session, s.captureId, output.id)),
    );
    expect(await sharp(files[0].path).metadata()).toMatchObject({ width: 800, height: 600 });
    expect(await sharp(files[1].path).metadata()).toMatchObject({ width: 400, height: 300 });
    expect((await sharp(files[1].path).raw().toBuffer()).equals(await sharp(files[2].path).raw().toBuffer())).toBe(
      false,
    );
    expect(
      (await readFile(files[0].path)).equals(await renderPhotographyRendition(s.source, null, undefined, 65_535)),
    ).toBe(true);
    expect(order.items[0].outputs![1].revisionId).toBe(oldRevision.id);
    await expect(s.service.outputFile(s.shootId, client.session, randomUUID(), views[0].id)).rejects.toThrow();
    await expect(s.service.outputFile(s.shootId, client.session, s.captureId, randomUUID())).rejects.toThrow();
    const zip = await s.service.zip(s.shootId, client.session, {
      captureIds: [],
      outputs: views.map((output) => ({ captureId: s.captureId, outputId: output.id })),
    });
    expect(s.row().value.zips[0].entries).toHaveLength(3);
    await s.service.config(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      config: {
        ...s.row().value.config,
        downloadOutputs: [{ ...outputs[0], watermark: s.row().value.config.proofWatermark }],
      },
    });
    expect(s.row().value.orders[0].items[0].outputs![0].exportWatermark).toBeNull();
    s.asset.checksum = Buffer.alloc(32, 2);
    await expect(s.service.outputFile(s.shootId, client.session, s.captureId, views[0].id)).rejects.toThrow();
    await expect(s.service.archive(s.shootId, client.session, zip.id)).rejects.toThrow();
    expect(s.storage.createZipStream).not.toHaveBeenCalled();
  });
  it.each(['locked', 'expired', 'revoked', 'refunded'] as const)(
    'rechecks %s grants for each output and pinned ZIP retrieval',
    async (reason) => {
      const s = await setup();
      const client = await s.invitation();
      await s.published();
      await s.service.config(s.auth, s.shootId, {
        expectedRevision: s.row().revision,
        config: { ...s.row().value.config, mode: 'edited-delivery' },
      });
      await s.service.approval(s.auth, s.shootId, {
        expectedRevision: s.row().revision,
        captureId: s.captureId,
        revisionId: s.revisionId,
        requestClientApproval: false,
      });
      await s.service.order(s.auth, s.shootId, {
        expectedRevision: s.row().revision,
        recipientId: client.recipientId,
        roundId: null,
        pricing: 'package',
        captureIds: [s.captureId],
      });
      expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
      const output = (await s.service.gallery(s.shootId, client.session)).photos[0].outputs[0];
      const zip = await s.service.zip(s.shootId, client.session, {
        captureIds: [],
        outputs: [{ captureId: s.captureId, outputId: output.id }],
      });
      if (reason === 'locked') s.setVisible(false);
      else if (reason === 'refunded') s.row().value.orders[0].status = 'refunded';
      else {
        const recipient = s.row().value.recipients[0];
        if (reason === 'expired') recipient.expiresAt = '2000-01-01T00:00:00Z';
        else recipient.revoked = true;
      }
      await expect(s.service.outputFile(s.shootId, client.session, s.captureId, output.id)).rejects.toThrow();
      await expect(
        s.service.zip(s.shootId, client.session, {
          captureIds: [],
          outputs: [{ captureId: s.captureId, outputId: output.id }],
        }),
      ).rejects.toThrow();
      await expect(s.service.archive(s.shootId, client.session, zip.id)).rejects.toThrow();
      expect(s.storage.createZipStream).not.toHaveBeenCalled();
    },
  );
  it('carries approval requested before order into all outputs and never reuses another recipient approval', async () => {
    const s = await setup();
    const a = await s.invitation();
    const b = await s.invitation();
    await s.service.config(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      config: {
        ...s.row().value.config,
        mode: 'edited-delivery',
        downloadOutputs: [
          { key: 'print', label: 'Print', kind: 'print', maxEdge: 65_535, watermark: null },
          { key: 'web', label: 'Web', kind: 'web', maxEdge: 1024, watermark: null },
        ],
      },
    });
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      requestClientApproval: true,
    });
    await s.published();
    await s.service.order(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      roundId: null,
      recipientId: a.recipientId,
      pricing: 'package',
      captureIds: [s.captureId],
    });
    expect(
      s
        .row()
        .value.orders[0].items[0].outputs!.every(
          (output) => output.revisionId === s.revisionId && output.clientApprovalRequired && !output.approved,
        ),
    ).toBe(true);
    expect((await s.service.get(s.auth, s.shootId)).pendingEdits).toBe(1);
    await s.service.guestApproval(s.shootId, a.session, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      approved: true,
      note: '',
    });
    await s.service.order(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      roundId: null,
      recipientId: b.recipientId,
      pricing: 'package',
      captureIds: [s.captureId],
      outputs: [
        {
          key: 'colour',
          label: 'Colour',
          kind: 'print',
          maxEdge: 65_535,
          watermark: null,
          revisions: [{ captureId: s.captureId, revisionId: s.revisionId }],
        },
      ],
    });
    expect(s.row().value.orders[1].items[0].outputs![0]).toMatchObject({
      revisionId: s.revisionId,
      approved: false,
      clientApprovalRequired: true,
    });
    await s.service.guestApproval(s.shootId, b.session, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      approved: true,
      note: '',
    });
    expect((await s.service.get(s.auth, s.shootId)).pendingEdits).toBe(0);
  });
  it('passes original validated logo bytes to the renderer so light variants are selected exactly once', async () => {
    const s = await setup();
    const logoId = randomUUID();
    const file = path.join(path.dirname(s.source), 'logo.jpg');
    const raw = Buffer.alloc(700 * 700 * 3);
    let seed = 123;
    for (let i = 0; i < raw.length; i++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      raw[i] = seed >>> 24;
    }
    const upload = await sharp(raw, { raw: { width: 700, height: 700, channels: 3 } })
      .jpeg({ quality: 60 })
      .toBuffer();
    expect(upload.length).toBeLessThan(512_000);
    expect((await preparePhotographyLogo(upload)).original.length).toBeGreaterThan(512_000);
    await writeFile(file, upload);
    s.repository.logo.mockResolvedValue([{ ...s.asset, id: logoId, originalPath: file }] as never);
    const mark = PhotographyWatermarkSchema.parse({
      type: 'logo',
      text: 'Studio',
      logoAssetId: logoId,
      logoVariant: 'light',
      opacity: 100,
      size: 20,
    });
    const bytes = await (s.service as any).logo({ ownerId: s.ownerId, albumId: randomUUID() }, mark);
    expect(bytes.equals(upload)).toBe(true);
    expect(await renderPhotographyRendition(s.source, mark, bytes, 480)).toEqual(
      await renderPhotographyRendition(s.source, mark, upload, 480),
    );
  });
  it('saves reusable output/package/presentation defaults and applies source and gallery CAS without changing live publication', async () => {
    const s = await setup();
    const client = await s.invitation();
    await s.published();
    const config = {
      ...s.row().value.config,
      title: 'Reusable portrait',
      presentation: {
        ...s.row().value.config.presentation,
        coverCaptureId: s.captureId,
        blocks: [
          {
            id: randomUUID(),
            type: 'grid' as const,
            chapterId: randomUUID(),
            captureIds: [s.captureId],
            text: 'Reusable layout',
          },
        ],
      },
      downloadOutputs: [
        { key: 'social', label: 'Clean social', kind: 'social' as const, maxEdge: 1200, watermark: null },
      ],
    };
    const preset = await s.service.saveStudioPreset(s.auth, {
      expectedRevision: null,
      id: null,
      name: 'Portrait setup',
      config,
    });
    expect(preset.presets[0].config.presentation.coverCaptureId).toBeNull();
    expect(preset.presets[0].config.presentation.blocks?.[0]).toMatchObject({
      chapterId: null,
      captureIds: [],
      text: 'Reusable layout',
    });
    expect(preset.presets[0].config.downloadOutputs).toEqual(config.downloadOutputs);
    const current = s.row().revision;
    await expect(
      s.service.applyStudioPreset(s.auth, s.shootId, preset.presets[0].id, {
        expectedRevision: current,
        expectedPresetRevision: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(s.row().revision).toBe(current);
    await s.service.applyStudioPreset(s.auth, s.shootId, preset.presets[0].id, {
      expectedRevision: current,
      expectedPresetRevision: preset.revision,
    });
    expect(s.row().value.config.title).toBe(config.title);
    expect((await s.service.gallery(s.shootId, client.session)).title).toBe('Portrait');
    await expect(
      s.service.saveStudioPreset(s.auth, { expectedRevision: null, id: null, name: 'Stale', config }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      s.service.saveStudioPreset({ ...s.auth, apiKey: {} } as AuthDto, {
        expectedRevision: preset.revision,
        id: null,
        name: 'Forbidden',
        config,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      s.service.config(s.auth, s.shootId, {
        expectedRevision: s.row().revision,
        config: { ...config, downloadOutputs: [{ ...config.downloadOutputs[0], maxEdge: 6000 }] },
      }),
    ).rejects.toThrow('Output size');
  });
  it('allows a recipient to approve a pinned historical output via its burned proof while current gallery proof changes', async () => {
    const s = await setup();
    const a = await s.invitation();
    const b = await s.invitation();
    await s.service.config(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      config: { ...s.row().value.config, mode: 'edited-delivery' },
    });
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      requestClientApproval: true,
    });
    await s.published();
    await s.service.order(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      roundId: null,
      recipientId: a.recipientId,
      pricing: 'package',
      captureIds: [s.captureId],
    });
    await s.service.guestApproval(s.shootId, a.session, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      approved: true,
      note: '',
    });
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    const original = (await s.revisions.get(s.revisionId))!;
    const newer = { ...original, id: randomUUID() };
    s.revisions.get.mockImplementation((id) =>
      Promise.resolve(id === newer.id ? newer : id === original.id ? original : undefined),
    );
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: newer.id,
      requestClientApproval: false,
    });
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    await s.published();
    await s.service.order(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      roundId: null,
      recipientId: b.recipientId,
      pricing: 'package',
      captureIds: [s.captureId],
      outputs: [
        {
          key: 'original-colour',
          label: 'Original Colour',
          kind: 'print',
          maxEdge: 65_535,
          watermark: null,
          revisions: [{ captureId: s.captureId, revisionId: original.id }],
        },
      ],
    });
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    const view = (await s.service.gallery(s.shootId, b.session)).photos[0].outputs[0];
    expect(view.approvalPreviewUrl).toBeTruthy();
    expect(view.canDownload).toBe(false);
    const preview = await s.service.outputPreview(s.shootId, b.session, s.captureId, view.id);
    expect(
      (await readFile(preview.path)).equals(await renderPhotographyRendition(s.source, null, undefined, 2400)),
    ).toBe(false);
    await expect(s.service.outputPreview(s.shootId, a.session, s.captureId, view.id)).rejects.toThrow();
    await s.service.guestApproval(s.shootId, b.session, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: original.id,
      approved: true,
      note: '',
    });
    expect(s.row().value.captures[0].proofRevisionId).toBe(newer.id);
    expect(s.row().value.orders[0].items[0].revisionId).toBe(original.id);
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    expect((await s.service.outputFile(s.shootId, b.session, s.captureId, view.id)).path).not.toBe(preview.path);
  });
  it('validates ordered presentation blocks, preserves legacy omission, pins publication and filters guest capture references', async () => {
    const s = await setup();
    const client = await s.invitation();
    expect(s.row().value.config.presentation.blocks).toBeUndefined();
    const blocks = [
      {
        id: randomUUID(),
        type: 'grid' as const,
        chapterId: null,
        captureIds: [s.captureId],
        text: 'Published caption',
      },
    ];
    const config = { ...s.row().value.config, presentation: { ...s.row().value.config.presentation, blocks } };
    await expect(
      s.service.config(s.auth, s.shootId, {
        expectedRevision: s.row().revision,
        config: {
          ...config,
          presentation: { ...config.presentation, blocks: [{ ...blocks[0], captureIds: [randomUUID()] }] },
        },
      }),
    ).rejects.toThrow('Unknown block photograph');
    await expect(
      s.service.config(s.auth, s.shootId, {
        expectedRevision: s.row().revision,
        config: {
          ...config,
          presentation: { ...config.presentation, blocks: [{ ...blocks[0], chapterId: randomUUID() }] },
        },
      }),
    ).rejects.toThrow('Unknown block chapter');
    await expect(
      s.service.config(s.auth, s.shootId, {
        expectedRevision: s.row().revision,
        config: { ...config, presentation: { ...config.presentation, blocks: [blocks[0], blocks[0]] } },
      }),
    ).rejects.toThrow('Duplicate block ID');
    await s.service.config(s.auth, s.shootId, { expectedRevision: s.row().revision, config });
    await s.published();
    await s.service.config(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      config: {
        ...config,
        presentation: { ...config.presentation, blocks: [{ ...blocks[0], text: 'Draft caption' }] },
      },
    });
    expect((await s.service.gallery(s.shootId, client.session)).presentation.blocks).toEqual(
      blocks.map((block) => ({ ...block, selection: 'explicit' })),
    );
    s.asset.isOffline = true;
    const guest = await s.service.gallery(s.shootId, client.session);
    expect(guest.photos).toEqual([]);
    expect(guest.presentation.blocks![0]).toMatchObject({
      selection: 'explicit',
      captureIds: [],
      text: 'Published caption',
    });
  });
  it('keys live pixels to the committed generation and binds ordinary approval to the served proof', async () => {
    const s = await setup();
    const client = await s.invitation();
    expect((await s.service.gallery(s.shootId, client.session)).publishedGenerationId).toBeNull();
    await s.service.config(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      config: { ...s.row().value.config, mode: 'edited-delivery' },
    });
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: s.revisionId,
      requestClientApproval: true,
    });
    await s.published();
    const liveGeneration = s.row().value.publication!.id;
    await s.service.order(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      roundId: null,
      recipientId: client.recipientId,
      pricing: 'package',
      captureIds: [s.captureId],
    });
    const first = await s.service.gallery(s.shootId, client.session);
    expect(first.publishedGenerationId).toBe(liveGeneration);
    expect(first.publication!.id).not.toBe(liveGeneration);
    expect(first.photos[0].approvalRevisionId).toBe(s.row().value.published!.photos[0].revisionId);
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    const latestLive = s.row().value.published!.generationId!;
    const source = (await s.revisions.get(s.revisionId))!;
    const next = { ...source, id: randomUUID() };
    s.revisions.get.mockImplementation((id) =>
      Promise.resolve(id === next.id ? next : id === source.id ? source : undefined),
    );
    await s.service.approval(s.auth, s.shootId, {
      expectedRevision: s.row().revision,
      captureId: s.captureId,
      revisionId: next.id,
      requestClientApproval: true,
    });
    await s.service.publish(s.auth, s.shootId, { expectedRevision: s.row().revision, scope: 'all-eligible' });
    const pending = await s.service.gallery(s.shootId, client.session);
    expect(pending.publishedGenerationId).toBe(latestLive);
    expect(pending.publication!.id).not.toBe(latestLive);
    expect(pending.photos[0].approvalRevisionId).toBeNull();
    expect(s.row().value.published!.photos[0].revisionId).toBe(source.id);
    expect(pending.photos[0].outputs.every((output) => output.approvalPreviewUrl === null)).toBe(true);
    expect(await s.service.render({ id: s.shootId })).toBe(JobStatus.Success);
    const committed = await s.service.gallery(s.shootId, client.session);
    expect(committed.publishedGenerationId).toBe(pending.publication!.id);
    expect(committed.photos[0].approvalRevisionId).toBe(next.id);
    expect(committed.photos[0].outputs[0].approvalPreviewUrl).toBeTruthy();
  });
});
