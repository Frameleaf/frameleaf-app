import { type PreviewAsset, getPreviewFilter, isCoreAction, passesPreviewFilter } from 'src/utils/workflow-preview.js';

// the core plugin's own methods, unwrapped, so each case is checked against what a run would decide
vi.mock('@frameleaf/plugin-sdk', () => ({ wrapper: (methods: unknown) => methods }));
vi.mock('@frameleaf/sdk', () => ({ AssetVisibility: {} }));
const corePath = new URL('../../../packages/plugin-core/src/index.ts', import.meta.url).href;
type CoreMethod = (input: {
  config: unknown;
  data: { asset: unknown };
}) => { workflow?: { continue?: boolean } } | undefined;
let core: Record<string, CoreMethod>;
beforeAll(async () => {
  core = await import(/* @vite-ignore */ corePath);
});

const runs = (name: string, config: unknown, asset: PreviewAsset) => {
  try {
    // a run sees the asset as JSON
    const result = core[name]({ config, data: { asset: JSON.parse(JSON.stringify(asset)) } });
    return result?.workflow?.continue ?? true;
  } catch {
    return false;
  }
};

const asset = (overrides: Partial<PreviewAsset> = {}): PreviewAsset => ({
  id: '00000000-0000-4000-8000-000000000001',
  type: 'IMAGE',
  localDateTime: new Date('2024-12-30T10:00:00Z'),
  originalPath: '/library/Trips/IMG_0001.JPG',
  originalFileName: 'IMG_0001.JPG',
  tags: [{ id: 'tag-a' }],
  exifInfo: {
    make: 'Canon',
    model: null,
    city: 'Calgary',
    state: 'Alberta',
    country: 'Canada',
    latitude: 51.05,
    longitude: -114.07,
    timeZone: null,
  },
  ...overrides,
});

const cases: [string, unknown, PreviewAsset][] = [
  ['assetTypeFilter', { allowedTypes: ['VIDEO'] }, asset()],
  ['assetTypeFilter', { allowedTypes: ['IMAGE', 'VIDEO'] }, asset()],
  ['assetFileFilter', { pattern: 'img_', matchType: 'startsWith' }, asset()],
  ['assetFileFilter', { pattern: 'img_', matchType: 'startsWith', caseSensitive: true }, asset()],
  ['assetFileFilter', { pattern: 'trips', usePath: true }, asset()],
  ['assetFileFilter', { pattern: String.raw`^IMG_\d+\.JPG$`, matchType: 'regex' }, asset()],
  ['assetFileFilter', { pattern: '(', matchType: 'regex' }, asset()],
  ['assetFileFilter', { pattern: 'IMG_0001.JPG', matchType: 'exact' }, asset()],
  ['assetExifFilter', { property: 'make', pattern: 'canon' }, asset()],
  ['assetExifFilter', { property: 'model', pattern: 'x' }, asset()],
  ['assetExifFilter', { property: 'make', pattern: 'canon' }, asset({ exifInfo: null })],
  ['assetTagFilter', { tags: ['tag-a', 'tag-b'], matching: 'any' }, asset()],
  ['assetTagFilter', { tags: ['tag-a', 'tag-b'], matching: 'all' }, asset()],
  ['assetTagFilter', { tags: ['tag-a'], matching: 'none' }, asset()],
  ['assetMissingTimeZoneFilter', {}, asset()],
  ['assetMissingTimeZoneFilter', { inverse: true }, asset()],
  ['assetMissingTimeZoneFilter', {}, asset({ exifInfo: { timeZone: 'America/Edmonton' } })],
  [
    'assetDateFilter',
    { startDate: { year: 2024, month: 12, day: 1 }, endDate: { year: 2024, month: 12, day: 31 } },
    asset(),
  ],
  [
    'assetDateFilter',
    { startDate: { year: 2024, month: 1, day: 1 }, endDate: { year: 2024, month: 12, day: 29 } },
    asset(),
  ],
  [
    'assetDateFilter',
    { startDate: { year: 2000, month: 12, day: 20 }, endDate: { year: 2001, month: 1, day: 5 }, recurring: true },
    asset(),
  ],
  [
    'assetDateFilter',
    { startDate: { year: 2000, month: 12, day: 20 }, endDate: { year: 2001, month: 1, day: 5 }, recurring: true },
    asset({ localDateTime: new Date('2025-01-03T00:00:00Z') }),
  ],
  ['assetLocationFilter', { region: { country: 'Canada', city: 'Calgary' } }, asset()],
  ['assetLocationFilter', { region: { city: 'Edmonton' } }, asset()],
  ['assetLocationFilter', { coordinate: { latitude: 51.04, longitude: -114.06, radius: 5 } }, asset()],
  ['assetLocationFilter', { coordinate: { latitude: 53.54, longitude: -113.49, radius: 5 } }, asset()],
  ['assetLocationFilter', { coordinate: { latitude: 51, longitude: -114, radius: 5 } }, asset({ exifInfo: null })],
];

describe('workflow preview filters (FL-729)', () => {
  it.each(cases)('%s %j decides as the core plugin does', (name, config, value) => {
    const filter = getPreviewFilter(`immich-plugin-core#${name}`)!;
    expect(filter).toBeDefined();
    expect(passesPreviewFilter(filter, config as never, value)).toBe(runs(name, config, value));
  });

  it('leaves a regular-expression match to the run, where the plugin sandbox evaluates it', () => {
    for (const name of ['assetFileFilter', 'assetExifFilter']) {
      expect(getPreviewFilter(`immich-plugin-core#${name}`, { pattern: '(a+)+$', matchType: 'regex' })).toBeUndefined();
      expect(getPreviewFilter(`immich-plugin-core#${name}`, { pattern: 'a', matchType: 'contains' })).toBeDefined();
    }
    // a filter that has no pattern ignores a stray matchType and is still checked
    expect(
      getPreviewFilter('immich-plugin-core#assetTypeFilter', { allowedTypes: ['VIDEO'], matchType: 'regex' }),
    ).toBeDefined();
  });

  it('covers every core filter and no action', () => {
    const coreFilters = Object.keys(core).filter((name) => name.endsWith('Filter'));
    expect(coreFilters.every((name) => getPreviewFilter(`immich-plugin-core#${name}`))).toBe(true);
    for (const action of ['assetAddTags', 'assetAddToAlbums', 'assetArchive', 'webhook']) {
      expect(getPreviewFilter(`immich-plugin-core#${action}`)).toBeUndefined();
      expect(isCoreAction(`immich-plugin-core#${action}`)).toBe(true);
    }
    expect(isCoreAction('immich-plugin-core#assetFileFilter')).toBe(false);
    expect(getPreviewFilter('third-party#assetTypeFilter')).toBeUndefined();
    expect(isCoreAction('third-party#assetTypeFilter')).toBe(false);
  });
});
