import { WorkflowTrigger } from '@frameleaf/plugin-sdk';
import { eventRunIds, isFrameleafEventTrigger, signEventBody, toEventPayload } from 'src/utils/workflow-event.js';

describe('Frameleaf events (FL-819)', () => {
  it('signs the timestamp, delivery id and body as HMAC-SHA256 (known vector)', () => {
    const vector = 'sha256=9cd2af4efc0ad7feb339dc6ab001fc96bc4253d5ebd2dd7a9206a5b31a99b4c6';
    expect(signEventBody('my-secret', '1700000000', 'cloud-backup:run-1:failed', '{"event":"cloud.backup.failed"}')).toBe(
      vector,
    );
    expect(signEventBody('my-secret', '1700000000', 'another', '{"event":"cloud.backup.failed"}')).not.toBe(vector);
  });

  it('sends only the listed detail fields and never the photos the event is about', () => {
    const payload = toEventPayload({
      trigger: WorkflowTrigger.CloudJobCompleted,
      ownerId: 'owner',
      deliveryId: 'cloud-job:1',
      occurredAt: '2026-11-10T11:05:00.000Z',
      subject: { kind: 'cloud-job', id: '1', name: 'Restoration' },
      detail: { job: 'restoration', stage: 'full', assetId: 'photo-1', path: '/library/a.jpg', nested: { a: 1 } },
      privacyAssetIds: ['photo-1'],
    });
    expect(payload).toEqual({
      event: 'cloud.job.completed',
      deliveryId: 'cloud-job:1',
      occurredAt: '2026-11-10T11:05:00.000Z',
      subject: { kind: 'cloud-job', id: '1', name: 'Restoration' },
      detail: { job: 'restoration', stage: 'full' },
    });
    expect(JSON.stringify(payload)).not.toContain('photo-1');
  });

  it('gives one occurrence of one workflow the same run, and another workflow its own', () => {
    expect(eventRunIds('w1', 'd1')).toEqual(eventRunIds('w1', 'd1'));
    expect(eventRunIds('w1', 'd1').runId).not.toBe(eventRunIds('w2', 'd1').runId);
    expect(eventRunIds('w1', 'd1').executionId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/);
  });

  it('tells Frameleaf events from photo triggers', () => {
    expect(isFrameleafEventTrigger(WorkflowTrigger.ClientsGalleryApproved)).toBe(true);
    expect(isFrameleafEventTrigger(WorkflowTrigger.AssetCreate)).toBe(false);
  });
});
