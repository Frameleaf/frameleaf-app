#!/usr/bin/env node
// Gathers one small square brand icon for every landmark that has a brand presence on Wikidata.
//   node build-icons.mjs [--force] [--retry] [--limit N] [--only Q1,Q2] [landmarks.ndjson.gz] [output-dir]
//   node build-icons.mjs --self-test
// The pictures are third-party marks collected automatically for a person to review (see README.md).
// Everything fetched is untrusted: a download is only ever decoded by sharp and re-encoded, never run,
// imported or published as it arrived.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const takeFlag = (name) => args.includes(name) && args.splice(args.indexOf(name), 1).length > 0;
const takeOption = (name) => (args.includes(name) ? args.splice(args.indexOf(name), 2)[1] : undefined);
const force = takeFlag('--force');
const retry = takeFlag('--retry');
const selfTest = takeFlag('--self-test');
const limit = Number(takeOption('--limit') ?? Infinity);
const only = takeOption('--only')?.split(',');
const [packPath = join(here, '..', 'landmarks.ndjson.gz'), outDir = join(here, 'out')] = args;
const rawDir = join(outDir, 'raw');
const iconDir = join(outDir, 'icons');

const WIKIDATA = 'https://qlever.dev/api/wikidata';
// Wikimedia refuses clients that do not say who they are, and every other site deserves the same honesty.
const USER_AGENT = 'FrameleafIconBuilder/0.1 (https://frameleaf.app; aj@ajtaylor.net)';
const SIZE = 128;
const MARGIN = 10; // about 8% on each side
// Wider than this (longer side : shorter side) is a wordmark, not an icon.
const WIDE = 1.6;
// A website icon smaller than this does not displace a Commons wordmark.
const MIN_SITE_ICON = 64;
const TIMEOUT_MS = 15_000;
const HTML_CAP = 2 * 1024 * 1024;
const IMAGE_CAP = 1024 * 1024;
const WORKERS = 8;
const HOST_GAP_MS = 200;
const SOCIAL = ['instagram.com', 'facebook.com', 'fb.com', 'fb.me', 'twitter.com', 'x.com', 'tiktok.com']
  .concat(['youtube.com', 'youtu.be', 'linkedin.com', 'pinterest.com', 'threads.net', 'threads.com', 'vk.com'])
  .concat(['weibo.com', 'weibo.cn', 'snapchat.com', 'tumblr.com', 't.me', 'ok.ru', 'reddit.com', 'flickr.com']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Pictures that are a platform's stock icon and nobody's mark, by the hash of their decoded pixels (the
// `hash` the manifest shows for every picture). A site serving one is treated as having no icon there.
const PLATFORM_DEFAULTS = new Map([
  ['b252389ea4f4bf82', 'WordPress "W", grey, 80 px'],
  ['90f4f47fd6926130', 'WordPress "W", blue, 80 px'],
]);
const DEFAULT_ICON = 'platform default icon';
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };
// The two neutral backings a mark without a background of its own can be given, and how much of a mark has
// to stand out against its backing for it to count as legible.
const WHITE = [255, 255, 255];
const NEAR_BLACK = [0x11, 0x13, 0x15];
const LEGIBLE = 0.6;
// The least contrast (1 is none, 21 is black on white) at which a colour can be made out against another.
const VISIBLE = 1.8;
// What `render` measures; cleared before a download is inspected again.
const MEASURED = ['width', 'height', 'aspect', 'mostlyLight', 'mostlyDark', 'tile', 'hash', 'error'].concat([
  'background',
  'backgroundFrom',
  'backgroundUniform',
  'lowContrast',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const qidOf = (iri) => iri.slice(iri.lastIndexOf('/') + 1).replace('>', '');
// TSV literals arrive quoted ("x"@en, "x"^^<type>) or, for some datatypes, bare. Inner quotes are not escaped.
const unquote = (literal) => (literal.startsWith('"') ? literal.slice(1, literal.lastIndexOf('"')) : literal);
const chunks = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const timedOut = (error) =>
  error.name === 'TimeoutError' || error.name === 'AbortError' || error.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
const why = (error) =>
  timedOut(error)
    ? 'timeout'
    : String(error.cause?.code ?? error.message)
        .split('\n')[0]
        .slice(0, 120);
const siteOf = (url) => new URL(url).hostname.replace(/^www\./, '');
const isSocial = (hostname) => SOCIAL.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));

// 1. Which places have a brand presence: a logo (P154), a small icon (P8972) or an Instagram account (P2003).
const sparql = async (query) => {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(WIKIDATA, {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-query',
        accept: 'text/tab-separated-values',
        'user-agent': USER_AGENT,
      },
      body: query,
    });
    if (response.ok) {
      const [, ...rows] = (await response.text()).split('\n');
      return rows.filter(Boolean).map((row) => row.split('\t'));
    }
    if (attempt === 5) {
      throw new Error(`${WIKIDATA} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    // The endpoint rate-limits with 429 and needs a long pause before it answers again.
    await sleep(response.status === 429 ? attempt * 20_000 : attempt * 5000);
  }
};

const lookUp = async (ids) => {
  const facts = {};
  for (const [index, batch] of chunks(ids, 800).entries()) {
    // A place with none of the four is recorded too, so that it is not asked about again.
    for (const id of batch) {
      facts[id] = { P154: [], P8972: [], P2003: [], P856: [] };
    }
    const rows = await sparql(
      `PREFIX wd: <http://www.wikidata.org/entity/> PREFIX wdt: <http://www.wikidata.org/prop/direct/>
       SELECT ?item ?property ?value WHERE { VALUES ?item { ${batch.map((id) => `wd:${id}`).join(' ')} }
         VALUES ?property { wdt:P154 wdt:P8972 wdt:P2003 wdt:P856 } ?item ?property ?value }`,
    );
    for (const [item, property, value] of rows) {
      facts[qidOf(item)][qidOf(property)].push(value.startsWith('<') ? value.slice(1, -1) : unquote(value));
    }
    console.error(`wikidata: ${Math.min((index + 1) * 800, ids.length)}/${ids.length}`);
    await sleep(2000);
  }
  return facts;
};

// 2. Fetching. One request at a time per host with a pause in between, whoever asks. Wikimedia gets two
// lanes across all of its hosts, because one Commons picture takes three hops.
const tails = new Map();
let wikimediaTurn = 0;
const queued = (url, task) => {
  const lane = url.hostname.endsWith('.wikimedia.org') ? `wikimedia#${wikimediaTurn++ % 2}` : url.host;
  const result = (tails.get(lane) ?? Promise.resolve()).then(task);
  const rested = () => sleep(HOST_GAP_MS);
  tails.set(lane, result.then(rested, rested));
  return result;
};

// Wikidata and web pages can be edited by anyone, so only ordinary public web addresses are followed.
const refuse = (url) => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'not a web address';
  }
  const name = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(name) || name === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(name)) {
    return 'not a public host';
  }
  return isSocial(name) ? 'social network, not fetched' : undefined;
};

const once = async (url, { accept, cap, truncate }) => {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT, accept },
  });
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location) {
    await response.body?.cancel();
    return { redirect: new URL(location, url) };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`http ${response.status}`), { status: response.status });
  }
  const parts = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > cap) {
      if (!truncate) {
        throw new Error(`larger than ${cap} bytes`);
      }
      parts.push(chunk.subarray(0, chunk.length - (size - cap)));
      break;
    }
    parts.push(chunk);
  }
  return { bytes: Buffer.concat(parts) };
};

// Follows redirects by hand so that every hop is checked and waits its turn on its own host.
const get = async (start, options) => {
  let url = new URL(start);
  for (let hop = 0; hop < 6; hop++) {
    const refusal = refuse(url);
    if (refusal) {
      throw new Error(refusal);
    }
    const current = url;
    const answer = await queued(current, async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await once(current, options);
        } catch (error) {
          // One retry for a hiccup; a site that says no, or does not answer in time, is recorded as failed.
          const hiccup = error.status === 429 || error.status >= 500 || error.name === 'TypeError';
          const tries = current.hostname.endsWith('.wikimedia.org') ? 4 : 2;
          if (!hiccup || attempt === tries || timedOut(error) || error.cause?.code === 'ENOTFOUND') {
            throw error;
          }
          await sleep(error.status === 429 ? attempt * 20_000 : 2000);
        }
      }
    });
    if (answer.bytes) {
      return { url: current.href, bytes: answer.bytes };
    }
    url = answer.redirect;
  }
  throw new Error('too many redirects');
};

// 3. Decoding. What a download is gets decided here, by decoding it, never by its name or content type.
const isIco = (bytes) => bytes.length > 22 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1;
// The largest picture inside a .ico, and of two the same size the one with more colours.
const largestIcoEntry = (bytes) => {
  let best;
  for (let index = 0; index < bytes.readUInt16LE(4) && 22 + index * 16 <= bytes.length; index++) {
    const entry = 6 + index * 16;
    const width = bytes[entry] || 256;
    const bits = bytes.readUInt16LE(entry + 6);
    if (!best || width > best.width || (width === best.width && bits > best.bits)) {
      best = { width, bits, size: bytes.readUInt32LE(entry + 8), offset: bytes.readUInt32LE(entry + 12) };
    }
  }
  return best ? bytes.subarray(best.offset, best.offset + best.size) : Buffer.alloc(0);
};

// A .ico entry that is not a PNG is a BMP without its file header: a 40-byte header, a palette when there
// are 8 bits a pixel or fewer, the picture with its bottom row first and rows padded to four bytes, then a
// one-bit mask of what is see-through. Returns the pixels top row first as RGBA.
const icoBitmap = (dib) => {
  const header = dib.length >= 40 ? dib.readUInt32LE(0) : 0;
  const width = header && dib.readInt32LE(4);
  const height = header && dib.readInt32LE(8) / 2; // the stored height counts the picture and the mask
  const bits = header && dib.readUInt16LE(14);
  const sane = (side) => Number.isInteger(side) && side > 0 && side <= 1024;
  if (header < 40 || dib.readUInt32LE(16) !== 0 || ![1, 4, 8, 24, 32].includes(bits) || !sane(width) || !sane(height)) {
    throw new Error('.ico holds a BMP of an unusual kind');
  }
  const palette = header;
  const picture = palette + (bits <= 8 ? dib.readUInt32LE(32) || 1 << bits : 0) * 4;
  const rowBytes = Math.ceil((width * bits) / 32) * 4;
  const mask = picture + rowBytes * height;
  const maskRowBytes = Math.ceil(width / 32) * 4;
  if (mask > dib.length) {
    throw new Error('.ico is cut short');
  }
  const hasMask = mask + maskRowBytes * height <= dib.length;
  const data = Buffer.alloc(width * height * 4);
  let ownAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = picture + (height - 1 - y) * rowBytes;
    const maskRow = mask + (height - 1 - y) * maskRowBytes;
    for (let x = 0; x < width; x++) {
      // Where this pixel's blue, green, red (and alpha) sit: in the row itself, or in the palette.
      const at =
        bits >= 24
          ? row + (x * bits) / 8
          : palette + ((dib[row + ((x * bits) >> 3)] >> (8 - bits - ((x * bits) & 7))) & ((1 << bits) - 1)) * 4;
      const hidden = hasMask && (dib[maskRow + (x >> 3)] >> (7 - (x & 7))) & 1;
      data.set([dib[at + 2], dib[at + 1], dib[at], hidden ? 0 : 255], (y * width + x) * 4);
      ownAlpha ||= bits === 32 && dib[at + 3] > 0;
    }
  }
  // A 32-bit picture carries its own alpha. Old writers left it empty and relied on the mask, kept above.
  for (let pixel = 0; ownAlpha && pixel < width * height; pixel++) {
    const [x, y] = [pixel % width, Math.floor(pixel / width)];
    data[pixel * 4 + 3] = dib[picture + (height - 1 - y) * rowBytes + x * 4 + 3];
  }
  return { data, width, height };
};

// The pixels of a download, top row first as RGBA. Throws when the bytes are not a picture.
const decode = async (bytes) => {
  const input = isIco(bytes) ? largestIcoEntry(bytes) : bytes;
  if (isIco(bytes) && !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return icoBitmap(input);
  }
  const limits = { limitInputPixels: 4096 * 4096, failOn: 'error' };
  const { format, width, height } = await sharp(input).metadata();
  // An SVG is drawn at 72 dpi unless told otherwise, which turns a 16-unit icon into 16 pixels and a
  // poster-sized one into far too many. Draw it about 512 px on its longer side.
  const density = Math.min(2400, Math.max(1, Math.ceil((72 * 512) / Math.max(width, height))));
  const image = sharp(input, format === 'svg' ? { ...limits, density } : limits);
  const { data, info } = await image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new Error(`unexpected ${info.channels}-channel picture`);
  }
  return { data, width: info.width, height: info.height };
};

// Brightness as WCAG measures it, how far apart two brightnesses are (1 is the same, 21 is black on white),
// and a colour as the app wants it written.
const LINEAR = Float64Array.from({ length: 256 }, (_, value) =>
  value <= 10 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4,
);
const luminance = (r, g, b) => 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const hex = (colour) => `#${colour.map((value) => value.toString(16).padStart(2, '0')).join('')}`;

// Returns the 128 px icon and what was measured on the way. Throws when the bytes are not a usable picture.
const render = async (bytes) => {
  const { data, width, height } = await decode(bytes);
  const hash = createHash('sha1').update(`${width}x${height}`).update(data).digest('hex').slice(0, 16);
  if (PLATFORM_DEFAULTS.has(hash)) {
    throw new Error(DEFAULT_ICON);
  }

  // Bounding box of what can be seen, how much of it is near-white or near-black, and whether it is one
  // flat colour.
  let [left, top, right, bottom] = [width, height, -1, -1];
  let [solid, light, dark] = [0, 0, 0];
  const low = [255, 255, 255];
  const high = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3];
      if (alpha < 16) {
        continue;
      }
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      if (alpha >= 128) {
        solid++;
        light += Math.min(data[offset], data[offset + 1], data[offset + 2]) >= 225 ? 1 : 0;
        // Brightness as the eye weighs it, so a navy counts as dark and a pure red does not.
        dark += 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2] <= 70 ? 1 : 0;
        for (let channel = 0; channel < 3; channel++) {
          low[channel] = Math.min(low[channel], data[offset + channel]);
          high[channel] = Math.max(high[channel], data[offset + channel]);
        }
      }
    }
  }
  if (solid === 0) {
    throw new Error('blank: nothing visible');
  }
  const box = { left, top, width: right - left + 1, height: bottom - top + 1 };
  if (solid === box.width * box.height && high.every((value, channel) => value - low[channel] < 12)) {
    throw new Error('blank: one flat colour');
  }

  // The rim of the shape: coming in from both ends of every row and every column, the first solid pixel,
  // taken a little further in so that a soft edge is skipped. On a square that is its border; on a tile with
  // rounded corners, or on a disc, it follows the curve. `span` is what lies between the two ends of each row.
  const solidAt = (x, y) => data[(y * width + x) * 4 + 3] >= 128;
  const ends = (from, to, isSolid) => {
    let [first, last] = [from, to];
    while (first <= to && !isSolid(first)) {
      first++;
    }
    while (last > first && !isSolid(last)) {
      last--;
    }
    return first > to ? [] : [first, last];
  };
  const inset = Math.round(Math.min(box.width, box.height) * 0.015);
  const rim = [];
  let span = 0;
  for (let y = top; y <= bottom; y++) {
    const [first, last] = ends(left, right, (x) => solidAt(x, y));
    if (first !== undefined) {
      span += last - first + 1;
      rim.push([Math.min(first + inset, last), y], [Math.max(last - inset, first), y]);
    }
  }
  for (let x = left; x <= right; x++) {
    const [first, last] = ends(top, bottom, (y) => solidAt(x, y));
    if (first !== undefined) {
      rim.push([x, Math.min(first + inset, last)], [x, Math.max(last - inset, first)]);
    }
  }
  const samples = rim.filter(([x, y]) => solidAt(x, y)).map(([x, y]) => (y * width + x) * 4);
  // The colour of the rim: its dominant colour when most of it is close to the middle value, else the
  // average of all of it. It counts as one colour when at least 70% of it is that close, which lets a mark
  // touch the edge here and there but not a photograph, a gradient or a picture split in two.
  const middle = [0, 1, 2].map(
    (channel) => Uint8Array.from(samples, (offset) => data[offset + channel]).sort()[samples.length >> 1],
  );
  const close = samples.filter((offset) =>
    middle.every((value, channel) => Math.abs(data[offset + channel] - value) <= 24),
  );
  const pool = close.length >= samples.length / 2 ? close : samples;
  const edge = [0, 1, 2].map((channel) =>
    Math.round(pool.reduce((sum, offset) => sum + data[offset + channel], 0) / pool.length),
  );
  const rimUniform = close.length >= samples.length * 0.7;

  // Two ways of looking at the solid pixels against a colour: the share that is a different colour at all,
  // and the share that is light or dark enough beside it to be made out.
  const share = (test) => {
    let count = 0;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const offset = (y * width + x) * 4;
        count += data[offset + 3] >= 128 && test(data[offset], data[offset + 1], data[offset + 2]) ? 1 : 0;
      }
    }
    return count / solid;
  };
  const differsFrom = ([r, g, b]) =>
    share((...pixel) => Math.max(...[r, g, b].map((v, i) => Math.abs(v - pixel[i]))) > 48);
  const standsOut = (backing) => share((r, g, b) => contrast(luminance(r, g, b), luminance(...backing)) >= VISIBLE);

  // A picture brings its own background when it fills its frame (a square, with rounded corners or not), or
  // when it is a filled shape with a rim of one colour and a mark inside it (a disc, a shield).
  const coverage = solid / (box.width * box.height);
  const badge = coverage >= 0.7 && solid / span >= 0.97 && rimUniform && differsFrom(edge) >= 0.03;
  const tile = coverage >= 0.9 || badge;
  // Behind a tile goes the colour of its own rim. Behind a mark on transparency goes white, unless much of
  // the mark would be lost on white and more of it shows on near-black.
  const onWhite = tile ? 1 : standsOut(WHITE);
  const paleMark = !tile && onWhite < LEGIBLE && standsOut(NEAR_BLACK) > onWhite;
  const background = tile ? edge : paleMark ? NEAR_BLACK : WHITE;
  // Hard to read: a tile with next to nothing on it, or a mark of which much is lost against its backing.
  const lowContrast = standsOut(background) < (tile ? 0.02 : LEGIBLE);

  const inner = SIZE - 2 * MARGIN;
  const png = await sharp(data, { raw: { width, height, channels: 4 } })
    .extract(box)
    .resize(inner, inner, { fit: 'contain', background: CLEAR })
    .extend({ top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, background: CLEAR })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return {
    png,
    stats: {
      width,
      height,
      // Measured on the visible part, so a wordmark floating in a square transparent canvas still counts as wide.
      aspect: Math.round((Math.max(box.width, box.height) / Math.min(box.width, box.height)) * 100) / 100,
      mostlyLight: solid > 0 && light / solid >= 0.6,
      mostlyDark: solid > 0 && dark / solid >= 0.6,
      // The picture brings its own background; `background` is then the colour of its rim, and
      // `backgroundUniform` says whether the rim really is one colour.
      tile,
      background: hex(background),
      backgroundFrom: tile ? 'edge' : 'contrast',
      ...(tile ? { backgroundUniform: rimUniform } : {}),
      lowContrast,
      // Of the decoded pixels, so the same picture is recognised whatever the size of the icon made from it.
      hash,
    },
  };
};

// --self-test: a 2 x 2 icon (red, green / blue, see-through) built by hand in each BMP depth has to decode
// to those pixels, and has to come out of the whole pipeline as a 128 px PNG.
const runSelfTest = async () => {
  const bgr = [
    [0, 0, 255],
    [0, 255, 0],
    [255, 0, 0],
    [0, 0, 0],
  ]; // red, green, blue, and the hidden pixel
  const fixture = (bits, compression = 0) => {
    const used = bits <= 8 ? Math.min(4, 1 << bits) : 0;
    const row = (a, b) => {
      const pixels =
        bits === 32
          ? [...bgr[a], a === 3 ? 0 : 255, ...bgr[b], b === 3 ? 0 : 255]
          : bits === 24
            ? [...bgr[a], ...bgr[b]]
            : bits === 8
              ? [a, b]
              : [((a % used) << (8 - bits)) | ((b % used) << (8 - 2 * bits))];
      return [...pixels, ...Array.from({ length: (4 - (pixels.length % 4)) % 4 }, () => 0)];
    };
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(2, 4);
    header.writeInt32LE(4, 8); // twice the height: picture and mask
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(bits, 14);
    header.writeUInt32LE(compression, 16);
    header.writeUInt32LE(used, 32);
    const palette = bgr.slice(0, used).flatMap((colour) => [...colour, 0]);
    // Rows are stored bottom first. The mask hides the second pixel of the bottom row.
    const dib = Buffer.concat([
      header,
      Buffer.from([...palette, ...row(2, 3), ...row(0, 1), 0x40, 0, 0, 0, 0, 0, 0, 0]),
    ]);
    const directory = Buffer.from([0, 0, 1, 0, 1, 0, 2, 2, 0, 0, 1, 0, bits, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
    directory.writeUInt32LE(dib.length, 14);
    return Buffer.concat([directory, dib]);
  };
  for (const bits of [32, 24, 8, 4, 1]) {
    const { data, width, height } = await decode(fixture(bits));
    const shown = (pixel) => bgr[bits <= 8 ? pixel % Math.min(4, 1 << bits) : pixel].toReversed();
    const expected = [0, 1, 2].flatMap((pixel) => [...shown(pixel), 255]);
    assert.deepEqual([width, height, ...data.subarray(0, 12), data[15]], [2, 2, ...expected, 0], `${bits}-bit .ico`);
  }
  const { png, stats } = await render(fixture(32));
  const { format, width, height } = await sharp(png).metadata();
  assert.deepEqual([stats.width, stats.height, format, width, height], [2, 2, 'png', SIZE, SIZE]);
  await assert.rejects(render(fixture(8, 1)), /unusual kind/);

  // Backgrounds, on 40 px pictures painted here: a blue tile with a clipped corner and a white square on it
  // takes its own blue; a ring on transparency takes the neutral backing it shows on.
  const painted = (paint) => {
    const data = Buffer.alloc(40 * 40 * 4);
    for (let pixel = 0; pixel < 40 * 40; pixel++) {
      data.set(paint(pixel % 40, Math.floor(pixel / 40)), pixel * 4);
    }
    return sharp(data, { raw: { width: 40, height: 40, channels: 4 } })
      .png()
      .toBuffer();
  };
  const within = (x, y, from, to) => x >= from && x < to && y >= from && y < to;
  const backing = async (paint) => {
    const { tile, background, backgroundFrom, backgroundUniform, lowContrast } = (await render(await painted(paint)))
      .stats;
    return [tile, background, backgroundFrom, backgroundUniform, lowContrast];
  };
  const blueTile = (x, y) =>
    x + y < 4 ? [0, 0, 0, 0] : within(x, y, 14, 26) ? [255, 255, 255, 255] : [0, 0, 200, 255];
  const ring = (colour) => (x, y) => (within(x, y, 4, 36) && !within(x, y, 10, 30) ? [...colour, 255] : [0, 0, 0, 0]);
  assert.deepEqual(await backing(blueTile), [true, '#0000c8', 'edge', true, false]);
  assert.deepEqual(await backing(ring([0, 0, 0])), [false, '#ffffff', 'contrast', undefined, false]);
  assert.deepEqual(await backing(ring([255, 255, 255])), [false, '#111315', 'contrast', undefined, false]);
  assert.deepEqual(await backing(ring([255, 235, 60])), [false, '#111315', 'contrast', undefined, false]);
};

// What a download turned out to be, worked out from its bytes: its measurements, or why it is no use.
const finished = new Map(); // raw file name -> the 128 px icon made from it
const inspect = async (candidate, bytes) => {
  for (const key of MEASURED) {
    delete candidate[key];
  }
  if (isIco(bytes) && candidate.source === 'site-icon') {
    candidate.source = 'site-favicon';
  }
  try {
    const { png, stats } = await render(bytes);
    finished.set(candidate.raw, png);
    Object.assign(candidate, stats);
  } catch (error) {
    candidate.error = why(error);
  }
  return !candidate.error;
};

// 4. Candidates from the official website: the icons its homepage declares.
const attributes = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)].map((match) => [
      match[1].toLowerCase(),
      match[2] ?? match[3] ?? match[4],
    ]),
  );
const resolve = (href, base) => {
  try {
    const url = new URL(String(href).trim().replaceAll('&amp;', '&'), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
};
// "180x180" is 180, "any" (a vector) counts as large, nothing declared sorts last.
const declaredSize = (sizes) =>
  Math.max(
    0,
    ...String(sizes ?? '')
      .split(/\s+/)
      .map((size) => (/^any$/i.test(size) ? 512 : Number.parseInt(size) || 0)),
  );
const bySize = (a, b) => b.declared - a.declared;
const looksIco = ({ url }) => (/\.ico(\?|$)/i.test(url) ? 1 : 0);

const declaredIcons = (html, pageUrl) => {
  const found = { touch: [], icons: [], manifest: undefined };
  const baseTag = /<base\b[^>]*>/i.exec(html);
  const base = (baseTag && resolve(attributes(baseTag[0]).href, pageUrl)) || pageUrl;
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const { rel = '', href, sizes } = attributes(tag);
    const url = href && resolve(href, base);
    const rels = rel.toLowerCase().split(/\s+/);
    if (!url) {
      continue;
    }
    if (rels.some((value) => value.startsWith('apple-touch-icon'))) {
      found.touch.push({ source: 'site-touch-icon', url, declared: declaredSize(sizes) });
    } else if (rels.includes('icon')) {
      found.icons.push({ source: 'site-icon', url, declared: declaredSize(sizes) });
    } else if (rels.includes('manifest')) {
      found.manifest ??= url;
    }
  }
  found.touch.sort(bySize);
  // Order is only a hint from the address; whether a file really is a .ico is decided when it is decoded.
  found.icons.sort((a, b) => looksIco(a) - looksIco(b) || bySize(a, b));
  return found;
};

const manifestIcons = async (address) => {
  const { url, bytes } = await get(address, { accept: 'application/manifest+json,application/json', cap: HTML_CAP });
  const { icons } = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  return (Array.isArray(icons) ? icons : [])
    .filter((icon) => typeof icon?.src === 'string' && String(icon.purpose ?? '') !== 'monochrome')
    .map((icon) => ({ source: 'site-manifest', url: resolve(icon.src, url), declared: declaredSize(icon.sizes) }))
    .filter((icon) => icon.url)
    .sort(bySize);
};

const commonsCandidate = (iri, source) => {
  const name = decodeURIComponent(iri.slice(iri.lastIndexOf('/') + 1)).replaceAll(' ', '_');
  return {
    source,
    // Special:FilePath answers with a server-rendered PNG, which also rasterises SVG logos.
    url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=256`,
    filePage: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name)}`,
  };
};

// Several official websites are often language versions of one site: prefer https, then the shortest.
const pickSite = (sites) =>
  [...sites].sort((a, b) => b.startsWith('https:') - a.startsWith('https:') || a.length - b.length)[0];

// Everything known about one place: each candidate found, and for the ones fetched, what they turned out to be.
const gather = async (id, fact) => {
  let downloads = 0;
  const fetchInto = async (candidate) => {
    let bytes;
    try {
      ({ bytes } = await get(candidate.url, { accept: 'image/*', cap: IMAGE_CAP }));
    } catch (error) {
      candidate.error = why(error);
      return false;
    }
    // Named after this run too, so gathering a place again never overwrites what its last record points at.
    candidate.raw = `${id}-${RUN}-${downloads++}`;
    writeFileSync(join(rawDir, candidate.raw), bytes);
    return inspect(candidate, bytes);
  };
  const firstThatWorks = async (candidates) => {
    for (const candidate of candidates.slice(0, 3)) {
      if (await fetchInto(candidate)) {
        return true;
      }
    }
    return false;
  };

  const commons = [];
  const fromCommons = async () => {
    for (const [property, source] of [
      ['P8972', 'commons-icon'],
      ['P154', 'commons-logo'],
    ]) {
      const files = fact[property].map((iri) => commonsCandidate(iri, source));
      commons.push(...files);
      for (const file of files) {
        if (await fetchInto(file)) {
          break;
        }
      }
    }
  };

  const site = pickSite(fact.P856);
  const onSite = [];
  // Returns why the website gave nothing, or nothing when it gave an icon.
  const fromSite = async () => {
    if (!site) {
      return 'no website on Wikidata';
    }
    const html = { accept: 'text/html,application/xhtml+xml', cap: HTML_CAP, truncate: true };
    let page;
    try {
      page = await get(site, html);
    } catch (error) {
      // Some hosts no longer answer on plain http at all; a browser would have tried https by itself.
      const secure = !error.status && site.startsWith('http:') && site.replace('http:', 'https:');
      page = secure ? await get(secure, html).catch(() => undefined) : undefined;
      if (!page) {
        return `homepage: ${why(error)}`;
      }
    }
    // Every declared icon is recorded; they are fetched best first, and only until one decodes.
    const declared = declaredIcons(page.bytes.toString('utf8'), page.url);
    onSite.push(...declared.touch, ...declared.icons);
    if (await firstThatWorks(declared.touch)) {
      return;
    }
    if (declared.manifest) {
      const listed = await manifestIcons(declared.manifest).catch(() => []);
      onSite.push(...listed);
      if (await firstThatWorks(listed)) {
        return;
      }
    }
    if (await firstThatWorks(declared.icons.filter((icon) => !looksIco(icon)))) {
      return;
    }
    // Nothing better than a .ico was declared. Before settling for one, look where a touch icon lives by
    // convention: many sites keep one there without declaring it.
    const probes = ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']
      .map((path) => ({ source: 'site-touch-icon', url: new URL(path, page.url).href, probed: true }))
      .filter(({ url }) => !onSite.some((candidate) => candidate.url === url && candidate.error));
    onSite.push(...probes);
    if (await firstThatWorks(probes)) {
      return;
    }
    // Last resort: the .ico files that were declared, then the one every site is assumed to have.
    const icos = declared.icons.filter((icon) => looksIco(icon));
    const favicon = { source: 'site-favicon', url: new URL('/favicon.ico', page.url).href };
    if (!onSite.some((candidate) => candidate.url === favicon.url)) {
      onSite.push(favicon);
      icos.push(favicon);
    }
    if (await firstThatWorks(icos)) {
      return;
    }
    return 'no usable icon on the website';
  };

  const [, siteNote] = await Promise.all([fromCommons(), fromSite()]);
  return { id, site, siteNote, candidates: [...commons, ...onSite] };
};

// 5. Choosing. Commons when it is roughly square; the website's icon when Commons only has a wide wordmark
// and the website has a real icon; otherwise whatever there is.
// The website's candidates in order of preference. Usually only one was fetched, but a download that did
// not decode once may decode now, and then the better kind wins, and of one kind the larger picture.
const siteOrder = ['site-touch-icon', 'site-manifest', 'site-icon', 'probed', 'site-favicon'];
const sitePreference = ({ source, probed }) => siteOrder.indexOf(probed ? 'probed' : source);
const smallerSide = ({ width, height }) => Math.min(width, height);
const choose = (candidates) => {
  const usable = candidates.filter((candidate) => candidate.hash);
  const commons = usable.find((candidate) => candidate.source.startsWith('commons-'));
  const [site] = usable
    .filter((candidate) => candidate.source.startsWith('site-'))
    .sort((a, b) => sitePreference(a) - sitePreference(b) || smallerSide(b) - smallerSide(a));
  const siteIsAnIcon = site && site.aspect <= WIDE && smallerSide(site) >= MIN_SITE_ICON && !site.sharedAcrossSites;
  return commons && (commons.aspect <= WIDE || !siteIsAnIcon) ? commons : site;
};

const escapeHtml = (text) =>
  String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const contactSheet = (entries) => {
  const done = entries.filter((entry) => entry.source !== 'none');
  const failed = entries.filter((entry) => entry.source === 'none');
  const card = (entry) => {
    const notes = [
      `${entry.kind} · rank ${entry.rank} · ${entry.source} · ${entry.width}×${entry.height}`,
      `${entry.background} ${entry.backgroundFrom}`,
      entry.probed && 'probed',
      entry.padded && 'padded',
      entry.sharedWith && `same image as ${entry.sharedWith} other`,
      entry.sharedAcrossSites && 'SHARED ACROSS SITES',
    ];
    const warnings = [entry.backgroundUniform === false && 'edge not one colour', entry.lowContrast && 'low contrast'];
    const flags = warnings.filter(Boolean).map((warning) => `<em>${warning}</em> · `);
    // As the app draws it: one circle filled with the icon's own background, the icon clipped to it.
    return `<li><span class="c" style="background:${escapeHtml(entry.background)}"><img src="icons/${entry.id}.png" width="38" height="38" alt="" loading="lazy"></span><div><b>${escapeHtml(entry.name)}</b>
<small>${escapeHtml(notes.filter(Boolean).join(' · '))} · ${flags.join('')}<a href="https://www.wikidata.org/wiki/${entry.id}">${entry.id}</a></small></div></li>`;
  };
  const row = (entry) =>
    `<tr><td>${escapeHtml(entry.name)}</td><td>${entry.kind}</td><td>${entry.rank}</td><td><a href="https://www.wikidata.org/wiki/${entry.id}">${entry.id}</a></td><td>${escapeHtml(entry.reason)}</td></tr>`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Landmark brand icons: contact sheet</title>
<style>
  body { margin: 24px; background: #ececf0; color: #1c1c1e; font: 13px/1.35 -apple-system, system-ui, sans-serif; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px 16px; }
  li { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .c { flex: none; width: 38px; height: 38px; border-radius: 50%; overflow: hidden; box-shadow: 0 0 0 1px #0003; }
  em { color: #c0262d; font-style: normal; font-weight: 600; }
  img { display: block; }
  b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  small { display: block; }
  li div { min-width: 0; }
  small, td { color: #555; }
  table { border-collapse: collapse; }
  td { padding: 2px 12px 2px 0; vertical-align: top; }
</style>
<h1>Landmark brand icons</h1>
<p>${done.length} icons, ${failed.length} places without one. Third-party marks gathered automatically for review;
each is shown as the app draws it, in a 38 px circle filled with the icon's own background colour, most famous
first. The hairline ring is only there so that a white circle shows on this page.</p>
<ul>
${done.map(card).join('\n')}
</ul>
<h2>No icon (${failed.length})</h2>
<table>
${failed.map(row).join('\n')}
</table>
</html>
`;
};

// --- main ---
if (selfTest) {
  await runSelfTest();
  console.error('self-test passed');
  process.exit(0);
}
const RUN = Date.now().toString(36);
mkdirSync(rawDir, { recursive: true });
const pack = gunzipSync(readFileSync(packPath))
  .toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .map(({ id, name, kind, rank }) => ({ id, name, kind, rank }));

// The lookup is kept between runs, and only places it has not seen are asked about, so a rebuilt pack costs
// little. Delete wikidata.json to ask about everything again.
const factsPath = join(outDir, 'wikidata.json');
const facts = existsSync(factsPath) ? JSON.parse(readFileSync(factsPath, 'utf8')) : {};
const unasked = pack.map(({ id }) => id).filter((id) => !facts[id]);
if (unasked.length > 0) {
  Object.assign(facts, await lookUp(unasked));
  writeFileSync(factsPath, JSON.stringify(facts));
}
const branded = pack
  .filter(({ id }) => facts[id] && facts[id].P154.length + facts[id].P8972.length + facts[id].P2003.length > 0)
  .sort((a, b) => b.rank - a.rank || Number(a.id.slice(1)) - Number(b.id.slice(1)));
console.error(`${branded.length} of ${pack.length} places have a logo, an icon or an Instagram account`);

// One line per finished place, appended as it finishes, so an interrupted run picks up where it stopped.
const logPath = join(outDir, 'gathered.ndjson');
const gathered = new Map();
for (const line of existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []) {
  const record = JSON.parse(line);
  gathered.set(record.id, record);
}
// What each download turned out to be is worked out again from the file on every run, so a change to the
// decoding, or a newly listed platform default, applies to everything already fetched.
for (const { candidates } of gathered.values()) {
  for (const candidate of candidates.filter(({ raw }) => raw)) {
    await inspect(candidate, readFileSync(join(rawDir, candidate.raw)));
  }
}
// --retry asks again the websites that have not given a real icon yet: nothing at all, or only a .ico.
const settled = ({ site, candidates }) =>
  !site || candidates.some(({ hash, source }) => hash && source.startsWith('site-') && source !== 'site-favicon');
const todo = branded
  .filter(({ id }) => !only || only.includes(id))
  .slice(0, limit)
  .filter(({ id }) => force || !gathered.has(id) || (retry && !settled(gathered.get(id))));
console.error(`${todo.length} places to gather`);
let next = 0;
await Promise.all(
  Array.from({ length: WORKERS }, async () => {
    while (next < todo.length) {
      const { id } = todo[next++];
      const before = gathered.get(id);
      const record = await gather(id, facts[id]).catch((error) => ({ id, siteNote: why(error), candidates: [] }));
      gathered.set(id, record);
      appendFileSync(logPath, JSON.stringify(record) + '\n');
      // The downloads of an earlier attempt go only once the new record is safely written.
      for (const { raw } of (before?.candidates ?? []).filter((candidate) => candidate.raw)) {
        rmSync(join(rawDir, raw), { force: true });
      }
      if (gathered.size % 50 === 0) {
        console.error(`gathered ${gathered.size}/${branded.length}`);
      }
    }
  }),
);

// The same picture served by different websites is not an attraction's own mark: it is a CMS or hosting
// default, or the mark of an operator that runs several sites. Those are flagged and never displace a
// Commons picture. The same picture on one website (every park on a park service's site) is only counted.
const records = branded.filter(({ id }) => gathered.has(id)).map((place) => ({ ...place, ...gathered.get(place.id) }));
const places = new Map();
const sites = new Map();
for (const { site, candidates } of records) {
  for (const { hash, source } of candidates.filter((candidate) => candidate.hash)) {
    places.set(hash, (places.get(hash) ?? 0) + 1);
    if (source.startsWith('site-')) {
      sites.set(hash, (sites.get(hash) ?? new Set()).add(siteOf(site)));
    }
  }
}

rmSync(iconDir, { recursive: true, force: true });
mkdirSync(iconDir, { recursive: true });
const entries = [];
for (const { id, name, kind, rank, site, siteNote, candidates } of records) {
  for (const candidate of candidates) {
    candidate.sharedAcrossSites = (sites.get(candidate.hash)?.size ?? 0) > 1 && candidate.source.startsWith('site-');
  }
  const chosen = choose(candidates);
  const others = candidates
    .filter((candidate) => candidate !== chosen)
    .map(({ sharedAcrossSites, ...rest }) => ({ ...rest, ...(sharedAcrossSites ? { sharedAcrossSites } : {}) }));
  // Why the website gave nothing. A platform default is named first, because it is the real reason.
  const siteGave = candidates.some((candidate) => candidate.hash && candidate.source.startsWith('site-'));
  const lead = candidates.some((candidate) => candidate.error === DEFAULT_ICON) ? DEFAULT_ICON : siteNote;
  if (!chosen) {
    const reasons = [lead, ...candidates.map((c) => c.error && `${c.source}: ${c.error}`)].filter(Boolean);
    const reason =
      candidates.length === 0 && !site ? 'Instagram only: no logo or website on Wikidata' : reasons.join('; ');
    entries.push({ id, name, kind, rank, source: 'none', site, reason: reason.slice(0, 300), candidates: others });
    continue;
  }
  writeFileSync(join(iconDir, `${id}.png`), finished.get(chosen.raw));
  entries.push({
    id,
    name,
    kind,
    rank,
    source: chosen.source,
    sourceUrl: chosen.url,
    ...(chosen.filePage ? { filePage: chosen.filePage } : {}),
    // Found at the conventional address, not declared by the page.
    ...(chosen.probed ? { probed: true } : {}),
    site,
    ...(lead && !siteGave ? { siteNote: lead } : {}),
    width: chosen.width,
    height: chosen.height,
    aspect: chosen.aspect,
    padded: chosen.aspect > WIDE,
    mostlyLight: chosen.mostlyLight,
    mostlyDark: chosen.mostlyDark,
    tile: chosen.tile,
    background: chosen.background,
    backgroundFrom: chosen.backgroundFrom,
    ...(chosen.tile ? { backgroundUniform: chosen.backgroundUniform } : {}),
    lowContrast: chosen.lowContrast,
    hash: chosen.hash,
    ...(places.get(chosen.hash) > 1 ? { sharedWith: places.get(chosen.hash) - 1 } : {}),
    ...(chosen.sharedAcrossSites ? { sharedAcrossSites: true } : {}),
    candidates: others,
  });
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(entries, null, 1) + '\n');
writeFileSync(join(outDir, 'index.html'), contactSheet(entries));
// All the app needs to draw an icon: the colour to fill its circle with, and whether the picture is a tile.
// One place to a line.
const forApp = entries
  .filter((entry) => entry.source !== 'none')
  .map(({ id, background, tile }) => `${JSON.stringify(id)}: ${JSON.stringify({ background, tile })}`);
writeFileSync(join(outDir, 'icons.json'), `{\n${forApp.join(',\n')}\n}\n`);

const tally = (values) => {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
};
const withIcon = entries.filter((entry) => entry.source !== 'none');
console.error(`${withIcon.length} icons, ${entries.length - withIcon.length} places without one`);
console.error('by source', tally(entries.map((entry) => entry.source)));
console.error('by kind', tally(withIcon.map((entry) => entry.kind)));
console.error(
  'no icon because',
  tally(entries.filter((entry) => entry.reason).map((entry) => entry.reason.split(';')[0])),
);
console.error(
  `${withIcon.filter((entry) => entry.padded).length} padded wordmarks, ` +
    `${withIcon.filter((entry) => entry.probed).length} probed, ` +
    `${withIcon.filter((entry) => entry.sharedAcrossSites).length} shared across sites`,
);
console.error(
  'background',
  tally(withIcon.map((entry) => `${entry.backgroundFrom} ${entry.tile ? '' : entry.background}`.trim())),
  `${withIcon.filter((entry) => entry.backgroundUniform === false).length} edges not one colour, ` +
    `${withIcon.filter((entry) => entry.lowContrast).length} low contrast`,
);
