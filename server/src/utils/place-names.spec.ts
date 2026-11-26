import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  type LinkedPlace,
  linkGeonames,
  localizePlaceNames,
  parsePlaceNameLine,
  placeNameLanguageOf,
  placeNameSpellings,
} from 'src/utils/place-names.js';

type Candidate = { id: number; lang: string; name: string; rank: number; exact: boolean; order: number };
interface PackBuilder {
  PACK_LANGUAGES: Map<string, string>;
  candidateOf(line: string, places: Map<number, string>): Candidate | undefined;
  isBetter(candidate: Candidate, current?: Candidate): boolean;
  placesOf(lines: AsyncIterable<string> | Iterable<string>, kind: string): Promise<Map<number, string>>;
  selectNames(
    lines: AsyncIterable<string> | Iterable<string>,
    places: Map<number, string>,
    options?: { flaggedOnly?: boolean },
  ): Promise<string[]>;
}

// The builder is a plain script (bin/build-place-names-pack.mjs); a variable path keeps it out of type-checking.
const builderPath = join(process.cwd(), 'bin', 'build-place-names-pack.mjs');
const fixtures = join(process.cwd(), 'test', 'fixtures', 'place-names');
const linesOf = (file: string) =>
  createInterface({ input: createReadStream(join(fixtures, file)), crlfDelay: Infinity });

const MUNICH = 2_867_714;
const BAVARIA = 2_951_839;
const UPPER_BAVARIA = 2_861_322;
const GERMANY = 2_921_044;
const TOKYO = 1_850_147;
const JAPAN = 1_861_060;

describe('place-name pack builder (FL-987)', () => {
  let builder: PackBuilder;
  let places: Map<number, string>;

  beforeAll(async () => {
    builder = (await import(pathToFileURL(builderPath).href)) as PackBuilder;
    places = new Map<number, string>();
    for (const [file, kind] of [
      ['cities500.txt', 'cities'],
      ['admin1CodesASCII.txt', 'admin'],
      ['admin2Codes.txt', 'admin'],
      ['countryInfo.txt', 'countries'],
    ]) {
      for (const [id, name] of await builder.placesOf(linesOf(file), kind)) {
        places.set(id, name);
      }
    }
  });

  it('reads the shipped places with their English names, skipping the city rows the server skips', () => {
    expect(places).toEqual(
      new Map([
        [MUNICH, 'Munich'],
        [TOKYO, 'Tokyo'],
        [BAVARIA, 'Bavaria'],
        [1_850_144, 'Tokyo'],
        [UPPER_BAVARIA, 'Upper Bavaria'],
        [GERMANY, 'Germany'],
        [JAPAN, 'Japan'],
      ]),
    );
  });

  it('carries the ten languages, with Norwegian under one code', () => {
    expect([...new Set(builder.PACK_LANGUAGES.values())].toSorted()).toEqual(
      ['da', 'de', 'es', 'fr', 'it', 'nb', 'nl', 'pl', 'pt', 'sv'].toSorted(),
    );
    expect(builder.PACK_LANGUAGES.get('no')).toBe('nb');
    expect(builder.PACK_LANGUAGES.has('en')).toBe(false);
  });

  it('builds the pack lines from the sample', async () => {
    await expect(builder.selectNames(linesOf('alternateNamesV2.txt'), places)).resolves.toEqual([
      `${TOKYO}\tde\tTokio`,
      `${JAPAN}\tfr\tJapon`,
      `${UPPER_BAVARIA}\tde\tOberbayern`,
      // the preferred name wins over the other spelling; a lone unmarked name is kept
      `${MUNICH}\tde\tMünchen`,
      `${MUNICH}\tes\tMúnich`,
      `${MUNICH}\tit\tMonaco di Baviera`,
      `${MUNICH}\tnb\tMünchen`,
      // preferred and short beats preferred alone ("Bundesrepublik Deutschland") and short alone
      `${GERMANY}\tde\tDeutschland`,
      `${GERMANY}\tfr\tAllemagne`,
      `${GERMANY}\tit\tGermania`,
      // a name filed under `nb` beats one filed under `no`
      `${GERMANY}\tnb\tTyskland`,
      `${BAVARIA}\tde\tBayern`,
      `${BAVARIA}\tfr\tBavière`,
    ]);
  });

  it('leaves out what a server should not show', async () => {
    const lines = await builder.selectNames(linesOf('alternateNamesV2.txt'), places);
    const named = (id: number, lang: string) => lines.some((line) => line.startsWith(`${id}\t${lang}\t`));

    // equal to the English name already stored
    expect(named(MUNICH, 'fr')).toBe(false);
    expect(named(TOKYO, 'fr')).toBe(false);
    expect(named(JAPAN, 'de')).toBe(false);
    // two unmarked spellings: choosing one would be a guess
    expect(named(MUNICH, 'pl')).toBe(false);
    // colloquial, historic, no longer in use, longer than the column
    expect(named(MUNICH, 'sv')).toBe(false);
    expect(named(MUNICH, 'da')).toBe(false);
    expect(named(MUNICH, 'nl')).toBe(false);
    expect(named(MUNICH, 'pt')).toBe(false);
    // other languages, links, and places the server does not ship (a skipped city row, an unknown id)
    expect(lines.some((line) => /\t(ja|link|en)\t/.test(line))).toBe(false);
    expect(lines.some((line) => line.startsWith('7777777\t') || line.startsWith('1111111\t'))).toBe(false);
  });

  it('keeps only marked names when asked to', async () => {
    const lines = await builder.selectNames(linesOf('alternateNamesV2.txt'), places, { flaggedOnly: true });
    expect(lines).toContain(`${MUNICH}\tde\tMünchen`);
    expect(lines).not.toContain(`${MUNICH}\tes\tMúnich`);
    expect(lines).not.toContain(`${GERMANY}\tit\tGermania`);
  });

  it('writes lines the server reads back', async () => {
    for (const line of await builder.selectNames(linesOf('alternateNamesV2.txt'), places)) {
      expect(parsePlaceNameLine(line)).toBeDefined();
    }
  });
});

describe('parsePlaceNameLine', () => {
  it('reads a pack line', () => {
    expect(parsePlaceNameLine(`${MUNICH}\tde\tMünchen`)).toEqual({ geonameId: MUNICH, lang: 'de', name: 'München' });
  });

  it.each([
    ['an unknown language', `${MUNICH}\ten\tMunich`],
    ['no name', `${MUNICH}\tde\t`],
    ['an id that is not a number', `Q1726\tde\tMünchen`],
    ['an id past the column', `99999999999\tde\tMünchen`],
    ['a fourth column', `${MUNICH}\tde\tMünchen\textra`],
    ['a name longer than the column', `${MUNICH}\tde\t${'M'.repeat(201)}`],
  ])('refuses %s', (_, line) => {
    expect(parsePlaceNameLine(line)).toBeUndefined();
  });
});

describe('placeNameLanguageOf', () => {
  it.each([
    ['de', 'de'],
    ['de-AT', 'de'],
    ['pt-PT', 'pt'],
    ['nb-NO', 'nb'],
    ['nb_NO', 'nb'],
    ['no', 'nb'],
    ['FR', 'fr'],
  ])('%s is shown in %s', (locale, lang) => {
    expect(placeNameLanguageOf(locale)).toBe(lang);
  });

  it.each(['en', 'en-GB', 'ja', '', undefined])('%s keeps English names', (locale) => {
    expect(placeNameLanguageOf(locale)).toBeUndefined();
  });
});

describe('linkGeonames', () => {
  const admin1Ids = new Map([['DE.02', BAVARIA]]);
  const munich = { id: MUNICH, name: 'Munich', admin1Name: 'Bavaria', admin1Code: '02', countryCode: 'DE' };

  it('links the city, region and country the stored names came from', () => {
    expect(linkGeonames({ city: 'Munich', state: 'Bavaria', country: 'Germany' }, munich, admin1Ids)).toEqual({
      cityGeonameId: MUNICH,
      admin1GeonameId: BAVARIA,
      countryCode: 'DE',
    });
  });

  it('does not link a nearby place to a name it did not give', () => {
    expect(linkGeonames({ city: 'Grandma’s house', state: 'Bavaria', country: 'Germany' }, munich, admin1Ids)).toEqual({
      cityGeonameId: null,
      admin1GeonameId: null,
      countryCode: 'DE',
    });
    expect(linkGeonames({ city: 'Munich', state: 'Bayern', country: 'Deutschland' }, munich, admin1Ids)).toEqual({
      cityGeonameId: MUNICH,
      admin1GeonameId: null,
      countryCode: null,
    });
  });

  it('reads the country of an item far from any city from its stored name', () => {
    expect(linkGeonames({ city: null, state: null, country: 'Greenland' }, null, admin1Ids)).toEqual({
      cityGeonameId: null,
      admin1GeonameId: null,
      countryCode: 'GL',
    });
    expect(linkGeonames({}, null, admin1Ids)).toEqual({
      cityGeonameId: null,
      admin1GeonameId: null,
      countryCode: null,
    });
  });
});

describe('localizePlaceNames', () => {
  const stored = { city: 'Munich', state: 'Bavaria', country: 'Germany' };
  const linked: LinkedPlace = {
    cityGeonameId: MUNICH,
    admin1GeonameId: BAVARIA,
    countryCode: 'DE',
    cityName: 'Munich',
    admin1Name: 'Bavaria',
  };
  const countryIds = new Map([['DE', GERMANY]]);
  const german = new Map([
    [MUNICH, 'München'],
    [BAVARIA, 'Bayern'],
    [GERMANY, 'Deutschland'],
  ]);

  it('translates every name the pack has', () => {
    expect(localizePlaceNames('de', stored, linked, german, countryIds)).toEqual({
      city: 'München',
      state: 'Bayern',
      country: 'Deutschland',
      lang: 'de',
    });
  });

  it('falls back to the stored English name where a translation is missing', () => {
    expect(localizePlaceNames('es', stored, linked, new Map([[MUNICH, 'Múnich']]), countryIds)).toEqual({
      city: 'Múnich',
      state: 'Bavaria',
      country: 'Germany',
      lang: 'es',
    });
  });

  it('is null when nothing is translated, the pack is empty, or the item is not linked', () => {
    expect(localizePlaceNames('pl', stored, linked, new Map(), countryIds)).toBeNull();
    expect(localizePlaceNames('de', stored, undefined, german, countryIds)).toBeNull();
  });

  it('never translates a stored name the link no longer fits', () => {
    expect(localizePlaceNames('de', { ...stored, city: 'Garching' }, linked, german, countryIds)).toEqual({
      city: 'Garching',
      state: 'Bayern',
      country: 'Deutschland',
      lang: 'de',
    });
    expect(localizePlaceNames('de', { city: null, state: null, country: null }, linked, german, countryIds)).toBeNull();
    expect(localizePlaceNames('de', { ...stored, country: 'Austria' }, linked, german, countryIds)).toMatchObject({
      country: 'Austria',
    });
  });
});

describe('placeNameSpellings (FL-1027)', () => {
  it('tries the plain letters a German keyboard stands in for', () => {
    expect(placeNameSpellings('Muenchen', 'de')).toEqual(['Muenchen', 'Munchen']);
    expect(placeNameSpellings('Koeln', 'de')).toEqual(['Koeln', 'Koln']);
    expect(placeNameSpellings('Gießen', 'de')).toEqual(['Gießen', 'Giessen']);
    expect(placeNameSpellings('Berlin', 'de')).toEqual(['Berlin']);
  });

  it('leaves other languages as typed', () => {
    expect(placeNameSpellings('Rafael', 'es')).toEqual(['Rafael']);
  });
});
