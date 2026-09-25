import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  STUDIO_MAX_GRAPH_DEPTH,
  STUDIO_MAX_REFERENCES,
  StudioAccessCheck,
  StudioDestination,
  StudioEgress,
  StudioRefusalReason,
  StudioResourceKind,
  buildStudioResourceInventory,
  checkNestedSequences,
  extractStudioResourceReferences,
  getStudioResourceClass,
  isExternalLocator,
  isKnownStudioPreset,
  isStudioIdentifier,
  measureStudioGraph,
  studioPresetFamilies,
  studioReferenceKey,
  studioResourceKinds,
  studioResourceRegistry,
} from 'src/utils/studio-resources.js';

const inventoryPath = new URL('../../../studio/resource-inventory.json', import.meta.url);

const assetId = '11111111-1111-4111-8111-111111111111';
const otherAssetId = '22222222-2222-4222-8222-222222222222';

/** A graph shaped like the prototype's project model, with one of everything. */
const prototypeGraph = () => ({
  schemaVersion: 1,
  name: 'Summer in the Rockies',
  activeSequenceId: 'seq-main',
  sequences: [
    {
      id: 'seq-main',
      name: 'Main',
      captions: [{ id: 'caption-1', start: 0, end: 2, text: 'Visit https://example.com for more' }],
      captionLanguage: 'English',
      tracks: [
        {
          id: 't-title',
          kind: 'title',
          clips: [
            {
              id: 'title-main',
              kind: 'title',
              text: 'Summer',
              style: 'Minimal',
              animation: 'Fade',
              position: 'bl',
              fontFamily: 'Inter',
            },
          ],
        },
        {
          id: 't-video',
          kind: 'video',
          clips: [
            {
              id: 'clip-1',
              kind: 'video',
              assetId,
              transitionIn: { type: 'Cross dissolve', duration: 0.6 },
              grade: { look: 'alpine', intensity: 0.5, lutId: 'teal-orange' },
            },
            { id: 'clip-2', kind: 'photo', assetId: otherAssetId, kenBurns: { from: {}, to: {} } },
            { id: 'clip-3', kind: 'sequence', sequenceId: 'seq-intro' },
            { id: 'clip-4', kind: 'overlay', graphicId: 'logo-svg' },
          ],
        },
        {
          id: 't-audio',
          kind: 'audio',
          clips: [{ id: 'audio-1', kind: 'audio', assetId }],
        },
        {
          id: 't-music',
          kind: 'music',
          clips: [{ id: 'music-1', kind: 'music', musicId: 'mountain-dreams' }],
        },
        {
          id: 't-voice',
          kind: 'voice',
          clips: [
            { id: 'voice-1', kind: 'voice', uploadId: 'upload-voice-1' },
            { id: 'voice-2', kind: 'voice', generatedId: 'tts-1', modelId: 'kokoro-v1' },
          ],
        },
      ],
    },
    {
      id: 'seq-intro',
      name: 'Intro',
      tracks: [{ id: 't-intro-video', kind: 'video', clips: [{ id: 'clip-intro', kind: 'video', assetId }] }],
    },
  ],
  extensions: { $resource: { kind: 'edited-master', id: assetId } },
});

const find = (graph: unknown, kind: StudioResourceKind) =>
  extractStudioResourceReferences(graph).references.filter((reference) => reference.kind === kind);

describe('studio resource registry', () => {
  it('has one row per resource kind and every row is self-consistent', () => {
    expect(studioResourceRegistry.keys().toArray()).toEqual(studioResourceKinds);
    for (const kind of studioResourceKinds) {
      const definition = getStudioResourceClass(kind);
      expect(definition.kind).toBe(kind);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(20);
      expect(Object.keys(definition.egress).sort()).toEqual(Object.values(StudioDestination).sort());
      expect(new Set(definition.refusals).size).toBe(definition.refusals.length);
    }
  });

  it('never lets personal data leave the machine without explicit consent', () => {
    for (const definition of studioResourceRegistry.values()) {
      if (!definition.carriesPersonalData) {
        continue;
      }

      expect(definition.egress[StudioDestination.FrameleafCloud]).toBe(StudioEgress.ExplicitConsent);
      expect(definition.egress[StudioDestination.Local]).toBe(StudioEgress.Allowed);
      expect(definition.egress[StudioDestination.Lan]).toBe(StudioEgress.Allowed);
    }
  });

  it('checks library media through the library access path, not a Studio-specific one', () => {
    expect(getStudioResourceClass(StudioResourceKind.LibraryAsset).accessCheck).toBe(StudioAccessCheck.AssetRead);
    expect(getStudioResourceClass(StudioResourceKind.EditedMaster).accessCheck).toBe(
      StudioAccessCheck.AssetFileOwnerRead,
    );
    expect(getStudioResourceClass(StudioResourceKind.Model).fileBacked).toBe(false);
    expect(getStudioResourceClass(StudioResourceKind.RemotePreviewFrame).graphKeys).toEqual([]);
  });

  it('is what the checked-in inventory table was generated from', () => {
    const generated = buildStudioResourceInventory();
    const checkedIn = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    expect(checkedIn).toEqual(generated);
    expect(generated.digest).toBe(createHash('sha256').update(JSON.stringify(generated.resources)).digest('hex'));
    expect(generated.resources.map((row) => row.kind)).toEqual(studioResourceKinds);
  });

  it('knows the prototype presets and nothing else', () => {
    expect(isKnownStudioPreset('transition', 'Cross dissolve')).toBe(true);
    expect(isKnownStudioPreset('look', 'alpine')).toBe(true);
    expect(isKnownStudioPreset('look', 'vintage')).toBe(false);
    expect(isKnownStudioPreset('font', 'Inter')).toBe(false);
    expect(Object.keys(studioPresetFamilies)).toContain('exportColor');
  });
});

describe(isExternalLocator.name, () => {
  it.each([
    'https://fonts.example.com/inter.woff2',
    'http://x',
    'blob:https://app/uuid',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
    'filesystem:https://app/persistent/x',
    'javascript:alert(1)',
    '/var/lib/immich/upload/x.mp4',
    String.raw`C:\Users\x\y.mp4`,
    String.raw`\\server\share\x`,
    '../../etc/passwd',
    'foo/../bar',
    'a/..',
  ])('refuses %s', (value) => {
    expect(isExternalLocator(value)).toBe(true);
  });

  it.each(['clip-1', assetId, 'Inter', 'mountain-dreams', 'plain words', 'x.y'])('accepts %s', (value) => {
    expect(isExternalLocator(value)).toBe(false);
  });

  it('accepts identifiers only for ids', () => {
    expect(isStudioIdentifier('clip_1-a')).toBe(true);
    expect(isStudioIdentifier(assetId)).toBe(true);
    expect(isStudioIdentifier('a/b')).toBe(false);
    expect(isStudioIdentifier('')).toBe(false);
    expect(isStudioIdentifier('x'.repeat(129))).toBe(false);
    expect(isStudioIdentifier(42)).toBe(false);
  });
});

describe(extractStudioResourceReferences.name, () => {
  it('enumerates every class the prototype graph references, once each', () => {
    const { references, violations, sequences } = extractStudioResourceReferences(prototypeGraph());

    expect(violations).toEqual([]);

    const byKind = new Map<StudioResourceKind, string[]>();
    for (const reference of references) {
      byKind.set(reference.kind, [...(byKind.get(reference.kind) ?? []), reference.id]);
    }

    // The same asset on two clips and in a nested sequence is one library reference.
    expect(byKind.get(StudioResourceKind.LibraryAsset)?.sort()).toEqual([assetId, otherAssetId].sort());
    expect(byKind.get(StudioResourceKind.EditedMaster)).toEqual([assetId]);
    expect(byKind.get(StudioResourceKind.ProjectImport)).toEqual(['upload-voice-1']);
    expect(byKind.get(StudioResourceKind.Font)).toEqual(['Inter']);
    expect(byKind.get(StudioResourceKind.Lut)).toEqual(['teal-orange']);
    expect(byKind.get(StudioResourceKind.Model)).toEqual(['kokoro-v1']);
    expect(byKind.get(StudioResourceKind.VectorGraphic)).toEqual(['logo-svg']);
    expect(byKind.get(StudioResourceKind.GeneratedIntermediate)).toEqual(['tts-1']);
    expect(byKind.get(StudioResourceKind.NestedSequence)).toEqual(['seq-intro']);
    expect(byKind.get(StudioResourceKind.Captions)).toEqual(['seq-main']);

    const audio = references.filter((reference) => reference.kind === StudioResourceKind.Audio);
    expect(audio.map((reference) => [reference.source, reference.id])).toEqual([
      ['asset', assetId],
      ['catalog', 'mountain-dreams'],
      ['import', 'upload-voice-1'],
      ['generated', 'tts-1'],
    ]);

    const presets = references
      .filter((reference) => reference.kind === StudioResourceKind.Preset)
      .map((reference) => `${reference.family}:${reference.id}`)
      .sort();
    expect(presets).toEqual(
      [
        'captionLanguage:English',
        'titleStyle:Minimal',
        'titleAnimation:Fade',
        'titlePosition:bl',
        'transition:Cross dissolve',
        'look:alpine',
      ].sort(),
    );

    expect([...sequences]).toEqual([
      ['seq-main', ['seq-intro']],
      ['seq-intro', []],
    ]);
  });

  it('does not treat a URL inside caption text as a locator', () => {
    const { violations } = extractStudioResourceReferences(prototypeGraph());
    expect(violations).toEqual([]);
  });

  it('records where a reference came from and keys it stably', () => {
    const [reference] = find(prototypeGraph(), StudioResourceKind.Lut);
    expect(reference.graphPath).toBe('/sequences/0/tracks/1/clips/0/grade');
    expect(reference.lutSource).toBe('catalog');
    expect(studioReferenceKey(reference)).toBe('lut:teal-orange');
    const [preset] = find(prototypeGraph(), StudioResourceKind.Preset);
    expect(studioReferenceKey(preset)).toBe(`preset:${preset.family}:${preset.id}`);
  });

  it('refuses a font named by URL instead of by family', () => {
    const { references, violations } = extractStudioResourceReferences({
      id: 's',
      tracks: [{ clips: [{ kind: 'title', fontFamily: 'https://fonts.example.com/x.woff2' }] }],
    });
    expect(references.filter((reference) => reference.kind === StudioResourceKind.Font)).toEqual([]);
    expect(violations).toEqual([
      expect.objectContaining({
        reason: StudioRefusalReason.ExternalLocator,
        graphPath: '/tracks/0/clips/0',
        detail: expect.stringContaining('fontFamily'),
      }),
    ]);
  });

  it('refuses locators under locator keys and forbidden schemes anywhere', () => {
    const { violations } = extractStudioResourceReferences({
      clips: [
        { src: '/home/user/video.mp4' },
        { url: 'https://cdn.example.com/x.mp4' },
        { 'xlink:href': '../../secret.svg' },
        { name: 'blob:https://app/uuid' },
        { text: 'see https://example.com' },
        { path: 'relative/ok.txt' },
      ],
    });
    expect(violations.map((violation) => violation.graphPath)).toEqual([
      '/clips/0',
      '/clips/1',
      '/clips/2',
      '/clips/3',
    ]);
    expect(violations.every((violation) => violation.reason === StudioRefusalReason.ExternalLocator)).toBe(true);
  });

  it('refuses an id that is not an identifier, naming it as a locator when it is one', () => {
    const { references, violations } = extractStudioResourceReferences({
      clips: [{ assetId: 'https://cdn.example.com/x.mp4' }, { assetId: 'a b' }, { assetId: 7 }],
    });
    expect(references).toEqual([]);
    expect(violations.map((violation) => violation.reason)).toEqual([
      StudioRefusalReason.ExternalLocator,
      StudioRefusalReason.InvalidId,
      StudioRefusalReason.InvalidId,
    ]);
  });

  it('accepts explicit $resource declarations and refuses unknown or issued-only kinds', () => {
    const { references, violations } = extractStudioResourceReferences({
      a: { $resource: { kind: 'lut', id: 'warm', lutSource: 'import' } },
      b: { $resource: { kind: 'texture', id: 'x' } },
      c: { $resource: { kind: 'remote-preview-frame', id: 'x' } },
      d: { $resource: { kind: 'font', id: 'https://x/y.woff' } },
    });
    expect(references).toEqual([
      expect.objectContaining({
        kind: StudioResourceKind.Lut,
        id: 'warm',
        lutSource: 'import',
        graphPath: '/a/$resource',
      }),
    ]);
    expect(violations.map((violation) => [violation.reason, violation.graphPath])).toEqual([
      [StudioRefusalReason.UnknownKind, '/b/$resource'],
      [StudioRefusalReason.UnknownKind, '/c/$resource'],
      [StudioRefusalReason.ExternalLocator, '/d/$resource'],
    ]);
  });

  it('only treats a sequenceId as nesting on a sequence clip', () => {
    const { references } = extractStudioResourceReferences({
      id: 'main',
      tracks: [{ clips: [{ kind: 'video', sequenceId: 'not-nested', assetId }] }],
    });
    expect(references.filter((reference) => reference.kind === StudioResourceKind.NestedSequence)).toEqual([]);
  });

  it('ignores empty inline captions', () => {
    const { references } = extractStudioResourceReferences({ id: 's', tracks: [], captions: [] });
    expect(references).toEqual([]);
  });

  it('stops at the depth cap and says so once', () => {
    let graph: Record<string, unknown> = { assetId };
    for (let index = 0; index <= STUDIO_MAX_GRAPH_DEPTH; index++) {
      graph = { child: graph };
    }
    const { references, violations } = extractStudioResourceReferences(graph);
    expect(references).toEqual([]);
    expect(violations).toEqual([expect.objectContaining({ reason: StudioRefusalReason.DepthExceeded })]);
  });

  it('stops at the reference cap and says so once', () => {
    const clips = Array.from({ length: STUDIO_MAX_REFERENCES + 5 }, (_, index) => ({
      musicId: `track-${index}`,
    }));
    const { references, violations } = extractStudioResourceReferences({ clips });
    expect(references).toHaveLength(STUDIO_MAX_REFERENCES);
    expect(violations).toEqual([expect.objectContaining({ reason: StudioRefusalReason.TooManyReferences })]);
  });

  it('handles non-object graphs', () => {
    for (const graph of [null, undefined, 'text', 42, []]) {
      expect(extractStudioResourceReferences(graph)).toEqual({ references: [], violations: [], sequences: new Map() });
    }
  });

  it('measures the serialized graph', () => {
    expect(measureStudioGraph({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}', 'utf8'));
    expect(measureStudioGraph(undefined)).toBe(0);
  });
});

describe(checkNestedSequences.name, () => {
  it('accepts an acyclic tree within the depth cap', () => {
    const sequences = new Map([
      ['main', ['intro', 'outro']],
      ['intro', ['title']],
      ['outro', []],
      ['title', []],
    ]);
    expect(checkNestedSequences(sequences)).toEqual({ refused: [] });
  });

  it('refuses a target the graph does not define', () => {
    const { refused } = checkNestedSequences(new Map([['main', ['missing']]]));
    expect(refused).toEqual([expect.objectContaining({ id: 'missing', reason: StudioRefusalReason.UnknownSequence })]);
  });

  it('refuses every member of a cycle, including a self-reference', () => {
    const { refused } = checkNestedSequences(
      new Map([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']],
        ['d', ['d']],
        ['e', ['a']],
      ]),
    );
    expect(refused.map((item) => item.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(refused.every((item) => item.reason === StudioRefusalReason.CyclicSequence)).toBe(true);
  });

  it('refuses nesting deeper than the cap', () => {
    const sequences = new Map<string, string[]>();
    for (let index = 0; index < 5; index++) {
      sequences.set(`s${index}`, index < 4 ? [`s${index + 1}`] : []);
    }
    expect(checkNestedSequences(sequences, 3).refused).toEqual([
      expect.objectContaining({ id: 's4', reason: StudioRefusalReason.DepthExceeded }),
    ]);
    expect(checkNestedSequences(sequences, 4).refused).toEqual([]);
  });
});
