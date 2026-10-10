import { describe, expect, it } from 'vitest';
import {
  STUDIO_IMPORT_CAPTIONS_MAX_BYTES,
  STUDIO_IMPORT_LUT_MAX_BYTES,
  STUDIO_IMPORT_LUT_MAX_SIZE,
  StudioImportRefusal,
  scanStudioLottie,
  scanStudioSvg,
  scanStudioVector,
  sniffStudioImport,
  studioImportKind,
  validateStudioCubeLut,
  validateStudioImportText,
  validateStudioSubRip,
  validateStudioWebVtt,
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
    ['a later SMIL value', '<svg><animate attributeName="href" values="#a;//evil/x.png"/></svg>'],
    ['a relative SMIL target', '<svg><set attributeName="href" to="x.png"/></svg>'],
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

const bom = String.fromCodePoint(0xfe_ff);
const srt =
  '1\n00:00:01,000 --> 00:00:02,500\nHello <i>there</i>\nsecond line\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n';
const vtt =
  'WEBVTT - demo\nKind: captions\n\nNOTE made by hand\n\nintro\n00:01.000 --> 00:02.500 align:start line:90%\nHello\n';
const cube = (size: number, rows = size ** 3, head = '') =>
  `# made for a test\nTITLE "Warm"\n${head}LUT_3D_SIZE ${size}\n\n${'0.5 0.25 1.0\n'.repeat(rows)}`;

describe('caption files and LUTs (FL-105)', () => {
  it.each([
    ['SubRip', srt, 'application/x-subrip', 'captions', '.srt'],
    [
      'SubRip with a byte-order mark and CRLF',
      `${bom}${srt.replaceAll('\n', '\r\n')}`,
      'application/x-subrip',
      'captions',
      '.srt',
    ],
    ['WebVTT', vtt, 'text/vtt', 'captions', '.vtt'],
    ['a .cube LUT', cube(2), 'text/x-cube-lut', 'lut', '.cube'],
    ['a .cube LUT that opens with its size', 'LUT_3D_SIZE 2\n', 'text/x-cube-lut', 'lut', '.cube'],
  ])('reads %s from its bytes, whatever it is called', (_name, body, contentType, kind, extension) => {
    const type = sniffStudioImport(text(body), 'application/octet-stream');
    expect(type).toEqual({ contentType, kind, extension });
    expect(studioImportKind(contentType)).toBe(kind);
  });

  it.each([
    ['plain text', 'Dear diary,\ntoday I edited a film.\n'],
    ['a shell script', '#!/bin/sh\nrm -rf /\n'],
    ['only comments', '# TITLE\n# LUT_3D_SIZE 2\n'],
    ['CSV', '1,2,3\n4,5,6\n'],
    ['a number and no timing', '1\nhello\n'],
    ['WEBVTT as the start of a word', 'WEBVTTX\n\n00:01.000 --> 00:02.000\nHi\n'],
    ['a cube keyword as the start of a word', 'TITLED "x"\nLUT_3D_SIZE 2\n'],
  ])('refuses %s', (_name, body) => {
    expect(() => sniffStudioImport(text(body), 'text/vtt')).toThrow(StudioImportRefusal);
  });

  it('accepts well-formed SubRip', () => {
    expect(() => validateStudioSubRip(srt)).not.toThrow();
    expect(() => validateStudioSubRip(`${bom}${srt.replaceAll('\n', '\r\n')}`)).not.toThrow();
    expect(() =>
      validateStudioSubRip('7\n00:00:01.000 --> 00:00:02.000 X1:10 X2:20 Y1:30 Y2:40\nplaced\n'),
    ).not.toThrow();
    expect(() => validateStudioSubRip('1\n100:00:01,000 --> 100:00:01,000\n')).not.toThrow();
  });

  it.each([
    ['nothing after the head', '\n\n'],
    ['a caption without a number', '00:00:01,000 --> 00:00:02,000\nHi\n'],
    ['a caption without timing', '1\nHi\n'],
    ['a time that runs backwards', '1\n00:00:05,000 --> 00:00:02,000\nHi\n'],
    ['minutes past 59', '1\n00:61:00,000 --> 00:62:00,000\nHi\n'],
    ['seconds past 59', '1\n00:00:75,000 --> 00:01:00,000\nHi\n'],
    ['a short timestamp', '1\n0:00:01,000 --> 0:00:02,000\nHi\n'],
    ['text after the timing', '1\n00:00:01,000 --> 00:00:02,000 <script>\nHi\n'],
    ['a second timing line', '1\n00:00:01,000 --> 00:00:02,000\n00:00:03,000 --> 00:00:04,000\n'],
    ['a text gap inside a caption', `${srt}\nstray words\n`],
    ['a trailing document', `${srt}\n<html><body>hello</body></html>\n`],
    ['a control character', '1\n00:00:01,000 --> 00:00:02,000\nHi\u{0}\n'],
    ['an escape sequence', '1\n00:00:01,000 --> 00:00:02,000\n\u{1B}[31mHi\n'],
  ])('refuses SubRip with %s', (_name, body) => {
    expect(() => validateStudioSubRip(body)).toThrow(StudioImportRefusal);
  });

  it('accepts well-formed WebVTT', () => {
    expect(() => validateStudioWebVtt(vtt)).not.toThrow();
    expect(() => validateStudioWebVtt(`${bom}${vtt.replaceAll('\n', '\r\n')}`)).not.toThrow();
    expect(() =>
      validateStudioWebVtt(
        'WEBVTT\n\nSTYLE\n::cue { color: yellow }\n\nREGION\nid:top\nwidth:40%\n\n01:00:01.000 --> 01:00:02.000 region:top\n<v Ana>Hi\n',
      ),
    ).not.toThrow();
  });

  it.each([
    ['no signature', '00:01.000 --> 00:02.000\nHi\n'],
    ['a signature that runs on', 'WEBVTTX\n\n00:01.000 --> 00:02.000\nHi\n'],
    ['no captions', 'WEBVTT\n\nNOTE nothing here\n'],
    ['a caption in the header', 'WEBVTT\n00:01.000 --> 00:02.000\nHi\n'],
    ['a comma in a timestamp', 'WEBVTT\n\n00:01,000 --> 00:02,000\nHi\n'],
    ['a time that runs backwards', 'WEBVTT\n\n00:05.000 --> 00:02.000\nHi\n'],
    ['seconds past 59', 'WEBVTT\n\n00:75.000 --> 01:80.000\nHi\n'],
    ['a malformed setting', 'WEBVTT\n\n00:01.000 --> 00:02.000 <b>\nHi\n'],
    ['a block that is not a caption', 'WEBVTT\n\njust some words\nand more\n'],
    ['a second timing line', 'WEBVTT\n\n00:01.000 --> 00:02.000\n00:03.000 --> 00:04.000\n'],
    [
      'a style that loads a file',
      'WEBVTT\n\nSTYLE\n::cue { background: url(https://tracker.example/p.png) }\n\n00:01.000 --> 00:02.000\nHi\n',
    ],
    ['a style import', 'WEBVTT\n\nSTYLE\n@import "https://tracker.example/a.css";\n\n00:01.000 --> 00:02.000\nHi\n'],
    ['a style escape', 'WEBVTT\n\nSTYLE\n::cue { background: \\75 rl(x) }\n\n00:01.000 --> 00:02.000\nHi\n'],
    ['a style after the first caption', 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n\nSTYLE\n::cue { color: red }\n'],
    ['a control character', 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\u{7}\n'],
  ])('refuses WebVTT with %s', (_name, body) => {
    expect(() => validateStudioWebVtt(body)).toThrow(StudioImportRefusal);
  });

  it('accepts a well-formed 3D LUT', () => {
    expect(() => validateStudioCubeLut(cube(2))).not.toThrow();
    expect(() => validateStudioCubeLut(cube(2).replaceAll('\n', '\r\n'))).not.toThrow();
    expect(() =>
      validateStudioCubeLut(cube(3, 27, 'DOMAIN_MIN 0 0 0\nDOMAIN_MAX 1.0 1.0 1.0\nLUT_3D_INPUT_RANGE 0.0 1.0\n')),
    ).not.toThrow();
    expect(() => validateStudioCubeLut('LUT_3D_SIZE 2\n' + '1e-3 -.5 +2.\n'.repeat(8))).not.toThrow();
    expect(() => validateStudioCubeLut(cube(STUDIO_IMPORT_LUT_MAX_SIZE))).not.toThrow();
  });

  it.each([
    ['no size', '# empty\nTITLE "x"\n'],
    ['a 1D LUT', 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n'],
    ['too few rows', cube(2, 7)],
    ['too many rows', cube(2, 9)],
    ['a grid of one', cube(1)],
    ['a grid past the limit', `LUT_3D_SIZE ${STUDIO_IMPORT_LUT_MAX_SIZE + 1}\n`],
    ['a size that is not a whole number', 'LUT_3D_SIZE 2.5\n' + '0 0 0\n'.repeat(8)],
    ['two sizes', 'LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(8)],
    ['rows before the size', '0 0 0\nLUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(7)],
    ['a keyword inside the table', 'LUT_3D_SIZE 2\n0 0 0\nTITLE "late"\n' + '0 0 0\n'.repeat(7)],
    ['a row of two numbers', 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(7) + '0 0\n'],
    ['a row of four numbers', 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(7) + '0 0 0 0\n'],
    ['a row that is not numbers', 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(7) + 'a b c\n'],
    ['a number that is not finite', 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(7) + '1e999 0 0\n'],
    ['a hexadecimal number', 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(7) + '0x10 0 0\n'],
    ['an unknown keyword', 'LUT_3D_SIZE 2\nINCLUDE /etc/passwd\n' + '0 0 0\n'.repeat(8)],
    ['an empty domain', cube(2, 8, 'DOMAIN_MIN 1 1 1\nDOMAIN_MAX 1 1 1\n')],
    ['a domain of two numbers', cube(2, 8, 'DOMAIN_MIN 0 0\n')],
    ['a backwards input range', cube(2, 8, 'LUT_3D_INPUT_RANGE 1 0\n')],
    ['a line past the limit', `LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(7)}0 0 ${'0'.repeat(300)}\n`],
    ['a control character', `${cube(2)}\u{0}`],
  ])('refuses a LUT with %s', (_name, body) => {
    expect(() => validateStudioCubeLut(body)).toThrow(StudioImportRefusal);
  });

  it('checks each text kind with its own rules and leaves other kinds alone', () => {
    const type = (contentType: string) => ({ contentType, kind: studioImportKind(contentType), extension: '' });
    expect(() => validateStudioImportText(type('application/x-subrip'), vtt)).toThrow(StudioImportRefusal);
    expect(() => validateStudioImportText(type('text/vtt'), srt)).toThrow(StudioImportRefusal);
    expect(() => validateStudioImportText(type('text/x-cube-lut'), srt)).toThrow(StudioImportRefusal);
    expect(() => validateStudioImportText(type('text/vtt'), vtt)).not.toThrow();
    expect(() => validateStudioImportText(type('audio/wav'), 'anything')).not.toThrow();
    expect(STUDIO_IMPORT_CAPTIONS_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(STUDIO_IMPORT_LUT_MAX_BYTES).toBe(16 * 1024 * 1024);
  });
});

// File LUT domains are input coordinates; they never normalize table outputs.
describe('Cube file input-domain admission', () => {
  const body = (headers: string) => `LUT_3D_SIZE 2\n${headers}\n${'-1 2 .5\n'.repeat(8)}`;
  it('retains common input range and independent per-axis domains', () => {
    expect(validateStudioCubeLut(body('LUT_3D_INPUT_RANGE -2 2'))).toEqual({
      size: 2,
      domainMin: [-2, -2, -2],
      domainMax: [2, 2, 2],
    });
    expect(validateStudioCubeLut(body('DOMAIN_MIN -2 -1 0\nDOMAIN_MAX 2 3 4'))).toEqual({
      size: 2,
      domainMin: [-2, -1, 0],
      domainMax: [2, 3, 4],
    });
    expect(validateStudioCubeLut(body('LUT_3D_INPUT_RANGE -2 2\nDOMAIN_MIN -2 -2 -2'))).toEqual({
      size: 2,
      domainMin: [-2, -2, -2],
      domainMax: [2, 2, 2],
    });
  });
  it.each([
    'LUT_3D_INPUT_RANGE 0 1\nLUT_3D_INPUT_RANGE 0 1',
    'LUT_3D_INPUT_RANGE 0 2\nDOMAIN_MAX 1 2 2',
    'DOMAIN_MIN 0 -1 0\nLUT_3D_INPUT_RANGE 0 1',
    'DOMAIN_MIN 1 1 1\nDOMAIN_MAX 1.000000001 2 2',
    'LUT_3D_INPUT_RANGE 0 1e-40',
  ])('refuses ambiguous or unrepresentable input domains %s', (headers) => {
    expect(() => validateStudioCubeLut(body(headers))).toThrow(StudioImportRefusal);
  });
});
