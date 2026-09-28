import {
  DocumentField,
  DocumentFieldStatus,
  DocumentLineStatus,
  type DocumentFieldResponseDto,
  type DocumentLineDto,
  type DocumentResponseDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

/**
 * Documents (FL-63): the rules the Documents page and the information panel's "Text in this photo"
 * section share, kept free of Svelte so they can be tested on their own.
 *
 * The server decides what a line reads and what a field suggests; nothing here reinterprets text.
 * These helpers only choose labels, order what is shown, and keep one request current at a time so a
 * slow answer about a photo the person has already left can never be drawn over the photo they are
 * looking at now.
 */

export const DOCUMENT_PAGE_SIZE = 100;
export const DOCUMENT_SEARCH_DEBOUNCE_MS = 250;
/** How often, and how many times, the panel looks for the result of reading a photo again. */
export const DOCUMENT_REREAD_POLL_MS = 5000;
export const DOCUMENT_REREAD_POLL_LIMIT = 12;

export const documentFieldLabelKey = (field: DocumentField): Translations => `frameleaf_documents_field_${field}`;

export const documentLineStatusKey = (status: DocumentLineStatus): Translations => `frameleaf_documents_line_${status}`;

export const documentFieldStatusKey = (status: DocumentFieldStatus): Translations =>
  `frameleaf_documents_field_status_${status}`;

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * How sure the text recognition was about the text a line or a value was read from. It is never a
 * statement that the value is right: a well-read "12.50" can still be the wrong total.
 */
export const confidenceLevel = (confidence: number | null | undefined): ConfidenceLevel | null => {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) {
    return null;
  }
  if (confidence >= 0.9) {
    return 'high';
  }
  return confidence >= 0.7 ? 'medium' : 'low';
};

export const confidencePercent = (confidence: number | null | undefined): number | null =>
  confidence === null || confidence === undefined || !Number.isFinite(confidence)
    ? null
    : Math.round(Math.min(1, Math.max(0, confidence)) * 100);

/** Lines as the photo reads now: the owner's corrections applied, dismissed lines left out. */
export const readableLines = (document: DocumentResponseDto | null): DocumentLineDto[] =>
  (document?.lines ?? []).filter((line) => line.status !== DocumentLineStatus.Dismissed);

/** The text "Copy text" puts on the clipboard: one line per line, as the photo reads now. */
export const documentPlainText = (document: DocumentResponseDto | null): string => {
  const lines = readableLines(document);
  return lines.map((line) => line.text).join('\n');
};

/**
 * What the overlay over the photo draws for each recognized line: the owner's correction, or `null`
 * for a line they dismissed. Lines as recognized are left out, and so are kept corrections, which
 * have no recognized box to draw on.
 */
export const overlayOverrides = (document: DocumentResponseDto | null): Map<string, string | null> => {
  const overrides = new Map<string, string | null>();
  for (const line of document?.lines ?? []) {
    if (!line.ocrId) {
      continue;
    }
    if (line.status === DocumentLineStatus.Dismissed) {
      overrides.set(line.ocrId, null);
    } else if (line.status === DocumentLineStatus.Corrected) {
      overrides.set(line.ocrId, line.text);
    }
  }
  return overrides;
};

export const isDecidedField = (field: DocumentFieldResponseDto) => field.status !== DocumentFieldStatus.Suggested;

/** The other values the text suggests for a field, beside the one shown. */
export const otherCandidates = (field: DocumentFieldResponseDto) =>
  field.candidates.filter((candidate) => candidate.value !== field.value || candidate.lineId !== field.lineId);

/** Adds a page to what is already listed without repeating a photo a shifting offset returned twice. */
export const appendDocumentPage = <T extends { id: string }>(current: T[], page: T[]): T[] => {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...page.filter((item) => !seen.has(item.id))];
};

export const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

/**
 * One current request at a time. Starting a request cancels the one before it, and its `isCurrent`
 * turns false the moment a newer request starts or `cancel` is called, so a late answer is dropped.
 */
export class LatestRequest {
  #controller: AbortController | undefined;
  #generation = 0;

  start() {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const generation = ++this.#generation;
    return { signal: controller.signal, isCurrent: () => generation === this.#generation };
  }

  cancel() {
    this.#controller?.abort();
    this.#controller = undefined;
    this.#generation++;
  }
}
