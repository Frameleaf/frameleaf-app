import type { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { mapOperation } from 'src/services/media-operation.service.js';

it('never exposes a speech source or transcript through generic Activity even after privacy changes', () => {
  const operation = {
    id: 'job',
    kind: 'speech_transcription',
    status: 'completed',
    destination: 'local',
    label: 'private video',
    assetId: 'private-source',
    resultAssetId: null,
    destinationDetail: 'private-worker',
    settings: { source: 'private' },
    result: { transcript: 'private words' },
    error: '/private/original.mov failed',
    progress: 75,
    processedUnits: 4000,
    totalUnits: 5000,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as MediaOperation;
  const result = mapOperation(operation);
  expect(result.assetId).toBeNull();
  expect(result.label).not.toContain('private');
  expect(result.settings).toEqual({});
  expect(result.error).toBeNull();
  expect(result.totalUnits).toBeNull();
});
