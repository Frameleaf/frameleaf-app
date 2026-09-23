import {
  DocumentField,
  DocumentFieldStatus,
  DocumentLineStatus,
  type DocumentFieldResponseDto,
  type DocumentLineDto,
  type DocumentResponseDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  appendDocumentPage,
  confidenceLevel,
  confidencePercent,
  documentFieldLabelKey,
  documentPlainText,
  isAbortError,
  LatestRequest,
  otherCandidates,
  overlayOverrides,
  readableLines,
} from '$lib/frameleaf/documents';

const region = { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.1, x3: 0.4, y3: 0.15, x4: 0.1, y4: 0.15 };

const line = (overrides: Partial<DocumentLineDto>): DocumentLineDto => ({
  id: 'line',
  ocrId: 'line',
  editId: null,
  revision: null,
  status: DocumentLineStatus.Recognized,
  text: 'Text',
  recognizedText: 'Text',
  confidence: 0.9,
  region,
  evidenceChanged: false,
  ...overrides,
});

const document = (lines: DocumentLineDto[]): DocumentResponseDto => ({
  assetId: 'asset',
  canEdit: true,
  recognizedAt: null,
  lines,
  fieldsEnabled: false,
  fields: [],
  recognition: null,
});

describe('documents', () => {
  const receipt = document([
    line({ id: 'a', ocrId: 'a', text: 'Lake Agnes' }),
    line({ id: 'b', ocrId: 'b', status: DocumentLineStatus.Corrected, text: 'TOTAL 12.50', recognizedText: 'T0TAL' }),
    line({ id: 'c', ocrId: 'c', status: DocumentLineStatus.Dismissed, text: 'noise' }),
    line({ id: 'kept', ocrId: null, status: DocumentLineStatus.Kept, text: 'My note', recognizedText: null }),
  ]);

  it('reads the photo as corrected, without dismissed lines', () => {
    expect(readableLines(receipt).map((item) => item.id)).toEqual(['a', 'b', 'kept']);
    expect(documentPlainText(receipt)).toBe('Lake Agnes\nTOTAL 12.50\nMy note');
    expect(documentPlainText(null)).toBe('');
  });

  it('tells the overlay about corrections and dismissals only, by recognized line', () => {
    expect([...overlayOverrides(receipt)]).toEqual([
      ['b', 'TOTAL 12.50'],
      ['c', null],
    ]);
  });

  it('describes recognition confidence without calling a value verified', () => {
    expect(confidenceLevel(0.95)).toBe('high');
    expect(confidenceLevel(0.75)).toBe('medium');
    expect(confidenceLevel(0.4)).toBe('low');
    expect(confidenceLevel(null)).toBeNull();
    expect(confidencePercent(0.846)).toBe(85);
    expect(confidencePercent(undefined)).toBeNull();
  });

  it('names each field with its own translation key', () => {
    expect(documentFieldLabelKey(DocumentField.Total)).toBe('frameleaf_documents_field_total');
  });

  it('lists the other suggestions beside the value shown', () => {
    const field: DocumentFieldResponseDto = {
      field: DocumentField.Total,
      status: DocumentFieldStatus.Suggested,
      value: '12.50',
      confidence: 0.9,
      lineId: 'b',
      region,
      evidenceChanged: false,
      candidates: [
        { value: '12.50', lineId: 'b', confidence: 0.9, region },
        { value: '11.30', lineId: 'd', confidence: 0.8, region },
      ],
      editId: null,
      revision: null,
      updatedAt: null,
    };

    expect(otherCandidates(field).map((candidate) => candidate.value)).toEqual(['11.30']);
  });

  it('adds a page without listing a photo twice', () => {
    expect(appendDocumentPage([{ id: '1' }, { id: '2' }], [{ id: '2' }, { id: '3' }])).toEqual([
      { id: '1' },
      { id: '2' },
      { id: '3' },
    ]);
  });

  it('keeps only the newest request current and cancels the one before it', () => {
    const requests = new LatestRequest();
    const first = requests.start();
    const second = requests.start();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);

    requests.cancel();

    expect(second.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(false);
  });

  it('recognizes a cancelled request', () => {
    expect(isAbortError(new DOMException('stopped', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
