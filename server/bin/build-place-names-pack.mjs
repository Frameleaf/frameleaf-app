#!/usr/bin/env node
// Builds place-names.tsv.gz, the pack of city, region and country names in Frameleaf's languages (FL-987).
//
//   node bin/build-place-names-pack.mjs --alternate-names alternateNamesV2.txt --cities cities500.txt \
//     --admin1 admin1CodesASCII.txt --admin2 admin2Codes.txt --countries countryInfo.txt --out <folder>
//
// The four place files are the ones pinned in base-image/geodata/geodata.lock, so the pack names exactly the
// places a server can show. alternateNamesV2.txt is GeoNames' table of names by language
// (https://download.geonames.org/export/dump/alternateNamesV2.zip). GeoNames data is © GeoNames, CC BY 4.0.
//
// One line per name: geonameId, language, name, separated by tabs and ordered by id then language. A name
// is kept when it is in one of the ten languages, in use today, and differs from the English name the server
// already stores, and GeoNames either marks it as the preferred or the short name or lists no other name for
// the place in that language. `--flagged-only yes` leaves the unmarked names out.
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

/** GeoNames language code to the code a pack line carries. Norwegian is filed under both `nb` and `no`. */
export const PACK_LANGUAGES = new Map([
  ['fr', 'fr'],
  ['es', 'es'],
  ['de', 'de'],
  ['it', 'it'],
  ['pt', 'pt'],
  ['nl', 'nl'],
  ['pl', 'pl'],
  ['sv', 'sv'],
  ['da', 'da'],
  ['nb', 'nb'],
  ['no', 'nb'],
]);

/** The longest name `geodata_place_name.name` holds. */
export const MAX_NAME_LENGTH = 200;

/**
 * One line of alternateNamesV2.txt as a name the pack could carry, or undefined when the line is for a
 * place the server does not ship, another language, a link or code rather than a name, or a name GeoNames
 * marks as colloquial, historic or no longer in use. `rank` is 0 for a name that is neither preferred nor
 * short.
 *
 * Columns: alternateNameId, geonameid, isolanguage, alternate name, isPreferredName, isShortName,
 * isColloquial, isHistoric, from, to.
 */
export const candidateOf = (line, places) => {
  const [alternateNameId, geonameId, language, name, preferred, short, colloquial, historic, , to] = line.split('\t');
  const lang = PACK_LANGUAGES.get(language);
  const id = Number(geonameId);
  if (!lang || !places.has(id)) {
    return;
  }
  if (colloquial === '1' || historic === '1' || (to ?? '').trim() !== '') {
    return;
  }
  const rank = (preferred === '1' ? 2 : 0) + (short === '1' ? 1 : 0);
  const text = (name ?? '').trim();
  if (text === '' || text.length > MAX_NAME_LENGTH) {
    return;
  }
  return { id, lang, name: text, rank, exact: language === lang, order: Number(alternateNameId) };
};

/**
 * Whether `candidate` is a better name than `current` for the same place and language: a preferred name
 * before a short one, a name filed under the language's own code before one filed under `no`, then the
 * older GeoNames entry so a rebuild picks the same name.
 */
export const isBetter = (candidate, current) =>
  !current ||
  candidate.rank > current.rank ||
  (candidate.rank === current.rank &&
    (candidate.exact === current.exact ? candidate.order < current.order : candidate.exact));

/**
 * The pack's lines for `lines` of alternateNamesV2.txt. `places` maps each shipped geonameId to the English
 * name the server stores for it; a translation equal to that name is left out, because the English already
 * says it. A name that is neither preferred nor short is kept only when it is the one name the place has
 * in that language (several spellings would mean guessing), and never with `flaggedOnly`.
 */
export const selectNames = async (lines, places, { flaggedOnly = false } = {}) => {
  const best = new Map();
  const unmarked = new Map();
  for await (const line of lines) {
    const candidate = candidateOf(line, places);
    if (!candidate) {
      continue;
    }
    const key = `${candidate.id}\t${candidate.lang}`;
    if (candidate.rank === 0) {
      const names = unmarked.get(key) ?? new Set();
      unmarked.set(key, names.add(candidate.name));
    }
    if (isBetter(candidate, best.get(key))) {
      best.set(key, candidate);
    }
  }
  return [...best.entries()]
    .filter(([key, { rank }]) => rank > 0 || (!flaggedOnly && unmarked.get(key).size === 1))
    .map(([, candidate]) => candidate)
    .filter(({ id, name }) => name !== places.get(id))
    .toSorted((a, b) => a.id - b.id || (a.lang < b.lang ? -1 : 1))
    .map(({ id, lang, name }) => `${id}\t${lang}\t${name}`);
};

/** The geonameId and English name of every place in one of the shipped files, as its lines. */
export const placesOf = async (lines, kind) => {
  const places = new Map();
  for await (const line of lines) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const columns = line.split('\t');
    // cities500: geonameid, name, … feature code [7], country code [8]. The server skips the same rows.
    if (kind === 'cities' && ((columns[7] === 'PPLX' && columns[8] !== 'AU') || columns[7] === 'PPLH')) {
      continue;
    }
    // admin1CodesASCII and admin2Codes: code, name, ascii name, geonameid. countryInfo: ISO [0], … Country [4],
    // … geonameid [16].
    const [id, name] =
      kind === 'cities'
        ? [columns[0], columns[1]]
        : kind === 'countries'
          ? [columns[16], columns[4]]
          : [columns[3], columns[1]];
    if (/^\d+$/.test(id ?? '') && Number(id) > 0) {
      places.set(Number(id), name);
    }
  }
  return places;
};

const linesOf = (file) => createInterface({ input: createReadStream(file), crlfDelay: Infinity });

const main = async () => {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
  }
  const need = (name) => {
    const value = args.get(name);
    if (!value) {
      throw new Error(`--${name} <file> is required`);
    }
    return value;
  };

  const places = new Map();
  for (const [option, kind] of [
    ['cities', 'cities'],
    ['admin1', 'admin'],
    ['admin2', 'admin'],
    ['countries', 'countries'],
  ]) {
    for (const [id, name] of await placesOf(linesOf(need(option)), kind)) {
      places.set(id, name);
    }
  }
  const lines = await selectNames(linesOf(need('alternate-names')), places, {
    flaggedOnly: args.get('flagged-only') === 'yes',
  });

  const out = need('out');
  mkdirSync(out, { recursive: true });
  const file = join(out, 'place-names.tsv.gz');
  const packed = gzipSync(lines.join('\n') + '\n', { level: 9 });
  // Byte 9 of a gzip header names the system that wrote it; fixed, so every machine builds the same file.
  packed[9] = 3;
  writeFileSync(file, packed);
  const sha256 = createHash('sha256').update(packed).digest('hex');
  writeFileSync(join(out, 'place-names.tsv.gz.sha256'), `${sha256}  place-names.tsv.gz\n`);
  console.log(JSON.stringify({ file, places: places.size, names: lines.length, bytes: statSync(file).size, sha256 }));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
