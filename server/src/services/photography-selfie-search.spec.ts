import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import sharp from 'sharp';
import { PhotographySelfieService } from 'src/services/photography-selfie.service.js';

vi.mock('src/services/base.service.js', () => ({
  BaseService: class {
    getConfig() {
      return Promise.resolve({
        machineLearning: {
          enabled: true,
          facialRecognition: { enabled: true, modelName: 'buffalo_l', minScore: 0.7, maxDistance: 0.5 },
        },
      });
    }
  },
}));

const id = randomUUID();
const ownerId = randomUUID();
const token = 'a'.repeat(64);
const cloud = { source: 'cloud', destinationId: 'cloud', available: true };
const embedding = JSON.stringify([1, ...Array.from({ length: 511 }, () => 0)]);
const first = { captureId: randomUUID(), assetId: randomUUID() };
const second = { captureId: randomUUID(), assetId: randomUUID() };

async function setup() {
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const workflow = { selfieSource: vi.fn(async () => ({ ownerId, captures: [first, second] })) };
  const findGalleryFaces = vi.fn(async () => [second.assetId, first.assetId]);
  const rate = { hit: vi.fn(async (_key: string, _seconds: number) => ({ count: 1, resetSeconds: 3600 })) };
  const detectFaces = vi.fn(async (_selection, _path: string) => ({ faces: [{ embedding }] }));
  const resolveRoute = vi.fn(async () => [{ source: 'local', destinationId: 'local', available: true }]);
  const service = Object.assign(Object.create(PhotographySelfieService.prototype) as PhotographySelfieService, {
    keepsPhotosHome: vi.fn(async () => false),
    mlDestinationRepository: { resolveRoute },
    selectMlDestination: vi.fn(async () => ({ endpoint: {} })),
    searchRepository: { findGalleryFaces },
    machineLearningRepository: { detectFaces },
  });
  return { image, workflow, rate, detectFaces, findGalleryFaces, service, resolveRoute };
}

it('returns only current gallery capture ids in distance order and deletes the temporary selfie', async () => {
  const { image, workflow, rate, detectFaces, findGalleryFaces, service } = await setup();
  workflow.selfieSource
    .mockResolvedValueOnce({ ownerId, captures: [first, second] })
    .mockResolvedValueOnce({ ownerId, captures: [second] });
  await expect(service.search(workflow as never, rate as never, id, token, image)).resolves.toEqual({
    captureIds: [second.captureId],
  });
  expect(findGalleryFaces).toHaveBeenCalledExactlyOnceWith(ownerId, [first.assetId, second.assetId], embedding, 0.5);
  expect(rate.hit).toHaveBeenCalledWith(
    `gallery-selfie:${id}:${createHash('sha256').update(token).digest('hex')}`,
    3600,
  );
  await expect(access(detectFaces.mock.calls[0]![1])).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not process disabled, unauthorized, or over-limit searches', async () => {
  const { image, workflow, rate, detectFaces, service } = await setup();
  workflow.selfieSource.mockRejectedValueOnce(new NotFoundException()).mockRejectedValueOnce(new ForbiddenException());
  await expect(service.search(workflow as never, rate as never, id, token, image)).rejects.toBeInstanceOf(
    NotFoundException,
  );
  await expect(service.search(workflow as never, rate as never, id, token, image)).rejects.toBeInstanceOf(
    ForbiddenException,
  );
  rate.hit.mockResolvedValueOnce({ count: 11, resetSeconds: 12 });
  await expect(service.search(workflow as never, rate as never, id, token, image)).rejects.toMatchObject({
    status: 429,
    response: expect.objectContaining({ code: 'rate_limited', retryAfter: 12 }),
  } satisfies Partial<HttpException>);
  expect(detectFaces).not.toHaveBeenCalled();
});

it('rejects multiple faces and removes temporary input even if inference fails', async () => {
  const { image, workflow, rate, detectFaces, service } = await setup();
  detectFaces.mockResolvedValueOnce({ faces: [{ embedding: 'a' }, { embedding: 'b' }] });
  await expect(service.search(workflow as never, rate as never, id, token, image)).rejects.toBeInstanceOf(
    BadRequestException,
  );
  detectFaces.mockRejectedValueOnce(new Error('transport failure'));
  await expect(service.search(workflow as never, rate as never, id, token, image)).rejects.toMatchObject({
    status: 503,
  });
  for (const [, path] of detectFaces.mock.calls) {
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('refuses an unsupported ephemeral destination without sending a selfie or falling back', async () => {
  const { image, workflow, rate, detectFaces, service, resolveRoute } = await setup();
  resolveRoute.mockResolvedValueOnce([cloud, { source: 'local', destinationId: 'local', available: true }]);
  await expect(service.search(workflow as never, rate as never, id, token, image)).rejects.toMatchObject({
    status: 503,
    response: expect.objectContaining({ code: 'selfie_unavailable' }),
  });
  expect(detectFaces).not.toHaveBeenCalled();
});
