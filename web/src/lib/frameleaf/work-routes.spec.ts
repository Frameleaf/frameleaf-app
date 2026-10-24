import {
  CloudRouteMode,
  MlDestinationKind,
  MlWorkload,
  type MlDestinationResponseDto,
  type MlWorkloadRouteDto,
} from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  ASK,
  choicesFor,
  CLOUD,
  currentChoice,
  FOLLOW,
  followerChoice,
  followerChoices,
  hasWrites,
  homePlaces,
  NONE,
  routeWrites,
  SAME,
  type RouteFacts,
} from '$lib/frameleaf/work-routes';

const destination = (overrides: Partial<MlDestinationResponseDto>): MlDestinationResponseDto =>
  ({
    id: 'srv',
    name: 'This server',
    kind: MlDestinationKind.Local,
    enabled: true,
    workloads: [],
    ...overrides,
  }) as MlDestinationResponseDto;

const LIBRARY = [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment, MlWorkload.PetRecognition];
const server = destination({ workloads: LIBRARY });
const office = destination({
  id: 'office',
  name: 'Office PC',
  kind: MlDestinationKind.Lan,
  workloads: [
    MlWorkload.Enrichment,
    MlWorkload.Face,
    MlWorkload.PetRecognition,
    MlWorkload.Upscale,
    MlWorkload.RestorationFaithful,
    MlWorkload.RestorationCreative,
  ],
});
const cloud = destination({ id: 'fc', name: 'Frameleaf Cloud', kind: MlDestinationKind.FrameleafCloud });

const routes = (values: Partial<Record<MlWorkload, string | null>>): MlWorkloadRouteDto[] =>
  Object.entries(values).map(([workload, destinationId]) => ({ workload, destinationId })) as MlWorkloadRouteDto[];

const facts = (overrides: Partial<RouteFacts> = {}): RouteFacts => ({
  destinations: [server],
  routes: routes({
    [MlWorkload.Face]: 'srv',
    [MlWorkload.Clip]: 'srv',
    [MlWorkload.Ocr]: 'srv',
    [MlWorkload.Enrichment]: 'srv',
    [MlWorkload.PetRecognition]: 'srv',
  }),
  cloudRouting: {},
  cloudOn: false,
  ...overrides,
});

describe('reading one choice from the two records', () => {
  it('a row runs on the computer the home record names, or nowhere', () => {
    expect(currentChoice('faces', facts())).toBe('srv');
    expect(currentChoice('upscale', facts())).toBe(NONE);
  });

  it('"Both" in the cloud record is Ask me each time, "Cloud only" is Frameleaf Cloud', () => {
    const shared = facts({
      cloudOn: true,
      cloudRouting: { descriptions: CloudRouteMode.Both, upscale: CloudRouteMode.Cloud },
    });
    expect(currentChoice('descriptions', shared)).toBe(ASK);
    expect(currentChoice('upscale', shared)).toBe(CLOUD);
  });

  it('does not show a cloud choice the server would refuse: cloud processing off means the home record stands', () => {
    const off = facts({ cloudOn: false, cloudRouting: { descriptions: CloudRouteMode.Cloud } });
    expect(currentChoice('descriptions', off)).toBe('srv');
  });

  it('never reads Frameleaf Cloud out of the home record', () => {
    const odd = facts({
      destinations: [server, cloud],
      routes: routes({ [MlWorkload.Upscale]: 'fc' }),
      cloudOn: true,
      cloudRouting: { upscale: CloudRouteMode.Local },
    });
    // The two records disagree; the row says nowhere rather than a place work would be refused.
    expect(currentChoice('upscale', odd)).toBe(NONE);
  });
});

describe('what a row offers', () => {
  it('lists real places only, this server first, and skips a computer that is switched off', () => {
    const two = facts({
      destinations: [office, server, destination({ id: 'den', enabled: false, workloads: LIBRARY })],
    });
    expect(homePlaces(MlWorkload.Enrichment, two).map(({ id }) => id)).toEqual(['srv', 'office']);
    expect(choicesFor('descriptions', two)).toEqual(['srv', 'office', NONE]);
  });

  it('has nothing to choose when no place can do the work, or the only place already does', () => {
    expect(choicesFor('upscale', facts())).toEqual([]);
    expect(choicesFor('faces', facts())).toEqual([]);
  });

  it('lets a row that is off be turned on when one place can do it', () => {
    expect(choicesFor('faces', facts({ routes: [] }))).toEqual(['srv', NONE]);
  });

  it('offers Frameleaf Cloud only for work that may leave home, and asking only with a place at home', () => {
    const linked = facts({ destinations: [server, office], cloudOn: true });
    expect(choicesFor('descriptions', linked)).toEqual(['srv', 'office', ASK, CLOUD, NONE]);
    expect(choicesFor('faces', linked)).toEqual(['srv', 'office', NONE]);
    expect(choicesFor('interpolation', linked)).toEqual([CLOUD, NONE]);
  });
});

describe('search and faces run in one place (FL-455)', () => {
  const indexCloud = destination({
    id: 'fc',
    name: 'Frameleaf Cloud',
    kind: MlDestinationKind.FrameleafCloud,
    workloads: [MlWorkload.Clip, MlWorkload.Face],
    consent: { required: true, acknowledgedAt: '2026-10-01T00:00:00Z', version: '1', requiredVersion: '1' },
  } as Partial<MlDestinationResponseDto>);
  const offered = (overrides: Partial<RouteFacts> = {}) =>
    facts({ destinations: [server, office, indexCloud], cloudOn: true, ...overrides });

  it('offers Frameleaf Cloud as a place of its own, never Ask me each time', () => {
    expect(choicesFor('search', offered())).toEqual(['srv', CLOUD, NONE]);
    expect(choicesFor('faces', offered())).toEqual(['srv', 'office', CLOUD, NONE]);
    for (const kind of ['search', 'faces'] as const) {
      expect(choicesFor(kind, offered())).not.toContain(ASK);
    }
  });

  it('does not offer Frameleaf Cloud before its consent is recorded', () => {
    const unconsented = { ...indexCloud, consent: { ...indexCloud.consent, acknowledgedAt: null } };
    expect(choicesFor('search', offered({ destinations: [server, unconsented] }))).toEqual([]);
  });

  it('reads Frameleaf Cloud from the destination route, as Workload destinations shows it', () => {
    const onCloud = offered({ routes: routes({ [MlWorkload.Clip]: 'fc', [MlWorkload.Face]: 'srv' }) });
    expect(currentChoice('search', onCloud)).toBe(CLOUD);
    expect(currentChoice('faces', onCloud)).toBe('srv');
  });

  it('saves Frameleaf Cloud as the destination route and never writes a cloud routing mode', () => {
    expect(routeWrites({ search: CLOUD }, {}, offered())).toEqual({
      routes: [{ workload: MlWorkload.Clip, destinationId: 'fc' }],
      cloud: {},
      follow: [],
    });
    expect(routeWrites({ search: ASK }, {}, offered()).cloud).toEqual({});
  });

  it('moves back home, or off, by replacing the cloud route', () => {
    const onCloud = offered({ routes: routes({ [MlWorkload.Clip]: 'fc' }) });
    expect(routeWrites({ search: 'srv' }, {}, onCloud).routes).toEqual([
      { workload: MlWorkload.Clip, destinationId: 'srv' },
    ]);
    expect(routeWrites({ search: NONE }, {}, onCloud).routes).toEqual([
      { workload: MlWorkload.Clip, destinationId: null },
    ]);
  });
});

describe('finer choices', () => {
  it('a follower is "same" while it runs where its row does', () => {
    expect(followerChoice('pets', facts())).toBe(SAME);
    const split = facts({
      destinations: [server, office],
      routes: routes({ [MlWorkload.Face]: 'srv', [MlWorkload.PetRecognition]: 'office' }),
    });
    expect(followerChoice('pets', split)).toBe('office');
    expect(followerChoices('pets', split)).toEqual([SAME, 'srv', 'office', NONE]);
  });
});

describe('saving a choice writes both records', () => {
  const linked = facts({ destinations: [server, office], cloudOn: true });

  it('writes nothing when nothing changed', () => {
    expect(hasWrites(routeWrites({}, {}, linked))).toBe(false);
    expect(hasWrites(routeWrites({ faces: 'srv' }, {}, linked))).toBe(false);
  });

  it('moves a row to a computer at home, and its follower with it', () => {
    expect(routeWrites({ faces: 'office' }, {}, linked)).toEqual({
      routes: [
        { workload: MlWorkload.Face, destinationId: 'office' },
        { workload: MlWorkload.PetRecognition, destinationId: 'office' },
      ],
      cloud: {},
      follow: [],
    });
  });

  it('leaves a follower that has its own place where it is', () => {
    const split = facts({
      destinations: [server, office],
      routes: routes({ [MlWorkload.Face]: 'srv', [MlWorkload.PetRecognition]: 'office' }),
    });
    expect(routeWrites({ faces: NONE }, {}, split).routes).toEqual([
      { workload: MlWorkload.Face, destinationId: null },
    ]);
  });

  it('does not send a follower to a computer that is not allowed to run it', () => {
    const noPets = facts({
      destinations: [server, destination({ id: 'office', kind: MlDestinationKind.Lan, workloads: [MlWorkload.Face] })],
    });
    expect(routeWrites({ faces: 'office' }, {}, noPets).routes).toEqual([
      { workload: MlWorkload.Face, destinationId: 'office' },
    ]);
  });

  it('Ask and Frameleaf Cloud change the cloud record and keep the place at home', () => {
    expect(routeWrites({ descriptions: ASK, upscale: CLOUD }, {}, linked)).toEqual({
      routes: [],
      cloud: { descriptions: CloudRouteMode.Both, upscale: CloudRouteMode.Cloud },
      follow: [],
    });
  });

  it('choosing a computer for work that was on Frameleaf Cloud sets the cloud record back to home', () => {
    const onCloud = facts({
      destinations: [server, office],
      cloudOn: true,
      cloudRouting: { descriptions: CloudRouteMode.Cloud },
    });
    expect(routeWrites({ descriptions: 'office' }, {}, onCloud)).toEqual({
      routes: [{ workload: MlWorkload.Enrichment, destinationId: 'office' }],
      cloud: { descriptions: CloudRouteMode.Local },
      follow: [],
    });
  });

  it('"Nowhere" clears the home record and the cloud permission together', () => {
    const asking = facts({
      destinations: [server, office],
      cloudOn: true,
      cloudRouting: { descriptions: CloudRouteMode.Both },
    });
    expect(routeWrites({ descriptions: NONE }, {}, asking)).toEqual({
      routes: [{ workload: MlWorkload.Enrichment, destinationId: null }],
      cloud: { descriptions: CloudRouteMode.Local },
      follow: [],
    });
  });

  it('gives a follower its own place when asked', () => {
    expect(routeWrites({}, { creative: 'office' }, linked).routes).toEqual([
      { workload: MlWorkload.RestorationCreative, destinationId: 'office' },
    ]);
  });
});

describe('following the processing order (FL-456)', () => {
  const following = (overrides: Partial<RouteFacts> = {}) =>
    facts({
      destinations: [server, office],
      routes: [
        { workload: MlWorkload.Face, destinationId: 'srv', followsOrder: true },
        { workload: MlWorkload.PetRecognition, destinationId: 'srv', followsOrder: true },
        { workload: MlWorkload.Enrichment, destinationId: 'office', followsOrder: false },
      ] as MlWorkloadRouteDto[],
      ...overrides,
    });

  it('a row that follows the order says so, whatever place it runs on now', () => {
    expect(currentChoice('faces', following())).toBe(FOLLOW);
    expect(currentChoice('descriptions', following())).toBe('office');
  });

  it('offers the order first, then each place, then nowhere', () => {
    expect(choicesFor('faces', following())).toEqual([FOLLOW, 'srv', 'office', NONE]);
    // an older server keeps no order, so it is not offered
    expect(choicesFor('faces', facts({ destinations: [server, office] }))).toEqual(['srv', 'office', NONE]);
  });

  it('picking the place a following row runs on now pins it there, with its follower', () => {
    expect(routeWrites({ faces: 'srv' }, {}, following())).toEqual({
      routes: [
        { workload: MlWorkload.Face, destinationId: 'srv' },
        { workload: MlWorkload.PetRecognition, destinationId: 'srv' },
      ],
      cloud: {},
      follow: [],
    });
  });

  it('a pinned row follows the order again, and nothing is written while nothing changes', () => {
    expect(routeWrites({ descriptions: FOLLOW }, {}, following())).toEqual({
      routes: [],
      cloud: {},
      follow: [MlWorkload.Enrichment],
    });
    expect(hasWrites(routeWrites({ faces: FOLLOW }, {}, following()))).toBe(false);
    expect(hasWrites(routeWrites({}, {}, following()))).toBe(false);
  });

  it('a follower set to "same" follows the order with its row', () => {
    const pinned = following({
      routes: [
        { workload: MlWorkload.Face, destinationId: 'srv', followsOrder: false },
        { workload: MlWorkload.PetRecognition, destinationId: 'srv', followsOrder: false },
      ] as MlWorkloadRouteDto[],
    });
    expect(routeWrites({ faces: FOLLOW }, {}, pinned).follow).toEqual([MlWorkload.Face, MlWorkload.PetRecognition]);
  });
});
