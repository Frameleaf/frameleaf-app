/**
 * The live storage template example (FL-80 O-10), used by first-run setup's folder layout choice
 * (FL-176): the prototype's `renderStorageTemplate` against its sample asset.
 */
/** The prototype's sample asset (system-data.mjs:519-540), used for the live example. */
const SAMPLE: Record<string, string> = {
  y: '2026',
  yy: '26',
  MMMM: 'September',
  MMM: 'Sep',
  MM: '09',
  M: '9',
  dd: '14',
  d: '14',
  hh: '16',
  mm: '42',
  ss: '07',
  filename: 'IMG_4021',
  filetype: 'IMG',
  filetypefull: 'IMAGE',
  assetId: '6f1c2a9e-1d4b-4a6e-9c1f-0b7e2d9a4c31',
  assetIdShort: '0b7e2d9a4c31',
  album: 'Summer in the Rockies',
  make: 'Apple',
  model: 'iPhone 16 Pro',
  lensModel: 'iPhone 16 Pro back camera',
};

const STORAGE_TEMPLATE_MAX_LENGTH = 200;

/**
 * Expands a storage template against the sample asset (the prototype's `renderStorageTemplate`) for
 * the live example. The server supports more than the sample knows (`{{#if album}}` blocks, album
 * dates, lens model…), so a token the sample cannot fill only means there is no example for it: the
 * pattern is still saved and the server validates it. `previewable` is false in that case.
 */
export const renderStorageTemplate = (pattern: string, storageLabel: string) => {
  const unknown: string[] = [];
  const source = pattern.slice(0, STORAGE_TEMPLATE_MAX_LENGTH);
  const body = source.replaceAll(/{{\s*([^{}]*?)\s*}}/g, (match, key: string) => {
    if (Object.hasOwn(SAMPLE, key)) {
      return SAMPLE[key];
    }
    unknown.push(key);
    return match;
  });
  const clean = body
    .replaceAll(/\/+/g, '/')
    .replaceAll(/^\/|\/$/g, '')
    .trim();
  return { path: `library/${storageLabel}/${clean || '…'}.jpg`, unknown, previewable: unknown.length === 0 };
};
