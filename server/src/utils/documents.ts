import { AssetEditAction, type AssetEditActionItem } from 'src/dtos/editing.dto.js';
import { DocumentEditAction, DocumentField, DocumentFieldStatus, DocumentLineStatus } from 'src/enum.js';
import { boundingBoxOverlap } from 'src/utils/editor.js';

/**
 * Documents: the text read from a photo, with the owner's decisions applied (FL-63).
 *
 * Pure rules, no I/O. `DocumentService` loads the recognized lines (`asset_ocr`, only the ones a crop
 * left visible) and the owner's decisions (`asset_document_edit`) and hands both to
 * `assembleDocument`, which decides what each line reads, where its evidence is, and which values can
 * be suggested from it.
 *
 * The rules that keep private text private:
 * - Only visible recognized lines are ever read. A line a crop removed is not in the input.
 * - A decision whose region a crop removed "sleeps": it is not shown, not matched and not used for
 *   suggestions, until the crop no longer removes it.
 * - A decision whose recognized line is gone (the photo was read again and nothing covers its region
 *   any more) keeps the owner's own text, but never the recognized text it replaced.
 * - Only the owner sees dismissed lines, kept corrections and fields; everyone else who can see the
 *   photo reads its lines with corrections applied and dismissals removed.
 */

/** The four corners of a text region, normalized to the image (0-1). */
export type DocumentRegion = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
};

export type DocumentOcrLine = DocumentRegion & {
  id: string;
  text: string;
  boxScore: number;
  textScore: number;
};

export type DocumentEditRow = {
  id: string;
  key: string;
  action: DocumentEditAction;
  value: string | null;
  sourceText: string | null;
  x1: number | null;
  y1: number | null;
  x2: number | null;
  y2: number | null;
  x3: number | null;
  y3: number | null;
  x4: number | null;
  y4: number | null;
  revision: number;
  updatedAt: Date | string;
};

export type AssembledLine = {
  /** The recognized line's id, or the decision's id for a kept correction. */
  id: string;
  ocrId: string | null;
  editId: string | null;
  revision: number | null;
  status: DocumentLineStatus;
  /** What the line reads: the owner's correction, or the recognized text. */
  text: string;
  /** The recognized text, while the recognized line exists. Never the text of a line that is gone. */
  recognizedText: string | null;
  /** How sure the recognition was, 0-1: the lower of its detection and recognition scores. */
  confidence: number | null;
  region: DocumentRegion | null;
  /** The decision was made against text that has since been read differently. */
  evidenceChanged: boolean;
};

export type AssembledCandidate = {
  value: string;
  lineId: string;
  /** Recognition confidence of the line it was read from; null when that line is the owner's correction. */
  confidence: number | null;
  region: DocumentRegion;
};

export type AssembledField = {
  field: DocumentField;
  status: DocumentFieldStatus;
  value: string | null;
  confidence: number | null;
  lineId: string | null;
  region: DocumentRegion | null;
  evidenceChanged: boolean;
  candidates: AssembledCandidate[];
  editId: string | null;
  revision: number | null;
  updatedAt: Date | string | null;
};

export type AssembledDocument = {
  lines: AssembledLine[];
  fields: AssembledField[];
};

export type AssembleDocumentOptions = {
  /** The asset's recognized lines that a crop leaves visible, in original-image coordinates. */
  lines: DocumentOcrLine[];
  edits: DocumentEditRow[];
  /** False for a region a crop removed from the photo. */
  isRegionVisible: (region: DocumentRegion) => boolean;
  isOwner: boolean;
  fieldsEnabled: boolean;
};

export const LINE_KEY_PREFIX = 'line:';
export const FIELD_KEY_PREFIX = 'field:';

export const lineKey = (ocrId: string) => `${LINE_KEY_PREFIX}${ocrId}`;
export const fieldKey = (field: DocumentField) => `${FIELD_KEY_PREFIX}${field}`;

/** A region overlapping another by at least this much (intersection over union) is the same place. */
export const REGION_MATCH_THRESHOLD = 0.5;

export const DOCUMENT_FIELD_ORDER: readonly DocumentField[] = [
  DocumentField.Date,
  DocumentField.Total,
  DocumentField.Reference,
  DocumentField.Email,
  DocumentField.Phone,
];

const MAX_CANDIDATES = 5;

export const regionOf = (value: DocumentRegion): DocumentRegion => ({
  x1: value.x1,
  y1: value.y1,
  x2: value.x2,
  y2: value.y2,
  x3: value.x3,
  y3: value.y3,
  x4: value.x4,
  y4: value.y4,
});

/** The stored region of a decision, or null when it was made without one. */
export const editRegion = (edit: DocumentEditRow): DocumentRegion | null => {
  const { x1, y1, x2, y2, x3, y3, x4, y4 } = edit;
  if (x1 === null || y1 === null || x2 === null || y2 === null) {
    return null;
  }
  if (x3 === null || y3 === null || x4 === null || y4 === null) {
    return null;
  }
  return { x1, y1, x2, y2, x3, y3, x4, y4 };
};

export const boundsOf = (region: DocumentRegion) => ({
  left: Math.min(region.x1, region.x2, region.x3, region.x4),
  top: Math.min(region.y1, region.y2, region.y3, region.y4),
  right: Math.max(region.x1, region.x2, region.x3, region.x4),
  bottom: Math.max(region.y1, region.y2, region.y3, region.y4),
});

/** Intersection over union of the two regions' bounding boxes. */
export const regionOverlap = (a: DocumentRegion, b: DocumentRegion): number => {
  const boxA = boundsOf(a);
  const boxB = boundsOf(b);
  const width = Math.max(0, Math.min(boxA.right, boxB.right) - Math.max(boxA.left, boxB.left));
  const height = Math.max(0, Math.min(boxA.bottom, boxB.bottom) - Math.max(boxA.top, boxB.top));
  const intersection = width * height;
  const areaA = (boxA.right - boxA.left) * (boxA.bottom - boxA.top);
  const areaB = (boxB.right - boxB.left) * (boxB.bottom - boxB.top);
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
};

export type CropBox = { x1: number; y1: number; x2: number; y2: number };

/** The crop of an edited photo, in the original image's pixels, or undefined when it is not cropped. */
export const cropBoxOf = (edits: AssetEditActionItem[]): CropBox | undefined => {
  const crop = edits.find((edit) => edit.action === AssetEditAction.Crop);
  return crop
    ? {
        x1: crop.parameters.x,
        y1: crop.parameters.y,
        x2: crop.parameters.x + crop.parameters.width,
        y2: crop.parameters.y + crop.parameters.height,
      }
    : undefined;
};

/**
 * A crop keeps a region when at least half of it is inside, the rule `checkOcrVisibility` applies to
 * recognized lines. `region` is normalized to the original image of `dimensions`.
 */
export const isRegionInsideCrop = (
  region: DocumentRegion,
  dimensions: { width: number; height: number },
  crop?: CropBox,
): boolean => {
  if (!crop) {
    return true;
  }

  const xs = [region.x1, region.x2, region.x3, region.x4].map((value) => value * dimensions.width);
  const ys = [region.y1, region.y2, region.y3, region.y4].map((value) => value * dimensions.height);
  const box = { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  // a zero-sized box or image divides by zero; NaN fails the test, so unknown geometry stays hidden
  return boundingBoxOverlap(box, crop) >= 0.5;
};

export const lineConfidence = (line: Pick<DocumentOcrLine, 'boxScore' | 'textScore'>) =>
  Math.min(line.boxScore, line.textScore);

/** Top to bottom, then left to right within a row (rows are 2% of the image height). */
export const compareReadingOrder = (a: DocumentRegion, b: DocumentRegion) => {
  const boundsA = boundsOf(a);
  const boundsB = boundsOf(b);
  const rowDifference = boundsA.top - boundsB.top;
  if (Math.abs(rowDifference) < 0.02) {
    return boundsA.left - boundsB.left;
  }
  return rowDifference;
};

// ------------------------------------------------------------------------------------ suggestions

type SourceLine = { id: string; text: string; region: DocumentRegion; confidence: number | null };

const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const isDay = (value: number) => value >= 1 && value <= 31;
const isMonth = (value: number) => value >= 1 && value <= 12;

const DATE_RULES: Array<{ pattern: RegExp; valid: (match: RegExpExecArray) => boolean }> = [
  // 2026-09-23, 2026/9/23
  {
    pattern: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/,
    valid: (match) => isMonth(Number(match[2])) && isDay(Number(match[3])),
  },
  // 23/09/2026, 09-23-26: the order of day and month is not guessed, only checked for being possible
  {
    pattern: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/,
    valid: (match) => {
      const first = Number(match[1]);
      const second = Number(match[2]);
      return isDay(first) && isDay(second) && (isMonth(first) || isMonth(second));
    },
  },
  // September 23, 2026
  {
    pattern: new RegExp(String.raw`\b${MONTH}\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, 'i'),
    valid: (match) => isDay(Number(match[2])),
  },
  // 23 September 2026
  {
    pattern: new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH}\.?,?\s+(\d{4})\b`, 'i'),
    valid: (match) => isDay(Number(match[1])),
  },
];

const AMOUNT = /(?:[$€£¥]\s?)?\d{1,3}(?:[,\s.]\d{3})*[.,]\d{2}(?!\d)|[$€£¥]\s?\d+(?!\d)/;
const SUBTOTAL = /\bsub[\s-]?total\b/i;
const STRONG_TOTAL = /\b(grand\s+total|total\s+due|amount\s+due|balance\s+due|total\s+to\s+pay|montant\s+total)\b/i;
const TOTAL = /\b(total|totale|summe|montant)\b/i;
const REFERENCE =
  /\b(?:invoice|receipt|order|ref(?:erence)?|transaction|txn|confirmation|booking)\s*(?:no\.?|number|num\.?|#|id)?\s*[:#.]?\s*([a-z0-9][a-z0-9-]{3,})\b/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b/;

const firstDate = (text: string) => {
  for (const rule of DATE_RULES) {
    const match = rule.pattern.exec(text);
    if (match && rule.valid(match)) {
      return match[0].trim();
    }
  }
  return null;
};

const firstAmount = (text: string) => AMOUNT.exec(text)?.[0].trim() ?? null;

/** Another line on the same row, to the right: receipts often read "TOTAL" and "12.50" as two lines. */
const sameRowAmount = (line: SourceLine, lines: SourceLine[]) => {
  const bounds = boundsOf(line.region);
  const middle = (bounds.top + bounds.bottom) / 2;
  const onRow = lines
    .filter((other) => other.id !== line.id)
    .map((other) => ({ other, bounds: boundsOf(other.region) }))
    .filter(({ bounds: other }) => other.left >= bounds.left && other.top <= middle && other.bottom >= middle)
    .sort((a, b) => a.bounds.left - b.bounds.left);
  for (const { other } of onRow) {
    const amount = firstAmount(other.text);
    if (amount) {
      return { amount, line: other };
    }
  }
  return null;
};

const candidate = (value: string, line: SourceLine): AssembledCandidate => ({
  value,
  lineId: line.id,
  confidence: line.confidence,
  region: line.region,
});

const uniqueCandidates = (candidates: AssembledCandidate[]) => {
  const seen = new Set<string>();
  const unique: AssembledCandidate[] = [];
  for (const item of candidates) {
    const key = item.value.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  return unique.slice(0, MAX_CANDIDATES);
};

/**
 * Values that can be suggested from the lines, in reading order, most likely first. They are what
 * the text says, not facts: a date is not normalized (day and month order is not guessed), and a
 * total is the amount next to a "total" label, never a sum.
 */
export const suggestDocumentFields = (lines: SourceLine[]): Map<DocumentField, AssembledCandidate[]> => {
  const ordered = [...lines].sort((a, b) => compareReadingOrder(a.region, b.region));
  const suggestions = new Map<DocumentField, AssembledCandidate[]>();
  const add = (field: DocumentField, item: AssembledCandidate) => {
    suggestions.set(field, [...(suggestions.get(field) ?? []), item]);
  };

  const totals: Array<{ rank: number; index: number; item: AssembledCandidate }> = [];

  for (const [index, line] of ordered.entries()) {
    const date = firstDate(line.text);
    if (date) {
      add(DocumentField.Date, candidate(date, line));
    }

    if (!SUBTOTAL.test(line.text)) {
      const strong = STRONG_TOTAL.exec(line.text);
      const label = strong ?? TOTAL.exec(line.text);
      if (label) {
        const after = line.text.slice(label.index + label[0].length);
        const amount = firstAmount(after);
        const found = amount ? { amount, line } : sameRowAmount(line, ordered);
        if (found) {
          totals.push({ rank: strong ? 0 : 1, index, item: candidate(found.amount, found.line) });
        }
      }
    }

    const reference = REFERENCE.exec(line.text);
    if (reference && /\d/.test(reference[1])) {
      add(DocumentField.Reference, candidate(reference[1], line));
    }

    const email = EMAIL.exec(line.text);
    if (email) {
      add(DocumentField.Email, candidate(email[0], line));
    }

    const phone = PHONE.exec(line.text);
    if (phone) {
      const digits = phone[0].replaceAll(/\D/g, '').length;
      if (digits >= 9 && digits <= 15) {
        add(DocumentField.Phone, candidate(phone[0].trim(), line));
      }
    }
  }

  // An explicit "grand total"/"amount due" first, then the last "total" on the page: on a receipt
  // the final total comes after the item lines and any earlier running totals.
  totals.sort((a, b) => a.rank - b.rank || b.index - a.index);
  for (const { item } of totals) {
    add(DocumentField.Total, item);
  }

  for (const [field, items] of suggestions) {
    suggestions.set(field, uniqueCandidates(items));
  }

  return suggestions;
};

// ---------------------------------------------------------------------------------------- assembly

const bestMatch = (region: DocumentRegion, lines: DocumentOcrLine[], taken: Set<string>) => {
  let best: { line: DocumentOcrLine; overlap: number } | undefined;
  for (const line of lines) {
    if (taken.has(line.id)) {
      continue;
    }
    const overlap = regionOverlap(region, line);
    if (overlap >= REGION_MATCH_THRESHOLD && (!best || overlap > best.overlap)) {
      best = { line, overlap };
    }
  }
  return best?.line;
};

/**
 * Pairs each line decision with the recognized line it is about. The decision made against this very
 * reading finds its line by id; after the photo was read again (new ids), by the region it stored.
 * Each line takes at most one decision and each decision at most one line.
 */
export const matchLineEdits = (lines: DocumentOcrLine[], edits: DocumentEditRow[]) => {
  const lineIds = new Set(lines.map((line) => line.id));
  const byLine = new Map<string, DocumentEditRow>();
  const unmatched: DocumentEditRow[] = [];

  for (const edit of edits) {
    const ocrId = edit.key.slice(LINE_KEY_PREFIX.length);
    if (lineIds.has(ocrId) && !byLine.has(ocrId)) {
      byLine.set(ocrId, edit);
    } else {
      unmatched.push(edit);
    }
  }

  const pairs: Array<{ edit: DocumentEditRow; line: DocumentOcrLine; overlap: number }> = [];
  for (const edit of unmatched) {
    const region = editRegion(edit);
    if (!region) {
      continue;
    }
    for (const line of lines) {
      if (byLine.has(line.id)) {
        continue;
      }
      const overlap = regionOverlap(region, line);
      if (overlap >= REGION_MATCH_THRESHOLD) {
        pairs.push({ edit, line, overlap });
      }
    }
  }

  pairs.sort((a, b) => b.overlap - a.overlap);
  const placed = new Set<string>();
  for (const { edit, line } of pairs) {
    if (placed.has(edit.id) || byLine.has(line.id)) {
      continue;
    }
    byLine.set(line.id, edit);
    placed.add(edit.id);
  }

  const orphans = unmatched.filter((edit) => !placed.has(edit.id));
  return { byLine, orphans };
};

/** A line as someone who is not the owner may read it. */
const withoutReview = (line: AssembledLine): AssembledLine => {
  const reviewed = line.status !== DocumentLineStatus.Recognized;
  const dismissed = line.status === DocumentLineStatus.Dismissed;
  return {
    ...line,
    text: dismissed ? '' : line.text,
    recognizedText: reviewed ? null : line.recognizedText,
    confidence: reviewed ? null : line.confidence,
    region: dismissed ? null : line.region,
    editId: null,
    revision: null,
    evidenceChanged: false,
  };
};

const isAwake = (edit: DocumentEditRow, isRegionVisible: (region: DocumentRegion) => boolean) => {
  const region = editRegion(edit);
  return region === null || isRegionVisible(region);
};

const LINE_STATUS: Record<DocumentEditAction, DocumentLineStatus> = {
  [DocumentEditAction.Correct]: DocumentLineStatus.Corrected,
  [DocumentEditAction.Dismiss]: DocumentLineStatus.Dismissed,
  [DocumentEditAction.Confirm]: DocumentLineStatus.Recognized,
};

const FIELD_STATUS: Record<DocumentEditAction, DocumentFieldStatus> = {
  [DocumentEditAction.Confirm]: DocumentFieldStatus.Confirmed,
  [DocumentEditAction.Correct]: DocumentFieldStatus.Corrected,
  [DocumentEditAction.Dismiss]: DocumentFieldStatus.Dismissed,
};

export const assembleDocument = ({
  lines,
  edits,
  isRegionVisible,
  isOwner,
  fieldsEnabled,
}: AssembleDocumentOptions): AssembledDocument => {
  const awake = edits.filter((edit) => isAwake(edit, isRegionVisible));
  const lineEdits = awake.filter((edit) => edit.key.startsWith(LINE_KEY_PREFIX));
  const { byLine, orphans } = matchLineEdits(lines, lineEdits);

  const assembled: AssembledLine[] = [];
  for (const line of lines) {
    const matched = byLine.get(line.id);
    // a line is never confirmed (the service refuses it); a stray row leaves the line as recognized
    const edit = matched && matched.action !== DocumentEditAction.Confirm ? matched : undefined;
    const status = edit ? LINE_STATUS[edit.action] : DocumentLineStatus.Recognized;
    assembled.push({
      id: line.id,
      ocrId: line.id,
      editId: edit?.id ?? null,
      revision: edit?.revision ?? null,
      status,
      text: status === DocumentLineStatus.Corrected && edit?.value ? edit.value : line.text,
      recognizedText: line.text,
      confidence: lineConfidence(line),
      region: regionOf(line),
      evidenceChanged: !!edit && edit.sourceText !== line.text,
    });
  }

  for (const edit of orphans) {
    const region = editRegion(edit);
    if (edit.action !== DocumentEditAction.Correct || !edit.value || !region) {
      // a dismissal with nothing left to dismiss, or a decision with nowhere to show: stays stored
      continue;
    }
    assembled.push({
      id: edit.id,
      ocrId: null,
      editId: edit.id,
      revision: edit.revision,
      status: DocumentLineStatus.Kept,
      text: edit.value,
      recognizedText: null,
      confidence: null,
      region,
      evidenceChanged: true,
    });
  }

  assembled.sort((a, b) => (a.region && b.region ? compareReadingOrder(a.region, b.region) : 0));

  if (!isOwner) {
    // Everyone else reads the text as the owner left it. A corrected line carries only the owner's
    // text, and a dismissed line only its id, so a client can stop drawing its box; neither carries
    // the recognized text or its confidence, and the owner's own kept text is not shown at all.
    return {
      lines: assembled.filter((line) => line.status !== DocumentLineStatus.Kept).map((line) => withoutReview(line)),
      fields: [],
    };
  }

  if (!fieldsEnabled) {
    return { lines: assembled, fields: [] };
  }

  const sources: SourceLine[] = assembled
    .filter((line) => line.status === DocumentLineStatus.Recognized || line.status === DocumentLineStatus.Corrected)
    .filter((line): line is AssembledLine & { ocrId: string; region: DocumentRegion } => !!line.ocrId && !!line.region)
    .map((line) => ({
      id: line.ocrId,
      text: line.text,
      region: line.region,
      confidence: line.status === DocumentLineStatus.Recognized ? line.confidence : null,
    }));
  const suggestions = suggestDocumentFields(sources);
  const decisions = new Map(
    awake
      .filter((edit) => edit.key.startsWith(FIELD_KEY_PREFIX))
      .map((edit) => [edit.key.slice(FIELD_KEY_PREFIX.length), edit] as const),
  );
  const linesById = new Map(lines.map((line) => [line.id, line]));

  const fields: AssembledField[] = [];
  for (const field of DOCUMENT_FIELD_ORDER) {
    const candidates = suggestions.get(field) ?? [];
    const decision = decisions.get(field);

    if (decision) {
      const region = editRegion(decision);
      const line = region ? bestMatch(region, lines, new Set()) : undefined;
      const status = FIELD_STATUS[decision.action];
      fields.push({
        field,
        status,
        value: status === DocumentFieldStatus.Dismissed ? null : decision.value,
        confidence:
          status === DocumentFieldStatus.Confirmed && line && line.text === decision.sourceText
            ? lineConfidence(line)
            : null,
        lineId: line?.id ?? null,
        region: line ? regionOf(line) : region,
        evidenceChanged: region !== null && (!line || line.text !== decision.sourceText),
        candidates,
        editId: decision.id,
        revision: decision.revision,
        updatedAt: decision.updatedAt,
      });
      continue;
    }

    const [best] = candidates;
    if (!best) {
      continue;
    }

    fields.push({
      field,
      status: DocumentFieldStatus.Suggested,
      value: best.value,
      confidence: best.confidence,
      lineId: best.lineId,
      region: linesById.has(best.lineId) ? best.region : null,
      evidenceChanged: false,
      candidates,
      editId: null,
      revision: null,
      updatedAt: null,
    });
  }

  return { lines: assembled, fields };
};
