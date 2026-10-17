import { AssetVisibility } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, locale as translationLocale, register, waitLocale } from 'svelte-i18n';
import { get } from 'svelte/store';
import MemoryPhotoViewer from '$lib/components/frameleaf/MemoryPhotoViewer.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { locale } from '$lib/stores/preferences.store';
import { getAltText } from '$lib/utils/thumbnail-util';
import { fromTimelinePlainDateTime } from '$lib/utils/timeline-util';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';

interface Person {
  name: string;
}

const onePerson: Person[] = [{ name: 'person' }];
const twoPeople: Person[] = [{ name: 'person1' }, { name: 'person2' }];
const threePeople: Person[] = [{ name: 'person1' }, { name: 'person2' }, { name: 'person3' }];
const fourPeople: Person[] = [{ name: 'person1' }, { name: 'person2' }, { name: 'person3' }, { name: 'person4' }];

describe('getAltText', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    register('fr', () => import('$i18n/fr.json'));
    await waitLocale('en-US');
    await waitLocale('fr');
  });

  beforeEach(async () => {
    locale.set('en-US');
    await translationLocale.set('en-US');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    locale.set('default');
    await translationLocale.set('en-US');
  });

  it.each`
    isVideo  | city         | country      | people         | expected
    ${false} | ${undefined} | ${'country'} | ${undefined}   | ${'Image taken on January 1, 2024'}
    ${true}  | ${'city'}    | ${undefined} | ${undefined}   | ${'Video taken on January 1, 2024'}
    ${false} | ${'city'}    | ${'country'} | ${[]}          | ${'Image taken in city, country on January 1, 2024'}
    ${true}  | ${'city'}    | ${'country'} | ${[]}          | ${'Video taken in city, country on January 1, 2024'}
    ${false} | ${undefined} | ${undefined} | ${onePerson}   | ${'Image taken with person on January 1, 2024'}
    ${false} | ${undefined} | ${undefined} | ${twoPeople}   | ${'Image taken with person1 and person2 on January 1, 2024'}
    ${false} | ${undefined} | ${undefined} | ${threePeople} | ${'Image taken with person1, person2, and person3 on January 1, 2024'}
    ${false} | ${undefined} | ${undefined} | ${fourPeople}  | ${'Image taken with person1, person2, and 2 others on January 1, 2024'}
    ${false} | ${'city'}    | ${'country'} | ${onePerson}   | ${'Image taken in city, country with person on January 1, 2024'}
    ${false} | ${'city'}    | ${'country'} | ${twoPeople}   | ${'Image taken in city, country with person1 and person2 on January 1, 2024'}
    ${false} | ${'city'}    | ${'country'} | ${threePeople} | ${'Image taken in city, country with person1, person2, and person3 on January 1, 2024'}
    ${false} | ${'city'}    | ${'country'} | ${fourPeople}  | ${'Image taken in city, country with person1, person2, and 2 others on January 1, 2024'}
    ${true}  | ${undefined} | ${undefined} | ${onePerson}   | ${'Video taken with person on January 1, 2024'}
    ${true}  | ${undefined} | ${undefined} | ${twoPeople}   | ${'Video taken with person1 and person2 on January 1, 2024'}
    ${true}  | ${undefined} | ${undefined} | ${threePeople} | ${'Video taken with person1, person2, and person3 on January 1, 2024'}
    ${true}  | ${undefined} | ${undefined} | ${fourPeople}  | ${'Video taken with person1, person2, and 2 others on January 1, 2024'}
    ${true}  | ${'city'}    | ${'country'} | ${onePerson}   | ${'Video taken in city, country with person on January 1, 2024'}
    ${true}  | ${'city'}    | ${'country'} | ${twoPeople}   | ${'Video taken in city, country with person1 and person2 on January 1, 2024'}
    ${true}  | ${'city'}    | ${'country'} | ${threePeople} | ${'Video taken in city, country with person1, person2, and person3 on January 1, 2024'}
    ${true}  | ${'city'}    | ${'country'} | ${fourPeople}  | ${'Video taken in city, country with person1, person2, and 2 others on January 1, 2024'}
  `(
    'generates correctly formatted alt text when isVideo=$isVideo, city=$city, country=$country, people=$people.length',
    ({
      isVideo,
      city,
      country,
      people,
      expected,
    }: {
      isVideo: boolean;
      city?: string;
      country?: string;
      people?: Person[];
      expected: string;
    }) => {
      const testDate = new Date('2024-01-01T12:00:00.000Z');
      const asset: TimelineAsset = {
        id: 'test-id',
        ownerId: 'test-owner',
        ratio: 1,
        thumbhash: null,
        fileCreatedAt: {
          year: testDate.getUTCFullYear(),
          month: testDate.getUTCMonth() + 1, // Note: getMonth() is 0-based
          day: testDate.getUTCDate(),
          hour: testDate.getUTCHours(),
          minute: testDate.getUTCMinutes(),
          second: testDate.getUTCSeconds(),
          millisecond: testDate.getUTCMilliseconds(),
        },
        createdAt: {
          year: testDate.getUTCFullYear(),
          month: testDate.getUTCMonth() + 1, // Note: getMonth() is 0-based
          day: testDate.getUTCDate(),
          hour: testDate.getUTCHours(),
          minute: testDate.getUTCMinutes(),
          second: testDate.getUTCSeconds(),
          millisecond: testDate.getUTCMilliseconds(),
        },
        localDateTime: {
          year: testDate.getUTCFullYear(),
          month: testDate.getUTCMonth() + 1, // Note: getMonth() is 0-based
          day: testDate.getUTCDate(),
          hour: testDate.getUTCHours(),
          minute: testDate.getUTCMinutes(),
          second: testDate.getUTCSeconds(),
          millisecond: testDate.getUTCMilliseconds(),
        },

        visibility: AssetVisibility.Timeline,
        isFavorite: false,
        isTrashed: false,
        isVideo,
        isImage: !isVideo,
        stack: null,
        duration: null,
        projectionType: null,
        livePhotoVideoId: null,
        city: city ?? null,
        country: country ?? null,
        people: people?.map((person: Person) => person.name) ?? [],
      };

      expect(get(getAltText)(asset)).toEqual(expected);
    },
  );

  const asset = (overrides: Partial<TimelineAsset> = {}) =>
    timelineAssetFactory.build({
      localDateTime: { year: 2024, month: 1, day: 1, hour: 12, minute: 0, second: 0, millisecond: 0 },
      city: null,
      country: null,
      people: [],
      ...overrides,
    });

  const originalDate = (item: TimelineAsset) =>
    fromTimelinePlainDateTime(item.localDateTime)
      .toJSDate()
      .toLocaleString(get(locale), { dateStyle: 'long', timeZone: 'UTC' });

  it('reads formatting locale on every call, independently of the translation store', () => {
    const alt = get(getAltText);
    const item = asset();
    for (const language of ['en-US', 'fr', 'ar-EG', 'ja-JP-u-ca-japanese', 'th-TH-u-ca-buddhist', 'default', 'en-US']) {
      locale.set(language);
      expect(alt(item)).toBe(`Image taken on ${originalDate(item)}`);
    }
  });

  it.each([
    { year: 2024, month: 2, day: 30 },
    { year: 2024, month: 13, day: 1 },
    { year: 2024, month: 1, day: 1, hour: 25 },
    { year: 0, month: 1, day: 1 },
    { year: -100, month: 1, day: 1 },
    { year: 2024, month: 3, day: 10, hour: 2, minute: 30, millisecond: 123 },
  ])('preserves Luxon conversion and invalid dates for %j', (localDateTime) => {
    const item = asset({ localDateTime: { hour: 0, minute: 0, second: 0, millisecond: 0, ...localDateTime } });
    expect(get(getAltText)(item)).toBe(`Image taken on ${originalDate(item)}`);
  });

  it('preserves malformed locale errors and recovers after a valid locale is restored', () => {
    const alt = get(getAltText);
    const item = asset();
    expect(alt(item)).toBe('Image taken on January 1, 2024');
    locale.set('bad_locale');
    expect(() => originalDate(item)).toThrow(RangeError);
    expect(() => alt(item)).toThrow(RangeError);
    locale.set('fr');
    expect(alt(item)).toBe(`Image taken on ${originalDate(item)}`);
  });

  it('reuses only the last successful formatter and never formats invalid dates through Intl', () => {
    const alt = get(getAltText);
    const constructor = vi.spyOn(Intl, 'DateTimeFormat');
    const item = asset();
    alt(item);
    alt(item);
    expect(constructor.mock.calls.filter(([, options]) => options?.dateStyle === 'long')).toHaveLength(1);
    locale.set('fr');
    alt(item);
    alt(item);
    expect(constructor.mock.calls.filter(([, options]) => options?.dateStyle === 'long')).toHaveLength(2);
    expect(
      alt(asset({ localDateTime: { year: 2024, month: 2, day: 30, hour: 0, minute: 0, second: 0, millisecond: 0 } })),
    ).toBe('Image taken on Invalid Date');
    locale.set('en-US');
    alt(item);
    expect(constructor.mock.calls.filter(([, options]) => options?.dateStyle === 'long')).toHaveLength(3);
  });

  it.each([
    { city: '', country: 'Canada' },
    { city: 'Edmonton', country: '' },
    { city: null, country: null },
  ])('keeps incomplete places absent: %j', (place) => {
    expect(get(getAltText)(asset(place))).toBe('Image taken on January 1, 2024');
  });

  it('keeps all people counts and translated video values for larger groups', async () => {
    expect(
      get(getAltText)(
        asset({ people: ['A', 'B', 'C', 'D', 'E', 'F'], isVideo: true, city: 'Paris', country: 'France' }),
      ),
    ).toBe('Video taken in Paris, France with A, B, and 4 others on January 1, 2024');
    await translationLocale.set('fr');
    expect(get(getAltText)(asset({ isVideo: true }))).toBe('Video prise le January 1, 2024');
  });

  it('supplies the compiled memory image caller with the real translated accessibility label', async () => {
    const item = asset({ city: 'Edmonton', country: 'Canada', people: ['Alice'] });
    const { container } = render(MemoryPhotoViewer, { asset: item, onImageLoad: vi.fn() });
    await fireEvent.load(container.querySelector('img')!);
    expect(screen.getByRole('img')).toHaveAttribute(
      'alt',
      'Image taken in Edmonton, Canada with Alice on January 1, 2024',
    );
  });
});
