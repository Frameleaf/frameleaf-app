import { describe, expect, it } from 'vitest';
import {
  StudioImportRefusal,
  scanStudioLottie,
  scanStudioSvg,
  scanStudioVector,
  sniffStudioImport,
} from 'src/utils/studio-imports.js';

const bytes = (...parts: Array<string | number[]>) => {
  const out: number[] = [];
  for (const part of parts) {
    out.push(...(typeof part === 'string' ? [...part].map((char) => char.codePointAt(0)!) : part));
  }
  while (out.length < 64) {
    out.push(0);
  }
  return new Uint8Array(out);
};
const text = (value: string) => new TextEncoder().encode(value.padEnd(64, ' '));

describe('sniffStudioImport (FL-103 / FL-105)', () => {
  it.each([
    ['WAV', bytes('RIFF', [0, 0, 0, 0], 'WAVE'), undefined, 'audio/wav', 'audio'],
    ['WebP', bytes('RIFF', [0, 0, 0, 0], 'WEBP'), undefined, 'image/webp', 'image'],
    ['Ogg', bytes('OggS'), undefined, 'audio/ogg', 'audio'],
    ['FLAC', bytes('fLaC'), undefined, 'audio/flac', 'audio'],
    ['MP3 with ID3', bytes('ID3'), undefined, 'audio/mpeg', 'audio'],
    ['MP3 frame', bytes([0xff, 0xfb, 0x90]), undefined, 'audio/mpeg', 'audio'],
    ['ADTS AAC', bytes([0xff, 0xf1, 0x50]), undefined, 'audio/aac', 'audio'],
    ['M4A', bytes([0, 0, 0, 0x20], 'ftypM4A '), undefined, 'audio/mp4', 'audio'],
    ['MP4', bytes([0, 0, 0, 0x20], 'ftypisom'), 'video/mp4', 'video/mp4', 'video'],
    ['MP4 recorded as audio', bytes([0, 0, 0, 0x20], 'ftypisom'), 'audio/mp4', 'audio/mp4', 'audio'],
    ['QuickTime', bytes([0, 0, 0, 0x14], 'ftypqt  '), undefined, 'video/quicktime', 'video'],
    ['AVIF', bytes([0, 0, 0, 0x1c], 'ftypavif'), undefined, 'image/avif', 'image'],
    ['WebM take', bytes([0x1a, 0x45, 0xdf, 0xa3], 'webm'), 'audio/webm;codecs=opus', 'audio/webm', 'audio'],
    ['WebM video', bytes([0x1a, 0x45, 0xdf, 0xa3], 'webm'), 'video/webm', 'video/webm', 'video'],
    ['Matroska', bytes([0x1a, 0x45, 0xdf, 0xa3], 'matroska'), undefined, 'video/x-matroska', 'video'],
    ['PNG', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), undefined, 'image/png', 'image'],
    ['JPEG', bytes([0xff, 0xd8, 0xff, 0xe0]), undefined, 'image/jpeg', 'image'],
    ['GIF', bytes('GIF89a'), undefined, 'image/gif', 'image'],
    [
      'SVG',
      text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">'),
      undefined,
      'image/svg+xml',
      'vector',
    ],
    ['Lottie', text('{"v":"5.7.4","layers":[]}'), undefined, 'application/json', 'vector'],
  ])('reads %s from its bytes', (_name, head, declared, contentType, kind) => {
    expect(sniffStudioImport(head, declared)).toMatchObject({ contentType, kind });
  });

  it('ignores the name and the declared type when the bytes say otherwise', () => {
    expect(sniffStudioImport(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'audio/mpeg')).toMatchObject({
      contentType: 'image/png',
    });
  });

  it.each([
    ['an executable', bytes('MZ')],
    ['a PDF', bytes('%PDF-1.7')],
    ['HTML', text('<!doctype html><html><script>alert(1)</script>')],
    ['a ZIP', bytes('PK', [3, 4])],
  ])('refuses %s', (_name, head) => {
    expect(() => sniffStudioImport(head, 'audio/wav')).toThrow(StudioImportRefusal);
  });
});

describe('scanStudioSvg', () => {
  it('counts external subresources and ignores fragments and embedded data', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <defs><linearGradient id="g"/></defs>
      <rect fill="url(#g)" width="10" height="10"/>
      <image href="data:image/png;base64,AAAA"/>
      <use xlink:href="#shape"/>
      <image href="https://tracker.example/pixel.png"/>
      <image xlink:href='other.svg'/>
      <style>@import url("https://fonts.example/a.css"); .a { background: url(bg.png) }</style>
    </svg>`;
    // pixel.png, other.svg, the @import rule, its url() and bg.png.
    expect(scanStudioSvg(svg)).toBe(5);
    expect(scanStudioSvg('<svg><path d="M0 0"/></svg>')).toBe(0);
  });

  it.each([
    ['a prefixed href', '<svg><image xl:href="http://evil/x.png"/></svg>'],
    ['a SMIL set', '<svg><set attributeName="href" to="http://evil/x.png"/></svg>'],
    ['an image-set', '<svg><rect style="mask-image:image-set(\'http://evil/x.png\' 1x)"/></svg>'],
    ['a CSS escape', String.raw`<svg><style>.a{background:\75 rl(http://evil/x.png)}</style></svg>`],
    ['a character reference', '<svg><rect fill="u&#114;l(http://evil/x.png)"/></svg>'],
    ['srcset', '<svg><image srcset="http://evil/x.png 1x"/></svg>'],
  ])('counts external subresources hidden in %s', (_name, svg) => {
    expect(scanStudioSvg(svg)).toBeGreaterThan(0);
  });

  it.each([
    '<svg><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></svg>',
    '<svg><svg:script>alert(1)</svg:script></svg>',
    '<svg><x:foreignObject><div/></x:foreignObject></svg>',
    '<svg><a href="&#106;avascript:alert(1)"><rect/></a></svg>',
    '<svg><a href="java\tscript:alert(1)"><rect/></a></svg>',
    '<?xml version="1.0" encoding="ISO-2022-JP"?><svg/>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>',
    '<svg><rect/onload="alert(1)"/></svg>',
    '<svg><script>fetch("/api")</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg><foreignObject><div>html</div></foreignObject></svg>',
  ])('refuses active content: %s', (svg) => {
    expect(() => scanStudioSvg(svg)).toThrow(StudioImportRefusal);
  });
});

describe('scanStudioLottie', () => {
  it('counts image assets and fonts fetched at render time', () => {
    const lottie = JSON.stringify({
      v: '5.7.4',
      layers: [],
      assets: [
        { id: 'comp', layers: [] },
        { id: 'embedded', e: 1, p: 'data:image/png;base64,AAAA', u: '' },
        { id: 'flagged-but-remote', e: 1, p: 'https://cdn.example/x.png', u: '' },
        { id: 'inline', p: 'data:image/png;base64,AAAA' },
        { id: 'remote', p: 'img_0.png', u: 'https://cdn.example/images/' },
        { id: 'relative', p: 'img_1.png', u: 'images/' },
      ],
      fonts: { list: [{ fName: 'A' }, { fName: 'B', fPath: 'https://fonts.example/b.css' }] },
    });
    expect(scanStudioLottie(lottie)).toBe(4);
    expect(scanStudioLottie('{"v":"5.0","layers":[]}')).toBe(0);
  });

  it('refuses JSON that is not a Lottie animation', () => {
    expect(() => scanStudioLottie('{"layers":[]}')).toThrow(StudioImportRefusal);
    expect(() => scanStudioLottie('[1,2]')).toThrow(StudioImportRefusal);
    expect(() => scanStudioLottie('{not json')).toThrow(StudioImportRefusal);
  });

  it('scans only vector imports', () => {
    expect(scanStudioVector({ contentType: 'audio/wav', kind: 'audio', extension: '.wav' }, '')).toBeUndefined();
  });
});
