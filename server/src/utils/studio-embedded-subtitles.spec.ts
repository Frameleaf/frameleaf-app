import { createHash } from 'node:crypto';
import { StudioExportCreateDto } from 'src/dtos/studio-export.dto.js';
import { provesOutput, requiredOutput } from 'src/utils/render-admission.js';

const request = {
  destination: 'local',
  format: 'mp4-h264',
  color: 'preserve',
  resolution: '720p',
  quality: 'high',
  audio: 'preserve',
  subtitleMode: 'embedded',
};

describe('durable MP4 embedded caption admission', () => {
  it('admits the explicit embedded request schema without worker-authored authority', () => {
    expect(StudioExportCreateDto.schema.safeParse(request).success).toBe(true);
    expect(StudioExportCreateDto.schema.safeParse({ ...request, embeddedSubtitleSeal: {} }).success).toBe(false);
  });
  it('requires the same session to prove AVC, MP4, mov_text and the exact embedded profile', () => {
    const caps = { codecs: ['webcodecs-avc', 'mov_text'], formats: ['mp4', 'mp4-h264+mov-text-v1'] };
    expect(provesOutput(caps, requiredOutput(request)!)).toBe(true);
    for (const missing of [
      { ...caps, codecs: ['webcodecs-avc'] },
      { ...caps, codecs: ['mov_text'] },
      { ...caps, formats: ['mp4'] },
      { ...caps, formats: ['mp4', 'mp4-h264+mov-text-v2'] },
    ])
      expect(provesOutput(missing, requiredOutput(request)!)).toBe(false);
    for (const patch of [
      { format: 'webm-av1' },
      { color: 'hdr10' },
      { resolution: '1080p' },
      { audio: 'stereo' },
      { quality: 'low' },
    ])
      expect(provesOutput(caps, requiredOutput({ ...request, ...patch })!)).toBe(false);
  });
});

import {
  embeddedSubtitleSealOf,
  findEmbeddedSubtitleMismatch,
  parseEmbeddedSrt,
  sealStudioEmbeddedSubtitles,
} from 'src/utils/studio-embedded-subtitles.js';
import { parseStudioExportContract } from 'src/utils/studio-export-contract.js';
import { canonicalJson } from 'src/utils/studio-project.js';

const binding = { revisionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), engineDigest: 'c'.repeat(64) };
const captionGraph = () => ({
  metadata: { fps: 30_000 / 1001, frameRate: { num: 30_000, den: 1001 } },
  timeline: {
    tracks: [
      { id: 'v', visible: true },
      { id: 'c', visible: true },
      { id: 'hidden', visible: false },
    ],
    items: [
      { id: 'title', type: 'text', trackId: 'v', from: 0, durationInFrames: 120, text: 'ORDINARY TITLE' },
      {
        id: 'c',
        type: 'subtitle',
        trackId: 'c',
        from: 0,
        durationInFrames: 120,
        source: { type: 'subtitle-import' },
        cues: [
          {
            id: 'a',
            startSeconds: (20 * 1001) / 30_000,
            endSeconds: (50 * 1001) / 30_000,
            text: 'Café 東京\nsecond line',
          },
          { id: 'b', startSeconds: (70 * 1001) / 30_000, endSeconds: (110 * 1001) / 30_000, text: 'Tail' },
        ],
      },
      {
        id: 'hidden',
        type: 'text',
        textRole: 'caption',
        captionSource: { type: 'subtitle-import' },
        trackId: 'hidden',
        from: 0,
        durationInFrames: 120,
        text: 'HIDDEN',
      },
    ],
    transitions: [],
    keyframes: [],
  },
});
const measured = (content: string) => ({
  streams: [{ codec: 'mov_text', language: 'und', default: 1, forced: 0 }],
  content,
});

describe('immutable MP4 text-track semantics', () => {
  it('uses existing rational range projection without mutating titles, hidden captions or authored cues', () => {
    const graph = captionGraph(),
      before = structuredClone(graph);
    const seal = sealStudioEmbeddedSubtitles(graph, binding, { inPoint: 30, outPoint: 90 });
    // Integer frame arithmetic: 20 remaining frames -> 667ms, 40/60 -> 1335/2002ms.
    const expected = [
      { startMs: 0, endMs: 667, text: 'Café 東京\nsecond line' },
      { startMs: 1335, endMs: 2002, text: 'Tail' },
    ];
    expect(seal.decodedCueDigest).toBe(createHash('sha256').update(canonicalJson(expected)).digest('hex'));
    expect(seal.source).toMatchObject({ ...binding, inPoint: 30, outPoint: 90, cueCount: 2, zeroCue: false });
    expect(seal).not.toHaveProperty('cues');
    expect(graph).toEqual(before);
    expect(
      findEmbeddedSubtitleMismatch(
        seal,
        measured(
          '1\n00:00:00,000 --> 00:00:00,667\nCafé 東京\nsecond line\n\n2\n00:00:01,335 --> 00:00:02,002\nTail\n',
        ),
      ),
    ).toBeNull();
    expect(embeddedSubtitleSealOf({ subtitleMode: 'embedded', embeddedSubtitleSeal: seal })).toEqual(seal);
    expect(
      parseStudioExportContract({ video: { minBitDepth: 8, transfer: null }, audio: null, embeddedSubtitles: seal }),
    ).not.toBeNull();
  });
  it.each(['empty', 'overlap', 'markup', 'blank-line'])(
    'refuses unsupported %s cue semantics before a track promise exists',
    (kind) => {
      const graph = captionGraph();
      const caption = graph.timeline.items[1] as any;
      switch (kind) {
        case 'empty': {
          caption.cues = [];
          break;
        }
        case 'overlap': {
          caption.cues[1].startSeconds = caption.cues[0].endSeconds - 0.1;
          break;
        }
        case 'markup': {
          caption.cues[0].text = '<b>Authored styling</b>';
          break;
        }
        case 'blank-line': {
          caption.cues[0].text = 'A\n\nB';
          // No default
          break;
        }
      }
      expect(() => sealStudioEmbeddedSubtitles(graph, binding)).toThrow();
    },
  );
  it('refuses wrong mode, missing authority, mixed sibling/embedded promises and changed decoded text/time/disposition', () => {
    const seal = sealStudioEmbeddedSubtitles(captionGraph(), binding, { inPoint: 30, outPoint: 90 });
    expect(() => embeddedSubtitleSealOf({ subtitleMode: 'embedded' })).toThrow();
    expect(() => embeddedSubtitleSealOf({ subtitleMode: 'burn', embeddedSubtitleSeal: seal })).toThrow();
    expect(
      parseStudioExportContract({
        video: { minBitDepth: 8, transfer: null },
        audio: null,
        embeddedSubtitles: seal,
        subtitles: seal.source,
      }),
    ).toBeNull();
    const content =
      '1\n00:00:00,000 --> 00:00:00,667\nCafé 東京\nsecond line\n\n2\n00:00:01,335 --> 00:00:02,002\nTail';
    for (const changed of [content.replace('Tail', 'Changed'), content.replace('02,002', '02,003'), 'malformed'])
      expect(findEmbeddedSubtitleMismatch(seal, measured(changed))).not.toBeNull();
    for (const streams of [
      [],
      [...measured(content).streams, ...measured(content).streams],
      [{ codec: 'webvtt', language: 'und', default: 1, forced: 0 }],
      [{ codec: 'mov_text', language: 'eng', default: 1, forced: 0 }],
      [{ codec: 'mov_text', language: 'und', default: 0, forced: 0 }],
      [{ codec: 'mov_text', language: 'und', default: 1, forced: 1 }],
    ])
      expect(findEmbeddedSubtitleMismatch(seal, { content, streams })).not.toBeNull();
    expect(parseEmbeddedSrt(content.replaceAll('\n', '\r\n'))).toHaveLength(2);
  });
});
