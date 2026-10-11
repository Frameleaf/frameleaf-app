#!/usr/bin/env node
// Packs the gathered icons (out/icons.json and out/icons/<id>.png, made by build-icons.mjs) into the one
// file a server downloads: out/landmark-icons.ndjson.gz. Each line is one icon,
// {"id","background","tile","png"}, with the 128-pixel PNG in base64. A server takes the whole file, so
// no request ever names a place a customer has been. Lines are in id order and gzip carries no
// timestamp, so the same icons give the same bytes on the same Node release.
//
// Beside it goes out/NOTICE.txt, published with the pack: whose the marks are, and for each picture taken
// from Wikimedia Commons the page that gives its author and licence.
//
//   node pack.mjs        prints the icon count, size and SHA-256 to pin in server/src/constants.ts
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const out = new URL('out/', import.meta.url);
const icons = JSON.parse(readFileSync(new URL('icons.json', out), 'utf8'));
const lines = Object.keys(icons)
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  .map((id) => {
    const { background, tile } = icons[id];
    if (!/^Q\d{1,18}$/.test(id) || !/^#[0-9a-f]{6}$/i.test(background) || typeof tile !== 'boolean') {
      throw new Error(`icons.json has a malformed entry for ${id}`);
    }
    const png = readFileSync(new URL(`icons/${id}.png`, out));
    if (png.readUInt32BE(0) !== 0x89_50_4e_47) {
      throw new Error(`${id}.png is not a PNG`);
    }
    return JSON.stringify({ id, background, tile, png: png.toString('base64') });
  });
const pack = gzipSync(lines.join('\n') + '\n', { level: 9 });
writeFileSync(new URL('landmark-icons.ndjson.gz', out), pack);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
console.log(`${lines.length} icons, ${pack.length} bytes, sha256 ${sha256(pack)}`);

const commons = JSON.parse(readFileSync(new URL('manifest.json', out), 'utf8'))
  .filter(({ id, filePage }) => icons[id] && filePage)
  .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  .map(({ id, name, filePage }) => `${id}  ${name}  ${filePage}`);
const notice = `Landmark icons for Frameleaf

Each picture in landmark-icons.ndjson.gz is the logo or icon of the place it is keyed to (a Wikidata
id). It was gathered automatically from the place's own website or from Wikimedia Commons. Frameleaf
shows it beside a customer's own photos of that place, to say which place it is. The marks belong to
their owners. No endorsement by, or affiliation with, any of them is implied.

To have a mark corrected or removed, see https://frameleaf.app/legal.

Pictures taken from Wikimedia Commons, each with the page that gives its author and licence:

${commons.join('\n')}
`;
writeFileSync(new URL('NOTICE.txt', out), notice);
console.log(
  `NOTICE.txt: ${commons.length} Commons pictures, ${Buffer.byteLength(notice)} bytes, sha256 ${sha256(notice)}`,
);
