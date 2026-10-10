import { describe, expect, it } from 'vitest';
import { DocumentEditAction, DocumentField, DocumentFieldStatus, DocumentLineStatus } from 'src/enum.js';
import {
  DocumentEditRow,
  DocumentOcrLine,
  DocumentRegion,
  assembleDocument,
  fieldKey,
  isRegionInsideCrop,
  lineKey,
  matchLineEdits,
  regionOverlap,
  suggestDocumentFields,
} from 'src/utils/documents.js';

const box = (x: number, y: number, width = 0.3, height = 0.05): DocumentRegion => ({
  x1: x,
  y1: y,
  x2: x + width,
  y2: y,
  x3: x + width,
  y3: y + height,
  x4: x,
  y4: y + height,
});

const line = (id: string, text: string, region: DocumentRegion, scores?: { boxScore: number; textScore: number }) =>
  ({ id, text, ...region, ...(scores ?? { boxScore: 0.95, textScore: 0.9 }) }) satisfies DocumentOcrLine;

const edit = (
  overrides: Partial<DocumentEditRow> & Pick<DocumentEditRow, 'key' | 'action'>,
  region: DocumentRegion | null = null,
): DocumentEditRow => ({
  id: 'edit-1',
  value: null,
  sourceText: null,
  x1: region?.x1 ?? null,
  y1: region?.y1 ?? null,
  x2: region?.x2 ?? null,
  y2: region?.y2 ?? null,
  x3: region?.x3 ?? null,
  y3: region?.y3 ?? null,
  x4: region?.x4 ?? null,
  y4: region?.y4 ?? null,
  revision: 1,
  updatedAt: new Date('2026-09-23T00:00:00.000Z'),
  ...overrides,
});

const correction = (key: string, value: string, sourceText: string | null, region: DocumentRegion | null) =>
  edit({ key, action: DocumentEditAction.Correct, value, sourceText }, region);

const dismissal = (key: string, region: DocumentRegion | null) =>
  edit({ key, action: DocumentEditAction.Dismiss }, region);

const confirmation = (field: DocumentField, value: string, sourceText: string, region: DocumentRegion) =>
  edit({ key: fieldKey(field), action: DocumentEditAction.Confirm, value, sourceText }, region);

type AssembleOptions = {
  isOwner: boolean;
  fieldsEnabled: boolean;
  isRegionVisible: (region: DocumentRegion) => boolean;
};

const assemble = (lines: DocumentOcrLine[], edits: DocumentEditRow[] = [], options: Partial<AssembleOptions> = {}) =>
  assembleDocument({
    lines,
    edits,
    isRegionVisible: options.isRegionVisible ?? (() => true),
    isOwner: options.isOwner ?? true,
    fieldsEnabled: options.fieldsEnabled ?? false,
  });

/** Everything above y = 0.5 survives the crop in these fixtures. */
const topHalf = (region: DocumentRegion) => region.y1 < 0.5;

describe('regionOverlap', () => {
  it('is 1 for the same region and 0 for regions apart', () => {
    expect(regionOverlap(box(0.1, 0.1), box(0.1, 0.1))).toBe(1);
    expect(regionOverlap(box(0.1, 0.1), box(0.6, 0.6))).toBe(0);
  });
});

describe('assembleDocument lines', () => {
  it('reads recognized lines in reading order with their confidence', () => {
    const document = assemble([
      line('b', 'Second', box(0.1, 0.5)),
      line('a', 'First', box(0.1, 0.1), { boxScore: 0.7, textScore: 0.9 }),
    ]);

    expect(document.lines.map((item) => item.text)).toEqual(['First', 'Second']);
    expect(document.lines[0]).toMatchObject({
      status: DocumentLineStatus.Recognized,
      recognizedText: 'First',
      confidence: 0.7,
      editId: null,
      evidenceChanged: false,
    });
  });

  it('applies a correction and keeps the recognized text as provenance', () => {
    const region = box(0.1, 0.1);
    const document = assemble(
      [line('a', 'T0TAL 12,5O', region)],
      [correction(lineKey('a'), 'TOTAL 12.50', 'T0TAL 12,5O', region)],
    );

    expect(document.lines).toEqual([
      expect.objectContaining({
        status: DocumentLineStatus.Corrected,
        text: 'TOTAL 12.50',
        recognizedText: 'T0TAL 12,5O',
        editId: 'edit-1',
        revision: 1,
        evidenceChanged: false,
      }),
    ]);
  });

  it('keeps a correction through a new reading of the photo that finds the same region', () => {
    const document = assemble(
      [line('new-id', 'TOTAL 12.5O', box(0.105, 0.1))],
      [correction(lineKey('old-id'), 'TOTAL 12.50', 'T0TAL 12,5O', box(0.1, 0.1))],
    );

    expect(document.lines).toEqual([
      expect.objectContaining({
        ocrId: 'new-id',
        status: DocumentLineStatus.Corrected,
        text: 'TOTAL 12.50',
        recognizedText: 'TOTAL 12.5O',
        evidenceChanged: true,
      }),
    ]);
  });

  it('keeps an owner’s correction whose text was replaced, without the text it replaced', () => {
    const region = box(0.1, 0.1);
    const document = assemble(
      [line('other', 'Something else', box(0.1, 0.7))],
      [correction(lineKey('gone'), 'My note', 'private words', region)],
    );

    const kept = document.lines.find((item) => item.status === DocumentLineStatus.Kept);
    expect(kept).toMatchObject({ id: 'edit-1', ocrId: null, text: 'My note', recognizedText: null, region });
    expect(JSON.stringify(document)).not.toContain('private words');
  });

  it('never shows a kept correction, recognized text under a correction or edit metadata to anyone else', () => {
    const document = assemble(
      [line('a', 'Public', box(0.1, 0.1)), line('b', 'Set aside', box(0.1, 0.3)), line('c', 'Fixd', box(0.1, 0.5))],
      [
        { ...dismissal(lineKey('b'), box(0.1, 0.3)), id: 'e1' },
        { ...correction(lineKey('c'), 'Fixed', 'Fixd', box(0.1, 0.5)), id: 'e2' },
        { ...correction(lineKey('gone'), 'Kept', null, box(0.1, 0.8)), id: 'e3' },
      ],
      { isOwner: false, fieldsEnabled: true },
    );

    // the dismissed line keeps only its id, so a viewer's overlay can stop drawing it
    expect(document.lines.map((item) => [item.id, item.text])).toEqual([
      ['a', 'Public'],
      ['b', ''],
      ['c', 'Fixed'],
    ]);
    expect(document.lines[1]).toMatchObject({
      status: DocumentLineStatus.Dismissed,
      region: null,
      recognizedText: null,
    });
    expect(document.lines[2]).toMatchObject({ recognizedText: null, confidence: null });
    expect(document.lines.every((item) => item.editId === null && item.revision === null)).toBe(true);
    expect(JSON.stringify(document)).not.toContain('Set aside');
    expect(JSON.stringify(document)).not.toContain('Fixd');
    expect(document.fields).toEqual([]);
  });

  it('lets a decision whose region a crop removed sleep, so its text cannot reappear', () => {
    const document = assemble(
      [line('a', 'Still shown', box(0.1, 0.1))],
      [correction(lineKey('hidden'), 'account 1234', null, box(0.1, 0.9))],
      { isRegionVisible: topHalf },
    );

    expect(document.lines.map((item) => item.text)).toEqual(['Still shown']);
    expect(JSON.stringify(document)).not.toContain('account 1234');
  });

  it('drops a dismissal with no line left to dismiss', () => {
    expect(assemble([], [dismissal(lineKey('gone'), box(0.1, 0.1))]).lines).toEqual([]);
  });
});

describe('isRegionInsideCrop', () => {
  const dimensions = { width: 1000, height: 1000 };

  it('keeps every region without a crop', () => {
    expect(isRegionInsideCrop(box(0.1, 0.9), dimensions)).toBe(true);
  });

  it('keeps a region that is at least half inside the crop and drops the rest', () => {
    const crop = { x1: 0, y1: 0, x2: 1000, y2: 400 };

    expect(isRegionInsideCrop(box(0.1, 0.1), dimensions, crop)).toBe(true);
    expect(isRegionInsideCrop(box(0.1, 0.8), dimensions, crop)).toBe(false);
  });

  it('drops every region when the photo’s size is unknown', () => {
    const unknownSize = { width: 0, height: 0 };

    expect(isRegionInsideCrop(box(0.1, 0.1), unknownSize, { x1: 0, y1: 0, x2: 10, y2: 10 })).toBe(false);
  });
});

describe('matchLineEdits', () => {
  it('gives each line at most one decision, preferring the decision made against it', () => {
    const region = box(0.1, 0.1);
    const { byLine, orphans } = matchLineEdits(
      [line('a', 'Text', region)],
      [
        { ...dismissal(lineKey('a'), region), id: 'by-id' },
        { ...correction(lineKey('old'), 'x', null, region), id: 'by-region' },
      ],
    );

    expect(byLine.get('a')?.id).toBe('by-id');
    expect(orphans.map((item) => item.id)).toEqual(['by-region']);
  });
});

describe('suggestDocumentFields', () => {
  const source = (id: string, text: string, region: DocumentRegion) => ({ id, text, region, confidence: 0.9 });

  it('reads dates without guessing day and month order', () => {
    const suggestions = suggestDocumentFields([
      source('a', 'Date: 2026-09-23', box(0.1, 0.1)),
      source('b', 'Paid September 23, 2026', box(0.1, 0.2)),
      source('c', 'Not a date 45/45/2026', box(0.1, 0.3)),
    ]);

    expect(suggestions.get(DocumentField.Date)?.map((item) => item.value)).toEqual([
      '2026-09-23',
      'September 23, 2026',
    ]);
  });

  it('prefers an explicit amount due, then the last total, and never a subtotal', () => {
    const suggestions = suggestDocumentFields([
      source('a', 'Subtotal 10.00', box(0.1, 0.1)),
      source('b', 'Total 11.30', box(0.1, 0.2)),
      source('c', 'Amount due $12.50', box(0.1, 0.3)),
    ]);

    expect(suggestions.get(DocumentField.Total)?.map((item) => item.value)).toEqual(['$12.50', '11.30']);
  });

  it('reads a total whose amount is a separate line on the same row', () => {
    const suggestions = suggestDocumentFields([
      source('label', 'TOTAL', box(0.1, 0.5, 0.2)),
      source('amount', '42.00', box(0.6, 0.5, 0.2)),
    ]);

    expect(suggestions.get(DocumentField.Total)).toEqual([
      expect.objectContaining({ value: '42.00', lineId: 'amount' }),
    ]);
  });

  it('reads references with a digit, email addresses and phone numbers', () => {
    const suggestions = suggestDocumentFields([
      source('a', 'Invoice # INV-20931', box(0.1, 0.1)),
      source('b', 'Order confirmed', box(0.1, 0.2)),
      source('c', 'billing@example.com', box(0.1, 0.3)),
      source('d', 'Call (403) 555-0199', box(0.1, 0.4)),
    ]);

    expect(suggestions.get(DocumentField.Reference)?.map((item) => item.value)).toEqual(['INV-20931']);
    expect(suggestions.get(DocumentField.Email)?.map((item) => item.value)).toEqual(['billing@example.com']);
    expect(suggestions.get(DocumentField.Phone)?.map((item) => item.value)).toEqual(['(403) 555-0199']);
  });
});

describe('assembleDocument fields', () => {
  const receipt = [
    line('date', 'Date 2026-09-23', box(0.1, 0.1)),
    line('total', 'TOTAL 12.50', box(0.1, 0.6), { boxScore: 0.8, textScore: 0.95 }),
  ];

  it('suggests nothing while field suggestions are switched off', () => {
    expect(assemble(receipt).fields).toEqual([]);
  });

  it('suggests values with their evidence and uncertainty, never as decided', () => {
    const { fields } = assemble(receipt, [], { fieldsEnabled: true });

    expect(fields.find((item) => item.field === DocumentField.Total)).toMatchObject({
      status: DocumentFieldStatus.Suggested,
      value: '12.50',
      confidence: 0.8,
      lineId: 'total',
      region: box(0.1, 0.6),
      editId: null,
    });
  });

  it('suggests from the owner’s corrected text, without a recognition confidence', () => {
    const region = box(0.1, 0.6);
    const { fields } = assemble(
      [line('total', 'T0TAL 12,5O', region)],
      [correction(lineKey('total'), 'TOTAL 12.50', 'T0TAL 12,5O', region)],
      { fieldsEnabled: true },
    );

    expect(fields).toEqual([
      expect.objectContaining({ field: DocumentField.Total, value: '12.50', confidence: null, lineId: 'total' }),
    ]);
  });

  it('shows a decision over the suggestion and keeps the suggestions beside it', () => {
    const { fields } = assemble(
      receipt,
      [
        { ...correction(fieldKey(DocumentField.Total), '12.05', null, null), id: 'decided', revision: 3 },
        { ...dismissal(fieldKey(DocumentField.Date), null), id: 'dismissed' },
      ],
      { fieldsEnabled: true },
    );

    expect(fields.find((item) => item.field === DocumentField.Total)).toMatchObject({
      status: DocumentFieldStatus.Corrected,
      value: '12.05',
      region: null,
      editId: 'decided',
      revision: 3,
      candidates: [expect.objectContaining({ value: '12.50' })],
    });
    expect(fields.find((item) => item.field === DocumentField.Date)).toMatchObject({
      status: DocumentFieldStatus.Dismissed,
      value: null,
    });
  });

  it('marks a confirmed value whose text was read differently since', () => {
    const region = box(0.1, 0.6);
    const { fields } = assemble(
      [line('reread', 'TOTAL 13.50', region)],
      [confirmation(DocumentField.Total, '12.50', 'TOTAL 12.50', region)],
      { fieldsEnabled: true },
    );

    expect(fields[0]).toMatchObject({
      status: DocumentFieldStatus.Confirmed,
      value: '12.50',
      confidence: null,
      lineId: 'reread',
      evidenceChanged: true,
    });
  });

  it('lets a field decision whose text a crop removed sleep', () => {
    const { fields } = assemble(
      [line('date', 'Date 2026-09-23', box(0.1, 0.1))],
      [confirmation(DocumentField.Total, '99.99', 'TOTAL 99.99', box(0.1, 0.9))],
      { fieldsEnabled: true, isRegionVisible: topHalf },
    );

    expect(fields.map((item) => item.field)).toEqual([DocumentField.Date]);
    expect(JSON.stringify(fields)).not.toContain('99.99');
  });
});
