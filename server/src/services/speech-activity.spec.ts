import { NotFoundException } from '@nestjs/common';
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
  // The legacy contract cannot represent this internal kind, even as a sanitized row.
  expect(() => mapOperation(operation)).toThrow(NotFoundException);
  expect(() => mapOperation(operation, new Set(['private-source']))).toThrow(NotFoundException);
});
